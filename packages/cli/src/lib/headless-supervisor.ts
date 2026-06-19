/**
 * Headless multi-project supervisor daemon.
 *
 * Backs both `ao daemon` and `ao start --all`: supervises EVERY configured
 * project without a dashboard, so a native front-end (Maestro) can be the only
 * UI. Reuses the already-global project supervisor — `reconcileProjectSupervisor`
 * iterates every configured project and attaches a lifecycle worker to each one
 * that has an active session.
 *
 * Lives in its own module (not `commands/start.ts`) so it has a small, easily
 * mocked import surface and never pulls in the dashboard/web code path:
 * `findWebDir()` and the rest of `lib/web-dir.ts` are not imported here, so the
 * headless daemon is structurally incapable of touching `@aoagents/ao-web`.
 */

import { existsSync } from "node:fs";
import chalk from "chalk";
import ora from "ora";
import {
  loadConfig,
  getGlobalConfigPath,
  generateOrchestratorPrompt,
  recordActivityEvent,
  scanAoOrphans,
  reapAoOrphans,
  type OrchestratorConfig,
} from "@aoagents/ao-core";
import { getSessionManager } from "./create-session-manager.js";
import { startProjectSupervisor } from "./project-supervisor.js";
import { listLifecycleWorkers } from "./lifecycle-service.js";
import { runtimePreflight } from "./startup-preflight.js";
import { installShutdownHandlers } from "./shutdown.js";
import { acquireStartupLock, isAlreadyRunning, register } from "./running-state.js";
import { startBunTmpJanitor } from "./bun-tmp-janitor.js";
import { DEFAULT_PORT } from "./constants.js";

export interface HeadlessSupervisorOptions {
  /**
   * Also ensure an orchestrator session for EVERY configured project at
   * startup (opt-in `--orchestrate-all`). Default false: supervise only and
   * let front-ends (Maestro) spawn orchestrators on demand — parity with the
   * web dashboard server, which never auto-spawns orchestrators either.
   */
  orchestrateAll?: boolean;
  /** Reap orphaned AO child processes before starting. */
  reapOrphans?: boolean;
}

/**
 * Load the config that enumerates ALL configured projects. Prefers the global
 * registry (the canonical ~/.agent-orchestrator config that lists every
 * registered project); falls back to a cwd-walk `loadConfig()` for setups that
 * only have a local agent-orchestrator.yaml.
 */
function loadAllProjectsConfig(): OrchestratorConfig {
  const globalPath = getGlobalConfigPath();
  if (existsSync(globalPath)) {
    return loadConfig(globalPath);
  }
  return loadConfig();
}

/**
 * Non-interactive orphan reap. The daemon never prompts (it may be launched by
 * a native front-end), so this only runs when the caller explicitly opts in via
 * `--reap-orphans`.
 */
async function reapOrphansIfRequested(reap: boolean | undefined): Promise<void> {
  if (!reap) return;
  const orphans = await scanAoOrphans();
  if (orphans.length === 0) return;
  const result = await reapAoOrphans(orphans);
  console.log(
    chalk.green(`  Reaped ${result.attempted} orphaned AO child process(es).`),
  );
}

/**
 * Run the headless multi-project supervisor.
 *
 * Unlike single-project `ao start`, it does NOT resolve a single project and
 * never starts a dashboard. It stays alive via the supervisor's keep-alive
 * timer even when no project has an active session yet; SIGINT/SIGTERM (e.g.
 * `ao stop`) triggers the shared graceful shutdown handler.
 */
export async function runHeadlessSupervisor(
  opts: HeadlessSupervisorOptions = {},
): Promise<void> {
  recordActivityEvent({
    source: "cli",
    kind: "cli.daemon_invoked",
    level: "info",
    summary: "ao daemon (headless multi-project supervisor) invoked",
    data: { orchestrateAll: opts.orchestrateAll === true },
  });

  let releaseStartupLock: (() => void) | undefined;
  let startupLockReleased = false;
  const unlockStartup = (): void => {
    if (startupLockReleased || !releaseStartupLock) return;
    startupLockReleased = true;
    releaseStartupLock();
  };

  try {
    releaseStartupLock = await acquireStartupLock();
    await reapOrphansIfRequested(opts.reapOrphans);

    // A daemon or dashboard `ao start` already supervises every global project,
    // so don't spawn a competing supervisor process — report and return.
    const running = await isAlreadyRunning();
    if (running) {
      console.log(chalk.cyan("\nℹ AO is already running."));
      console.log(`  PID: ${running.pid} | Up since: ${running.startedAt}`);
      console.log(`  Projects: ${running.projects.join(", ")}`);
      console.log(chalk.dim("  The running instance already supervises all projects."));
      console.log(chalk.dim("  To restart headless: ao stop && ao daemon\n"));
      unlockStartup();
      return;
    }

    const config = loadAllProjectsConfig();
    const projectIds = Object.keys(config.projects);
    if (projectIds.length === 0) {
      throw new Error("No projects configured. Add a project to agent-orchestrator.yaml.");
    }

    await runtimePreflight(config);

    // Pick a deterministic "owner" project for the shared shutdown handler's
    // last-stop scoping. The daemon has no single primary project; the owner
    // only decides which project's killed sessions land in last-stop's primary
    // `sessionIds` list (the rest go to `otherProjects`). readLastStop rejects
    // an empty projectId, so a real id is required here.
    const shutdownOwner = [...projectIds].sort()[0];
    installShutdownHandlers({ configPath: config.configPath, projectId: shutdownOwner });

    console.log(
      chalk.bold(
        `\nStarting headless supervisor for ${chalk.cyan(String(projectIds.length))} project(s)\n`,
      ),
    );

    const spinner = ora();

    // Opt-in: ensure an orchestrator session for every configured project.
    if (opts.orchestrateAll) {
      const sm = await getSessionManager(config);
      for (const projectId of projectIds) {
        const project = config.projects[projectId];
        try {
          spinner.start(`Ensuring orchestrator: ${projectId}`);
          const systemPrompt = generateOrchestratorPrompt({ config, projectId, project });
          const session = await sm.ensureOrchestrator({ projectId, systemPrompt });
          spinner.succeed(`Orchestrator ready: ${projectId} → ${session.id}`);
        } catch (err) {
          spinner.fail(`Orchestrator failed: ${projectId}`);
          recordActivityEvent({
            projectId,
            source: "cli",
            kind: "cli.start_failed",
            level: "warn",
            summary: `headless orchestrate-all: failed to ensure orchestrator`,
            data: { errorMessage: err instanceof Error ? err.message : String(err) },
          });
          // Best-effort per project — one bad project must not abort the daemon.
        }
      }
    }

    spinner.start("Starting project supervisor");
    await startProjectSupervisor({ configPath: config.configPath, keepProcessAlive: true });
    spinner.succeed("Lifecycle project supervisor started");

    await register({
      pid: process.pid,
      configPath: config.configPath,
      port: config.port ?? DEFAULT_PORT,
      startedAt: new Date().toISOString(),
      projects: listLifecycleWorkers(),
    });

    startBunTmpJanitor({
      onSweep: ({ removed, freedBytes, errors }) => {
        if (removed > 0) {
          console.info(`[bun-tmp-janitor] reclaimed ${removed} file(s) / ${freedBytes} bytes`);
        }
        if (errors > 0) {
          console.warn(`[bun-tmp-janitor] sweep had ${errors} error(s)`);
        }
      },
    });

    unlockStartup();

    const supervisedProjects = listLifecycleWorkers().sort();
    console.log(chalk.bold.green("\n✓ Headless supervisor running\n"));
    console.log(
      chalk.cyan("Lifecycle:"),
      `supervising ${projectIds.length} configured project(s)` +
        (supervisedProjects.length > 0
          ? `; active now: ${supervisedProjects.join(", ")}`
          : "; no active sessions yet (front-ends spawn orchestrators on demand)"),
    );
    console.log(chalk.cyan("Attach:"), "ao session attach <sessionId>");
    console.log(chalk.dim(`Config: ${config.configPath}`));
    console.log(chalk.dim("Stop:   ao stop\n"));

    // Process stays alive via the supervisor's keep-alive timer until
    // SIGINT/SIGTERM triggers the shared graceful shutdown handler.
  } catch (err) {
    recordActivityEvent({
      source: "cli",
      kind: "cli.start_failed",
      level: "error",
      summary: `ao daemon (headless) failed`,
      data: {
        reason: "headless_outer",
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    });
    console.error(chalk.red("\nError:"), err instanceof Error ? err.message : String(err));
    unlockStartup();
    process.exit(1);
  } finally {
    unlockStartup();
  }
}
