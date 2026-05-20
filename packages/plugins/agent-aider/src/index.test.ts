import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createActivitySignal,
  type Session,
  type RuntimeHandle,
  type AgentLaunchConfig,
} from "@aoagents/ao-core";

// Mock fs/promises for getSessionInfo tests (readFile for .aider.chat.history.md)
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
  };
});

// Mock activity log utilities from core
const {
  mockAppendActivityEntry,
  mockReadLastActivityEntry,
  mockRecordTerminalActivity,
  mockIsWindows,
  mockReadFileSync,
} = vi.hoisted(() => ({
  mockAppendActivityEntry: vi.fn().mockResolvedValue(undefined),
  mockReadLastActivityEntry: vi.fn().mockResolvedValue(null),
  mockRecordTerminalActivity: vi.fn().mockResolvedValue(undefined),
  mockIsWindows: vi.fn(() => false),
  mockReadFileSync: vi.fn(() => ""),
}));

vi.mock("@aoagents/ao-core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    appendActivityEntry: mockAppendActivityEntry,
    readLastActivityEntry: mockReadLastActivityEntry,
    recordTerminalActivity: mockRecordTerminalActivity,
    isWindows: mockIsWindows,
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, readFileSync: mockReadFileSync };
});

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const { mockExecFileAsync } = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
}));

vi.mock("node:child_process", () => {
  const fn = Object.assign((..._args: unknown[]) => {}, {
    [Symbol.for("nodejs.util.promisify.custom")]: mockExecFileAsync,
  });
  return { execFile: fn };
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
    activitySignal: createActivitySignal("valid", {
      activity: "active",
      timestamp: new Date(),
      source: "native",
    }),
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

beforeEach(() => {
  vi.clearAllMocks();
});

// =========================================================================
// Manifest & Exports
// =========================================================================
describe("plugin manifest & exports", () => {
  it("has correct manifest", () => {
    expect(manifest).toEqual({
      name: "aider",
      slot: "agent",
      description: "Agent plugin: Aider",
      version: "0.1.0",
      displayName: "Aider",
    });
  });

  it("create() returns agent with correct name and processName", () => {
    const agent = create();
    expect(agent.name).toBe("aider");
    expect(agent.processName).toBe("aider");
  });

  it("default export is a valid PluginModule", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
  });
});

// =========================================================================
// getLaunchCommand
// =========================================================================
describe("getLaunchCommand", () => {
  const agent = create();

  it("generates base command", () => {
    expect(agent.getLaunchCommand(makeLaunchConfig())).toBe("aider");
  });

  it("includes --yes when permissions=permissionless", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "permissionless" }));
    expect(cmd).toContain("--yes");
  });

  it("treats legacy permissions=skip as permissionless", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ permissions: "skip" as unknown as AgentLaunchConfig["permissions"] }),
    );
    expect(cmd).toContain("--yes");
  });

  it("maps permissions=auto-edit to no-prompt mode on Aider", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "auto-edit" }));
    expect(cmd).toContain("--yes");
  });

  it("includes --model with shell-escaped value", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ model: "gpt-4o" }));
    expect(cmd).toContain("--model 'gpt-4o'");
  });

  it("includes --message with shell-escaped prompt", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "Fix the tests" }));
    expect(cmd).toContain("--message 'Fix the tests'");
  });

  it("combines all options", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ permissions: "permissionless", model: "sonnet", prompt: "Go" }),
    );
    expect(cmd).toBe("aider --yes --model 'sonnet' --message 'Go'");
  });

  it("escapes single quotes in prompt", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "it's broken" }));
    if (process.platform === "win32") {
      expect(cmd).toContain("--message 'it''s broken'");
    } else {
      expect(cmd).toContain("--message 'it'\\''s broken'");
    }
  });

  it("omits optional flags when not provided", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).not.toContain("--yes");
    expect(cmd).not.toContain("--model");
    expect(cmd).not.toContain("--message");
  });

  it("inlines systemPromptFile content on Windows instead of $(cat ...)", () => {
    mockIsWindows.mockReturnValueOnce(true);
    mockReadFileSync.mockReturnValueOnce("You are a senior engineer.");
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ systemPromptFile: "C:\\prompts\\sys.md" }),
    );
    expect(cmd).toContain("--system-prompt");
    expect(cmd).toContain("You are a senior engineer.");
    expect(cmd).not.toContain("$(cat");
  });
});

// =========================================================================
// getEnvironment
// =========================================================================
describe("getEnvironment", () => {
  const agent = create();

  it("sets AO_SESSION_ID but not AO_PROJECT_ID (caller's responsibility)", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["AO_SESSION_ID"]).toBe("sess-1");
    expect(env["AO_PROJECT_ID"]).toBeUndefined();
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

  it("returns true when aider found on tmux pane TTY", async () => {
    mockTmuxWithProcess("aider");
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("returns false when aider not on tmux pane TTY", async () => {
    mockTmuxWithProcess("aider", false);
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

  it("returns false for unknown runtime without PID", async () => {
    const handle: RuntimeHandle = { id: "x", runtimeName: "other", data: {} };
    expect(await agent.isProcessRunning(handle)).toBe(false);
  });

  it("returns indeterminate on tmux command failure", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("tmux gone"));
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe("indeterminate");
  });

  it("returns indeterminate when ps command fails", async () => {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") return Promise.resolve({ stdout: "/dev/ttys005\n", stderr: "" });
      if (cmd === "ps") return Promise.reject(new Error("ps timed out"));
      return Promise.reject(new Error("unexpected"));
    });
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe("indeterminate");
  });

  it("returns true when PID exists but throws EPERM", async () => {
    const epermErr = Object.assign(new Error("EPERM"), { code: "EPERM" });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw epermErr;
    });
    expect(await agent.isProcessRunning(makeProcessHandle(789))).toBe(true);
    killSpy.mockRestore();
  });

  it("finds aider on any pane in multi-pane session", async () => {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") {
        return Promise.resolve({ stdout: "/dev/ttys001\n/dev/ttys002\n", stderr: "" });
      }
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: "  PID TT ARGS\n  100 ttys001  bash\n  200 ttys002  aider --yes\n",
          stderr: "",
        });
      }
      return Promise.reject(new Error("unexpected"));
    });
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("returns false for tmux handle on Windows without spawning ps", async () => {
    mockIsWindows.mockReturnValue(true);
    mockExecFileAsync.mockRejectedValue(new Error("ps not available on Windows"));
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
    expect(mockExecFileAsync).not.toHaveBeenCalledWith("ps", expect.anything(), expect.anything());
    mockIsWindows.mockReturnValue(false);
  });
});

describe("isProcessRunning with process runtime", () => {
  it("returns true for a live PID", async () => {
    const handle = {
      id: "test-session",
      runtimeName: "process",
      data: { pid: process.pid }, // current process — known alive
    };
    const agent = create();
    const result = await agent.isProcessRunning(handle as unknown as RuntimeHandle);
    expect(result).toBe(true);
  });

  it("returns false for a dead PID", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementationOnce(() => {
      const err = Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      throw err;
    });
    const handle = { id: "test", runtimeName: "process", data: { pid: 999999 } };
    const agent = create();
    const result = await agent.isProcessRunning(handle as any);
    expect(result).toBe(false);
    killSpy.mockRestore();
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

  it("returns idle when prompt char visible", () => {
    expect(agent.detectActivity("some output\n> ")).toBe("idle");
    expect(agent.detectActivity("some output\n$ ")).toBe("idle");
  });

  it("returns idle for aider-specific prompt", () => {
    expect(agent.detectActivity("Tokens: 1.2k\naider> ")).toBe("idle");
  });

  it("returns waiting_input for Y/N confirmation", () => {
    expect(agent.detectActivity("Allow creation of new file foo.ts\n(Y)es/(N)o")).toBe(
      "waiting_input",
    );
  });

  it("returns waiting_input for add-to-chat prompt", () => {
    expect(agent.detectActivity("Add src/utils.ts to the chat? (Y)es/(N)o")).toBe("waiting_input");
  });

  it("returns waiting_input for proceed prompt", () => {
    expect(agent.detectActivity("This will modify 5 files. proceed?")).toBe("waiting_input");
  });

  it("returns active for non-empty terminal output", () => {
    expect(agent.detectActivity("aider is processing files\n")).toBe("active");
  });
});

// =========================================================================
// getSessionInfo
// =========================================================================
describe("getSessionInfo", () => {
  const agent = create();

  it("returns null when workspacePath is null", async () => {
    expect(await agent.getSessionInfo(makeSession({ workspacePath: null }))).toBeNull();
  });

  it("returns null when no chat history file exists", async () => {
    const { readFile } = await import("node:fs/promises");
    vi.mocked(readFile).mockRejectedValueOnce(new Error("ENOENT"));
    expect(await agent.getSessionInfo(makeSession())).toBeNull();
  });

  it("extracts summary from chat history file", async () => {
    const { readFile } = await import("node:fs/promises");
    vi.mocked(readFile).mockResolvedValueOnce(
      "# aider chat started\n\n#### Fix the login bug in auth.ts\n\nSome response here...\n",
    );
    const info = await agent.getSessionInfo(makeSession());
    expect(info).not.toBeNull();
    expect(info!.summary).toBe("Fix the login bug in auth.ts");
    expect(info!.summaryIsFallback).toBe(true);
    expect(info!.agentSessionId).toBeNull();
    expect(info!.cost).toBeUndefined();
  });

  it("truncates long summaries to 120 chars", async () => {
    const { readFile } = await import("node:fs/promises");
    const longMsg = "A".repeat(200);
    vi.mocked(readFile).mockResolvedValueOnce(`#### ${longMsg}\n`);
    const info = await agent.getSessionInfo(makeSession());
    expect(info!.summary).toHaveLength(123); // 120 + "..."
    expect(info!.summary!.endsWith("...")).toBe(true);
  });
});

// =========================================================================
// getRestoreCommand
// =========================================================================
describe("getRestoreCommand", () => {
  const agent = create();

  it("returns null (aider does not support session resume)", async () => {
    const result = await agent.getRestoreCommand!(makeSession(), {
      name: "proj",
      repo: "o/r",
      path: "/p",
      defaultBranch: "main",
      sessionPrefix: "p",
    });
    expect(result).toBeNull();
  });
});

// =========================================================================
// setupWorkspaceHooks
// =========================================================================
describe("setupWorkspaceHooks", () => {
  const agent = create();

  it("is defined (delegates to shared setupPathWrapperWorkspace)", () => {
    expect(agent.setupWorkspaceHooks).toBeDefined();
    expect(typeof agent.setupWorkspaceHooks).toBe("function");
  });
});

// =========================================================================
// postLaunchSetup
// =========================================================================
describe("postLaunchSetup", () => {
  const agent = create();

  it("is defined", () => {
    expect(agent.postLaunchSetup).toBeDefined();
    expect(typeof agent.postLaunchSetup).toBe("function");
  });

  it("does nothing when workspacePath is null", async () => {
    // Should not throw
    await agent.postLaunchSetup!(makeSession({ workspacePath: null }));
  });
});

// =========================================================================
// getEnvironment — PATH wrapping
// =========================================================================
describe("getEnvironment PATH", () => {
  const agent = create();

  it("does not set PATH (injected by session-manager)", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["PATH"]).toBeUndefined();
  });

  it("does not set GH_PATH (injected by session-manager)", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["GH_PATH"]).toBeUndefined();
  });
});

// =========================================================================
// recordActivity
// =========================================================================
describe("recordActivity", () => {
  const agent = create();

  it("is defined", () => {
    expect(agent.recordActivity).toBeDefined();
  });

  it("does nothing when workspacePath is null", async () => {
    await agent.recordActivity!(makeSession({ workspacePath: null }), "some output");
    expect(mockRecordTerminalActivity).not.toHaveBeenCalled();
  });

  it("delegates to recordTerminalActivity", async () => {
    await agent.recordActivity!(makeSession(), "aider is processing files");
    expect(mockRecordTerminalActivity).toHaveBeenCalledWith(
      "/workspace/test",
      "aider is processing files",
      expect.any(Function),
    );
  });
});

// =========================================================================
// getActivityState — reads from activity JSONL
// =========================================================================
describe("getActivityState with activity JSONL", () => {
  const agent = create();

  it("returns waiting_input from activity JSONL", async () => {
    mockTmuxWithProcess("aider");
    mockReadLastActivityEntry.mockResolvedValueOnce({
      entry: { ts: new Date().toISOString(), state: "waiting_input", source: "terminal" },
      modifiedAt: new Date(),
    });

    const result = await agent.getActivityState(makeSession({ runtimeHandle: makeTmuxHandle() }));
    expect(result?.state).toBe("waiting_input");
  });

  it("returns blocked from activity JSONL", async () => {
    mockTmuxWithProcess("aider");
    mockReadLastActivityEntry.mockResolvedValueOnce({
      entry: { ts: new Date().toISOString(), state: "blocked", source: "terminal" },
      modifiedAt: new Date(),
    });

    const result = await agent.getActivityState(makeSession({ runtimeHandle: makeTmuxHandle() }));
    expect(result?.state).toBe("blocked");
  });

  it("falls through to JSONL mtime fallback for non-critical states when native signals unavailable", async () => {
    mockTmuxWithProcess("aider");
    mockReadLastActivityEntry.mockResolvedValueOnce({
      entry: { ts: new Date().toISOString(), state: "active", source: "terminal" },
      modifiedAt: new Date(),
    });

    // Non-critical "active" from AO JSONL is ignored by checkActivityLogState —
    // falls through to git/chat fallbacks. With no git commits or chat history,
    // falls through to JSONL mtime fallback (step 4) which returns "active"
    // since modifiedAt is recent.
    const result = await agent.getActivityState(makeSession({ runtimeHandle: makeTmuxHandle() }));
    expect(result?.state).toBe("active");
  });
});
