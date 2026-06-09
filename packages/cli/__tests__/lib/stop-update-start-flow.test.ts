/**
 * Integration test for the stop → simulated-update → start flow.
 *
 * Reproduces the user-observed bug from issue #1743 in a hermetic
 * environment: the test stages a `last-stop.json` exactly the way
 * `ao stop` would, simulates the only side effect `ao update`
 * legitimately has on this directory (i.e. none), and asserts that
 * `ao start`'s read of `last-stop.json` returns the expected record.
 *
 * The fallback path is also exercised: if the record is somehow
 * missing on the next `ao start`, `findRecentlyKilledSessions` must
 * synthesize a restore set from recent `manually_killed` sessions
 * exposed by the session manager.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CanonicalSessionLifecycle, Session, SessionManager } from "@aoagents/ao-core";

const testHome = join(process.cwd(), ".tmp-stop-update-start-home");

vi.mock("node:os", () => ({
  homedir: () => testHome,
}));

const NOW = Date.parse("2026-05-08T17:54:00.000Z");
const STOPPED_AT = "2026-05-08T17:53:15.909Z";

function makeLifecycle(
  state: CanonicalSessionLifecycle["session"]["state"],
  reason: CanonicalSessionLifecycle["session"]["reason"],
  terminatedAt: string | null,
): CanonicalSessionLifecycle {
  return {
    version: 2,
    session: {
      kind: "worker",
      state,
      reason,
      startedAt: null,
      completedAt: null,
      terminatedAt,
      lastTransitionAt: terminatedAt ?? "2026-05-08T17:00:00.000Z",
    },
    pr: { state: "none", reason: "not_created", number: null, url: null, lastObservedAt: null },
    runtime: {
      state: "missing",
      reason: "manual_kill_requested",
      lastObservedAt: null,
      handle: null,
      tmuxName: null,
    },
  };
}

function makeSession(id: string, projectId: string, lifecycle: CanonicalSessionLifecycle): Session {
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

describe("stop → update → start flow (issue #1743)", () => {
  beforeEach(() => {
    rmSync(testHome, { recursive: true, force: true });
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(testHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("ao stop's writeLastStop produces a file ao start can read back across a simulated update", async () => {
    const runningState = await import("../../src/lib/running-state.js");

    // 1. Simulate `ao stop` recording the active sessions.
    await runningState.writeLastStop({
      stoppedAt: STOPPED_AT,
      projectId: "agent-orchestrator",
      sessionIds: ["ao-170", "ao-171"],
    });

    const lastStopPath = join(testHome, ".agent-orchestrator", "last-stop.json");
    expect(existsSync(lastStopPath)).toBe(true);
    const beforeUpdate = readFileSync(lastStopPath, "utf-8");

    // 2. Simulate `ao update`. The current update command never touches
    //    ~/.agent-orchestrator/, so the only valid simulation is a
    //    no-op — anything else would be a regression. Verify the
    //    file's bytes are byte-for-byte identical afterwards.
    //    (We deliberately add a few unrelated state mutations to make
    //    sure the simulated update only affects what it should.)
    mkdirSync(join(testHome, ".agent-orchestrator", "fake-update-marker"), { recursive: true });
    writeFileSync(
      join(testHome, ".agent-orchestrator", "fake-update-marker", "version"),
      "0.6.0\n",
    );

    const afterUpdate = readFileSync(lastStopPath, "utf-8");
    expect(afterUpdate).toBe(beforeUpdate);

    // 3. Simulate `ao start` reading the record back.
    const restored = await runningState.readLastStop();
    expect(restored).toEqual({
      stoppedAt: STOPPED_AT,
      projectId: "agent-orchestrator",
      sessionIds: ["ao-170", "ao-171"],
    });
  });

  it("ao start's fallback finds recently manually-killed sessions when last-stop.json is missing", async () => {
    // No last-stop.json exists — this is the failure mode reported in
    // the bug. The fallback should still surface the killed sessions
    // so the user gets a restore prompt.
    const stateDir = join(testHome, ".agent-orchestrator");
    mkdirSync(stateDir, { recursive: true });
    expect(existsSync(join(stateDir, "last-stop.json"))).toBe(false);

    const fallback = await import("../../src/lib/last-stop-fallback.js");
    const sessions: Session[] = [
      makeSession(
        "ao-170",
        "agent-orchestrator",
        makeLifecycle("terminated", "manually_killed", "2026-05-08T17:53:15.909Z"),
      ),
      makeSession(
        "ao-171",
        "agent-orchestrator",
        makeLifecycle("terminated", "manually_killed", "2026-05-08T17:53:16.728Z"),
      ),
    ];
    const fakeSm = {
      list: vi.fn(async () => sessions),
    } as unknown as SessionManager;

    const result = await fallback.findRecentlyKilledSessions(fakeSm, "agent-orchestrator", {
      now: NOW,
    });
    expect(result).not.toBeNull();
    expect(result?.projectId).toBe("agent-orchestrator");
    expect(result?.sessionIds).toEqual(expect.arrayContaining(["ao-170", "ao-171"]));
  });
});
