/**
 * SSE diff computation utilities.
 *
 * Extracts lightweight session entries from dashboard sessions and computes
 * incremental diffs between successive snapshots so the SSE endpoint only
 * sends changed data to connected clients.
 */

import { getAttentionLevel, type DashboardSession, type SSESessionEntry } from "./types";

/** Extract the lightweight SSE fields from a dashboard session. */
export function toSSEEntry(s: DashboardSession): SSESessionEntry {
  return {
    id: s.id,
    status: s.status,
    activity: s.activity,
    attentionLevel: getAttentionLevel(s),
    lastActivityAt: s.lastActivityAt,
  };
}

/** Check whether two SSE session entries are identical. */
export function entryEquals(a: SSESessionEntry, b: SSESessionEntry): boolean {
  return (
    a.status === b.status &&
    a.activity === b.activity &&
    a.attentionLevel === b.attentionLevel &&
    a.lastActivityAt === b.lastActivityAt
  );
}

/** Result of computing a diff between two snapshots. */
export interface SnapshotDiff {
  updated: SSESessionEntry[];
  removed: string[];
}

/**
 * Compute the diff between a previous snapshot and the current entries.
 * Returns updated/added entries and IDs of removed sessions.
 * Returns null if nothing changed (callers can skip sending an event).
 */
export function computeDiff(
  prev: Map<string, SSESessionEntry>,
  current: SSESessionEntry[],
): SnapshotDiff | null {
  const currentIds = new Set(current.map((e) => e.id));

  // Find updated/added sessions
  const updated: SSESessionEntry[] = [];
  for (const entry of current) {
    const prevEntry = prev.get(entry.id);
    if (!prevEntry || !entryEquals(prevEntry, entry)) {
      updated.push(entry);
    }
  }

  // Find removed sessions (present in previous snapshot but not current)
  const removed: string[] = [];
  for (const id of prev.keys()) {
    if (!currentIds.has(id)) {
      removed.push(id);
    }
  }

  if (updated.length === 0 && removed.length === 0) {
    return null;
  }

  return { updated, removed };
}
