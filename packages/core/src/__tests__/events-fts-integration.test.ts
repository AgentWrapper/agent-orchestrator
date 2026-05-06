/**
 * Integration test for FTS5 search using a real in-memory SQLite database.
 * Verifies that the FTS virtual table, triggers, and MATCH query actually work.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";

// We need a real better-sqlite3 instance for this test.
// If it's not available, skip.
let Database: (new (path: string) => any) | null = null;
try {
  const require = createRequire(import.meta.url);
  Database = require("better-sqlite3") as new (path: string) => any;
} catch {
  // better-sqlite3 unavailable — integration tests will be skipped
}

// Mock events-db to inject our real in-memory DB
vi.mock("../events-db.js", () => ({
  getDb: vi.fn(),
  isActivityEventsFtsEnabled: vi.fn(() => true),
}));

import * as eventsDb from "../events-db.js";
import { recordActivityEvent } from "../activity-events.js";
import { searchActivityEvents, queryActivityEvents } from "../query-activity-events.js";

function openMemoryDb(): any {
  if (!Database) throw new Error("better-sqlite3 not available");
  const db = new (Database as any)(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ts_epoch   INTEGER NOT NULL,
      ts         TEXT NOT NULL,
      project_id TEXT,
      session_id TEXT,
      source     TEXT NOT NULL,
      type       TEXT NOT NULL,
      log_level  TEXT NOT NULL DEFAULT 'info',
      summary    TEXT NOT NULL,
      data       TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS activity_events_fts USING fts5(
      summary, data,
      content='activity_events',
      content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS activity_events_ai
      AFTER INSERT ON activity_events
    BEGIN
      INSERT INTO activity_events_fts(rowid, summary, data)
        VALUES (new.id, new.summary, new.data);
    END;
    CREATE TRIGGER IF NOT EXISTS activity_events_ad
      AFTER DELETE ON activity_events
    BEGIN
      INSERT INTO activity_events_fts(activity_events_fts, rowid, summary, data)
        VALUES ('delete', old.id, old.summary, old.data);
    END;
    CREATE TRIGGER IF NOT EXISTS activity_events_au
      AFTER UPDATE ON activity_events
    BEGIN
      INSERT INTO activity_events_fts(activity_events_fts, rowid, summary, data)
        VALUES ('delete', old.id, old.summary, old.data);
      INSERT INTO activity_events_fts(rowid, summary, data)
        VALUES (new.id, new.summary, new.data);
    END;
    CREATE INDEX IF NOT EXISTS idx_ae_ts      ON activity_events(ts_epoch);
    CREATE INDEX IF NOT EXISTS idx_ae_session ON activity_events(session_id);
    CREATE INDEX IF NOT EXISTS idx_ae_project ON activity_events(project_id);
    CREATE INDEX IF NOT EXISTS idx_ae_type    ON activity_events(type);
    CREATE INDEX IF NOT EXISTS idx_ae_source  ON activity_events(source);
    PRAGMA user_version = 1;
  `);
  return db;
}

const itIfAvailable = Database ? it : it.skip;

describe("FTS5 integration (real SQLite)", () => {
  let db: ReturnType<typeof openMemoryDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    if (!Database) return;
    db = openMemoryDb();
    vi.mocked(eventsDb.getDb).mockReturnValue(db as any);
  });

  itIfAvailable("inserts and FTS-searches events end-to-end", () => {
    recordActivityEvent({
      source: "session-manager",
      kind: "session.spawned",
      summary: "spawned agent for feature-branch",
      data: { agent: "claude-code", branch: "feat/my-feature" },
    });
    recordActivityEvent({
      source: "lifecycle",
      kind: "lifecycle.transition",
      summary: "working → pr_open",
      data: { from: "working", to: "pr_open" },
    });

    const results = searchActivityEvents("spawned");
    expect(results).toHaveLength(1);
    expect(results[0]!.kind).toBe("session.spawned");
    expect(results[0]!.summary).toContain("spawned");
  });

  itIfAvailable("FTS search finds terms in data field", () => {
    recordActivityEvent({
      source: "session-manager",
      kind: "session.spawned",
      summary: "spawned",
      data: { agent: "claude-code", branch: "feat/my-feature" },
    });

    const results = searchActivityEvents("claude");
    expect(results).toHaveLength(1);
  });

  itIfAvailable("FTS search returns [] for non-matching term", () => {
    recordActivityEvent({
      source: "lifecycle",
      kind: "lifecycle.transition",
      summary: "working → pr_open",
    });

    const results = searchActivityEvents("nonexistentterm12345");
    expect(results).toHaveLength(0);
  });

  itIfAvailable("FTS search filters by projectId in SQL (before LIMIT)", () => {
    recordActivityEvent({
      projectId: "proj-a",
      source: "lifecycle",
      kind: "session.spawned",
      summary: "spawned in proj-a",
    });
    recordActivityEvent({
      projectId: "proj-b",
      source: "lifecycle",
      kind: "session.spawned",
      summary: "spawned in proj-b",
    });

    const results = searchActivityEvents("spawned", "proj-a");
    expect(results).toHaveLength(1);
    expect(results[0]!.projectId).toBe("proj-a");
  });

  itIfAvailable("queryActivityEvents returns events with epoch filter", () => {
    const past = Date.now() - 60_000;
    db.prepare(
      `INSERT INTO activity_events (ts_epoch, ts, source, type, log_level, summary)
       VALUES (?, ?, 'lifecycle', 'session.spawned', 'info', 'old event')`,
    ).run(past, new Date(past).toISOString());

    recordActivityEvent({
      source: "lifecycle",
      kind: "session.spawned",
      summary: "new event",
    });

    const recent = queryActivityEvents({ since: new Date(Date.now() - 1000) });
    expect(recent.length).toBeGreaterThanOrEqual(1);
    expect(recent.some((e) => e.summary === "new event")).toBe(true);
    expect(recent.every((e) => e.summary !== "old event")).toBe(true);
  });
});
