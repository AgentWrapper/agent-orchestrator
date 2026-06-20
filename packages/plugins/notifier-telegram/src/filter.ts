import { getNotificationDataV3, type OrchestratorEvent } from "@aoagents/ao-core";

// ---------------------------------------------------------------------------
// Actionable-event filter
//
// notifyHuman fans every orchestrator event out to whichever notifiers routing
// (and AO_NOTIFIERS_ALLOW) selects. For Telegram that firehose is too noisy:
// agents oscillate between `working` and `stuck` (a false activity probe), and
// each lifecycle pulse + each `agent-stuck` reaction lands in the chat. This
// gate keeps Telegram to events a human can act on, drops lifecycle pulses,
// never pings about a stuck *orchestrator* (false by definition — it conducts),
// throttles worker-stuck, and collapses duplicate (session, kind) bursts.
//
// Self-contained: the gate reads only fields already present on the event
// (`type`, `sessionId`, and `data.semanticType`), so the fix lives entirely in
// this plugin without touching the core.
// ---------------------------------------------------------------------------

/**
 * Semantic event types worth a Telegram ping. A reaction event carries its
 * underlying meaning in `data.semanticType` (e.g. `agent-stuck` → `session.stuck`,
 * `agent-needs-input` → `session.needs_input`), and direct events set
 * `semanticType` to their own type, so matching on the semantic type covers both
 * the raw event and the reaction that wraps it.
 */
const ACTIONABLE_TYPES: ReadonlySet<string> = new Set([
  // Session needs a human / finished / broke
  "session.needs_input",
  "session.errored",
  "session.exited",
  "session.killed",
  // Pull-request lifecycle
  "pr.created",
  "pr.merged",
  "pr.closed",
  // CI
  "ci.failing",
  "ci.fix_failed",
  // Reviews
  "review.pending",
  "review.changes_requested",
  "review.comments_unresolved",
  "automated_review.found",
  // Merge
  "merge.ready",
  "merge.conflicts",
  "merge.completed",
  // Aggregate / report
  "summary.all_complete",
  "report.no_acknowledge",
  "report.stale",
  "report.needs_input",
]);

/** The single noisy type that gets special handling (drop-for-orch, throttle-for-worker). */
const STUCK_TYPE = "session.stuck";

/** Collapse identical (session, kind) actionable events fired within this window. */
export const DEFAULT_DEDUP_WINDOW_MS = 60_000; // 1 minute
/** Rate-limit a worker's `stuck` pings to at most one per this window. */
export const DEFAULT_STUCK_THROTTLE_MS = 10 * 60_000; // 10 minutes

/**
 * Orchestrator sessions follow AO's id convention `<prefix>-orchestrator` (or the
 * numbered `<prefix>-orchestrator-<n>`). Detecting by suffix keeps the rule
 * portable across every project prefix with no hardcoded session id, mirroring
 * core's `isOrchestratorSession`.
 */
export function isOrchestratorSessionId(sessionId: string | undefined | null): boolean {
  if (!sessionId) return false;
  return /-orchestrator(?:-\d+)?$/.test(sessionId);
}

/**
 * Resolve the event's *semantic* type, preferring `data.semanticType` (which
 * unwraps reactions to the meaning they signal) and falling back to the raw
 * `event.type` when notification data is absent.
 */
export function effectiveType(event: OrchestratorEvent): string {
  const data = getNotificationDataV3(event.data);
  return data?.semanticType ?? event.type;
}

export type Classification = "actionable" | "stuck" | "drop";

/** Bucket an event by how Telegram should treat it. */
export function classify(event: OrchestratorEvent): Classification {
  const type = effectiveType(event);
  if (type === STUCK_TYPE) return "stuck";
  if (ACTIONABLE_TYPES.has(type)) return "actionable";
  return "drop";
}

export interface GateConfig {
  /** Override the dedup window (ms) for identical actionable events. */
  dedupWindowMs?: number;
  /** Override the throttle window (ms) for worker `stuck` pings. */
  stuckThrottleMs?: number;
}

export interface GateDecision {
  /** Whether the event should be delivered to Telegram. */
  send: boolean;
  /** Machine-readable reason (for debug logging when skipped). */
  reason:
    | "actionable"
    | "stuck"
    | "lifecycle"
    | "orchestrator-stuck"
    | "stuck-throttled"
    | "duplicate";
  /** The `${sessionId}::${kind}` key the decision keyed on. */
  key: string;
}

export interface NotificationGate {
  /** Decide whether `event` should be sent, given the current time `now` (ms). */
  evaluate(event: OrchestratorEvent, now: number): GateDecision;
}

function positiveOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Build a stateful gate. The returned gate holds a per-(session, kind) last-sent
 * clock so it can dedup bursts and throttle worker-stuck. One gate lives per
 * notifier instance (i.e. the daemon's lifetime).
 */
export function createNotificationGate(config: GateConfig = {}): NotificationGate {
  const dedupWindowMs = positiveOr(config.dedupWindowMs, DEFAULT_DEDUP_WINDOW_MS);
  const stuckThrottleMs = positiveOr(config.stuckThrottleMs, DEFAULT_STUCK_THROTTLE_MS);
  // last *delivered* timestamp per `${sessionId}::${kind}` — anchors the window
  // on the last send, not the last attempt, so a flood never resets the clock.
  const lastSent = new Map<string, number>();

  function withinWindow(key: string, now: number, windowMs: number): boolean {
    const prev = lastSent.get(key);
    return prev !== undefined && now - prev < windowMs;
  }

  return {
    evaluate(event, now): GateDecision {
      const type = effectiveType(event);
      const key = `${event.sessionId}::${type}`;
      const cls = classify(event);

      if (cls === "drop") {
        return { send: false, reason: "lifecycle", key };
      }

      if (cls === "stuck") {
        // The orchestrator is the conductor; a "stuck" verdict on it is a false
        // positive from the activity probe — never ping about it.
        if (isOrchestratorSessionId(event.sessionId)) {
          return { send: false, reason: "orchestrator-stuck", key };
        }
        if (withinWindow(key, now, stuckThrottleMs)) {
          return { send: false, reason: "stuck-throttled", key };
        }
        lastSent.set(key, now);
        return { send: true, reason: "stuck", key };
      }

      // actionable — collapse identical bursts inside the dedup window
      if (withinWindow(key, now, dedupWindowMs)) {
        return { send: false, reason: "duplicate", key };
      }
      lastSent.set(key, now);
      return { send: true, reason: "actionable", key };
    },
  };
}
