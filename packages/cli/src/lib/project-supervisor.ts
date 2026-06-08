import {
  loadConfig,
  getGlobalConfigPath,
  isTerminalSession,
  createCorrelationId,
  createProjectObserver,
  ConfigNotFoundError,
  type OrchestratorConfig,
  type ProjectObserver,
} from "@aoagents/ao-core";
import { getSessionManager } from "./create-session-manager.js";
import {
  ensureLifecycleWorker,
  listLifecycleWorkers,
  stopLifecycleWorker,
} from "./lifecycle-service.js";
import { addProjectToRunning, removeProjectFromRunning } from "./running-state.js";

const DEFAULT_SUPERVISOR_INTERVAL_MS = 60_000;

interface SupervisorHandle {
  stop: () => void;
  reconcileNow: () => Promise<void>;
}

let activeSupervisor: SupervisorHandle | null = null;

type SupervisorConfigSource = "global" | "local-fallback";

interface LoadedSupervisorConfig {
  config: OrchestratorConfig;
  source: SupervisorConfigSource;
}

export interface ReconcileProjectSupervisorOptions {
  intervalMs?: number;
  /**
   * Resolved config path from the caller (typically `ao start`). When the
   * global config is missing, this is used as the explicit local-fallback
   * source. Without it the supervisor would fall back to a cwd-walk via
   * bare `loadConfig()`, which misses configs in `ao start <url>` /
   * `ao start <path>` first-run flows — there the resolved config can
   * live under the clone/target path while the daemon's cwd is somewhere
   * else. A bare cwd-walk in that case throws ConfigNotFoundError, which
   * `run()` silently swallows, leaving `running.projects` empty.
   */
  configPath?: string;
}

export interface StartProjectSupervisorOptions {
  intervalMs?: number;
  /** See {@link ReconcileProjectSupervisorOptions.configPath}. */
  configPath?: string;
}

function isMissingConfigError(error: unknown): boolean {
  if (error instanceof ConfigNotFoundError) return true;
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ENOENT" &&
    "path" in error &&
    error.path === getGlobalConfigPath()
  );
}

/** Load the supervisor config: prefer the global registry, fall back to the
 *  caller-resolved local config path (or cwd discovery when none provided).
 *  Returns the source so callers can gate authoritative actions (like the
 *  detach pass) on whether we're looking at the real registry. */
function loadSupervisorConfig(configPath?: string): LoadedSupervisorConfig {
  const globalConfigPath = getGlobalConfigPath();
  try {
    return { config: loadConfig(globalConfigPath), source: "global" };
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT" &&
      "path" in error &&
      error.path === globalConfigPath
    ) {
      const config = configPath ? loadConfig(configPath) : loadConfig();
      return { config, source: "local-fallback" };
    }
    throw error;
  }
}

function reportProjectSupervisorError(
  observer: ProjectObserver,
  projectId: string,
  reason: string,
  error: unknown,
): void {
  observer.setHealth({
    surface: "project-supervisor.reconcile",
    status: "warn",
    projectId,
    correlationId: createCorrelationId("project-supervisor"),
    reason,
    details: {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    },
  });
}

async function projectHasNonTerminalSession(
  config: OrchestratorConfig,
  projectId: string,
): Promise<boolean> {
  const sm = await getSessionManager(config);
  const sessions = await sm.list(projectId);
  return sessions.some((session) => !isTerminalSession(session));
}

export async function reconcileProjectSupervisor(
  options: ReconcileProjectSupervisorOptions = {},
): Promise<void> {
  const { config, source } = loadSupervisorConfig(options.configPath);
  const observer = createProjectObserver(config, "project-supervisor");
  const configuredProjectIds = new Set(Object.keys(config.projects));

  // Only the authoritative global registry can declare a project "removed".
  // On a local fallback (e.g. global config was deleted while the daemon is
  // already supervising multiple projects) the loaded config likely doesn't
  // enumerate every supervised project — running the detach pass would kill
  // unrelated lifecycle workers. Pre-fallback behavior was a no-op on
  // missing global; preserve that property for the detach pass specifically.
  if (source === "global") {
    const activeProjectIds = new Set(listLifecycleWorkers());
    for (const projectId of activeProjectIds) {
      if (!configuredProjectIds.has(projectId)) {
        try {
          stopLifecycleWorker(projectId);
          await removeProjectFromRunning(projectId);
        } catch (error) {
          reportProjectSupervisorError(
            observer,
            projectId,
            "Failed to detach lifecycle worker for removed project",
            error,
          );
        }
      }
    }
  }

  for (const projectId of configuredProjectIds) {
    try {
      const hasNonTerminalSession = await projectHasNonTerminalSession(config, projectId);
      const isAttached = listLifecycleWorkers().includes(projectId);

      if (hasNonTerminalSession) {
        if (!isAttached) {
          await ensureLifecycleWorker(config, projectId, options.intervalMs);
        }
        await addProjectToRunning(projectId);
      } else if (isAttached) {
        stopLifecycleWorker(projectId);
        await removeProjectFromRunning(projectId);
      }
    } catch (error) {
      reportProjectSupervisorError(
        observer,
        projectId,
        "Failed to reconcile lifecycle worker for project",
        error,
      );
      // Best-effort per project: a broken project must not block others from reconciling.
    }
  }
}

export async function startProjectSupervisor(
  options: StartProjectSupervisorOptions = {},
): Promise<SupervisorHandle> {
  if (activeSupervisor) return activeSupervisor;

  const intervalMs = options.intervalMs ?? DEFAULT_SUPERVISOR_INTERVAL_MS;
  const configPath = options.configPath;

  let reconciling = false;
  let pending = false;
  let stopped = false;
  let waiters: Array<() => void> = [];

  const run = async (runOptions: { swallowErrors?: boolean } = {}): Promise<void> => {
    if (stopped) return;
    if (reconciling) {
      pending = true;
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    }

    reconciling = true;
    try {
      do {
        pending = false;
        try {
          await reconcileProjectSupervisor({ intervalMs, configPath });
        } catch (error) {
          if (isMissingConfigError(error)) return;
          if (!runOptions.swallowErrors) throw error;
          // Best-effort background loop: transient config/state errors should not crash ao start.
        }
      } while (pending && !stopped);
    } finally {
      reconciling = false;
      const pendingWaiters = waiters;
      waiters = [];
      for (const resolve of pendingWaiters) resolve();
    }
  };

  const timer = setInterval(() => {
    void run({ swallowErrors: true });
  }, intervalMs);
  timer.unref?.();

  const handle: SupervisorHandle = {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      activeSupervisor = null;
    },
    reconcileNow: run,
  };
  activeSupervisor = handle;

  try {
    await run();
  } catch (error) {
    handle.stop();
    throw error;
  }
  return handle;
}

export function stopProjectSupervisor(): void {
  activeSupervisor?.stop();
}
