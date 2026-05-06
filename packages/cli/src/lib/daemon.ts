/**
 * Daemon attachment and lifecycle helpers.
 *
 * Pulls the "AO is already running" branches out of `start.ts` so the running
 * vs. not-running fork in the entry command is a single decision point and
 * the per-branch operations (attach, kill, dashboard cache invalidation) can
 * be reused.
 *
 * Today this covers:
 * - {@link attachToDaemon}: build a handle to an already-running daemon and
 *   surface dashboard cache invalidation through {@link AttachedDaemon.notifyProjectChange}.
 * - {@link killExistingDaemon}: SIGTERM -> wait -> SIGKILL the daemon and
 *   unregister `running.json`. Used by the "Restart everything" menu option.
 *
 * Spawning a fresh daemon (dashboard + supervisor + register) still lives in
 * `start.ts`'s `runStartup`. PR B's plan eventually folds that into a
 * symmetrical `spawnDaemon` here, but doing so requires extracting last-stop
 * restore + browser-open + shutdown-handler installation, which is out of
 * scope for this PR.
 */

import chalk from "chalk";
import { unregister, waitForExit, type RunningState } from "./running-state.js";

/**
 * Return value of `notifyProjectChange`. The daemon may be unreachable (user
 * stopped the dashboard manually) — callers can choose to warn or throw based
 * on whether they expect the daemon to be live.
 */
export type NotifyResult = { ok: true } | { ok: false; reason: string };

/**
 * Handle for a daemon that was already running when this CLI invocation
 * started. Distinguishes from a freshly-spawned daemon (which would be
 * managed in-process by `runStartup` + `installShutdownHandlers`).
 */
export interface AttachedDaemon {
  readonly outcome: "attached";
  readonly port: number;
  readonly pid: number;
  /**
   * Tell the dashboard a project was added or changed so it reloads its
   * cached config. Returns `{ ok: false }` on any error; the dashboard might
   * be down (user killed it manually), so callers typically warn rather than
   * throw.
   */
  notifyProjectChange(): Promise<NotifyResult>;
}

async function postProjectsReload(port: number): Promise<NotifyResult> {
  try {
    const res = await fetch(`http://localhost:${port}/api/projects/reload`, {
      method: "POST",
    });
    if (res.ok) return { ok: true };
    return { ok: false, reason: `Dashboard reload returned ${res.status}` };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Build an {@link AttachedDaemon} for an existing running daemon.
 * Pure — does not perform any network/filesystem I/O until the returned
 * handle's methods are called.
 */
export function attachToDaemon(running: RunningState): AttachedDaemon {
  return {
    outcome: "attached",
    port: running.port,
    pid: running.pid,
    notifyProjectChange: () => postProjectsReload(running.port),
  };
}

/**
 * Stop a running daemon synchronously: SIGTERM, wait up to 5s, SIGKILL if
 * still alive, wait another 3s. Throws if the process refuses to die.
 * Always unregisters `running.json` on success so the next `ao start` can
 * spawn a fresh daemon without hitting the "already running" gate.
 */
export async function killExistingDaemon(running: RunningState): Promise<void> {
  try {
    process.kill(running.pid, "SIGTERM");
  } catch {
    // already dead — fall through to wait/unregister
  }
  if (!(await waitForExit(running.pid, 5000))) {
    console.log(chalk.yellow("  Process didn't exit cleanly, sending SIGKILL..."));
    try {
      process.kill(running.pid, "SIGKILL");
    } catch {
      // already dead
    }
    if (!(await waitForExit(running.pid, 3000))) {
      throw new Error(
        `Failed to stop AO process (PID ${running.pid}). Check permissions or stop it manually.`,
      );
    }
  }
  await unregister();
}
