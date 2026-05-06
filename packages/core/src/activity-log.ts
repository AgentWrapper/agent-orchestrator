/**
 * Activity JSONL log — shared utilities for agents that don't have native JSONL.
 *
 * Agents like Aider and OpenCode use this to write activity observations
 * (derived from terminal output) to `{workspacePath}/.ao/activity.jsonl`.
 * Their `getActivityState()` then reads from this file, enabling detection
 * of states like `waiting_input` and `blocked` that terminal-only parsing
 * couldn't surface through the deprecated `detectActivity()` path.
 *
 * Agents with native JSONL (Claude Code, Codex) don't use this — they read
 * richer data directly from their own session files.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { ActivityState, ActivityLogEntry, ActivityDetection } from "./types.js";

/**
 * Maximum age (ms) for `waiting_input`/`blocked` entries before they're
 * considered stale. If no new terminal output overwrites the entry within
 * this window, the state falls through to downstream fallbacks instead of
 * keeping the session stuck in `needs_input` on the dashboard forever.
 */
export const ACTIVITY_INPUT_STALENESS_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get the path to the activity JSONL log for a session.
 * Location: `{workspacePath}/.ao/activity.jsonl`
 */
export function getActivityLogPath(workspacePath: string): string {
  return join(workspacePath, ".ao", "activity.jsonl");
}

/**
 * Append an activity observation to the session's JSONL log.
 * Creates the `.ao/` directory if it doesn't exist.
 */
export async function appendActivityEntry(
  workspacePath: string,
  state: ActivityState,
  source: "terminal" | "native",
  trigger?: string,
): Promise<void> {
  const logPath = getActivityLogPath(workspacePath);
  await mkdir(dirname(logPath), { recursive: true });

  const entry: ActivityLogEntry = {
    ts: new Date().toISOString(),
    state,
    source,
    ...(trigger !== undefined &&
      (state === "waiting_input" || state === "blocked") && { trigger }),
  };

  await appendFile(logPath, JSON.stringify(entry) + "\n", "utf-8");
}

/**
 * Read the last activity entry from the session's JSONL log.
 * Returns the parsed entry with the file's modification time, or null if
 * the file doesn't exist or is empty.
 */
export async function readLastActivityEntry(
  workspacePath: string,
): Promise<{ entry: ActivityLogEntry; modifiedAt: Date } | null> {
  const logPath = getActivityLogPath(workspacePath);

  try {
    const { open } = await import("node:fs/promises");
    const handle = await open(logPath, "r");
    try {
      const fileStat = await handle.stat();
      if (fileStat.size === 0) return null;

      // Read last 4KB — more than enough for a single JSON line
      const tailSize = Math.min(fileStat.size, 4096);
      const offset = Math.max(0, fileStat.size - tailSize);
      const buffer = Buffer.alloc(tailSize);
      const { bytesRead } = await handle.read(buffer, 0, tailSize, offset);
      if (bytesRead === 0) return null;
      const content = buffer.subarray(0, bytesRead).toString("utf-8");

      // Find the last non-empty line. If we read from a non-zero offset,
      // the first line may be truncated — drop it.
      let lines = content.split("\n").filter((l) => l.trim());
      if (offset > 0 && lines.length > 1) lines = lines.slice(1);
      if (lines.length === 0) return null;

      // Try lines from the end — skip any that fail to parse (e.g. truncated)
      let parsed: unknown = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          parsed = JSON.parse(lines[i]!);
          break;
        } catch {
          continue;
        }
      }
      if (parsed === null) return null;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

      const record = parsed as Record<string, unknown>;
      const validStates = new Set(["active", "ready", "idle", "waiting_input", "blocked", "exited"]);
      const validSources = new Set(["terminal", "native"]);
      if (
        typeof record.ts !== "string" ||
        typeof record.state !== "string" ||
        typeof record.source !== "string" ||
        !validStates.has(record.state) ||
        !validSources.has(record.source)
      ) {
        return null;
      }

      const entry: ActivityLogEntry = {
        ts: record.ts,
        state: record.state as ActivityLogEntry["state"],
        source: record.source as ActivityLogEntry["source"],
        ...(typeof record.trigger === "string" && { trigger: record.trigger }),
      };
      return { entry, modifiedAt: fileStat.mtime };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/**
 * Check the AO activity JSONL for actionable states only.
 *
 * Only returns `waiting_input`/`blocked` (with a staleness cap).
 * Non-critical states (`active`, `ready`, `idle`) always return `null` so
 * callers fall through to their native signals (git commits, chat history,
 * API queries, native JSONL). This prevents the lifecycle manager's
 * `recordActivity` writes (which refresh `mtime` every poll cycle) from
 * shadowing those richer detection methods and breaking stuck-detection.
 */
export function checkActivityLogState(
  activityResult: { entry: ActivityLogEntry; modifiedAt: Date } | null,
): ActivityDetection | null {
  if (!activityResult) return null;

  const { entry } = activityResult;

  if (entry.state === "waiting_input" || entry.state === "blocked") {
    // Use the entry's own timestamp for staleness — not file mtime, which
    // gets refreshed every poll cycle by recordActivity and would prevent
    // stale entries from ever being detected.
    const entryTs = new Date(entry.ts);
    if (Number.isNaN(entryTs.getTime())) return null;
    const ageMs = Date.now() - entryTs.getTime();
    if (ageMs <= ACTIVITY_INPUT_STALENESS_MS) {
      return { state: entry.state, timestamp: entryTs };
    }
  }

  // Non-critical states and stale entries — fall through to native signals
  return null;
}

/**
 * Derive an activity state from the JSONL entry with age-based decay.
 *
 * Unlike `checkActivityLogState` (which only returns actionable states),
 * this returns any state — but reclassifies `active`/`ready` entries as
 * `ready`/`idle` if they've aged past the active window / threshold.
 * Use this as a last-resort fallback when native signals are unavailable.
 */
export function getActivityFallbackState(
  activityResult: { entry: ActivityLogEntry; modifiedAt: Date } | null,
  activeWindowMs: number,
  thresholdMs: number,
): ActivityDetection | null {
  if (!activityResult) return null;

  const { entry } = activityResult;
  const entryTs = new Date(entry.ts);
  if (Number.isNaN(entryTs.getTime())) return null;

  // Actionable states use the same staleness cap as checkActivityLogState.
  // If the entry is stale, fall through to age-based decay instead of
  // re-surfacing a waiting_input/blocked that checkActivityLogState already filtered.
  if (entry.state === "waiting_input" || entry.state === "blocked") {
    const ageMs = Date.now() - entryTs.getTime();
    if (ageMs <= ACTIVITY_INPUT_STALENESS_MS) {
      return { state: entry.state, timestamp: entryTs };
    }
    // Stale actionable entry — treat as idle
    return { state: "idle", timestamp: entryTs };
  }

  // Age-based decay: active→ready→idle, but never promote past the
  // entry's detected state (e.g. a fresh "idle" entry stays "idle").
  const ageMs = Math.max(0, Date.now() - entryTs.getTime());
  let ageState: ActivityState;
  if (ageMs <= activeWindowMs) ageState = "active";
  else if (ageMs <= thresholdMs) ageState = "ready";
  else ageState = "idle";

  const activityRank: Record<string, number> = { active: 0, ready: 1, idle: 2 };
  const entryRank = activityRank[entry.state] ?? 2;
  const ageRank = activityRank[ageState] ?? 2;
  const finalState = ageRank >= entryRank ? ageState : entry.state;

  return { state: finalState, timestamp: entryTs };
}

/**
 * Build the arguments for `appendActivityEntry` from terminal output.
 *
 * Classifies terminal output via the provided `detectActivity` function and
 * returns the state + trigger. Plugins call `appendActivityEntry` themselves
 * (keeping it mockable in tests).
 */
export function classifyTerminalActivity(
  terminalOutput: string,
  detectActivity: (output: string) => ActivityState,
): { state: ActivityState; trigger: string | undefined } {
  const state = detectActivity(terminalOutput);
  const trigger =
    state === "waiting_input" || state === "blocked"
      ? terminalOutput.trim().split("\n").slice(-3).join("\n")
      : undefined;
  return { state, trigger };
}

/**
 * Shared `recordActivity` implementation for all agents.
 *
 * Classifies terminal output, deduplicates writes (skips when the state
 * hasn't changed and the last entry is recent), and appends to the JSONL.
 * Actionable states (waiting_input/blocked) always write immediately.
 */
export async function recordTerminalActivity(
  workspacePath: string,
  terminalOutput: string,
  detectActivity: (output: string) => ActivityState,
): Promise<void> {
  const { state, trigger } = classifyTerminalActivity(terminalOutput, detectActivity);

  // Deduplicate writes to reduce I/O. Skip when the state hasn't changed
  // and the last entry is recent (<20s). Actionable states always write.
  if (state !== "waiting_input" && state !== "blocked") {
    const lastEntry = await readLastActivityEntry(workspacePath);
    if (lastEntry && lastEntry.entry.state === state) {
      const entryAgeMs = Date.now() - lastEntry.modifiedAt.getTime();
      if (entryAgeMs < 20_000) return;
    }
  }

  await appendActivityEntry(workspacePath, state, "terminal", trigger);
}
