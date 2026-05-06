import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// Mock events-db before importing activity-events so getDb is controllable
vi.mock("../events-db.js", () => {
  const rows: unknown[] = [];
  const mockDb = {
    prepare: (sql: string) => ({
      run: (..._args: unknown[]) => {
        if (sql.includes("INSERT INTO activity_events")) {
          rows.push(_args);
        }
      },
      all: () => [],
    }),
  };
  return {
    getDb: vi.fn(() => mockDb),
    __rows: rows,
  };
});

import { recordActivityEvent, droppedEventCount } from "../activity-events.js";
import * as eventsDb from "../events-db.js";

describe("recordActivityEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("inserts an event when DB is available", () => {
    recordActivityEvent({
      projectId: "proj-1",
      sessionId: "sess-1",
      source: "lifecycle",
      kind: "lifecycle.transition",
      summary: "working → pr_open",
      data: { from: "working", to: "pr_open" },
    });
    // getDb was called
    expect(eventsDb.getDb).toHaveBeenCalled();
  });

  it("increments droppedEventCount when DB returns null", () => {
    const before = droppedEventCount();
    vi.mocked(eventsDb.getDb).mockReturnValueOnce(null);
    recordActivityEvent({
      source: "lifecycle",
      kind: "session.spawned",
      summary: "spawned: sess-x",
    });
    expect(droppedEventCount()).toBe(before + 1);
  });

  it("never throws even if prepare throws", () => {
    const badDb = {
      prepare: () => {
        throw new Error("disk full");
      },
    };
    vi.mocked(eventsDb.getDb).mockReturnValueOnce(badDb as any);
    expect(() =>
      recordActivityEvent({
        source: "session-manager",
        kind: "session.killed",
        summary: "killed: sess-1",
      }),
    ).not.toThrow();
  });

  it("never throws even if data sanitization throws", () => {
    const data = {};
    Object.defineProperty(data, "bad", {
      enumerable: true,
      get: () => {
        throw new Error("getter failed");
      },
    });

    expect(() =>
      recordActivityEvent({
        source: "session-manager",
        kind: "session.spawned",
        summary: "spawned",
        data,
      }),
    ).not.toThrow();
  });

  it("sanitizes sensitive data keys", () => {
    let capturedData: unknown;
    const captureDb = {
      prepare: (_sql: string) => ({
        run: (...args: unknown[]) => {
          capturedData = args[8]; // data is 9th param (index 8)
        },
        all: () => [],
      }),
    };
    vi.mocked(eventsDb.getDb).mockReturnValueOnce(captureDb as any);
    recordActivityEvent({
      source: "lifecycle",
      kind: "session.spawned",
      summary: "spawned",
      data: { token: "secret123", agent: "claude-code" },
    });
    const parsed = JSON.parse(capturedData as string);
    expect(parsed["token"]).toBe("[redacted]");
    expect(parsed["agent"]).toBe("claude-code");
  });

  it("sanitizes nested sensitive data keys and credential URLs", () => {
    let capturedData: unknown;
    const captureDb = {
      prepare: (_sql: string) => ({
        run: (...args: unknown[]) => {
          capturedData = args[8];
        },
        all: () => [],
      }),
    };
    vi.mocked(eventsDb.getDb).mockReturnValueOnce(captureDb as any);
    recordActivityEvent({
      source: "lifecycle",
      kind: "session.spawned",
      summary: "spawned",
      data: {
        request: {
          headers: {
            authorization: "Bearer ghp_secret",
            url: "HTTPS://token@example.com/path",
          },
        },
      },
    });
    const parsed = JSON.parse(capturedData as string);
    expect(parsed["request"]["headers"]["authorization"]).toBe("[redacted]");
    expect(parsed["request"]["headers"]["url"]).toBe("https://[redacted]@example.com/path");
  });

  it("preserves error messages that mention sensitive words in values", () => {
    // Greptile flagged this as a bug: values like "token expired" or
    // "authorization header missing" would be redacted. They are not —
    // SENSITIVE_KEY_RE only matches key names, not string values.
    let capturedData: unknown;
    const captureDb = {
      prepare: (_sql: string) => ({
        run: (...args: unknown[]) => {
          capturedData = args[8];
        },
        all: () => [],
      }),
    };
    vi.mocked(eventsDb.getDb).mockReturnValueOnce(captureDb as any);
    recordActivityEvent({
      source: "session-manager",
      kind: "session.spawn_failed",
      summary: "spawn failed",
      data: {
        reason: "token expired",
        message: "authorization header missing",
        agent: "claude-code",
      },
    });
    const parsed = JSON.parse(capturedData as string);
    expect(parsed["reason"]).toBe("token expired");
    expect(parsed["message"]).toBe("authorization header missing");
    expect(parsed["agent"]).toBe("claude-code");
  });

  it("handles BigInt in data without throwing", () => {
    let capturedData: unknown;
    const captureDb = {
      prepare: (_sql: string) => ({
        run: (...args: unknown[]) => {
          capturedData = args[8];
        },
        all: () => [],
      }),
    };
    vi.mocked(eventsDb.getDb).mockReturnValueOnce(captureDb as any);
    expect(() =>
      recordActivityEvent({
        source: "lifecycle",
        kind: "session.spawned",
        summary: "spawned",
        data: { big: BigInt(9007199254740991) as any },
      }),
    ).not.toThrow();
    expect(typeof capturedData).toBe("string");
  });

  it("truncates summary to 500 chars", () => {
    let capturedSummary: unknown;
    const captureDb = {
      prepare: (_sql: string) => ({
        run: (...args: unknown[]) => {
          capturedSummary = args[7]; // summary is 8th param (index 7)
        },
        all: () => [],
      }),
    };
    vi.mocked(eventsDb.getDb).mockReturnValueOnce(captureDb as any);
    const longSummary = "x".repeat(600);
    recordActivityEvent({
      source: "lifecycle",
      kind: "lifecycle.transition",
      summary: longSummary,
    });
    expect((capturedSummary as string).length).toBe(500);
    expect(capturedSummary).toMatch(/\.\.\.$/);
  });
});
