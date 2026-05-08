import { describe, it, expect, vi, beforeEach } from "vitest";
import { createActivitySignal, createInitialCanonicalLifecycle, type Session, type RuntimeHandle, type AgentLaunchConfig } from "@aoagents/ao-core";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const { mockExecFileAsync, mockReadLastActivityEntry } = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
  mockReadLastActivityEntry: vi.fn(),
}));

vi.mock("node:child_process", () => {
  const fn = Object.assign((..._args: unknown[]) => {}, {
    [Symbol.for("nodejs.util.promisify.custom")]: mockExecFileAsync,
  });
  return { execFile: fn, execFileSync: vi.fn() };
});

vi.mock("@aoagents/ao-core", async (importOriginal: () => Promise<Record<string, unknown>>) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readLastActivityEntry: mockReadLastActivityEntry,
    recordTerminalActivity: vi.fn(),
  };
});

import { create, manifest, default as defaultExport } from "./index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "test-1",
    projectId: "test-project",
    status: "working",
    activity: "active",
    activitySignal: createActivitySignal("null"),
    lifecycle: createInitialCanonicalLifecycle("worker"),
    branch: "feat/test",
    issueId: null,
    pr: null,
    workspacePath: "/workspace/test",
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

function makeTmuxHandle(id = "test-session"): RuntimeHandle {
  return { id, runtimeName: "tmux", data: {} };
}

function makeProcessHandle(pid?: number): RuntimeHandle {
  return { id: "proc-1", runtimeName: "process", data: pid !== undefined ? { pid } : {} };
}

function makeLaunchConfig(overrides: Partial<AgentLaunchConfig> = {}): AgentLaunchConfig {
  return {
    sessionId: "sess-1",
    projectConfig: {
      name: "my-project",
      repo: "owner/repo",
      path: "/workspace/repo",
      defaultBranch: "main",
      sessionPrefix: "my",
    },
    ...overrides,
  };
}

function mockTmuxWithProcess(processName: string, found = true) {
  mockExecFileAsync.mockImplementation((cmd: string) => {
    if (cmd === "tmux") return Promise.resolve({ stdout: "/dev/ttys005\n", stderr: "" });
    if (cmd === "ps") {
      const line = found ? `  444 ttys005  ${processName}` : "  444 ttys005  zsh";
      return Promise.resolve({
        stdout: `  PID TT       ARGS\n${line}\n`,
        stderr: "",
      });
    }
    return Promise.reject(new Error("unexpected"));
  });
}

// Activity entry builders
function makeActivityEntry(
  state: string,
  ageMs: number,
): { entry: { ts: string; state: string; source: string }; modifiedAt: Date } {
  const ts = new Date(Date.now() - ageMs);
  return {
    entry: {
      ts: ts.toISOString(),
      state,
      source: "terminal",
    },
    modifiedAt: ts,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockReadLastActivityEntry.mockResolvedValue(null);
});

// =========================================================================
// Manifest & Exports
// =========================================================================
describe("plugin manifest & exports", () => {
  it("has correct manifest", () => {
    expect(manifest).toEqual({
      name: "amp",
      slot: "agent",
      description: "Agent plugin: Amp CLI",
      version: "0.1.0",
      displayName: "Amp",
    });
  });

  it("create() returns agent with correct name and processName", () => {
    const agent = create();
    expect(agent.name).toBe("amp");
    expect(agent.processName).toBe("amp");
  });

  it("default export is a valid PluginModule", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
  });

  it("agent has promptDelivery set to post-launch", () => {
    const agent = create();
    expect(agent.promptDelivery).toBe("post-launch");
  });
});

// =========================================================================
// getLaunchCommand
// =========================================================================
describe("getLaunchCommand", () => {
  const agent = create();

  it("generates new thread command with --execute --dangerously-allow-all --no-ide", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).toBe("amp threads new --execute --dangerously-allow-all --no-ide");
  });

  it("continues existing thread when ampThreadId is in agentConfig", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        projectConfig: {
          name: "my-project",
          repo: "owner/repo",
          path: "/workspace/repo",
          defaultBranch: "main",
          sessionPrefix: "my",
          agentConfig: { ampThreadId: "abc-123" },
        },
      }),
    );
    expect(cmd).toContain("threads continue");
    expect(cmd).toContain("abc-123");
    expect(cmd).toContain("--execute");
    expect(cmd).toContain("--dangerously-allow-all");
  });

  it("uses new thread when no ampThreadId", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ model: "smart" }));
    expect(cmd).toContain("threads new");
    expect(cmd).not.toContain("continue");
  });
});

// =========================================================================
// getEnvironment
// =========================================================================
describe("getEnvironment", () => {
  const agent = create();

  it("sets AO_SESSION_ID", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["AO_SESSION_ID"]).toBe("sess-1");
  });

  it("sets AO_ISSUE_ID when provided", () => {
    const env = agent.getEnvironment(makeLaunchConfig({ issueId: "LIN-99" }));
    expect(env["AO_ISSUE_ID"]).toBe("LIN-99");
  });

  it("omits AO_ISSUE_ID when not provided", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["AO_ISSUE_ID"]).toBeUndefined();
  });
});

// =========================================================================
// isProcessRunning
// =========================================================================
describe("isProcessRunning", () => {
  const agent = create();

  it("returns true when amp process found on tmux pane TTY", async () => {
    mockTmuxWithProcess("amp");
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("returns false when amp process not on tmux pane TTY", async () => {
    mockTmuxWithProcess("amp", false);
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("returns true for process handle with alive PID", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(await agent.isProcessRunning(makeProcessHandle(456))).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(456, 0);
    killSpy.mockRestore();
  });

  it("returns false for process handle with dead PID", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    expect(await agent.isProcessRunning(makeProcessHandle(456))).toBe(false);
    killSpy.mockRestore();
  });

  it("returns true when PID exists but throws EPERM", async () => {
    const epermErr = Object.assign(new Error("EPERM"), { code: "EPERM" });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw epermErr;
    });
    expect(await agent.isProcessRunning(makeProcessHandle(789))).toBe(true);
    killSpy.mockRestore();
  });

  it("returns false on tmux command failure", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("tmux gone"));
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });
});

// =========================================================================
// detectActivity — terminal output classification
// =========================================================================
describe("detectActivity", () => {
  const agent = create();

  it("returns idle for empty terminal output", () => {
    expect(agent.detectActivity("")).toBe("idle");
  });

  it("returns idle for whitespace-only terminal output", () => {
    expect(agent.detectActivity("   \n  ")).toBe("idle");
  });

  it("returns active for non-empty terminal output", () => {
    expect(agent.detectActivity("amp is processing\n")).toBe("active");
  });

  it("returns waiting_input for permission prompt patterns", () => {
    expect(agent.detectActivity("Waiting for user confirmation")).toBe("waiting_input");
  });

  it("returns blocked for error patterns", () => {
    expect(agent.detectActivity("Error: command failed")).toBe("blocked");
  });
});

// =========================================================================
// getActivityState — required 7 test cases per CLAUDE.md spec
// =========================================================================
describe("getActivityState", () => {
  const agent = create();

  // 1. Returns exited when process not running
  it("returns exited when process is not running", async () => {
    const handle = makeTmuxHandle();
    const session = makeSession({ runtimeHandle: handle, workspacePath: "/workspace/test" });
    mockTmuxWithProcess("amp", false);
    const result = await agent.getActivityState(session);
    expect(result?.state).toBe("exited");
  });

  // 1b. Returns exited when runtimeHandle is null
  it("returns exited when runtimeHandle is null", async () => {
    const session = makeSession({ runtimeHandle: null });
    const result = await agent.getActivityState(session);
    expect(result?.state).toBe("exited");
  });

  // 2. Returns waiting_input from JSONL
  it("returns waiting_input from JSONL when agent is at a permission prompt", async () => {
    const handle = makeTmuxHandle();
    const session = makeSession({ runtimeHandle: handle, workspacePath: "/workspace/test" });
    mockTmuxWithProcess("amp", true);
    mockReadLastActivityEntry.mockResolvedValue(makeActivityEntry("waiting_input", 1000));
    const result = await agent.getActivityState(session);
    expect(result?.state).toBe("waiting_input");
  });

  // 3. Returns blocked from JSONL
  it("returns blocked from JSONL when agent hit an error", async () => {
    const handle = makeTmuxHandle();
    const session = makeSession({ runtimeHandle: handle, workspacePath: "/workspace/test" });
    mockTmuxWithProcess("amp", true);
    mockReadLastActivityEntry.mockResolvedValue(makeActivityEntry("blocked", 1000));
    const result = await agent.getActivityState(session);
    expect(result?.state).toBe("blocked");
  });

  // 4. Returns active from JSONL fallback (fresh entry)
  it("returns active from JSONL fallback when entry is fresh", async () => {
    const handle = makeTmuxHandle();
    const session = makeSession({ runtimeHandle: handle, workspacePath: "/workspace/test" });
    mockTmuxWithProcess("amp", true);
    mockReadLastActivityEntry.mockResolvedValue(makeActivityEntry("active", 5_000)); // 5s ago
    const result = await agent.getActivityState(session);
    expect(result?.state).toBe("active");
  });

  // 5. Returns idle from JSONL fallback (old entry with age decay)
  it("returns idle from JSONL fallback when entry is old", async () => {
    const handle = makeTmuxHandle();
    const session = makeSession({ runtimeHandle: handle, workspacePath: "/workspace/test" });
    mockTmuxWithProcess("amp", true);
    mockReadLastActivityEntry.mockResolvedValue(makeActivityEntry("active", 400_000)); // >5min ago
    const result = await agent.getActivityState(session);
    expect(result?.state).toBe("idle");
  });

  // 6. Returns null when no data available
  it("returns null when both JSONL and activity data are unavailable", async () => {
    const handle = makeTmuxHandle();
    const session = makeSession({ runtimeHandle: handle, workspacePath: null });
    mockTmuxWithProcess("amp", true);
    mockReadLastActivityEntry.mockResolvedValue(null);
    const result = await agent.getActivityState(session);
    expect(result).toBeNull();
  });

  // 7. Returns ready from JSONL fallback (mid-age entry)
  it("returns ready from JSONL fallback for mid-age entry (30s–5min)", async () => {
    const handle = makeTmuxHandle();
    const session = makeSession({ runtimeHandle: handle, workspacePath: "/workspace/test" });
    mockTmuxWithProcess("amp", true);
    mockReadLastActivityEntry.mockResolvedValue(makeActivityEntry("active", 60_000)); // 1min ago
    const result = await agent.getActivityState(session);
    expect(result?.state).toBe("ready");
  });
});

// =========================================================================
// getSessionInfo
// =========================================================================
describe("getSessionInfo", () => {
  const agent = create();

  it("always returns null (not implemented)", async () => {
    expect(await agent.getSessionInfo(makeSession())).toBeNull();
  });
});
