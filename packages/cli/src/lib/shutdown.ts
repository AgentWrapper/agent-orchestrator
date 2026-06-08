/**
 * SIGINT/SIGTERM shutdown handler for the long-running `ao start` process.
 *
 * Installs `process.once` listeners that perform a full graceful shutdown:
 * stop lifecycle workers, kill all active sessions, record last-stop state
 * for restore on next `ao start`, unregister from running.json, await the
 * bun-tmp janitor's final sweep, then exit.
 *
 * Lives in its own module so the orchestration is testable in isolation
 * and so the equivalent kill-and-record logic in `ao stop` can converge
 * here in a later refactor (today the two paths duplicate the core loop;
 * see ao-118 plan PR B).
 */

import {
  isTerminalSession,
  loadConfig,
  markDaemonShutdownHandlerInstalled,
  recordActivityEvent,
  sweepDaemonChildren,
} from "@aoagents/ao-core";
import { stopBunTmpJanitor } from "./bun-tmp-janitor.js";
import { getSessionManager } from "./create-session-manager.js";
import { stopAllLifecycleWorkers } from "./lifecycle-service.js";
import { stopProjectSupervisor } from "./project-supervisor.js";
import { unregister, writeLastStop } from "./running-state.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

export interface ShutdownContext {
  /** Path to the orchestrator config; re-read at shutdown time so any
   *  config edits since startup are honored. */
  configPath: string;
  /** Project this `ao start` invocation owns; used to scope last-stop's
   *  primary `sessionIds` field (other projects go to `otherProjects`). */
  projectId: string;
}

// Module-level guards so a second call to installShutdownHandlers within
// the same process is a no-op (vs. registering duplicate listeners that
// would each race to writeLastStop / unregister / process.exit on signal).
let handlersInstalled = false;
let shuttingDown = false;

export function isShutdownInProgress(): boolean {
  return shuttingDown;
}

/**
 * Install SIGINT/SIGTERM handlers. Process-wide idempotent — calling
 * this more than once is a no-op. Only the first signal triggers
 * cleanup; subsequent signals are ignored until the 10-second
 * force-exit timer fires.
 */
export function installShutdownHandlers(ctx: ShutdownContext): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  markDaemonShutdownHandlerInstalled();

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;

    const exitCode = signal === "SIGINT" ? 130 : 0;

    recordActivityEvent({
      projectId: ctx.projectId,
      source: "cli",
      kind: "cli.shutdown_signal",
      level: "info",
      summary: `received ${signal}, beginning graceful shutdown`,
      data: { signal, exitCode },
    });

    try {
      stopProjectSupervisor();
      stopAllLifecycleWorkers();
    } catch {
      // Best-effort — never block shutdown on observability.
    }

    const forceExit = setTimeout(() => {
      recordActivityEvent({
        projectId: ctx.projectId,
        source: "cli",
        kind: "cli.shutdown_force_exit",
        level: "warn",
        summary: `force-exit after ${SHUTDOWN_TIMEOUT_MS}ms timeout`,
        data: { signal, timeoutMs: SHUTDOWN_TIMEOUT_MS, exitCode },
      });
      process.exit(exitCode);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    void (async () => {
      try {
        const shutdownConfig = loadConfig(ctx.configPath);
        const sm = await getSessionManager(shutdownConfig);
        const allSessions = await sm.list();
        const activeSessions = allSessions.filter((s) => !isTerminalSession(s));

        const killedSessionIds: string[] = [];
        for (const session of activeSessions) {
          try {
            const result = await sm.kill(session.id);
            if (result.cleaned || result.alreadyTerminated) {
              killedSessionIds.push(session.id);
            }
          } catch (err) {
            recordActivityEvent({
              projectId: session.projectId ?? ctx.projectId,
              sessionId: session.id,
              source: "cli",
              kind: "cli.shutdown_session_kill_failed",
              level: "warn",
              summary: `failed to kill session during shutdown`,
              data: { errorMessage: err instanceof Error ? err.message : String(err) },
            });
          }
        }

        if (killedSessionIds.length > 0) {
          const targetIds = killedSessionIds.filter((id) =>
            activeSessions.some((s) => s.id === id && s.projectId === ctx.projectId),
          );
          const otherProjects: Array<{ projectId: string; sessionIds: string[] }> = [];
          const otherByProject = new Map<string, string[]>();
          for (const s of activeSessions) {
            if (s.projectId === ctx.projectId) continue;
            if (!killedSessionIds.includes(s.id)) continue;
            const list = otherByProject.get(s.projectId ?? "unknown") ?? [];
            list.push(s.id);
            otherByProject.set(s.projectId ?? "unknown", list);
          }
          for (const [pid, ids] of otherByProject) {
            otherProjects.push({ projectId: pid, sessionIds: ids });
          }
          try {
            await writeLastStop({
              stoppedAt: new Date().toISOString(),
              projectId: ctx.projectId,
              sessionIds: targetIds,
              otherProjects: otherProjects.length > 0 ? otherProjects : undefined,
            });
          } catch (err) {
            recordActivityEvent({
              projectId: ctx.projectId,
              source: "cli",
              kind: "cli.last_stop_write_failed",
              level: "error",
              summary: `failed to write last-stop state during shutdown`,
              data: {
                targetSessionCount: targetIds.length,
                otherProjectCount: otherProjects.length,
                totalKilled: killedSessionIds.length,
                errorMessage: err instanceof Error ? err.message : String(err),
              },
            });
          }
        }

        await sweepDaemonChildren({ ownerPid: process.pid });
        await unregister();
        recordActivityEvent({
          projectId: ctx.projectId,
          source: "cli",
          kind: "cli.shutdown_completed",
          level: "info",
          summary: `clean shutdown completed`,
          data: { signal, killedSessionCount: killedSessionIds.length, exitCode },
        });
      } catch (err) {
        recordActivityEvent({
          projectId: ctx.projectId,
          source: "cli",
          kind: "cli.shutdown_failed",
          level: "error",
          summary: `shutdown body threw before cleanup completed`,
          data: { signal, errorMessage: err instanceof Error ? err.message : String(err) },
        });
      }
      try {
        // Await any in-flight sweep so shutdown does not exit while
        // unlink() calls are still mid-flight against the filesystem.
        await stopBunTmpJanitor();
      } catch {
        // Best-effort cleanup.
      }
      process.exit(exitCode);
    })();
  };

  process.once("SIGINT", (sig) => {
    shutdown(sig);
  });
  process.once("SIGTERM", (sig) => {
    shutdown(sig);
  });
}
