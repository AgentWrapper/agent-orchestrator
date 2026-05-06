import type { ActivityDetection, ActivitySignal, ActivitySignalSource, ActivityState } from "./types.js";

const TIMING_SENSITIVE_ACTIVITY_STATES: ReadonlySet<ActivityState> = new Set([
  "active",
  "ready",
  "idle",
  "blocked",
]);

const LIVENESS_ACTIVITY_STATES: ReadonlySet<ActivityState> = new Set(["active", "ready"]);
const IDLE_ACTIVITY_STATES: ReadonlySet<ActivityState> = new Set(["idle", "blocked"]);

export const ACTIVITY_STRONG_WINDOW_MS = 60_000;
export const ACTIVITY_WEAK_WINDOW_MS = 5 * 60_000;

export function summarizeActivityFreshness(
  timestamp: Date | undefined,
  now: Date = new Date(),
): "strong" | "weak" | "stale" | "none" {
  if (!timestamp) return "none";
  const ageMs = Math.max(0, now.getTime() - timestamp.getTime());
  if (ageMs <= ACTIVITY_STRONG_WINDOW_MS) return "strong";
  if (ageMs <= ACTIVITY_WEAK_WINDOW_MS) return "weak";
  return "stale";
}

export function createActivitySignal(
  state: ActivitySignal["state"],
  options: {
    activity?: ActivityState | null;
    timestamp?: Date;
    source?: ActivitySignalSource;
    detail?: string;
  } = {},
): ActivitySignal {
  return {
    state,
    activity: options.activity ?? null,
    timestamp: options.timestamp,
    source: options.source ?? "none",
    detail: options.detail,
  };
}

export function classifyActivitySignal(
  detection: ActivityDetection,
  source: ActivitySignalSource,
  now: Date = new Date(),
): ActivitySignal {
  if (!TIMING_SENSITIVE_ACTIVITY_STATES.has(detection.state)) {
    return createActivitySignal("valid", {
      activity: detection.state,
      timestamp: detection.timestamp,
      source,
    });
  }

  if (!detection.timestamp && IDLE_ACTIVITY_STATES.has(detection.state)) {
    return createActivitySignal("stale", {
      activity: detection.state,
      source,
      detail: "missing_timestamp",
    });
  }

  if (!detection.timestamp) {
    return createActivitySignal("valid", {
      activity: detection.state,
      source,
    });
  }

  if (
    LIVENESS_ACTIVITY_STATES.has(detection.state) &&
    summarizeActivityFreshness(detection.timestamp, now) === "stale"
  ) {
    return createActivitySignal("stale", {
      activity: detection.state,
      timestamp: detection.timestamp,
      source,
      detail: "stale_timestamp",
    });
  }

  return createActivitySignal("valid", {
    activity: detection.state,
    timestamp: detection.timestamp,
    source,
  });
}

export function hasPositiveIdleEvidence(signal: ActivitySignal): signal is ActivitySignal & {
  activity: "idle" | "blocked";
  timestamp: Date;
  state: "valid";
} {
  return (
    signal.state === "valid" &&
    signal.timestamp instanceof Date &&
    signal.activity !== null &&
    IDLE_ACTIVITY_STATES.has(signal.activity)
  );
}

export function supportsRecentLiveness(signal: ActivitySignal, now: Date = new Date()): boolean {
  return (
    signal.state === "valid" &&
    signal.timestamp instanceof Date &&
    signal.activity !== null &&
    LIVENESS_ACTIVITY_STATES.has(signal.activity) &&
    summarizeActivityFreshness(signal.timestamp, now) !== "stale"
  );
}

export function isWeakActivityEvidence(signal: ActivitySignal): boolean {
  return signal.state !== "valid";
}

export function formatActivitySignalEvidence(signal: ActivitySignal): string {
  const source = signal.source === "none" ? "" : ` via_${signal.source}`;
  const activity = signal.activity ? ` activity=${signal.activity}` : "";
  const timing = signal.timestamp ? ` at=${signal.timestamp.toISOString()}` : "";
  const detail = signal.detail ? ` detail=${signal.detail}` : "";
  return `activity_signal=${signal.state}${source}${activity}${timing}${detail}`;
}
