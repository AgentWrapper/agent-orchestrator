import {
  createCorrelationId,
  createProjectObserver,
  type LifecycleManager,
  type OrchestratorConfig,
} from "@aoagents/ao-core";
import { getLifecycleManager } from "./create-session-manager.js";

const DEFAULT_INTERVAL_MS = 30_000;

interface ActiveLoop {
  lifecycle: LifecycleManager;
  stop: () => void;
}

const active = new Map<string, ActiveLoop>();

// Note: no SIGINT/SIGTERM listeners are installed here. Adding a listener for
// those signals removes Node.js's default "exit on signal" behavior, which
// would leave `ao start` hanging when `ao stop` sends SIGTERM (the setInterval
// keeps the event loop alive forever). Default signal handling terminates the
// process cleanly; the OS reclaims the interval timer. Callers that need to
// flush state explicitly before exit can call `stopAllLifecycleWorkers()`.

export interface LifecycleWorkerStatus {
  running: boolean;
  started: boolean;
}

export async function ensureLifecycleWorker(
  config: OrchestratorConfig,
  projectId: string,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): Promise<LifecycleWorkerStatus> {
  if (!config.projects[projectId]) {
    throw new Error(`Unknown project: ${projectId}`);
  }

  if (active.has(projectId)) {
    return { running: true, started: false };
  }

  const observer = createProjectObserver(config, "lifecycle-service");
  const lifecycle = await getLifecycleManager(config, projectId);

  lifecycle.start(intervalMs);

  observer.setHealth({
    surface: "lifecycle.worker",
    status: "ok",
    projectId,
    correlationId: createCorrelationId("lifecycle-service"),
    details: { projectId, intervalMs, inProcess: true },
  });

  active.set(projectId, {
    lifecycle,
    stop: () => {
      try {
        lifecycle.stop();
      } finally {
        observer.setHealth({
          surface: "lifecycle.worker",
          status: "warn",
          projectId,
          correlationId: createCorrelationId("lifecycle-service"),
          reason: "Lifecycle polling stopped",
          details: { projectId },
        });
      }
    },
  });

  return { running: true, started: true };
}

export function stopLifecycleWorker(projectId: string): void {
  const entry = active.get(projectId);
  if (!entry) return;

  try {
    entry.stop();
  } catch {
    // Best-effort
  }
  active.delete(projectId);
}

export function stopAllLifecycleWorkers(): void {
  for (const projectId of Array.from(active.keys())) {
    stopLifecycleWorker(projectId);
  }
}

export function isLifecycleWorkerRunning(projectId: string): boolean {
  return active.has(projectId);
}

export function listLifecycleWorkers(): string[] {
  return Array.from(active.keys());
}
