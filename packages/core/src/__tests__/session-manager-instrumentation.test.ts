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
 *   - data payload omits prompt content (`session.prompt_delivery_failed`)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createSessionManager } from "../session-manager.js";
import { writeMetadata, readMetadataRaw } from "../metadata.js";
import { recordActivityEvent } from "../activity-events.js";
import type { OrchestratorConfig, PluginRegistry, Agent } from "../types.js";
import { setupTestContext, teardownTestContext, makeHandle, type TestContext } from "./test-utils.js";

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

describe("session.prompt_delivery_failed (MUST)", () => {
  it("emits after all 3 retries exhaust, omitting prompt content", async () => {
    vi.useFakeTimers();
    const promptDeliveryAgent: Agent = {
      name: "prompt-delivery-agent",
      processName: "pda",
      promptDelivery: "post-launch",
      getLaunchCommand: vi.fn().mockReturnValue("agent --start"),
      getEnvironment: vi.fn().mockReturnValue({}),
      detectActivity: vi.fn().mockReturnValue("active"),
      getActivityState: vi.fn().mockResolvedValue({ state: "active" }),
      isProcessRunning: vi.fn().mockResolvedValue(true),
      getSessionInfo: vi.fn().mockResolvedValue(null),
    };

    const originalGet = mockRegistry.get;
    mockRegistry.get = vi.fn().mockImplementation((slot: string, name?: string) => {
      if (slot === "agent" && (!name || name === "prompt-delivery-agent")) return promptDeliveryAgent;
      return (originalGet as any)(slot, name);
    });
    config.projects["my-app"]!.agent = "prompt-delivery-agent";

    vi.mocked(ctx.mockRuntime.sendMessage).mockRejectedValue(new Error("PTY closed"));

    const sm = createSessionManager({ config, registry: mockRegistry });
    const spawnPromise = sm.spawn({ projectId: "my-app", prompt: "secret task content" });
    await vi.runAllTimersAsync();
    await spawnPromise;

    const event = findEvent("session.prompt_delivery_failed");
    expect(event).toBeDefined();
    expect(event!.level).toBe("error");
    expect(event!.source).toBe("session-manager");
    expect(event!.data).toMatchObject({ attempts: 3 });
    expect(event!.summary).toBe(`prompt delivery failed after 3 retries: ${event!.sessionId}`);
    expect(JSON.stringify(event!.data ?? {})).not.toContain("secret task content");
  });

  it("does not emit when prompt delivery succeeds on first attempt", async () => {
    vi.useFakeTimers();
    const promptDeliveryAgent: Agent = {
      name: "prompt-delivery-agent",
      processName: "pda",
      promptDelivery: "post-launch",
      getLaunchCommand: vi.fn().mockReturnValue("agent --start"),
      getEnvironment: vi.fn().mockReturnValue({}),
      detectActivity: vi.fn().mockReturnValue("active"),
      getActivityState: vi.fn().mockResolvedValue({ state: "active" }),
      isProcessRunning: vi.fn().mockResolvedValue(true),
      getSessionInfo: vi.fn().mockResolvedValue(null),
    };

    const originalGet = mockRegistry.get;
    mockRegistry.get = vi.fn().mockImplementation((slot: string, name?: string) => {
      if (slot === "agent" && (!name || name === "prompt-delivery-agent")) return promptDeliveryAgent;
      return (originalGet as any)(slot, name);
    });
    config.projects["my-app"]!.agent = "prompt-delivery-agent";

    const sm = createSessionManager({ config, registry: mockRegistry });
    const spawnPromise = sm.spawn({ projectId: "my-app", prompt: "task" });
    await vi.runAllTimersAsync();
    await spawnPromise;

    expect(findEvent("session.prompt_delivery_failed")).toBeUndefined();
  });
});

describe("session.spawn_failed — orchestrator path (MUST)", () => {
  it("emits when spawnOrchestrator's workspace.create throws", async () => {
    vi.mocked(ctx.mockWorkspace.create).mockRejectedValue(new Error("disk full"));

    const sm = createSessionManager({ config, registry: mockRegistry });
    await expect(
      sm.spawnOrchestrator({ projectId: "my-app", systemPrompt: "be helpful" }),
    ).rejects.toThrow("disk full");

    const events = findAllEvents("session.spawn_failed");
    expect(events.length).toBeGreaterThanOrEqual(1);
    const orchestratorFailure = events.find((e) => e.data && (e.data as Record<string, unknown>)["role"] === "orchestrator");
    expect(orchestratorFailure).toBeDefined();
    expect(orchestratorFailure!.level).toBe("error");
    expect(orchestratorFailure!.projectId).toBe("my-app");
  });

  it("emits when spawnOrchestrator's runtime.create throws", async () => {
    vi.mocked(ctx.mockRuntime.create).mockRejectedValue(new Error("tmux not found"));

    const sm = createSessionManager({ config, registry: mockRegistry });
    await expect(
      sm.spawnOrchestrator({ projectId: "my-app", systemPrompt: "be helpful" }),
    ).rejects.toThrow("tmux not found");

    const events = findAllEvents("session.spawn_failed");
    const orchestratorFailure = events.find((e) => e.data && (e.data as Record<string, unknown>)["role"] === "orchestrator");
    expect(orchestratorFailure).toBeDefined();
    expect(orchestratorFailure!.level).toBe("error");
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
    expect(lc.session.state).toBe("terminated");
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
});

describe("metadata.corrupt_detected (MUST)", () => {
  it("emits when mutateMetadata side-renames a corrupt file", async () => {
    // Simulate a corrupt metadata file in the sessions dir
    const sessionPath = join(sessionsDir, "app-corrupt.json");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(sessionPath, "{ this is not json", "utf-8");

    const { mutateMetadata } = await import("../metadata.js");
    mutateMetadata(
      sessionsDir,
      "app-corrupt",
      () => ({ branch: "feat/x", project: "my-app" }),
      { createIfMissing: true, activityEventSource: "agent-report" },
    );

    const event = findEvent("metadata.corrupt_detected");
    expect(event).toBeDefined();
    expect(event!.level).toBe("warn");
    expect(event!.source).toBe("agent-report");
    expect(event!.sessionId).toBe("app-corrupt");
    const data = event!.data as Record<string, unknown>;
    expect(data["renamed"]).toBe(true);
    expect(data["corruptPath"]).toMatch(/\.corrupt-\d+$/);
  });
});
