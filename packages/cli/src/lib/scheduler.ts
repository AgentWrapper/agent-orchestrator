/**
 * Durable scheduled-tasks ticker for the headless daemon.
 *
 * Runs inside `ao daemon` (see headless-supervisor.ts). Once a minute it
 * enumerates every configured project, reads that project's task library
 * (`<projectRoot>/.maestro/scheduled-tasks/*.yaml`), decides which jobs are due
 * (`evaluateScheduledJob`, which is durable across restarts via the persisted
 * state file), and fires each due job's action through the engine's internal
 * APIs — `spawn` / `send` via the SessionManager, `notify` via the notifier
 * fan-out. Every firing is written to the activity-event log.
 *
 * The pure halves live in core: trigger math + evaluation in `scheduled-tasks`,
 * persistence in `scheduler-state`. This module is just the runtime wiring.
 */

import {
  loadConfig,
  getGlobalConfigPath,
  recordActivityEvent,
  resolveNotifierTarget,
  createCorrelationId,
  loadScheduledTasks,
  evaluateScheduledJob,
  dispatchScheduledAction,
  loadSchedulerState,
  saveSchedulerState,
  jobStateKey,
  type OrchestratorConfig,
  type Notifier,
  type OrchestratorEvent,
  type ScheduledActionHandlers,
  type ScheduledJobState,
} from "@aoagents/ao-core";
import { getSessionManager, getPluginRegistry } from "./create-session-manager.js";

const DEFAULT_SCHEDULER_INTERVAL_MS = 60_000;

export interface StartSchedulerOptions {
  /** Tick cadence; defaults to 60s. */
  intervalMs?: number;
  /** Firing tolerance passed to evaluateScheduledJob (defaults to core's). */
  graceMs?: number;
  /** Override the durable state path (tests). */
  statePath?: string;
}

export interface SchedulerHandle {
  stop: () => void;
  /** Run a single tick immediately (used at startup and by tests). */
  tickNow: () => Promise<void>;
}

let activeScheduler: SchedulerHandle | null = null;

/**
 * Reload the all-projects config each tick so newly registered projects and
 * edited task files are picked up without restarting the daemon. Mirrors
 * headless-supervisor's global-then-local-fallback loader. On any error the
 * previous good config is reused.
 */
function reloadConfig(previous: OrchestratorConfig): OrchestratorConfig {
  const globalPath = getGlobalConfigPath();
  try {
    return loadConfig(globalPath);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT" &&
      "path" in error &&
      (error as { path?: unknown }).path === globalPath
    ) {
      try {
        return previous.configPath ? loadConfig(previous.configPath) : loadConfig();
      } catch {
        return previous;
      }
    }
    return previous;
  }
}

/** Fan a notify action out to the configured notifiers (best-effort). */
async function emitSchedulerNotification(
  config: OrchestratorConfig,
  opts: { projectId: string; taskName: string; message: string; target?: string },
): Promise<void> {
  const priority = "info" as const;
  const routed = config.notificationRouting?.[priority] ?? config.defaults?.notifiers ?? [];
  const forced = (process.env["AO_NOTIFIERS_ALLOW"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const names = [...new Set([...routed, ...forced, ...(opts.target ? [opts.target] : [])])];
  if (names.length === 0) return;

  const registry = await getPluginRegistry(config);
  const event: OrchestratorEvent = {
    id: createCorrelationId("scheduler"),
    type: "reaction.triggered",
    priority,
    sessionId: "",
    projectId: opts.projectId,
    timestamp: new Date(),
    message: opts.message,
    data: { source: "scheduled-task", taskName: opts.taskName },
  };

  for (const name of names) {
    const target = resolveNotifierTarget(config, name);
    const notifier =
      registry.get<Notifier>("notifier", target.reference) ??
      registry.get<Notifier>("notifier", target.pluginName);
    if (!notifier) continue;
    try {
      await notifier.notify(event);
    } catch {
      // Best-effort: a failing notifier must not abort the firing.
    }
  }
}

/** Build the real spawn/send/notify handlers bound to the current config. */
function makeHandlers(getConfig: () => OrchestratorConfig): ScheduledActionHandlers {
  return {
    async spawn({ projectId, taskName, prompt, skills, model }) {
      const config = getConfig();
      const sm = await getSessionManager(config);
      const session = await sm.spawn({
        projectId,
        prompt,
        skills,
        model,
        title: `scheduled: ${taskName}`,
      });
      recordActivityEvent({
        projectId,
        sessionId: session.id,
        source: "cli",
        kind: "scheduler.action_spawned",
        level: "info",
        summary: `scheduled task "${taskName}" spawned ${session.id}`,
        data: { taskName, model: model ?? undefined, skills: skills ?? undefined },
      });
    },
    async send({ projectId, taskName, target, message }) {
      const config = getConfig();
      const sm = await getSessionManager(config);
      await sm.send(target, message);
      recordActivityEvent({
        projectId,
        sessionId: target,
        source: "cli",
        kind: "scheduler.action_sent",
        level: "info",
        summary: `scheduled task "${taskName}" sent message to ${target}`,
        data: { taskName, target },
      });
    },
    async notify({ projectId, taskName, message, target }) {
      const config = getConfig();
      await emitSchedulerNotification(config, { projectId, taskName, message, target });
      recordActivityEvent({
        projectId,
        source: "cli",
        kind: "scheduler.action_notified",
        level: "info",
        summary: `scheduled task "${taskName}" notified`,
        data: { taskName, target: target ?? undefined },
      });
    },
  };
}

/**
 * One scheduler pass: load durable state, evaluate every enabled job across all
 * projects, fire the due ones, prune state for jobs that no longer exist, and
 * persist. Exported for tests.
 */
export async function runSchedulerTick(args: {
  config: OrchestratorConfig;
  handlers: ScheduledActionHandlers;
  now?: Date;
  graceMs?: number;
  statePath?: string;
}): Promise<void> {
  const { config, handlers, graceMs, statePath } = args;
  const state = loadSchedulerState(statePath);
  const liveKeys = new Set<string>();

  for (const [projectId, project] of Object.entries(config.projects)) {
    const projectRoot = project.path;
    if (!projectRoot) continue;

    const { tasks, errors } = loadScheduledTasks(projectRoot);
    for (const { file, error } of errors) {
      recordActivityEvent({
        projectId,
        source: "cli",
        kind: "scheduler.task_invalid",
        level: "warn",
        summary: `invalid scheduled task file ${file}`,
        data: { file, error },
      });
    }

    for (const task of tasks) {
      if (!task.enabled) continue;
      const key = jobStateKey(projectId, task.name);
      liveKeys.add(key);

      const now = args.now ?? new Date();
      const jobState: ScheduledJobState = state.jobs[key] ?? {};
      const { shouldFire, nextState } = evaluateScheduledJob({ task, state: jobState, now, graceMs });
      state.jobs[key] = nextState;

      if (!shouldFire) continue;
      try {
        await dispatchScheduledAction(task, projectId, handlers);
        recordActivityEvent({
          projectId,
          source: "cli",
          kind: "scheduler.fired",
          level: "info",
          summary: `scheduled task "${task.name}" fired (${task.action.type})`,
          data: { taskName: task.name, trigger: task.trigger.type, action: task.action.type },
        });
      } catch (err) {
        recordActivityEvent({
          projectId,
          source: "cli",
          kind: "scheduler.fire_failed",
          level: "error",
          summary: `scheduled task "${task.name}" failed to fire`,
          data: { taskName: task.name, errorMessage: err instanceof Error ? err.message : String(err) },
        });
      }
    }
  }

  // Drop state for jobs whose definition is gone (file deleted / project removed)
  // so a re-created datetime job isn't permanently stuck `spent`.
  for (const key of Object.keys(state.jobs)) {
    if (!liveKeys.has(key)) delete state.jobs[key];
  }

  saveSchedulerState(state, statePath);
}

/**
 * Start the durable scheduler. Idempotent: a second call returns the existing
 * handle. The interval timer is `unref()`'d — the daemon's supervisor keep-alive
 * timer is what holds the process open.
 */
export function startScheduler(
  config: OrchestratorConfig,
  options: StartSchedulerOptions = {},
): SchedulerHandle {
  if (activeScheduler) return activeScheduler;

  const intervalMs = options.intervalMs ?? DEFAULT_SCHEDULER_INTERVAL_MS;
  let currentConfig = config;
  let stopped = false;
  let running = false;

  const handlers = makeHandlers(() => currentConfig);

  const tickNow = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      currentConfig = reloadConfig(currentConfig);
      await runSchedulerTick({
        config: currentConfig,
        handlers,
        graceMs: options.graceMs,
        statePath: options.statePath,
      });
    } catch (err) {
      recordActivityEvent({
        source: "cli",
        kind: "scheduler.tick_failed",
        level: "warn",
        summary: "scheduler tick failed",
        data: { errorMessage: err instanceof Error ? err.message : String(err) },
      });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tickNow();
  }, intervalMs);
  timer.unref?.();

  const handle: SchedulerHandle = {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      activeScheduler = null;
    },
    tickNow,
  };
  activeScheduler = handle;

  // Seed state on the first tick (no job fires on its first sighting).
  void tickNow();

  return handle;
}

export function stopScheduler(): void {
  activeScheduler?.stop();
}
