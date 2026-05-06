/**
 * Activity event logging — read API.
 *
 * queryActivityEvents: structured filter-based retrieval.
 * searchActivityEvents: FTS5 natural-language search.
 * getActivityEventStats: aggregate counts for `ao events stats`.
 */

import { getDb, isActivityEventsFtsEnabled } from "./events-db.js";
import {
  droppedEventCount,
  type ActivityEvent,
  type ActivityEventKind,
  type ActivityEventSource,
  type ActivityEventLevel,
} from "./activity-events.js";

export interface ActivityEventFilter {
  projectId?: string;
  sessionId?: string;
  kind?: ActivityEventKind | string;
  source?: ActivityEventSource;
  level?: ActivityEventLevel;
  since?: Date;
  until?: Date;
  limit?: number;
}

export interface ActivityEventStats {
  total: number;
  byKind: Record<string, number>;
  bySource: Record<string, number>;
  droppedThisProcess: number;
  oldestTs?: string;
  newestTs?: string;
}

function rowToEvent(row: Record<string, unknown>): ActivityEvent {
  return {
    id: row["id"] as number,
    tsEpoch: row["ts_epoch"] as number,
    ts: row["ts"] as string,
    projectId: (row["project_id"] as string | null) ?? null,
    sessionId: (row["session_id"] as string | null) ?? null,
    source: row["source"] as string,
    kind: row["type"] as string,
    level: row["log_level"] as string,
    summary: row["summary"] as string,
    data: (row["data"] as string | null) ?? null,
    rank: typeof row["rank"] === "number" ? (row["rank"] as number) : undefined,
  };
}

function escapeLike(raw: string): string {
  return raw.replace(/[\\%_]/g, "\\$&");
}

/**
 * Query events with structured filters. Returns [] if DB is unavailable.
 */
export function queryActivityEvents(filter: ActivityEventFilter = {}): ActivityEvent[] {
  const db = getDb();
  if (!db) return [];

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter.projectId) {
    conditions.push("project_id = ?");
    params.push(filter.projectId);
  }
  if (filter.sessionId) {
    conditions.push("session_id = ?");
    params.push(filter.sessionId);
  }
  if (filter.kind) {
    conditions.push("type = ?");
    params.push(filter.kind);
  }
  if (filter.source) {
    conditions.push("source = ?");
    params.push(filter.source);
  }
  if (filter.level) {
    conditions.push("log_level = ?");
    params.push(filter.level);
  }
  if (filter.since) {
    conditions.push("ts_epoch >= ?");
    params.push(filter.since.getTime());
  }
  if (filter.until) {
    conditions.push("ts_epoch <= ?");
    params.push(filter.until.getTime());
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rawLimit = filter.limit ?? 100;
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 1000)) : 100;

  try {
    const rows = db
      .prepare(`SELECT * FROM activity_events ${where} ORDER BY ts_epoch DESC LIMIT ?`)
      .all(...params, limit) as Record<string, unknown>[];
    return rows.map(rowToEvent);
  } catch {
    return [];
  }
}

/**
 * FTS5 natural-language search. Sanitizes the query to prevent injection.
 * Returns [] if DB is unavailable or search fails.
 * projectId filter is pushed into SQL so it applies before the LIMIT.
 */
export function searchActivityEvents(rawQuery: string, projectId?: string, limit = 100): ActivityEvent[] {
  const db = getDb();
  if (!db) return [];

  // Only allow word characters; join with AND to prevent FTS syntax injection
  const tokens = rawQuery.match(/\w+/g);
  if (!tokens || tokens.length === 0) return [];
  const ftsQuery = tokens.map((t) => `"${t}"`).join(" AND ");

  const projectFilter = projectId ? "AND ae.project_id = ?" : "";
  const clampedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 1000)) : 100;
  const params: unknown[] = [];
  if (projectId) params.push(projectId);
  params.push(clampedLimit);

  try {
    if (!isActivityEventsFtsEnabled()) {
      const likePattern = `%${escapeLike(tokens.join(" "))}%`;
      const fallbackParams: unknown[] = [likePattern, likePattern];
      if (projectId) fallbackParams.push(projectId);
      fallbackParams.push(clampedLimit);
      const rows = db
        .prepare(
          `SELECT ae.*, NULL AS rank FROM activity_events ae
           WHERE (ae.summary LIKE ? ESCAPE '\\' OR ae.data LIKE ? ESCAPE '\\') ${projectFilter}
           ORDER BY ae.ts_epoch DESC
           LIMIT ?`,
        )
        .all(...fallbackParams) as Record<string, unknown>[];
      return rows.map(rowToEvent);
    }

    params.unshift(ftsQuery);
    const rows = db
      .prepare(
        `SELECT ae.*, activity_events_fts.rank AS rank FROM activity_events ae
         JOIN activity_events_fts ON activity_events_fts.rowid = ae.id
         WHERE activity_events_fts MATCH ? ${projectFilter}
         ORDER BY activity_events_fts.rank
         LIMIT ?`,
      )
      .all(...params) as Record<string, unknown>[];
    return rows.map(rowToEvent);
  } catch {
    return [];
  }
}

/**
 * Aggregate stats for `ao events stats`. Returns null if DB is unavailable.
 */
export function getActivityEventStats(): ActivityEventStats | null {
  const db = getDb();
  if (!db) return null;

  try {
    const totalRow = db.prepare("SELECT COUNT(*) as cnt FROM activity_events").all() as Record<
      string,
      unknown
    >[];
    const total = (totalRow[0]?.["cnt"] as number) ?? 0;

    const byKindRows = db
      .prepare("SELECT type, COUNT(*) as cnt FROM activity_events GROUP BY type")
      .all() as Record<string, unknown>[];
    const byKind: Record<string, number> = {};
    for (const row of byKindRows) {
      byKind[row["type"] as string] = row["cnt"] as number;
    }

    const bySourceRows = db
      .prepare("SELECT source, COUNT(*) as cnt FROM activity_events GROUP BY source")
      .all() as Record<string, unknown>[];
    const bySource: Record<string, number> = {};
    for (const row of bySourceRows) {
      bySource[row["source"] as string] = row["cnt"] as number;
    }

    const rangeRow = db
      .prepare("SELECT MIN(ts) as oldest, MAX(ts) as newest FROM activity_events")
      .all() as Record<string, unknown>[];

    return {
      total,
      byKind,
      bySource,
      droppedThisProcess: droppedEventCount(),
      oldestTs: (rangeRow[0]?.["oldest"] as string | null) ?? undefined,
      newestTs: (rangeRow[0]?.["newest"] as string | null) ?? undefined,
    };
  } catch {
    return null;
  }
}

export type { ActivityEvent, ActivityEventKind, ActivityEventSource, ActivityEventLevel };
