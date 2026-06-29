/**
 * Durable state for the scheduled-tasks daemon.
 *
 * Persists each job's `nextDueAt` / `lastFiredAt` / `spent` to a single JSON file
 * under the AO home (`~/.agent-orchestrator/scheduler-state.json`). This is what
 * makes the scheduler survive daemon restarts without re-firing an already-fired
 * slot (anti-double-fire). The firing decision itself lives in
 * `evaluateScheduledJob` (scheduled-tasks.ts); this module is just load/save.
 *
 * FAIL-SOFT: a missing or corrupt state file resets to empty rather than
 * throwing — a bad state file must not wedge the daemon (worst case a job is
 * re-seeded and skips one slot).
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAoBaseDir } from "./paths.js";
import { atomicWriteFileSync } from "./atomic-write.js";
import type { ScheduledJobState } from "./scheduled-tasks.js";

export interface SchedulerState {
  version: 1;
  /** Keyed by {@link jobStateKey}: `<projectId>::<taskName>`. */
  jobs: Record<string, ScheduledJobState>;
}

/** Default location of the scheduler state file. */
export function getSchedulerStatePath(): string {
  return join(getAoBaseDir(), "scheduler-state.json");
}

/** Stable per-job key. Scopes by project so two projects can share a task name. */
export function jobStateKey(projectId: string, taskName: string): string {
  return `${projectId}::${taskName}`;
}

function emptyState(): SchedulerState {
  return { version: 1, jobs: {} };
}

function isJobState(value: unknown): value is ScheduledJobState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.nextDueAt === undefined || typeof v.nextDueAt === "string") &&
    (v.lastFiredAt === undefined || typeof v.lastFiredAt === "string") &&
    (v.spent === undefined || typeof v.spent === "boolean")
  );
}

/** Load scheduler state. Returns an empty state on missing/corrupt file. */
export function loadSchedulerState(path: string = getSchedulerStatePath()): SchedulerState {
  if (!existsSync(path)) return emptyState();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return emptyState();
    const raw = parsed as Record<string, unknown>;
    if (raw.version !== 1 || typeof raw.jobs !== "object" || raw.jobs === null) return emptyState();

    const jobs: Record<string, ScheduledJobState> = {};
    for (const [key, value] of Object.entries(raw.jobs as Record<string, unknown>)) {
      if (isJobState(value)) jobs[key] = value;
    }
    return { version: 1, jobs };
  } catch {
    return emptyState();
  }
}

/** Persist scheduler state atomically (creates the AO home dir if needed). */
export function saveSchedulerState(
  state: SchedulerState,
  path: string = getSchedulerStatePath(),
): void {
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, JSON.stringify(state, null, 2));
}
