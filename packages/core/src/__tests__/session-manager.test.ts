import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createSessionManager } from "../session-manager.js";
import { writeMetadata } from "../metadata.js";
import { recordActivityEvent } from "../activity-events.js";
import type { OrchestratorConfig, PluginRegistry, Agent } from "../types.js";
import { setupTestContext, teardownTestContext, makeHandle, type TestContext } from "./test-utils.js";

vi.mock("../activity-events.js", () => ({
  recordActivityEvent: vi.fn(),
}));

// Mock child_process module with custom promisify
vi.mock("node:child_process", () => {
  const execFileMock = vi.fn() as any;
  // Implement custom promisify to return { stdout, stderr } objects
  execFileMock[Symbol.for("nodejs.util.promisify.custom")] = (...args: any[]) => {
    return new Promise((resolve, reject) => {
      execFileMock(...args, (error: any, stdout: string, stderr: string) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }));
        } else {
          resolve({ stdout, stderr });
        }
      });
    });
  };
  return {
    execFile: execFileMock,
  };
});

let ctx: TestContext;
let sessionsDir: string;
let mockRegistry: PluginRegistry;
let config: OrchestratorConfig;

beforeEach(() => {
  ctx = setupTestContext();
  ({ sessionsDir, mockRegistry, config } = ctx);
  vi.mocked(recordActivityEvent).mockClear();

  // Create an opencode agent mock
  const opencodeAgent: Agent = {
    name: "opencode",
    processName: "opencode",
    getLaunchCommand: vi.fn().mockReturnValue("opencode start"),
    getEnvironment: vi.fn().mockReturnValue({}),
    detectActivity: vi.fn().mockReturnValue("active"),
    getActivityState: vi.fn().mockResolvedValue({ state: "active" }),
    isProcessRunning: vi.fn().mockResolvedValue(true),
    getSessionInfo: vi.fn().mockResolvedValue(null),
  };

  // Update registry to include opencode agent
  const originalGet = mockRegistry.get;
  mockRegistry.get = vi.fn().mockImplementation((slot: string, name?: string) => {
    if (slot === "agent" && name === "opencode") {
      return opencodeAgent;
    }
    return (originalGet as any)(slot, name);
  });

  // Set project to use opencode agent
  config.projects["my-app"]!.agent = "opencode";
});

afterEach(() => {
  teardownTestContext(ctx);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("activity event logging", () => {
  it("records session.spawned after a successful spawn", async () => {
    const { execFile } = await import("node:child_process");
    vi.mocked(execFile).mockImplementation(((_file: string, _args: string[], options: any, callback?: any) => {
      const cb = typeof options === "function" ? options : callback;
      if (cb) cb(null, "", "");
      return null as any;
    }) as any);

    vi.useFakeTimers();
    config.projects["my-app"]!.agent = "mock-agent";
    const sm = createSessionManager({ config, registry: mockRegistry });

    const spawnPromise = sm.spawn({ projectId: "my-app" });
    await vi.runAllTimersAsync();
    const session = await spawnPromise;

    expect(recordActivityEvent).toHaveBeenCalledWith({
      projectId: "my-app",
      source: "session-manager",
      kind: "session.spawn_started",
      summary: "spawn started",
      data: { agent: undefined },
    });
    expect(recordActivityEvent).toHaveBeenCalledWith({
      projectId: "my-app",
      sessionId: session.id,
      source: "session-manager",
      kind: "session.spawned",
      summary: `spawned: ${session.id}`,
      data: { agent: "mock-agent", branch: session.branch },
    });
  });

  it("records session.spawn_failed when spawn fails", async () => {
    const sm = createSessionManager({ config, registry: mockRegistry });

    await expect(sm.spawn({ projectId: "missing-project", prompt: "nope" })).rejects.toThrow(
      "Unknown project: missing-project",
    );

    expect(recordActivityEvent).toHaveBeenCalledWith({
      projectId: "missing-project",
      source: "session-manager",
      kind: "session.spawn_started",
      summary: "spawn started",
      data: { agent: undefined },
    });
    expect(recordActivityEvent).toHaveBeenCalledWith({
      projectId: "missing-project",
      source: "session-manager",
      kind: "session.spawn_failed",
      level: "error",
      summary: "spawn failed",
      data: { reason: "Unknown project: missing-project" },
    });
  });

  it("records session.killed after successful kill cleanup", async () => {
    writeMetadata(sessionsDir, "app-kill", {
      worktree: "/tmp/ws",
      branch: "main",
      status: "working",
      project: "my-app",
      agent: "opencode",
      runtimeHandle: makeHandle("rt-kill"),
    });

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.kill("app-kill");

    expect(recordActivityEvent).toHaveBeenCalledWith({
      projectId: "my-app",
      sessionId: "app-kill",
      source: "session-manager",
      kind: "session.killed",
      summary: "killed: app-kill",
      data: { reason: "manually_killed" },
    });
  });
});

describe("deleteSession retry loop", () => {
  it("verifies retry count - calls execFileAsync 3 times when all attempts fail", async () => {
    const { execFile } = await import("node:child_process");

    // Setup: Create a session with opencode agent
    writeMetadata(sessionsDir, "app-1", {
      worktree: "/tmp/ws",
      branch: "main",
      status: "working",
      project: "my-app",
      agent: "opencode",
      opencodeSessionId: "ses_test_123",
      runtimeHandle: makeHandle("rt-1"),
    });

    let deleteCallCount = 0;
    const mockError = new Error("OpenCode delete failed");

    vi.mocked(execFile).mockImplementation(((file: string, args: string[], options: any, callback?: any) => {
      const cb = typeof options === "function" ? options : callback;
      if (!cb) return null as any;

      const argsArray = Array.isArray(args) ? args : [];
      if (argsArray[1] === "delete") {
        deleteCallCount++;
        cb(mockError, "", "");
      } else if (argsArray[1] === "list") {
        cb(null, "[]", "");
      }
      return null as any;
    }) as any);

    const sm = createSessionManager({ config, registry: mockRegistry });

    // Execute kill with purgeOpenCode option
    await sm.kill("app-1", { purgeOpenCode: true });

    // Verify delete was called 3 times (one for each retry)
    expect(deleteCallCount).toBe(3);
  });

  it("verifies retry delays - confirms delays are 0ms, 200ms, 600ms", async () => {
    const { execFile } = await import("node:child_process");
    vi.useFakeTimers();

    writeMetadata(sessionsDir, "app-2", {
      worktree: "/tmp/ws",
      branch: "main",
      status: "working",
      project: "my-app",
      agent: "opencode",
      opencodeSessionId: "ses_test_456",
      runtimeHandle: makeHandle("rt-2"),
    });

    const callTimes: number[] = [];
    const mockError = new Error("OpenCode delete failed");

    vi.mocked(execFile).mockImplementation(((file: string, args: string[], options: any, callback?: any) => {
      const cb = typeof options === "function" ? options : callback;
      if (!cb) return null as any;

      const argsArray = Array.isArray(args) ? args : [];
      if (argsArray[1] === "delete") {
        callTimes.push(Date.now());
        cb(mockError, "", "");
      } else if (argsArray[1] === "list") {
        cb(null, "[]", "");
      }
      return null as any;
    }) as any);

    const sm = createSessionManager({ config, registry: mockRegistry });
    const killPromise = sm.kill("app-2", { purgeOpenCode: true });

    // Run all timers to completion
    await vi.runAllTimersAsync();
    await killPromise;

    // Verify we have 3 calls
    expect(callTimes).toHaveLength(3);

    // Calculate delays between calls
    const delay1 = callTimes[1]! - callTimes[0]!; // Should be 200ms
    const delay2 = callTimes[2]! - callTimes[1]!; // Should be 600ms

    expect(delay1).toBe(200);
    expect(delay2).toBe(600);

    vi.useRealTimers();
  });

  it("verifies all retries are attempted when deletion fails", async () => {
    const { execFile } = await import("node:child_process");

    writeMetadata(sessionsDir, "app-3", {
      worktree: "/tmp/ws",
      branch: "main",
      status: "working",
      project: "my-app",
      agent: "opencode",
      opencodeSessionId: "ses_test_789",
      runtimeHandle: makeHandle("rt-3"),
    });

    const lastError = new Error("Final error after retries");
    let deleteCallCount = 0;

    vi.mocked(execFile).mockImplementation(((file: string, args: string[], options: any, callback?: any) => {
      const cb = typeof options === "function" ? options : callback;
      if (!cb) return null as any;

      const argsArray = Array.isArray(args) ? args : [];
      if (argsArray[1] === "delete") {
        deleteCallCount++;
        const error = deleteCallCount === 3 ? lastError : new Error(`Error ${deleteCallCount}`);
        cb(error, "", "");
      } else if (argsArray[1] === "list") {
        cb(null, "[]", "");
      }
      return null as any;
    }) as any);

    const sm = createSessionManager({ config, registry: mockRegistry });

    // The kill function catches and ignores deleteOpenCodeSession() failures,
    // so this test verifies that all retry attempts are made despite errors
    await sm.kill("app-3", { purgeOpenCode: true });

    // Verify all 3 delete attempts were made
    expect(deleteCallCount).toBe(3);
  });

  it("verifies early success exit - stops after first success without unnecessary retries", async () => {
    const { execFile } = await import("node:child_process");

    writeMetadata(sessionsDir, "app-4", {
      worktree: "/tmp/ws",
      branch: "main",
      status: "working",
      project: "my-app",
      agent: "opencode",
      opencodeSessionId: "ses_test_abc",
      runtimeHandle: makeHandle("rt-4"),
    });

    let deleteCallCount = 0;

    vi.mocked(execFile).mockImplementation(((file: string, args: string[], options: any, callback?: any) => {
      const cb = typeof options === "function" ? options : callback;
      if (!cb) return null as any;

      const argsArray = Array.isArray(args) ? args : [];
      if (argsArray[1] === "delete") {
        deleteCallCount++;
        if (deleteCallCount === 1) {
          // First attempt fails
          cb(new Error("First attempt failed"), "", "");
        } else {
          // Second attempt succeeds
          cb(null, "", "");
        }
      } else if (argsArray[1] === "list") {
        cb(null, "[]", "");
      }
      return null as any;
    }) as any);

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.kill("app-4", { purgeOpenCode: true });

    // Verify delete was called exactly 2 times (failed once, succeeded on second)
    expect(deleteCallCount).toBe(2);
  });

  it("verifies session-not-found handling - exits gracefully without retrying", async () => {
    const { execFile } = await import("node:child_process");

    writeMetadata(sessionsDir, "app-5", {
      worktree: "/tmp/ws",
      branch: "main",
      status: "working",
      project: "my-app",
      agent: "opencode",
      opencodeSessionId: "ses_test_def",
      runtimeHandle: makeHandle("rt-5"),
    });

    const notFoundError = new Error("Session not found: ses_test_def") as Error & {
      stderr?: string;
      stdout?: string;
    };
    notFoundError.stderr = "Error: session not found: ses_test_def";

    let deleteCallCount = 0;

    vi.mocked(execFile).mockImplementation(((file: string, args: string[], options: any, callback?: any) => {
      const cb = typeof options === "function" ? options : callback;
      if (!cb) return null as any;

      const argsArray = Array.isArray(args) ? args : [];
      if (argsArray[1] === "delete") {
        deleteCallCount++;
        cb(notFoundError, "", "");
      } else if (argsArray[1] === "list") {
        cb(null, "[]", "");
      }
      return null as any;
    }) as any);

    const sm = createSessionManager({ config, registry: mockRegistry });
    await sm.kill("app-5", { purgeOpenCode: true });

    // Verify delete was called only once - no retries for "not found" errors
    expect(deleteCallCount).toBe(1);
  });
});

describe("spawning session liveness (#1035)", () => {
  it("does not call runtime.isAlive for spawning sessions, preventing false 'killed' status", async () => {
    // Write a session in "spawning" status with a persisted runtime handle
    writeMetadata(sessionsDir, "app-spawn", {
      worktree: "/tmp/ws",
      branch: "main",
      status: "spawning",
      project: "my-app",
      agent: "opencode",
      runtimeHandle: makeHandle("rt-spawn"),
    });

    // Make isAlive return false — if it were called, the session would become "killed"
    vi.mocked(ctx.mockRuntime.isAlive).mockResolvedValue(false);

    const sm = createSessionManager({ config, registry: mockRegistry });
    const sessions = await sm.list();
    const spawning = sessions.find((s) => s.id === "app-spawn");

    // isAlive must NOT have been called for the spawning session
    expect(ctx.mockRuntime.isAlive).not.toHaveBeenCalled();

    // Status must remain "spawning", not "killed"
    expect(spawning).toBeDefined();
    expect(spawning!.status).toBe("spawning");
  });
});
