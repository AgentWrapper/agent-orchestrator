/**
 * Activity event logging — write API.
 *
 * recordActivityEvent() is synchronous and best-effort: it never throws.
 * If the DB is unavailable or a write fails, the event is dropped and
 * droppedEventCount is incremented.
 *
 * droppedEventCount is process-local. Events dropped in other processes
 * (web server, lifecycle manager) are not reflected here.
 */

import { getDb } from "./events-db.js";

// Distinct names to avoid collision with types.ts EventType / EventSource.
export type ActivityEventSource = "lifecycle" | "session-manager" | "api" | "ui";

export type ActivityEventKind =
  | "session.spawn_started"
  | "session.spawned"
  | "session.spawn_failed"
  | "session.killed"
  | "activity.transition"
  | "lifecycle.transition"
  | "ci.failing"
  | "review.pending";

export type ActivityEventLevel = "debug" | "info" | "warn" | "error";

export interface ActivityEventInput {
  projectId?: string;
  sessionId?: string;
  source: ActivityEventSource | string;
  kind: ActivityEventKind | string;
  level?: ActivityEventLevel;
  summary: string;
  data?: Record<string, unknown>;
}

export interface ActivityEvent {
  id: number;
  tsEpoch: number;
  ts: string;
  projectId: string | null;
  sessionId: string | null;
  source: string;
  kind: string;
  level: string;
  summary: string;
  data: string | null;
  rank?: number;
}

let _droppedEventCount = 0;
let _lastPruneMs = 0;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const PRUNE_BATCH_SIZE = 1000;

/** Number of events dropped due to DB errors in this process. */
export function droppedEventCount(): number {
  return _droppedEventCount;
}

function pruneOldEvents(db: ReturnType<typeof getDb>, cutoff: number): void {
  db
    ?.prepare(
      `DELETE FROM activity_events
       WHERE rowid IN (
         SELECT rowid FROM activity_events WHERE ts_epoch < ? LIMIT ?
       )`,
    )
    .run(cutoff, PRUNE_BATCH_SIZE);
}

// Patterns that indicate sensitive field names
const SENSITIVE_KEY_RE = /token|password|secret|authorization|cookie|api[-_]?key/i;
// URL credentials: https://token@host or http://user:pass@host
const CREDENTIAL_URL_RE = /https?:\/\/[^@\s]+@/gi;

function sanitizeValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value.replace(CREDENTIAL_URL_RE, "https://[redacted]@");
  if (value === null || typeof value !== "object") return value;

  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, seen));
  }

  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    cleaned[k] = SENSITIVE_KEY_RE.test(k) ? "[redacted]" : sanitizeValue(v, seen);
  }
  return cleaned;
}

function sanitizeData(data: Record<string, unknown>): string | undefined {
  const cleaned = sanitizeValue(data, new WeakSet<object>());

  let json: string;
  try {
    json = JSON.stringify(cleaned);
  } catch {
    return undefined;
  }

  // Reject if over 16 KB after sanitization (slicing would produce malformed JSON)
  if (json.length > 16 * 1024) {
    return undefined;
  }
  return json;
}

function sanitizeSummary(summary: string): string {
  if (summary.length <= 500) return summary;
  return `${summary.slice(0, 497)}...`;
}

/**
 * Record an activity event. Synchronous, best-effort — never throws.
 */
export function recordActivityEvent(event: ActivityEventInput): void {
  try {
    const db = getDb();
    if (!db) {
      _droppedEventCount++;
      return;
    }

    const now = Date.now();
    const ts = new Date(now).toISOString();
    const summary = sanitizeSummary(event.summary);
    const data = event.data ? sanitizeData(event.data) : undefined;

    db.prepare(
      `INSERT INTO activity_events
        (ts_epoch, ts, project_id, session_id, source, type, log_level, summary, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      now,
      ts,
      event.projectId ?? null,
      event.sessionId ?? null,
      event.source,
      event.kind,
      event.level ?? "info",
      summary,
      data ?? null,
    );
    // Periodically purge old events so long-lived processes don't grow the DB indefinitely
    if (now - _lastPruneMs >= PRUNE_INTERVAL_MS) {
      _lastPruneMs = now;
      pruneOldEvents(db, now - RETENTION_MS);
    }
  } catch {
    _droppedEventCount++;
  }
}
