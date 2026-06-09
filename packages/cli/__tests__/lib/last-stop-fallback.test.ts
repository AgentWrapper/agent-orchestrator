/**
 * Tests for the `last-stop.json` missing/malformed fallback in
 * `ao start`. See issue #1743 — without this fallback, a single
 * regression in the last-stop write pipeline silently drops the
 * restore prompt.
 */

import { describe, it, expect } from "vitest";
import type { CanonicalSessionLifecycle, Session } from "@aoagents/ao-core";
import {
  buildLastStopFallback,
  FALLBACK_RECENT_WINDOW_MS,
} from "../../src/lib/last-stop-fallback.js";

const NOW = Date.parse("2026-05-08T18:00:00.000Z");

function makeLifecycle(
  state: CanonicalSessionLifecycle["session"]["state"],
  reason: CanonicalSessionLifecycle["session"]["reason"],
  terminatedAtIso: string | null,
): CanonicalSessionLifecycle {
  return {
    version: 2,
    session: {
      kind: "worker",
      state,
      reason,
      startedAt: null,
      completedAt: null,
      terminatedAt: terminatedAtIso,
      lastTransitionAt: terminatedAtIso ?? "2026-05-08T17:00:00.000Z",
    },
    pr: { state: "none", reason: "not_created", number: null, url: null, lastObservedAt: null },
    runtime: { state: "missing", reason: "manual_kill_requested", lastObservedAt: null, handle: null, tmuxName: null },
  };
}

function makeSession(
  id: string,
  projectId: string,
  lifecycle: CanonicalSessionLifecycle,
): Session {
  return {
    id,
    projectId,
    status: lifecycle.session.state === "terminated" ? "killed" : "working",
    activity: lifecycle.session.state === "terminated" ? "exited" : null,
    activitySignal: { state: "unavailable", activity: null, source: "none" },
    lifecycle,
    branch: null,
    issueId: null,
    pr: null,
    workspacePath: null,
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(NOW - 60_000),
    lastActivityAt: new Date(NOW - 30_000),
    metadata: {},
  };
}

describe("last-stop-fallback", () => {
  it("returns null when there are no manually-killed sessions in the window", () => {
    const sessions: Session[] = [
      // Wrong reason — auto cleanup, not the user's `ao stop`
      makeSession(
        "s1",
        "my-app",
        makeLifecycle("terminated", "auto_cleanup", new Date(NOW - 60_000).toISOString()),
      ),
      // Killed too long ago (> 10 min)
      makeSession(
        "s2",
        "my-app",
        makeLifecycle(
          "terminated",
          "manually_killed",
          new Date(NOW - FALLBACK_RECENT_WINDOW_MS - 60_000).toISOString(),
        ),
      ),
      // Still alive
      makeSession(
        "s3",
        "my-app",
        makeLifecycle("working", "task_in_progress", null),
      ),
    ];

    const result = buildLastStopFallback(sessions, "my-app", { now: NOW });
    expect(result).toBeNull();
  });

  it("surfaces recently manually-killed sessions in the primary project", () => {
    const t1 = new Date(NOW - 30_000).toISOString();
    const t2 = new Date(NOW - 60_000).toISOString();
    const sessions: Session[] = [
      makeSession("s1", "my-app", makeLifecycle("terminated", "manually_killed", t1)),
      makeSession("s2", "my-app", makeLifecycle("terminated", "manually_killed", t2)),
      // Different project — goes to otherProjects.
      makeSession(
        "s3",
        "other-app",
        makeLifecycle("terminated", "manually_killed", new Date(NOW - 90_000).toISOString()),
      ),
    ];

    const result = buildLastStopFallback(sessions, "my-app", { now: NOW });
    expect(result).not.toBeNull();
    expect(result?.projectId).toBe("my-app");
    expect(result?.sessionIds).toEqual(expect.arrayContaining(["s1", "s2"]));
    expect(result?.sessionIds).toHaveLength(2);
    // Most recent terminatedAt becomes stoppedAt so the prompt's "stopped at"
    // string is meaningful.
    expect(result?.stoppedAt).toBe(t1);
    expect(result?.otherProjects).toEqual([
      { projectId: "other-app", sessionIds: ["s3"] },
    ]);
  });

  it("surfaces other-project sessions even when the primary project has none", () => {
    const sessions: Session[] = [
      makeSession(
        "s1",
        "other-app",
        makeLifecycle(
          "terminated",
          "manually_killed",
          new Date(NOW - 30_000).toISOString(),
        ),
      ),
    ];

    const result = buildLastStopFallback(sessions, "my-app", { now: NOW });
    expect(result).not.toBeNull();
    expect(result?.projectId).toBe("my-app");
    expect(result?.sessionIds).toEqual([]);
    expect(result?.otherProjects).toEqual([
      { projectId: "other-app", sessionIds: ["s1"] },
    ]);
  });

  it("ignores sessions with missing or unparseable terminatedAt", () => {
    const sessions: Session[] = [
      makeSession("s1", "my-app", makeLifecycle("terminated", "manually_killed", null)),
      makeSession(
        "s2",
        "my-app",
        makeLifecycle("terminated", "manually_killed", "not-an-iso-date"),
      ),
    ];

    const result = buildLastStopFallback(sessions, "my-app", { now: NOW });
    expect(result).toBeNull();
  });

  it("respects a custom window", () => {
    const sessions: Session[] = [
      makeSession(
        "s1",
        "my-app",
        makeLifecycle(
          "terminated",
          "manually_killed",
          new Date(NOW - 5 * 60 * 1000).toISOString(),
        ),
      ),
    ];

    // Default window includes it.
    expect(buildLastStopFallback(sessions, "my-app", { now: NOW })).not.toBeNull();
    // 1-minute window excludes it.
    expect(
      buildLastStopFallback(sessions, "my-app", { now: NOW, windowMs: 60_000 }),
    ).toBeNull();
  });
});
