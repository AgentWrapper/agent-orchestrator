import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../events-db.js", () => ({
  getDb: vi.fn(),
  isActivityEventsFtsEnabled: vi.fn(() => true),
}));
vi.mock("../activity-events.js", async (importOriginal) => {
  const mod = await (importOriginal as () => Promise<any>)();
  return { ...mod, droppedEventCount: () => 0 };
});

import { queryActivityEvents, searchActivityEvents, getActivityEventStats } from "../query-activity-events.js";
import * as eventsDb from "../events-db.js";

const sampleRow = {
  id: 1,
  ts_epoch: Date.now(),
  ts: new Date().toISOString(),
  project_id: "proj-1",
  session_id: "sess-1",
  source: "lifecycle",
  type: "lifecycle.transition",
  log_level: "info",
  summary: "working → pr_open",
  data: JSON.stringify({ from: "working", to: "pr_open" }),
};

function makeDb(rows: unknown[] = [sampleRow]) {
  return {
    prepare: () => ({
      all: (..._args: unknown[]) => rows,
      run: () => {},
    }),
  };
}

describe("queryActivityEvents", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns [] when DB is null", () => {
    vi.mocked(eventsDb.getDb).mockReturnValue(null);
    expect(queryActivityEvents()).toEqual([]);
  });

  it("maps rows to ActivityEvent shape", () => {
    vi.mocked(eventsDb.getDb).mockReturnValue(makeDb() as any);
    const results = queryActivityEvents();
    expect(results).toHaveLength(1);
    expect(results[0]!.kind).toBe("lifecycle.transition");
    expect(results[0]!.projectId).toBe("proj-1");
  });

  it("clamps limit to max 1000", () => {
    let capturedSql = "";
    const captureDb = {
      prepare: (sql: string) => {
        capturedSql = sql;
        return { all: () => [] };
      },
    };
    vi.mocked(eventsDb.getDb).mockReturnValue(captureDb as any);
    queryActivityEvents({ limit: 9999 });
    expect(capturedSql).toContain("LIMIT ?");
  });

  it("returns [] on DB error", () => {
    const badDb = {
      prepare: () => ({
        all: () => {
          throw new Error("disk error");
        },
      }),
    };
    vi.mocked(eventsDb.getDb).mockReturnValue(badDb as any);
    expect(queryActivityEvents()).toEqual([]);
  });
});

describe("searchActivityEvents", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns [] for empty query", () => {
    vi.mocked(eventsDb.getDb).mockReturnValue(makeDb() as any);
    expect(searchActivityEvents("")).toEqual([]);
    expect(searchActivityEvents("   ")).toEqual([]);
  });

  it("sanitizes query — only word characters reach FTS", () => {
    let capturedFtsQuery = "";
    const captureDb = {
      prepare: () => ({
        all: (q: string) => {
          capturedFtsQuery = q;
          return [];
        },
      }),
    };
    vi.mocked(eventsDb.getDb).mockReturnValue(captureDb as any);
    searchActivityEvents("spawn; DROP TABLE activity_events--");
    // SQL injection stripped; only word tokens joined by AND
    expect(capturedFtsQuery).toBe('"spawn" AND "DROP" AND "TABLE" AND "activity_events"');
  });

  it("returns [] when DB is null", () => {
    vi.mocked(eventsDb.getDb).mockReturnValue(null);
    expect(searchActivityEvents("spawned")).toEqual([]);
  });

  it("uses a bounded LIKE fallback when FTS is unavailable", () => {
    let capturedSql = "";
    let capturedArgs: unknown[] = [];
    const captureDb = {
      prepare: (sql: string) => {
        capturedSql = sql;
        return {
          all: (...args: unknown[]) => {
            capturedArgs = args;
            return [sampleRow];
          },
        };
      },
    };
    vi.mocked(eventsDb.getDb).mockReturnValue(captureDb as any);
    vi.mocked(eventsDb.isActivityEventsFtsEnabled).mockReturnValueOnce(false);

    const results = searchActivityEvents("spawn failed", "proj-1", 10);

    expect(results).toHaveLength(1);
    expect(capturedSql).toContain("LIKE");
    expect(capturedSql).toContain("ae.project_id = ?");
    expect(capturedArgs).toEqual(["%spawn failed%", "%spawn failed%", "proj-1", 10]);
  });
});

describe("getActivityEventStats", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns null when DB is null", () => {
    vi.mocked(eventsDb.getDb).mockReturnValue(null);
    expect(getActivityEventStats()).toBeNull();
  });

  it("aggregates byKind and bySource", () => {
    let callCount = 0;
    const stubDb = {
      prepare: () => ({
        all: () => {
          callCount++;
          if (callCount === 1) return [{ cnt: 5 }]; // total
          if (callCount === 2)
            return [
              { type: "lifecycle.transition", cnt: 3 },
              { type: "session.spawned", cnt: 2 },
            ];
          if (callCount === 3)
            return [
              { source: "lifecycle", cnt: 4 },
              { source: "session-manager", cnt: 1 },
            ];
          return [{ oldest: "2026-01-01T00:00:00Z", newest: "2026-04-27T00:00:00Z" }];
        },
      }),
    };
    vi.mocked(eventsDb.getDb).mockReturnValue(stubDb as any);
    const stats = getActivityEventStats();
    expect(stats).not.toBeNull();
    expect(stats!.total).toBe(5);
    expect(stats!.byKind["lifecycle.transition"]).toBe(3);
    expect(stats!.bySource["lifecycle"]).toBe(4);
  });
});
