/**
 * Auto-trigger orchestrator — drives `Pipeline.triggers` from polled SCM
 * events and applies the configured concurrency policy.
 *
 * Pure I/O coordination on top of the pure `triggers.ts` decision functions:
 *
 *   1. Fetch events since the last-checked timestamp (via SCM.getRecentPREvents).
 *   2. For each pipeline configured on the project, evaluate every trigger
 *      against every event. Earliest matching event wins per (pipeline, event).
 *   3. Apply the concurrency policy (`isActiveRun(pipelineName)` is supplied
 *      by the caller — we don't reach into the engine state directly).
 *   4. For `start` / `cancel_then_start`, call `startRun(pipelineName, opts)`.
 *      For `cancel_then_start`, also call `cancelActiveRun(pipelineName)`
 *      first. For `queue`, persist a queue entry; for `skip`, drop silently.
 *   5. Drain the persisted queue: any queued entry whose pipeline now has
 *      no active run is dispatched.
 *   6. Persist `lastCheckedAt = now` (and the updated queue).
 *
 * State persistence: a single JSON file per project at
 * `{getProjectPipelinesDir(projectId)}/auto-trigger-state.json`. Persisting
 * `lastCheckedAt` is the load-bearing requirement — without it, a restart
 * re-fires every event in the SCM event window. The queue lives in the same
 * file so a process restart recovers in-flight queued triggers, but the
 * format is deliberately small (no migrations machinery yet).
 *
 * Dependency injection: this module never imports `engine.ts` directly. The
 * caller wires `startRun` / `cancelActiveRun` / `isActiveRun` callbacks so
 * the lifecycle-manager can either dispatch through a real PipelineEngine
 * (when v0.4 lifecycle wiring lands) or through the CLI's `triggerRun`
 * adapter (today). Decoupling here means the auto-trigger pass is unit
 * testable without the engine and survives the engine wiring rework.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { PREvent, SCM } from "../types.js";
import {
  decideConcurrencyAction,
  evaluateTrigger,
  type ConcurrencyAction,
} from "./triggers.js";
import {
  DEFAULT_CONCURRENCY_POLICY,
  type ConcurrencyPolicy,
  type Pipeline,
  type PipelineTrigger,
} from "./types.js";

/**
 * Persisted state for one project. Kept intentionally tiny; if more state
 * shows up here, take a beat and decide whether it should live in the
 * pipeline store instead.
 */
export interface AutoTriggerState {
  /** ISO timestamp of the last poll. Used as `since` for `getRecentPREvents`. */
  lastCheckedAt: string;
  /**
   * Triggers held over by the `queue` policy. Drained on the next pass when
   * the target pipeline's loop is idle.
   */
  queued: QueuedTrigger[];
}

export interface QueuedTrigger {
  pipelineName: string;
  prNumber: number;
  /** ISO. Drop entries older than `queueMaxAgeMs` to bound the queue. */
  queuedAt: string;
  /** Carried for observability. The dispatcher only needs `prNumber`. */
  triggerEventType: PREvent["type"];
}

export const DEFAULT_QUEUE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

export const EMPTY_AUTO_TRIGGER_STATE: AutoTriggerState = {
  lastCheckedAt: new Date(0).toISOString(),
  queued: [],
};

// ============================================================================
// State persistence
// ============================================================================

/**
 * Read the per-project auto-trigger state from `path`. Missing file yields
 * `EMPTY_AUTO_TRIGGER_STATE`; corrupt JSON yields the same and is logged
 * by the caller (we don't want a bad state file to block trigger evaluation
 * forever — a fresh `lastCheckedAt = epoch` is recoverable, just noisy).
 */
export async function readAutoTriggerState(path: string): Promise<AutoTriggerState> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...EMPTY_AUTO_TRIGGER_STATE };
    }
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AutoTriggerState>;
    return {
      lastCheckedAt:
        typeof parsed.lastCheckedAt === "string"
          ? parsed.lastCheckedAt
          : EMPTY_AUTO_TRIGGER_STATE.lastCheckedAt,
      queued: Array.isArray(parsed.queued) ? parsed.queued : [],
    };
  } catch {
    return { ...EMPTY_AUTO_TRIGGER_STATE };
  }
}

export async function writeAutoTriggerState(
  path: string,
  state: AutoTriggerState,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2), "utf8");
}

// ============================================================================
// Pass orchestration
// ============================================================================

export interface DispatchInput {
  pipelineName: string;
  prNumber: number;
  triggerEventType: PREvent["type"] | "manual_queue_drain";
}

export interface AutoTriggerPassDeps {
  /** SCM plugin instance for the project. May lack `getRecentPREvents`. */
  scm: SCM;
  /** Pipelines configured on the project. */
  pipelines: Pipeline[];
  /** True if a non-terminal run is currently in-flight for this pipeline. */
  isActiveRun(pipelineName: string): boolean;
  /** Start a run. The caller resolves `pipelineName` to a Pipeline internally. */
  startRun(input: DispatchInput): Promise<void> | void;
  /** Cancel the active run for a pipeline (no-op when there isn't one). */
  cancelActiveRun(pipelineName: string): Promise<void> | void;
  /** Override clock for tests. */
  now?: () => Date;
  /** Drop queued entries older than this. Defaults to `DEFAULT_QUEUE_MAX_AGE_MS`. */
  queueMaxAgeMs?: number;
  /** Per-action observability hook. */
  onAction?: (action: AutoTriggerActionLog) => void;
}

export interface AutoTriggerActionLog {
  action: ConcurrencyAction | "drain";
  pipelineName: string;
  prNumber: number;
  trigger: PipelineTrigger;
  /** When `action === "drain"`, the original event type carried in the queue. */
  drainedFromEventType?: PREvent["type"];
}

export interface AutoTriggerPassResult {
  /** Updated state, suitable for `writeAutoTriggerState`. */
  state: AutoTriggerState;
  /** Number of dispatches that called `startRun`. */
  dispatched: number;
  /** Number of trigger evaluations that decided `skip`. */
  skipped: number;
  /** Number of trigger evaluations that pushed to the queue. */
  queued: number;
  /** Number of queued entries dispatched in the drain phase. */
  drained: number;
}

/**
 * Run one auto-trigger pass. Returns the new state — the caller persists it.
 * Tests pass the previous state directly; the lifecycle-manager wraps this
 * with `readAutoTriggerState` / `writeAutoTriggerState`.
 */
export async function runAutoTriggerPass(
  prevState: AutoTriggerState,
  deps: AutoTriggerPassDeps,
): Promise<AutoTriggerPassResult> {
  const now = deps.now?.() ?? new Date();
  const queueMaxAgeMs = deps.queueMaxAgeMs ?? DEFAULT_QUEUE_MAX_AGE_MS;
  const since = new Date(prevState.lastCheckedAt);

  let dispatched = 0;
  let skipped = 0;
  let queuedCount = 0;
  let drained = 0;

  // Mutable working copy of the queue. Newly enqueued entries land here;
  // drained entries are removed.
  const workingQueue: QueuedTrigger[] = [...prevState.queued];

  // ---- Phase 1: ingest fresh events ----

  // Plugins without getRecentPREvents short-circuit to a no-op pass — but
  // we still drain the queue and advance `lastCheckedAt`. Without advancing,
  // a transient SCM outage would leave us re-fetching the same window
  // forever once the plugin starts implementing the method.
  const events: PREvent[] = deps.scm.getRecentPREvents
    ? await deps.scm.getRecentPREvents(since)
    : [];

  // Sort events by occurredAt ascending so cancel_in_progress ordering is
  // deterministic when multiple events match the same pipeline in one pass.
  events.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

  for (const event of events) {
    for (const pipeline of deps.pipelines) {
      const matchedTrigger = findMatchingTrigger(pipeline, event);
      if (!matchedTrigger) continue;

      const policy = pipeline.concurrency ?? DEFAULT_CONCURRENCY_POLICY;
      const hasActiveRun = deps.isActiveRun(pipeline.name);
      const action = decideConcurrencyAction({ policy, hasActiveRun });

      deps.onAction?.({
        action,
        pipelineName: pipeline.name,
        prNumber: event.prNumber,
        trigger: matchedTrigger,
      });

      switch (action) {
        case "start":
          await deps.startRun({
            pipelineName: pipeline.name,
            prNumber: event.prNumber,
            triggerEventType: event.type,
          });
          dispatched++;
          break;

        case "cancel_then_start":
          await deps.cancelActiveRun(pipeline.name);
          await deps.startRun({
            pipelineName: pipeline.name,
            prNumber: event.prNumber,
            triggerEventType: event.type,
          });
          dispatched++;
          break;

        case "skip":
          skipped++;
          break;

        case "queue":
          workingQueue.push({
            pipelineName: pipeline.name,
            prNumber: event.prNumber,
            queuedAt: now.toISOString(),
            triggerEventType: event.type,
          });
          queuedCount++;
          break;
      }
    }
  }

  // ---- Phase 2: age out + drain queue ----

  const stillFresh = workingQueue.filter((q) => {
    const ageMs = now.getTime() - new Date(q.queuedAt).getTime();
    return ageMs <= queueMaxAgeMs;
  });

  const remainingQueue: QueuedTrigger[] = [];
  for (const entry of stillFresh) {
    if (deps.isActiveRun(entry.pipelineName)) {
      remainingQueue.push(entry);
      continue;
    }
    deps.onAction?.({
      action: "drain",
      pipelineName: entry.pipelineName,
      prNumber: entry.prNumber,
      // Synthetic trigger record for observability — the queue intentionally
      // doesn't store the original `PipelineTrigger` because by drain time
      // its filter context is irrelevant.
      trigger: { on: entry.triggerEventType },
      drainedFromEventType: entry.triggerEventType,
    });
    await deps.startRun({
      pipelineName: entry.pipelineName,
      prNumber: entry.prNumber,
      triggerEventType: entry.triggerEventType,
    });
    drained++;
  }

  // ---- Phase 3: build new state ----

  const nextState: AutoTriggerState = {
    lastCheckedAt: now.toISOString(),
    queued: remainingQueue,
  };

  return { state: nextState, dispatched, skipped, queued: queuedCount, drained };
}

/**
 * Return the first trigger on `pipeline` that matches `event`. We pick the
 * first match (declaration order) so operators can put their narrower
 * triggers first — same-event with different filters resolves to the most
 * specific configured trigger.
 */
function findMatchingTrigger(pipeline: Pipeline, event: PREvent): PipelineTrigger | null {
  for (const trigger of pipeline.triggers ?? []) {
    if (evaluateTrigger({ trigger, event })) return trigger;
  }
  return null;
}

/** For tests: build a fresh state pinned to a specific timestamp. */
export function makeInitialAutoTriggerState(at: Date): AutoTriggerState {
  return { lastCheckedAt: at.toISOString(), queued: [] };
}

/** Resolve the per-project state file path (caller-controlled root dir). */
export function autoTriggerStatePath(pipelinesDir: string): string {
  return `${pipelinesDir}/auto-trigger-state.json`;
}

// Re-export for convenience — the policy default is consumed both by the
// pass and by callers that need to surface the effective policy in UIs.
export { DEFAULT_CONCURRENCY_POLICY } from "./types.js";
export type { ConcurrencyPolicy };
