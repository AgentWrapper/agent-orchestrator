import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { applyAgentReport } from "../agent-report.js";
import { writeMetadata, writeCanonicalLifecycle } from "../metadata.js";
import { createInitialCanonicalLifecycle } from "../lifecycle-state.js";
import { recordActivityEvent } from "../activity-events.js";

vi.mock("../activity-events.js", () => ({
  recordActivityEvent: vi.fn(),
}));

let dataDir: string;
let sessionId: string;

beforeEach(() => {
  dataDir = join(tmpdir(), `ao-test-agent-report-events-${randomUUID()}`);
  mkdirSync(dataDir, { recursive: true });
  sessionId = "ao-1";
  vi.mocked(recordActivityEvent).mockClear();
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("activity events: agent-report", () => {
  it("emits api.agent_report.transition_rejected when the transition is invalid", () => {
    const lifecycle = createInitialCanonicalLifecycle("worker");
    lifecycle.session.state = "terminated";
    writeMetadata(dataDir, sessionId, {
      worktree: "/tmp/worktree",
      branch: "feat/x",
      status: "terminated",
      project: "demo",
    });
    writeCanonicalLifecycle(dataDir, sessionId, lifecycle);

    expect(() =>
      applyAgentReport(dataDir, sessionId, {
        state: "working",
        now: new Date(),
      }),
    ).toThrow();

    const calls = vi.mocked(recordActivityEvent).mock.calls.map((c) => c[0]);
    const rejected = calls.find((c) => c.kind === "api.agent_report.transition_rejected");
    expect(rejected).toBeDefined();
    expect(rejected?.sessionId).toBe(sessionId);
    expect(rejected?.source).toBe("api");
  });

  it("does not emit transition_rejected on a valid transition", () => {
    const lifecycle = createInitialCanonicalLifecycle("worker");
    lifecycle.session.state = "working";
    lifecycle.session.reason = "task_in_progress";
    lifecycle.session.startedAt = "2024-12-01T00:00:00.000Z";
    lifecycle.runtime.state = "alive";
    lifecycle.runtime.reason = "process_running";
    writeMetadata(dataDir, sessionId, {
      worktree: "/tmp/worktree",
      branch: "feat/x",
      status: "working",
      project: "demo",
    });
    writeCanonicalLifecycle(dataDir, sessionId, lifecycle);

    applyAgentReport(dataDir, sessionId, {
      state: "needs_input",
      now: new Date(),
    });

    const calls = vi.mocked(recordActivityEvent).mock.calls.map((c) => c[0]);
    expect(calls.find((c) => c.kind === "api.agent_report.transition_rejected")).toBeUndefined();
  });
});
