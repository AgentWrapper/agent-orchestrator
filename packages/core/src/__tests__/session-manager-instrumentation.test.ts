/**
 * Regression tests for session-manager activity event instrumentation
 * (issue #1657 — extends PR #1620 to cover the rest of the failure paths
 * inside spawn / kill / restore / send / list).
 *
 * One test per MUST-class emit. Pattern follows the lifecycle-manager-
 * instrumentation tests: mock `recordActivityEvent`, drive the manager into
 * the failure path, then assert the right kind/level/data was logged.
 *
 * Invariants asserted by these tests (PR #1620 B1/B2 plus #1657 B25):
 *   - state mutation happens BEFORE event emission
 *   - failure-only emits — no event on a successful send/spawn
 *   - cleanup-stack rollbacks emit per failed step (not in aggregate)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createSessionManager } from "../session-manager.js";
import { writeMetadata, readMetadataRaw } from "../metadata.js";
import { recordActivityEvent } from "../activity-events.js";
import { getProjectWorktreesDir } from "../paths.js";
import type { OrchestratorConfig, PluginRegistry, Agent } from "../types.js";
import {
  setupTestContext,
  teardownTestContext,
  makeHandle,
  type TestContext,
} from "./test-utils.js";

vi.mock("../activity-events.js", () => ({
  recordActivityEvent: vi.fn(),
}));

let ctx: TestContext;
let sessionsDir: string;
let mockRegistry: PluginRegistry;
let config: OrchestratorConfig;

beforeEach(() => {
  ctx = setupTestContext();
  ({ sessionsDir, mockRegistry, config } = ctx);
  vi.mocked(recordActivityEvent).mockClear();
});

afterEach(() => {
  teardownTestContext(ctx);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function findEvent(kind: string) {
  return vi
    .mocked(recordActivityEvent)
    .mock.calls.map((c) => c[0])
    .find((e) => e.kind === kind);
}

function findAllEvents(kind: string) {
  return vi
    .mocked(recordActivityEvent)
    .mock.calls.map((c) => c[0])
    .filter((e) => e.kind === kind);
}

function writeTerminatedSession(
  sessionId: string,
  options: { worktree: string; branch?: string },
): void {
  const metadata: Record<string, unknown> = {
    worktree: options.worktree,
    status: "killed",
    project: "my-app",
    runtimeHandle: makeHandle("rt-old"),
    lifecycle: {
      version: 2,
      session: {
        kind: "worker",
        state: "terminated",
        reason: "manually_killed",
        startedAt: "2025-01-01T00:00:00.000Z",
        completedAt: null,
        terminatedAt: "2025-01-01T00:00:00.000Z",
        lastTransitionAt: "2025-01-01T00:00:00.000Z",
      },
      pr: { state: "none", reason: "not_created", number: null, url: null, lastObservedAt: null },
      runtime: {
        state: "missing",
        reason: "process_missing",
        lastObservedAt: "2025-01-01T00:00:00.000Z",
        handle: null,
        tmuxName: null,
      },
    },
  };
  if (options.branch !== undefined) {
    metadata["branch"] = options.branch;
  }
  writeMetadata(sessionsDir, sessionId, metadata as unknown as Parameters<typeof writeMetadata>[2]);
}

describe("session.kill_started (MUST)", () => {
  it("emits before runtime.destroy is attempted", async () => {
    let destroyCalled = false;
    let killStartedEmittedBeforeDestroy = false;

    vi.mocked(ctx.mockRuntime.destroy).mockImplementation(async () => {
      destroyCalled = true;
      killStartedEmittedBeforeDestroy = !!findEvent("session.kill_started");
    });

    writeMetadata(sessionsDir, "app-killed", {
      worktree: "/tmp/ws",
      branch: "main",
      status: "working",
      project: "my-app",
      runtimeHandle: makeHandle("rt-1"),
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.kill("app-killed");

    expect(destroyCalled).toBe(true);
    expect(killStartedEmittedBeforeDestroy).toBe(true);

    const start = findEvent("session.kill_started");
    expect(start).toMatchObject({
      projectId: "my-app",
      sessionId: "app-killed",
      source: "session-manager",
      kind: "session.kill_started",
    });
  });

  it("does not emit kill_started when session is already terminated (idempotent)", async () => {
    writeMetadata(sessionsDir, "app-already-killed", {
      worktree: "/tmp/ws",
      branch: "main",
      status: "killed",
      project: "my-app",
      lifecycle: {
        version: 2,
        session: {
          kind: "worker",
          state: "terminated",
          reason: "manually_killed",
          startedAt: "2025-01-01T00:00:00.000Z",
          completedAt: null,
          terminatedAt: "2025-01-01T00:00:00.000Z",
          lastTransitionAt: "2025-01-01T00:00:00.000Z",
        },
        pr: { state: "none", reason: "not_created", number: null, url: null, lastObservedAt: null },
        runtime: {
          state: "missing",
          reason: "manual_kill_requested",
          lastObservedAt: "2025-01-01T00:00:00.000Z",
          handle: null,
          tmuxName: null,
        },
      },
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.kill("app-already-killed");

    expect(findEvent("session.kill_started")).toBeUndefined();
  });
});

describe("session.spawn_failed — orchestrator path (MUST)", () => {
  it("emits session.spawned after a successful orchestrator spawn", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });
    const session = await sm.spawnOrchestrator({
      projectId: "my-app",
      systemPrompt: "be helpful",
    });

    const events = findAllEvents("session.spawned");
    const orchestratorSpawned = events.find(
      (e) => e.data && (e.data as Record<string, unknown>)["role"] === "orchestrator",
    );

    expect(session.id).toBe("app-orchestrator");
    expect(orchestratorSpawned).toMatchObject({
      projectId: "my-app",
      sessionId: "app-orchestrator",
      source: "session-manager",
      kind: "session.spawned",
      summary: "spawned: app-orchestrator",
      data: {
        agent: "mock-agent",
        branch: "orchestrator/app-orchestrator",
        role: "orchestrator",
      },
    });
  });

  it("does not emit terminal spawn_failed when ensure recovers a fixed reservation conflict", async () => {
    let releaseWorkspace: () => void = () => {};
    const blockingWorkspace = new Promise<void>((resolve) => {
      releaseWorkspace = resolve;
    });
    vi.mocked(ctx.mockWorkspace.create).mockImplementationOnce(async (cfg) => {
      await blockingWorkspace;
      return {
        path: join(ctx.tmpDir, "ws-orchestrator"),
        branch: cfg.branch,
        sessionId: cfg.sessionId,
        projectId: cfg.projectId,
      };
    });

    const firstManager = createSessionManager({ config, registry: mockRegistry });
    const secondManager = createSessionManager({ config, registry: mockRegistry });

    const firstEnsure = firstManager.ensureOrchestrator({
      projectId: "my-app",
      systemPrompt: "be helpful",
    });
    await vi.waitFor(() => {
      expect(ctx.mockWorkspace.create).toHaveBeenCalledTimes(1);
    });

    const secondEnsure = secondManager.ensureOrchestrator({
      projectId: "my-app",
      systemPrompt: "be helpful",
    });
    await vi.waitFor(() => {
      expect(findEvent("session.orchestrator_conflict")).toBeDefined();
    });

    releaseWorkspace();
    const [created, recovered] = await Promise.all([firstEnsure, secondEnsure]);

    expect(created.id).toBe("app-orchestrator");
    expect(recovered.id).toBe("app-orchestrator");
    expect(findAllEvents("session.orchestrator_conflict")).toHaveLength(1);
    expect(
      findAllEvents("session.spawn_failed").filter(
        (e) => e.data && (e.data as Record<string, unknown>)["role"] === "orchestrator",
      ),
    ).toHaveLength(0);
  });

  it("emits one terminal failure plus one stage failure when workspace.create throws", async () => {
    vi.mocked(ctx.mockWorkspace.create).mockRejectedValue(new Error("disk full"));

    const sm = createSessionManager({ config, registry: mockRegistry });
    await expect(
      sm.spawnOrchestrator({ projectId: "my-app", systemPrompt: "be helpful" }),
    ).rejects.toThrow("disk full");

    const events = findAllEvents("session.spawn_failed");
    expect(events).toHaveLength(1);
    const orchestratorFailure = events.find(
      (e) => e.data && (e.data as Record<string, unknown>)["role"] === "orchestrator",
    );
    expect(orchestratorFailure).toBeDefined();
    expect(orchestratorFailure!.level).toBe("error");
    expect(orchestratorFailure!.projectId).toBe("my-app");

    const stepEvents = findAllEvents("session.spawn_step_failed");
    expect(stepEvents).toHaveLength(1);
    expect(stepEvents[0]!.sessionId).toBe("app-orchestrator");
    expect(stepEvents[0]!.data).toMatchObject({
      role: "orchestrator",
      stage: "workspace_create",
    });
  });

  it("emits one terminal failure plus one stage failure when runtime.create throws", async () => {
    vi.mocked(ctx.mockRuntime.create).mockRejectedValue(new Error("tmux not found"));

    const sm = createSessionManager({ config, registry: mockRegistry });
    await expect(
      sm.spawnOrchestrator({ projectId: "my-app", systemPrompt: "be helpful" }),
    ).rejects.toThrow("tmux not found");

    const events = findAllEvents("session.spawn_failed");
    expect(events).toHaveLength(1);
    const orchestratorFailure = events.find(
      (e) => e.data && (e.data as Record<string, unknown>)["role"] === "orchestrator",
    );
    expect(orchestratorFailure).toBeDefined();
    expect(orchestratorFailure!.level).toBe("error");

    const stepEvents = findAllEvents("session.spawn_step_failed");
    expect(stepEvents).toHaveLength(1);
    expect(stepEvents[0]!.sessionId).toBe("app-orchestrator");
    expect(stepEvents[0]!.data).toMatchObject({
      role: "orchestrator",
      stage: "runtime_create",
    });
  });
});

describe("session.rollback_started/session.rollback_step_failed (MUST)", () => {
  it("includes reserved sessionId when worker spawn rolls back after reservation", async () => {
    const workspacePath = join(getProjectWorktreesDir("my-app"), "app-1");
    vi.mocked(ctx.mockWorkspace.create).mockResolvedValue({
      path: workspacePath,
      branch: "feat/test",
      sessionId: "app-1",
      projectId: "my-app",
    });
    vi.mocked(ctx.mockWorkspace.destroy).mockRejectedValue(new Error("destroy failed"));
    vi.mocked(ctx.mockRuntime.create).mockRejectedValue(new Error("runtime failed"));

    const sm = createSessionManager({ config, registry: mockRegistry });
    await expect(sm.spawn({ projectId: "my-app" })).rejects.toThrow("runtime failed");

    const rollbackStarted = findEvent("session.rollback_started");
    expect(rollbackStarted).toBeDefined();
    expect(rollbackStarted!.sessionId).toBe("app-1");

    const rollbackStepFailed = findEvent("session.rollback_step_failed");
    expect(rollbackStepFailed).toBeDefined();
    expect(rollbackStepFailed!.sessionId).toBe("app-1");
    expect(rollbackStepFailed!.data).toMatchObject({ reason: "destroy failed" });
  });
});

describe("session.workspace_hooks_failed (MUST)", () => {
  it("emits when setupWorkspaceHooks throws during orchestrator spawn", async () => {
    const hookFailingAgent: Agent = {
      ...ctx.mockAgent,
      name: "hook-failing-agent",
      setupWorkspaceHooks: vi.fn().mockRejectedValue(new Error("settings.json EACCES")),
    };
    const originalGet = mockRegistry.get;
    mockRegistry.get = vi.fn().mockImplementation((slot: string, name?: string) => {
      if (slot === "agent") return hookFailingAgent;
      return (originalGet as any)(slot, name);
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    await expect(
      sm.spawnOrchestrator({ projectId: "my-app", systemPrompt: "be helpful" }),
    ).rejects.toThrow("settings.json EACCES");

    const event = findEvent("session.workspace_hooks_failed");
    expect(event).toBeDefined();
    expect(event!.level).toBe("error");
    expect(event!.projectId).toBe("my-app");
  });
});

describe("runtime.lost_detected (MUST)", () => {
  it("emits when sm.list() persists runtime_lost for a dead runtime", async () => {
    writeMetadata(sessionsDir, "app-dead", {
      worktree: "/tmp/ws",
      branch: "main",
      status: "working",
      project: "my-app",
      runtimeHandle: makeHandle("rt-dead"),
    });

    // Runtime claims dead, agent process gone
    vi.mocked(ctx.mockRuntime.isAlive).mockResolvedValue(false);
    vi.mocked(ctx.mockAgent.isProcessRunning).mockResolvedValue(false);

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.list();

    const event = findEvent("runtime.lost_detected");
    expect(event).toBeDefined();
    expect(event!.projectId).toBe("my-app");
    expect(event!.sessionId).toBe("app-dead");
    expect(event!.level).toBe("warn");

    // B1: state mutation BEFORE event emission — verify metadata was persisted
    const persisted = readMetadataRaw(sessionsDir, "app-dead");
    expect(persisted).not.toBeNull();
    const lifecycleStr = persisted!["lifecycle"];
    expect(lifecycleStr).toBeDefined();
    const lc = JSON.parse(lifecycleStr!) as { session: { state: string; reason: string } };
    expect(lc.session.state).toBe("detecting");
    expect(lc.session.reason).toBe("runtime_lost");
  });
});

describe("session.send_failed (MUST)", () => {
  it("emits after send retry-with-restore exhausts", async () => {
    writeMetadata(sessionsDir, "app-send", {
      worktree: "/tmp/ws",
      branch: "main",
      status: "killed",
      project: "my-app",
      runtimeHandle: makeHandle("rt-1"),
      lifecycle: {
        version: 2,
        session: {
          kind: "worker",
          state: "terminated",
          reason: "manually_killed",
          startedAt: "2025-01-01T00:00:00.000Z",
          completedAt: null,
          terminatedAt: "2025-01-01T00:00:00.000Z",
          lastTransitionAt: "2025-01-01T00:00:00.000Z",
        },
        pr: { state: "none", reason: "not_created", number: null, url: null, lastObservedAt: null },
        runtime: {
          state: "missing",
          reason: "process_missing",
          lastObservedAt: "2025-01-01T00:00:00.000Z",
          handle: null,
          tmuxName: null,
        },
      },
    });

    vi.mocked(ctx.mockRuntime.sendMessage).mockRejectedValue(new Error("send broke"));
    // restore() throws so retry-with-restore exhausts
    vi.mocked(ctx.mockRuntime.create).mockRejectedValue(new Error("restore failed"));

    const sm = createSessionManager({ config, registry: mockRegistry });
    await expect(sm.send("app-send", "hi")).rejects.toThrow();

    const event = findEvent("session.send_failed");
    expect(event).toBeDefined();
    expect(event!.level).toBe("error");
    expect(event!.sessionId).toBe("app-send");
    // B11: data must not contain message content
    expect(JSON.stringify(event!.data ?? {})).not.toContain("hi");
  });

  it("does not double-emit session.restore_failed when restore fails during send", async () => {
    const wsPath = join(ctx.tmpDir, "missing-send-ws");
    writeTerminatedSession("app-send-restore", { worktree: wsPath, branch: "feat/send" });

    ctx.mockWorkspace.exists = vi.fn().mockResolvedValue(false);
    ctx.mockWorkspace.restore = vi.fn().mockRejectedValue(new Error("restore failed"));

    const sm = createSessionManager({ config, registry: mockRegistry });
    await expect(sm.send("app-send-restore", "hi")).rejects.toThrow();

    const restoreFailed = findAllEvents("session.restore_failed");
    expect(restoreFailed).toHaveLength(1);
    expect(restoreFailed[0]!.data).toMatchObject({ stage: "workspace_restore" });
    expect(findEvent("session.send_failed")).toBeDefined();
  });

  it("tags restore-for-delivery timeout restore_failed with ready_timeout stage", async () => {
    vi.useFakeTimers();
    try {
      const wsPath = join(ctx.tmpDir, "send-restore-ready-timeout");
      mkdirSync(wsPath, { recursive: true });
      writeTerminatedSession("app-send-timeout", { worktree: wsPath, branch: "feat/send" });

      vi.mocked(ctx.mockRuntime.isAlive).mockImplementation(async (handle) => {
        return handle.id !== "rt-restored";
      });
      vi.mocked(ctx.mockAgent.isProcessRunning).mockImplementation(async (handle) => {
        return handle.id !== "rt-restored";
      });
      vi.mocked(ctx.mockRuntime.create).mockResolvedValue(makeHandle("rt-restored"));
      vi.mocked(ctx.mockRuntime.getOutput).mockResolvedValue("");
      vi.mocked(ctx.mockAgent.detectActivity).mockReturnValue("idle");

      const sm = createSessionManager({ config, registry: mockRegistry });
      const sendPromise = sm.send("app-send-timeout", "hi");
      const rejection = expect(sendPromise).rejects.toThrow(
        "restored session did not become ready for delivery",
      );

      await vi.runAllTimersAsync();
      await rejection;

      const restoreFailed = findAllEvents("session.restore_failed");
      expect(restoreFailed).toHaveLength(1);
      expect(restoreFailed[0]!.data).toMatchObject({
        stage: "ready_timeout",
        reason: "restored session did not become ready for delivery",
        trigger: "send",
      });
      expect(findEvent("session.send_failed")).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("session.restore_failed (MUST)", () => {
  it("emits when restore's workspace restore throws", async () => {
    const wsPath = join(ctx.tmpDir, "missing-ws");
    writeMetadata(sessionsDir, "app-rest", {
      worktree: wsPath,
      branch: "feat/x",
      status: "killed",
      project: "my-app",
      runtimeHandle: makeHandle("rt-old"),
      lifecycle: {
        version: 2,
        session: {
          kind: "worker",
          state: "terminated",
          reason: "manually_killed",
          startedAt: "2025-01-01T00:00:00.000Z",
          completedAt: null,
          terminatedAt: "2025-01-01T00:00:00.000Z",
          lastTransitionAt: "2025-01-01T00:00:00.000Z",
        },
        pr: { state: "none", reason: "not_created", number: null, url: null, lastObservedAt: null },
        runtime: {
          state: "missing",
          reason: "process_missing",
          lastObservedAt: "2025-01-01T00:00:00.000Z",
          handle: null,
          tmuxName: null,
        },
      },
    });

    // workspace doesn't exist + restore throws
    vi.mocked(ctx.mockWorkspace.exists ?? (() => false)).mockResolvedValue?.(false);
    ctx.mockWorkspace.exists = vi.fn().mockResolvedValue(false);
    ctx.mockWorkspace.restore = vi.fn().mockRejectedValue(new Error("clone failed"));

    const sm = createSessionManager({ config, registry: mockRegistry });
    await expect(sm.restore("app-rest")).rejects.toThrow();

    const event = findEvent("session.restore_failed");
    expect(event).toBeDefined();
    expect(event!.level).toBe("error");
    expect(event!.sessionId).toBe("app-rest");
  });

  it("emits SessionNotRestorableError when session is not restorable", async () => {
    writeMetadata(sessionsDir, "app-not-rest", {
      worktree: "/tmp/ws",
      branch: "feat/x",
      status: "working",
      project: "my-app",
      runtimeHandle: makeHandle("rt-1"),
      lifecycle: {
        version: 2,
        session: {
          kind: "worker",
          state: "working",
          reason: "task_in_progress",
          startedAt: "2025-01-01T00:00:00.000Z",
          completedAt: null,
          terminatedAt: null,
          lastTransitionAt: "2025-01-01T00:00:00.000Z",
        },
        pr: { state: "none", reason: "not_created", number: null, url: null, lastObservedAt: null },
        runtime: {
          state: "alive",
          reason: "process_running",
          lastObservedAt: "2025-01-01T00:00:00.000Z",
          handle: makeHandle("rt-1"),
          tmuxName: null,
        },
      },
    });

    // active session — not restorable
    vi.mocked(ctx.mockRuntime.isAlive).mockResolvedValue(true);
    vi.mocked(ctx.mockAgent.isProcessRunning).mockResolvedValue(true);

    const sm = createSessionManager({ config, registry: mockRegistry });
    await expect(sm.restore("app-not-rest")).rejects.toThrow();

    const event = findEvent("session.restore_failed");
    expect(event).toBeDefined();
  });

  it("emits when workspace is missing and the workspace plugin cannot restore", async () => {
    const wsPath = join(ctx.tmpDir, "missing-no-restore");
    writeTerminatedSession("app-no-restore", { worktree: wsPath, branch: "feat/no-restore" });

    ctx.mockWorkspace.exists = vi.fn().mockResolvedValue(false);
    ctx.mockWorkspace.restore = undefined;

    const sm = createSessionManager({ config, registry: mockRegistry });
    await expect(sm.restore("app-no-restore")).rejects.toThrow();

    const event = findEvent("session.restore_failed");
    expect(event).toBeDefined();
    expect(event!.sessionId).toBe("app-no-restore");
    expect(event!.data).toMatchObject({
      stage: "workspace_restore",
      workspacePath: wsPath,
      reason: "workspace plugin does not support restore",
    });
  });

  it("emits when workspace is missing and branch metadata is absent", async () => {
    const wsPath = join(ctx.tmpDir, "missing-no-branch");
    writeTerminatedSession("app-no-branch", { worktree: wsPath });

    ctx.mockWorkspace.exists = vi.fn().mockResolvedValue(false);
    ctx.mockWorkspace.restore = vi.fn().mockResolvedValue({
      path: wsPath,
      branch: "unused",
      sessionId: "app-no-branch",
      projectId: "my-app",
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    await expect(sm.restore("app-no-branch")).rejects.toThrow();

    const event = findEvent("session.restore_failed");
    expect(event).toBeDefined();
    expect(event!.sessionId).toBe("app-no-branch");
    expect(event!.data).toMatchObject({
      stage: "workspace_restore",
      workspacePath: wsPath,
      reason: "branch metadata is missing",
    });
  });
});

describe("metadata.corrupt_detected (MUST)", () => {
  it("emits when mutateMetadata side-renames a corrupt file", async () => {
    // Simulate a corrupt metadata file in the sessions dir
    const sessionPath = join(sessionsDir, "app-corrupt.json");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(sessionPath, "{ this is not json", "utf-8");

    const { mutateMetadata } = await import("../metadata.js");
    mutateMetadata(sessionsDir, "app-corrupt", () => ({ branch: "feat/x", project: "my-app" }), {
      createIfMissing: true,
      activityEventSource: "api",
    });

    const event = findEvent("metadata.corrupt_detected");
    expect(event).toBeDefined();
    expect(event!.level).toBe("error");
    expect(event!.source).toBe("api");
    expect(event!.sessionId).toBe("app-corrupt");
    const data = event!.data as Record<string, unknown>;
    expect(data["renameSucceeded"]).toBe(true);
    expect(data["renamedTo"]).toMatch(/\.corrupt-\d+$/);
  });
});
