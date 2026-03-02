import { describe, it, expect } from "vitest";
import { toSSEEntry, entryEquals, computeDiff } from "../sse-diff";
import type { DashboardSession, SSESessionEntry } from "../types";

function makeDashboardSession(overrides: Partial<DashboardSession> & { id: string }): DashboardSession {
  return {
    projectId: "my-app",
    status: "working",
    activity: "active",
    branch: null,
    issueId: null,
    issueUrl: null,
    issueLabel: null,
    issueTitle: null,
    summary: null,
    summaryIsFallback: false,
    createdAt: "2025-01-01T00:00:00.000Z",
    lastActivityAt: "2025-01-01T00:00:00.000Z",
    pr: null,
    metadata: {},
    ...overrides,
  };
}

function makeEntry(overrides: Partial<SSESessionEntry> & { id: string }): SSESessionEntry {
  return {
    status: "working",
    activity: "active",
    attentionLevel: "working",
    lastActivityAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("toSSEEntry", () => {
  it("extracts lightweight fields from a dashboard session", () => {
    const session = makeDashboardSession({
      id: "app-1",
      status: "working",
      activity: "active",
      lastActivityAt: "2025-06-01T12:00:00.000Z",
    });
    const entry = toSSEEntry(session);
    expect(entry.id).toBe("app-1");
    expect(entry.status).toBe("working");
    expect(entry.activity).toBe("active");
    expect(entry.attentionLevel).toBe("working");
    expect(entry.lastActivityAt).toBe("2025-06-01T12:00:00.000Z");
  });

  it("computes attentionLevel from session state", () => {
    const killed = makeDashboardSession({ id: "app-1", status: "killed", activity: "exited" });
    expect(toSSEEntry(killed).attentionLevel).toBe("done");

    const mergeable = makeDashboardSession({ id: "app-2", status: "mergeable", activity: "idle" });
    expect(toSSEEntry(mergeable).attentionLevel).toBe("merge");

    const errored = makeDashboardSession({ id: "app-3", status: "errored", activity: "blocked" });
    expect(toSSEEntry(errored).attentionLevel).toBe("respond");
  });
});

describe("entryEquals", () => {
  it("returns true for identical entries", () => {
    const a = makeEntry({ id: "app-1" });
    const b = makeEntry({ id: "app-1" });
    expect(entryEquals(a, b)).toBe(true);
  });

  it("returns false when status differs", () => {
    const a = makeEntry({ id: "app-1", status: "working" });
    const b = makeEntry({ id: "app-1", status: "pr_open" });
    expect(entryEquals(a, b)).toBe(false);
  });

  it("returns false when activity differs", () => {
    const a = makeEntry({ id: "app-1", activity: "active" });
    const b = makeEntry({ id: "app-1", activity: "idle" });
    expect(entryEquals(a, b)).toBe(false);
  });

  it("returns false when attentionLevel differs", () => {
    const a = makeEntry({ id: "app-1", attentionLevel: "working" });
    const b = makeEntry({ id: "app-1", attentionLevel: "respond" });
    expect(entryEquals(a, b)).toBe(false);
  });

  it("returns false when lastActivityAt differs", () => {
    const a = makeEntry({ id: "app-1", lastActivityAt: "2025-01-01T00:00:00.000Z" });
    const b = makeEntry({ id: "app-1", lastActivityAt: "2025-01-01T00:05:00.000Z" });
    expect(entryEquals(a, b)).toBe(false);
  });

  it("handles null activity correctly", () => {
    const a = makeEntry({ id: "app-1", activity: null });
    const b = makeEntry({ id: "app-1", activity: null });
    expect(entryEquals(a, b)).toBe(true);

    const c = makeEntry({ id: "app-1", activity: "active" });
    expect(entryEquals(a, c)).toBe(false);
  });
});

describe("computeDiff", () => {
  it("returns null when nothing changed", () => {
    const entries = [
      makeEntry({ id: "app-1" }),
      makeEntry({ id: "app-2" }),
    ];
    const prev = new Map(entries.map((e) => [e.id, e]));
    const diff = computeDiff(prev, entries);
    expect(diff).toBeNull();
  });

  it("detects updated sessions", () => {
    const prev = new Map([
      ["app-1", makeEntry({ id: "app-1", status: "working" })],
      ["app-2", makeEntry({ id: "app-2", status: "working" })],
    ]);
    const current = [
      makeEntry({ id: "app-1", status: "pr_open" }), // changed
      makeEntry({ id: "app-2", status: "working" }),  // unchanged
    ];
    const diff = computeDiff(prev, current);
    expect(diff).not.toBeNull();
    expect(diff!.updated).toHaveLength(1);
    expect(diff!.updated[0].id).toBe("app-1");
    expect(diff!.updated[0].status).toBe("pr_open");
    expect(diff!.removed).toHaveLength(0);
  });

  it("detects removed sessions", () => {
    const prev = new Map([
      ["app-1", makeEntry({ id: "app-1" })],
      ["app-2", makeEntry({ id: "app-2" })],
    ]);
    const current = [
      makeEntry({ id: "app-1" }), // still present
      // app-2 is gone
    ];
    const diff = computeDiff(prev, current);
    expect(diff).not.toBeNull();
    expect(diff!.updated).toHaveLength(0);
    expect(diff!.removed).toEqual(["app-2"]);
  });

  it("detects newly added sessions", () => {
    const prev = new Map([
      ["app-1", makeEntry({ id: "app-1" })],
    ]);
    const current = [
      makeEntry({ id: "app-1" }),
      makeEntry({ id: "app-2" }), // new
    ];
    const diff = computeDiff(prev, current);
    expect(diff).not.toBeNull();
    expect(diff!.updated).toHaveLength(1);
    expect(diff!.updated[0].id).toBe("app-2");
    expect(diff!.removed).toHaveLength(0);
  });

  it("handles simultaneous adds, updates, and removes", () => {
    const prev = new Map([
      ["app-1", makeEntry({ id: "app-1", status: "working" })],
      ["app-2", makeEntry({ id: "app-2", status: "working" })],
      ["app-3", makeEntry({ id: "app-3", status: "killed", attentionLevel: "done" })],
    ]);
    const current = [
      makeEntry({ id: "app-1", status: "pr_open" }),  // updated
      // app-2 removed
      makeEntry({ id: "app-3", status: "killed", attentionLevel: "done" }), // unchanged
      makeEntry({ id: "app-4", status: "spawning", attentionLevel: "working" }), // added
    ];
    const diff = computeDiff(prev, current);
    expect(diff).not.toBeNull();
    expect(diff!.updated.map((u) => u.id).sort()).toEqual(["app-1", "app-4"]);
    expect(diff!.removed).toEqual(["app-2"]);
  });

  it("returns null for empty previous and empty current", () => {
    const diff = computeDiff(new Map(), []);
    expect(diff).toBeNull();
  });

  it("detects all entries as new when previous is empty", () => {
    const current = [
      makeEntry({ id: "app-1" }),
      makeEntry({ id: "app-2" }),
    ];
    const diff = computeDiff(new Map(), current);
    expect(diff).not.toBeNull();
    expect(diff!.updated).toHaveLength(2);
    expect(diff!.removed).toHaveLength(0);
  });

  it("detects all entries as removed when current is empty", () => {
    const prev = new Map([
      ["app-1", makeEntry({ id: "app-1" })],
      ["app-2", makeEntry({ id: "app-2" })],
    ]);
    const diff = computeDiff(prev, []);
    expect(diff).not.toBeNull();
    expect(diff!.updated).toHaveLength(0);
    expect(diff!.removed).toEqual(["app-1", "app-2"]);
  });
});
