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
export type ActivityEventSource =
  | "lifecycle"
  | "session-manager"
  | "api"
  | "ui"
  | "scm"
  | "runtime"
  | "agent"
  | "reaction"
  | "report-watcher";

export type ActivityEventKind =
  | "session.spawn_started"
  | "session.spawned"
  | "session.spawn_failed"
  | "session.killed"
  | "activity.transition"
  | "lifecycle.transition"
  | "ci.failing"
  | "review.pending"
  // Lifecycle-manager plugin-call failures
  | "scm.batch_enrich_failed"
  | "scm.detect_pr_succeeded"
  | "scm.detect_pr_failed"
  | "scm.review_fetch_failed"
  | "scm.poll_pr_failed"
  | "runtime.probe_failed"
  | "agent.process_probe_failed"
  | "agent.activity_probe_failed"
  // Reaction lifecycle
  | "reaction.escalated"
  | "reaction.send_to_agent_failed"
  | "reaction.action_succeeded"
  // Auto-cleanup + poll cycle
  | "session.auto_cleanup_deferred"
  | "session.auto_cleanup_completed"
  | "session.auto_cleanup_failed"
  | "lifecycle.poll_failed"
  | "detecting.escalated"
  // Report watcher
  | "report_watcher.triggered";

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
// URL credentials: https://token@host or http://user:pass@host.
// Linear scan — find :// then scan forward for the next @ before a path
// separator or whitespace. O(n) worst case, no regex backtracking, no length
// limits. Replaces the previous CREDENTIAL_URL_RE which either ReDoS'd
// (unbounded quantifier) or missed >200-char userinfo (bounded quantifier).
function redactCredentialUrls(input: string): string {
  let result = input;
  let offset = 0;
  while (offset < result.length) {
    const proto = result.indexOf("://", offset);
    if (proto === -1) break;
    // Only match http:// or https:// (case-insensitive, matching old /gi flag)
    if (proto < 4) { offset = proto + 3; continue; }
    const schemeEnd = result.slice(Math.max(0, proto - 5), proto).toLowerCase();
    if (!schemeEnd.endsWith("http") && !schemeEnd.endsWith("https")) {
      offset = proto + 3;
      continue;
    }

    let cursor = proto + 3;
    while (cursor < result.length) {
      const ch = result.charCodeAt(cursor);
      // Space/control chars or '/' mean no '@' is coming in userinfo
      if (ch <= 0x20 || ch === 0x2F) break;
      if (ch === 0x40) {
        // '@' found — redact everything between :// and @
        // Lowercase the scheme to match the old /gi regex behavior
        const before = result.slice(0, proto + 3).toLowerCase();
        const suffix = result.slice(cursor);
        result = before + "[redacted]" + suffix;
        offset = proto + 3 + "[redacted]".length + 1;
        break;
      }
      cursor++;
    }
    // No '@' found — not a credential URL, move past this ://
    if (cursor >= result.length || result.charCodeAt(cursor) <= 0x20 || result.charCodeAt(cursor) === 0x2F) {
      offset = proto + 3;
    }
  }
  return result;
}

// Per-string-value cap. The whole-data 16 KB cap still applies on top of this;
// truncating individual strings limits blast radius if a pattern below misses a
// new token format and a long error message gets pasted in.
const STRING_VALUE_MAX_CHARS = 500;

// Token-shape patterns matched against ANY string value, not just keys.
// Order: more-specific first. Replacement strings preserve the prefix where
// the prefix itself is informative (e.g. "Bearer [redacted]" so RCA can still
// see this was a bearer-auth failure).
//
// SENSITIVE_KEY_RE above redacts entire values under sensitive *key* names;
// these patterns redact token-shaped *substrings* anywhere — including under
// keys like `message` and `errorMessage`, which are the leak vector flagged
// in PR #1620 review (data column is FTS5-indexed in events-db.ts).
const TOKEN_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Bearer auth headers (also catches JWTs prefixed with Bearer)
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer [redacted]"],
  // GitHub Personal Access Tokens — classic (ghp_/gho_/ghu_/ghs_/ghr_)
  [/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[redacted]"],
  // GitHub fine-grained PATs
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[redacted]"],
  // OpenAI / Anthropic sk- keys (incl. sk-proj-, sk-svcacct-, sk-ant-)
  [/\bsk-(?:ant-)?(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}\b/g, "[redacted]"],
  // Slack tokens (xoxb-, xoxp-, xoxa-, xoxr-, xoxs-)
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[redacted]"],
  // AWS access key IDs (16 trailing chars exactly per AWS spec)
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]"],
  // JWTs — three base64url segments, eyJ prefix on header
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted]"],
  // ENV-style assignments: MY_API_TOKEN=value, GITHUB_SECRET=..., etc.
  // Scoped to ALL_CAPS keys containing a sensitive word so prose like
  // "the message=hello" doesn't redact.
  [
    /\b([A-Z][A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|AUTHORIZATION|COOKIE|API_KEY|APIKEY)[A-Z0-9_]*)=([^\s"'`]{6,})/g,
    "$1=[redacted]",
  ],
];

function sanitizeString(value: string): string {
  let cleaned = redactCredentialUrls(value);
  for (const [pattern, replacement] of TOKEN_PATTERNS) {
    cleaned = cleaned.replace(pattern, replacement);
  }
  if (cleaned.length > STRING_VALUE_MAX_CHARS) {
    cleaned = `${cleaned.slice(0, STRING_VALUE_MAX_CHARS - 3)}...`;
  }
  return cleaned;
}

function sanitizeValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return sanitizeString(value);
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
