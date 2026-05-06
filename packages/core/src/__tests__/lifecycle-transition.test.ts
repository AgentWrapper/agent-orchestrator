import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyLifecycleDecision,
  applyDecisionToLifecycle,
  buildTransitionMetadataPatch,
  createStateTransitionDecision,
} from "../lifecycle-transition.js";
import { createInitialCanonicalLifecycle } from "../lifecycle-state.js";
import { readMetadataRaw } from "../metadata.js";
import type { LifecycleDecision } from "../lifecycle-status-decisions.js";
import type { CanonicalSessionLifecycle } from "../types.js";

describe("applyDecisionToLifecycle", () => {
  let lifecycle: CanonicalSessionLifecycle;
  const nowIso = "2026-04-17T12:00:00.000Z";

  beforeEach(() => {
    lifecycle = createInitialCanonicalLifecycle("worker");
  });

  it("applies session state and reason", () => {
    const decision: LifecycleDecision = {
      status: "working",
      evidence: "test",
      detecting: { attempts: 0 },
      sessionState: "working",
      sessionReason: "task_in_progress",
    };

    applyDecisionToLifecycle(lifecycle, decision, nowIso);

    expect(lifecycle.session.state).toBe("working");
    expect(lifecycle.session.reason).toBe("task_in_progress");
    expect(lifecycle.session.lastTransitionAt).toBe(nowIso);
  });

  it("sets startedAt when transitioning to working", () => {
    expect(lifecycle.session.startedAt).toBeNull();

    const decision: LifecycleDecision = {
      status: "working",
      evidence: "test",
      detecting: { attempts: 0 },
      sessionState: "working",
      sessionReason: "task_in_progress",
    };

    applyDecisionToLifecycle(lifecycle, decision, nowIso);

    expect(lifecycle.session.startedAt).toBe(nowIso);
  });

  it("does not overwrite startedAt if already set", () => {
    lifecycle.session.startedAt = "2026-04-16T12:00:00.000Z";

    const decision: LifecycleDecision = {
      status: "working",
      evidence: "test",
      detecting: { attempts: 0 },
      sessionState: "working",
      sessionReason: "task_in_progress",
    };

    applyDecisionToLifecycle(lifecycle, decision, nowIso);

    expect(lifecycle.session.startedAt).toBe("2026-04-16T12:00:00.000Z");
  });

  it("sets completedAt when transitioning to done", () => {
    const decision: LifecycleDecision = {
      status: "done",
      evidence: "test",
      detecting: { attempts: 0 },
      sessionState: "done",
      sessionReason: "research_complete",
    };

    applyDecisionToLifecycle(lifecycle, decision, nowIso);

    expect(lifecycle.session.completedAt).toBe(nowIso);
  });

  it("sets terminatedAt when transitioning to terminated", () => {
    const decision: LifecycleDecision = {
      status: "terminated",
      evidence: "test",
      detecting: { attempts: 0 },
      sessionState: "terminated",
      sessionReason: "manually_killed",
    };

    applyDecisionToLifecycle(lifecycle, decision, nowIso);

    expect(lifecycle.session.terminatedAt).toBe(nowIso);
  });

  it("does not overwrite completedAt if already set", () => {
    lifecycle.session.completedAt = "2026-04-16T12:00:00.000Z";

    const decision: LifecycleDecision = {
      status: "done",
      evidence: "test",
      detecting: { attempts: 0 },
      sessionState: "done",
      sessionReason: "research_complete",
    };

    applyDecisionToLifecycle(lifecycle, decision, nowIso);

    expect(lifecycle.session.completedAt).toBe("2026-04-16T12:00:00.000Z");
  });

  it("does not overwrite terminatedAt if already set", () => {
    lifecycle.session.terminatedAt = "2026-04-16T12:00:00.000Z";

    const decision: LifecycleDecision = {
      status: "terminated",
      evidence: "test",
      detecting: { attempts: 0 },
      sessionState: "terminated",
      sessionReason: "manually_killed",
    };

    applyDecisionToLifecycle(lifecycle, decision, nowIso);

    expect(lifecycle.session.terminatedAt).toBe("2026-04-16T12:00:00.000Z");
  });

  it("applies PR state and reason", () => {
    const decision: LifecycleDecision = {
      status: "pr_open",
      evidence: "test",
      detecting: { attempts: 0 },
      prState: "open",
      prReason: "in_progress",
    };

    applyDecisionToLifecycle(lifecycle, decision, nowIso);

    expect(lifecycle.pr.state).toBe("open");
    expect(lifecycle.pr.reason).toBe("in_progress");
    expect(lifecycle.pr.lastObservedAt).toBe(nowIso);
  });
});

describe("buildTransitionMetadataPatch", () => {
  it("includes lifecycle evidence and detecting metadata", () => {
    const lifecycle = createInitialCanonicalLifecycle("worker");
    const decision: LifecycleDecision = {
      status: "detecting",
      evidence: "probe_failed",
      detecting: { attempts: 2, startedAt: "2026-04-17T11:55:00.000Z", evidenceHash: "abc123def456" },
      sessionState: "detecting",
      sessionReason: "probe_failure",
    };

    const patch = buildTransitionMetadataPatch(lifecycle, decision);

    expect(patch["lifecycleEvidence"]).toBe("probe_failed");
    expect(patch["detectingAttempts"]).toBe("2");
    expect(patch["detectingStartedAt"]).toBe("2026-04-17T11:55:00.000Z");
    expect(patch["detectingEvidenceHash"]).toBe("abc123def456");
  });

  it("clears detecting metadata when not detecting", () => {
    const lifecycle = createInitialCanonicalLifecycle("worker");
    const decision: LifecycleDecision = {
      status: "working",
      evidence: "active",
      detecting: { attempts: 0 },
      sessionState: "working",
      sessionReason: "task_in_progress",
    };

    const patch = buildTransitionMetadataPatch(lifecycle, decision);

    expect(patch["detectingAttempts"]).toBe("");
    expect(patch["detectingStartedAt"]).toBe("");
    expect(patch["detectingEvidenceHash"]).toBe("");
  });

  it("includes lifecycle in the patch", () => {
    const lifecycle = createInitialCanonicalLifecycle("worker");
    const decision: LifecycleDecision = {
      status: "working",
      evidence: "test",
      detecting: { attempts: 0 },
    };

    const patch = buildTransitionMetadataPatch(lifecycle, decision);

    expect(patch["lifecycle"]).toBeDefined();
    expect(JSON.parse(patch["lifecycle"])).toHaveProperty("version", 2);
  });

  it("clears stale PR, runtime, and role metadata when lifecycle no longer carries them", () => {
    const lifecycle = createInitialCanonicalLifecycle("worker");
    const decision: LifecycleDecision = {
      status: "working",
      evidence: "active",
      detecting: { attempts: 0 },
      sessionState: "working",
      sessionReason: "task_in_progress",
    };

    const patch = buildTransitionMetadataPatch(lifecycle, decision);

    expect(patch["pr"]).toBe("");
    expect(patch["runtimeHandle"]).toBe("");
    expect(patch["tmuxName"]).toBe("");
    expect(patch["role"]).toBe("");
  });
});

describe("applyLifecycleDecision (integration)", () => {
  let testDir: string;
  let dataDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `lifecycle-transition-test-${Date.now()}`);
    dataDir = join(testDir, "sessions");
    mkdirSync(dataDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function writeTestSession(sessionId: string, metadata: Record<string, string>) {
    writeFileSync(join(dataDir, `${sessionId}.json`), JSON.stringify(metadata));
  }

  it("returns failure when session not found", () => {
    const result = applyLifecycleDecision({
      dataDir,
      sessionId: "nonexistent",
      decision: {
        status: "working",
        evidence: "test",
        detecting: { attempts: 0 },
      },
      source: "poll",
    });

    expect(result.success).toBe(false);
    expect(result.rejectionReason).toContain("Session not found");
  });

  it("applies decision and persists metadata", () => {
    writeTestSession("test-1", {
      status: "spawning",
      worktree: "/tmp/test",
      branch: "main",
    });

    const result = applyLifecycleDecision({
      dataDir,
      sessionId: "test-1",
      decision: {
        status: "working",
        evidence: "agent_started",
        detecting: { attempts: 0 },
        sessionState: "working",
        sessionReason: "task_in_progress",
      },
      source: "poll",
    });

    expect(result.success).toBe(true);
    expect(result.previousStatus).toBe("spawning");
    expect(result.nextStatus).toBe("working");
    expect(result.statusChanged).toBe(true);

    const meta = readMetadataRaw(dataDir, "test-1");
    expect(meta?.["status"]).toBe("working");
    expect(meta?.["lifecycleEvidence"]).toBe("agent_started");
  });

  it("merges non-conflicting additional metadata", () => {
    writeTestSession("test-2", {
      status: "working",
      worktree: "/tmp/test",
      branch: "main",
    });

    const result = applyLifecycleDecision({
      dataDir,
      sessionId: "test-2",
      decision: {
        status: "pr_open",
        evidence: "pr_created",
        detecting: { attempts: 0 },
        prState: "open",
        prReason: "in_progress",
      },
      source: "agent_report",
      additionalMetadata: {
        summary: "worker reported PR creation",
      },
    });

    expect(result.success).toBe(true);

    const meta = readMetadataRaw(dataDir, "test-2");
    expect(meta?.["summary"]).toBe("worker reported PR creation");
  });

  it("clears stale metadata fields that are absent from the next lifecycle", () => {
    const lifecycle = createInitialCanonicalLifecycle("worker");
    lifecycle.session.state = "working";
    lifecycle.session.reason = "task_in_progress";
    lifecycle.session.startedAt = "2026-04-17T10:00:00.000Z";
    lifecycle.session.lastTransitionAt = "2026-04-17T10:00:00.000Z";

    writeTestSession("test-3", {
      status: "working",
      stateVersion: "2",
      statePayload: JSON.stringify(lifecycle),
      pr: "https://github.com/test/repo/pull/456",
      runtimeHandle: JSON.stringify({ id: "rt-1", runtimeName: "tmux", data: {} }),
      tmuxName: "tmux-1",
      role: "orchestrator",
      worktree: "/tmp/test",
      branch: "main",
    });

    const result = applyLifecycleDecision({
      dataDir,
      sessionId: "test-3",
      decision: {
        status: "working",
        evidence: "active",
        detecting: { attempts: 0 },
        sessionState: "working",
        sessionReason: "task_in_progress",
      },
      source: "poll",
    });

    expect(result.success).toBe(true);

    const meta = readMetadataRaw(dataDir, "test-3");
    expect(meta?.["pr"]).toBeUndefined();
    expect(meta?.["runtimeHandle"]).toBeUndefined();
    expect(meta?.["tmuxName"]).toBeUndefined();
    expect(meta?.["role"]).toBeUndefined();
  });

  it("validates stored legacy status before deriving the previous status", () => {
    writeTestSession("test-4", {
      status: "not-a-real-status",
      worktree: "/tmp/test",
      branch: "main",
    });

    const result = applyLifecycleDecision({
      dataDir,
      sessionId: "test-4",
      decision: {
        status: "working",
        evidence: "agent_started",
        detecting: { attempts: 0 },
        sessionState: "working",
        sessionReason: "task_in_progress",
      },
      source: "poll",
    });

    expect(result.success).toBe(true);
    expect(result.previousStatus).toBe("spawning");
  });
});

describe("createStateTransitionDecision", () => {
  it("creates a minimal decision for direct state updates", () => {
    const decision = createStateTransitionDecision(
      "stuck",
      "stuck",
      "probe_failure",
      "runtime dead after 3 attempts",
    );

    expect(decision.status).toBe("stuck");
    expect(decision.sessionState).toBe("stuck");
    expect(decision.sessionReason).toBe("probe_failure");
    expect(decision.evidence).toBe("runtime dead after 3 attempts");
    expect(decision.detecting.attempts).toBe(0);
  });
});
