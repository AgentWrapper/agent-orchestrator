import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createActivitySignal,
  type Session,
  type RuntimeHandle,
  type AgentLaunchConfig,
  type AgentSpecificConfig,
} from "@aoagents/ao-core";

// ---------------------------------------------------------------------------
// Hoisted mocks — available inside vi.mock factories
// ---------------------------------------------------------------------------
const {
  mockExecFileAsync,
  mockWriteFile,
  mockMkdir,
  mockReadFile,
  mockReaddir,
  mockRename,
  mockStat,
  mockLstat,
  mockOpen,
  mockCreateReadStream,
  mockHomedir,
  mockReadLastJsonlEntry,
} = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
  mockWriteFile: vi.fn().mockResolvedValue(undefined),
  mockMkdir: vi.fn().mockResolvedValue(undefined),
  mockReadFile: vi.fn(),
  mockReaddir: vi.fn(),
  mockRename: vi.fn().mockResolvedValue(undefined),
  mockStat: vi.fn(),
  mockLstat: vi.fn(),
  mockOpen: vi.fn(),
  mockCreateReadStream: vi.fn(),
  mockHomedir: vi.fn(() => "/mock/home"),
  mockReadLastJsonlEntry: vi.fn(),
}));

vi.mock("node:child_process", () => {
  const fn = Object.assign((..._args: unknown[]) => {}, {
    [Symbol.for("nodejs.util.promisify.custom")]: mockExecFileAsync,
  });
  return { execFile: fn };
});

vi.mock("node:fs/promises", () => ({
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
  readFile: mockReadFile,
  readdir: mockReaddir,
  rename: mockRename,
  stat: mockStat,
  lstat: mockLstat,
  open: mockOpen,
}));

vi.mock("node:crypto", () => ({
  randomBytes: () => ({ toString: () => "abc123" }),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  createReadStream: mockCreateReadStream,
}));

vi.mock("node:os", () => ({
  homedir: mockHomedir,
}));

vi.mock("@aoagents/ao-core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    readLastJsonlEntry: mockReadLastJsonlEntry,
  };
});

import { Readable } from "node:stream";
import {
  create,
  manifest,
  default as defaultExport,
  resolveCodexBinary,
  _resetSessionFileCache,
} from "./index.js";

// ---------------------------------------------------------------------------
// Test helpers
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

function makeProcessHandle(pid?: number | string): RuntimeHandle {
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
  mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === "tmux" && args[0] === "list-panes") {
      return Promise.resolve({ stdout: "/dev/ttys003\n", stderr: "" });
    }
    if (cmd === "ps") {
      const line = found ? `  789 ttys003  ${processName}` : "  789 ttys003  bash";
      return Promise.resolve({
        stdout: `  PID TT       ARGS\n${line}\n`,
        stderr: "",
      });
    }
    return Promise.reject(new Error(`Unexpected: ${cmd} ${args.join(" ")}`));
  });
}

/**
 * Create a mock file handle for `open()` that streams `content` across
 * successive `read()` calls. Tracks an internal cursor so sequential reads
 * advance through the buffer and eventually return `bytesRead: 0` at EOF.
 * Without position tracking, readJsonlPrefixLines would loop forever on
 * lines larger than its chunk size.
 */
function makeFakeFileHandle(content: string) {
  const buf = Buffer.from(content, "utf-8");
  let cursor = 0;
  return {
    read: vi
      .fn()
      .mockImplementation((buffer: Buffer, offset: number, length: number, _position: number) => {
        if (cursor >= buf.length) {
          return Promise.resolve({ bytesRead: 0, buffer });
        }
        const bytesToCopy = Math.min(length, buf.length - cursor);
        buf.copy(buffer, offset, cursor, cursor + bytesToCopy);
        cursor += bytesToCopy;
        return Promise.resolve({ bytesRead: bytesToCopy, buffer });
      }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Set up mockOpen so that any `open(path, "r")` call returns a fake handle
 * reading `content`. This is used by sessionFileMatchesCwd.
 */
function setupMockOpen(content: string) {
  mockOpen.mockResolvedValue(makeFakeFileHandle(content));
}

/**
 * Create a Readable stream from a string. Used to mock createReadStream
 * for the streaming JSONL parser (streamCodexSessionData).
 */
function makeContentStream(content: string): Readable {
  return Readable.from(Buffer.from(content, "utf-8"));
}

/**
 * Set up mockCreateReadStream to return a readable stream with the given content.
 * Used by getSessionInfo/getRestoreCommand which stream files line-by-line.
 */
function setupMockStream(content: string) {
  mockCreateReadStream.mockReturnValue(makeContentStream(content));
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetSessionFileCache();
  mockHomedir.mockReturnValue("/mock/home");
  // Default: open() returns a handle with empty content (no session_meta match).
  // Session tests call setupMockOpen(content) to override.
  mockOpen.mockResolvedValue(makeFakeFileHandle(""));
  // Default: lstat rejects (no subdirectories). Session tests override as needed.
  mockLstat.mockRejectedValue(new Error("ENOENT"));
  // Default: createReadStream returns an empty stream. Session tests call
  // setupMockStream(content) to override.
  mockCreateReadStream.mockReturnValue(makeContentStream(""));
});

// =========================================================================
// Manifest & Exports
// =========================================================================
describe("plugin manifest & exports", () => {
  it("has correct manifest", () => {
    expect(manifest).toEqual({
      name: "codex",
      slot: "agent",
      description: "Agent plugin: OpenAI Codex CLI",
      version: "0.1.1",
      displayName: "OpenAI Codex",
    });
  });

  it("create() returns agent with correct name and processName", () => {
    const agent = create();
    expect(agent.name).toBe("codex");
    expect(agent.processName).toBe("codex");
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
    expect(agent.getLaunchCommand(makeLaunchConfig())).toBe(
      "'codex' -c check_for_update_on_startup=false",
    );
  });

  it("includes bypass flag when permissions=permissionless", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "permissionless" }));
    expect(cmd).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(cmd).not.toContain("--ask-for-approval");
    expect(cmd).not.toContain("--full-auto");
  });

  it("treats legacy permissions=skip as permissionless", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ permissions: "skip" as unknown as AgentLaunchConfig["permissions"] }),
    );
    expect(cmd).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("includes --ask-for-approval never when permissions=auto-edit", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "auto-edit" }));
    expect(cmd).toContain("--ask-for-approval never");
  });

  it("includes --ask-for-approval untrusted when permissions=suggest", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "suggest" }));
    expect(cmd).toContain("--ask-for-approval untrusted");
  });

  it("omits approval flags when permissions=default", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "default" }));
    expect(cmd).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(cmd).not.toContain("--ask-for-approval");
    expect(cmd).not.toContain("--full-auto");
  });

  it("includes --model with shell-escaped value", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ model: "gpt-4o" }));
    expect(cmd).toContain("--model 'gpt-4o'");
  });

  it("appends shell-escaped prompt with -- separator", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "Fix it" }));
    expect(cmd).toContain("-- 'Fix it'");
  });

  it("combines all options", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ permissions: "permissionless", model: "o3", prompt: "Go" }),
    );
    expect(cmd).toBe(
      "'codex' -c check_for_update_on_startup=false --dangerously-bypass-approvals-and-sandbox --model 'o3' -c model_reasoning_effort=high -- 'Go'",
    );
  });

  it("escapes single quotes in prompt (POSIX shell escaping)", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "it's broken" }));
    expect(cmd).toContain("-- 'it'\\''s broken'");
  });

  it("escapes dangerous characters in prompt", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "$(rm -rf /); `evil`; $HOME" }));
    // Single-quoted strings prevent shell expansion
    expect(cmd).toContain("-- '$(rm -rf /); `evil`; $HOME'");
  });

  it("includes -c model_instructions_file when systemPromptFile is set", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ systemPromptFile: "/tmp/prompt.md" }));
    expect(cmd).toContain("-c model_instructions_file='/tmp/prompt.md'");
  });

  it("prefers systemPromptFile over systemPrompt", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ systemPromptFile: "/tmp/prompt.md", systemPrompt: "Ignored" }),
    );
    expect(cmd).toContain("model_instructions_file='/tmp/prompt.md'");
    expect(cmd).not.toContain("'Ignored'");
  });

  it("includes -c developer_instructions when systemPrompt is set", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ systemPrompt: "Be helpful" }));
    expect(cmd).toContain("-c developer_instructions='Be helpful'");
  });

  it("omits optional flags when not provided", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(cmd).not.toContain("--ask-for-approval");
    expect(cmd).not.toContain("--model");
    expect(cmd).toContain("-c check_for_update_on_startup=false");
    expect(cmd).not.toContain("model_reasoning_effort");
  });

  it("always includes -c check_for_update_on_startup=false", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ model: "gpt-4o", prompt: "Fix it" }));
    expect(cmd).toContain("-c check_for_update_on_startup=false");
  });

  // -- Reasoning effort tests --
  describe("reasoning effort", () => {
    it("adds model_reasoning_effort=high for o3 model", () => {
      const cmd = agent.getLaunchCommand(makeLaunchConfig({ model: "o3" }));
      expect(cmd).toContain("-c model_reasoning_effort=high");
    });

    it("adds model_reasoning_effort=high for o3-mini model", () => {
      const cmd = agent.getLaunchCommand(makeLaunchConfig({ model: "o3-mini" }));
      expect(cmd).toContain("-c model_reasoning_effort=high");
    });

    it("adds model_reasoning_effort=high for o4-mini model", () => {
      const cmd = agent.getLaunchCommand(makeLaunchConfig({ model: "o4-mini" }));
      expect(cmd).toContain("-c model_reasoning_effort=high");
    });

    it("adds model_reasoning_effort=high for O3 (case-insensitive)", () => {
      const cmd = agent.getLaunchCommand(makeLaunchConfig({ model: "O3" }));
      expect(cmd).toContain("-c model_reasoning_effort=high");
    });

    it("adds model_reasoning_effort=high for O4-MINI (case-insensitive)", () => {
      const cmd = agent.getLaunchCommand(makeLaunchConfig({ model: "O4-MINI" }));
      expect(cmd).toContain("-c model_reasoning_effort=high");
    });

    it("does NOT add reasoning effort for gpt-4o model", () => {
      const cmd = agent.getLaunchCommand(makeLaunchConfig({ model: "gpt-4o" }));
      expect(cmd).not.toContain("model_reasoning_effort");
    });

    it("does NOT add reasoning effort for gpt-4.1 model", () => {
      const cmd = agent.getLaunchCommand(makeLaunchConfig({ model: "gpt-4.1" }));
      expect(cmd).not.toContain("model_reasoning_effort");
    });

    it("does NOT add reasoning effort when no model specified", () => {
      const cmd = agent.getLaunchCommand(makeLaunchConfig());
      expect(cmd).not.toContain("model_reasoning_effort");
    });
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
    const env = agent.getEnvironment(makeLaunchConfig({ issueId: "GH-42" }));
    expect(env["AO_ISSUE_ID"]).toBe("GH-42");
  });

  it("omits AO_ISSUE_ID when not provided", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["AO_ISSUE_ID"]).toBeUndefined();
  });

  it("does not set PATH (injected by session-manager)", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["PATH"]).toBeUndefined();
  });

  it("sets CODEX_DISABLE_UPDATE_CHECK=1 to suppress interactive update prompts", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["CODEX_DISABLE_UPDATE_CHECK"]).toBe("1");
  });

  it("does not set GH_PATH (injected by session-manager)", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["GH_PATH"]).toBeUndefined();
  });
});

// =========================================================================
// isProcessRunning
// =========================================================================
describe("isProcessRunning", () => {
  const agent = create();

  it("returns true when codex found on tmux pane TTY", async () => {
    mockTmuxWithProcess("codex");
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("returns false when codex not on tmux pane TTY", async () => {
    mockTmuxWithProcess("codex", false);
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("returns false when tmux list-panes returns empty", async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("returns true for process handle with alive PID", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(await agent.isProcessRunning(makeProcessHandle(123))).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(123, 0);
    killSpy.mockRestore();
  });

  it("returns false for process handle with dead PID", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    expect(await agent.isProcessRunning(makeProcessHandle(123))).toBe(false);
    killSpy.mockRestore();
  });

  it("returns false for unknown runtime without PID", async () => {
    const handle: RuntimeHandle = { id: "x", runtimeName: "other", data: {} };
    expect(await agent.isProcessRunning(handle)).toBe(false);
    // Must NOT call external commands — could match wrong session
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it("returns false on tmux command failure", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("tmux not running"));
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("returns true when PID exists but throws EPERM", async () => {
    const epermErr = Object.assign(new Error("EPERM"), { code: "EPERM" });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw epermErr;
    });
    expect(await agent.isProcessRunning(makeProcessHandle(789))).toBe(true);
    killSpy.mockRestore();
  });

  it("finds codex on any pane in multi-pane session", async () => {
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "list-panes") {
        return Promise.resolve({ stdout: "/dev/ttys001\n/dev/ttys002\n", stderr: "" });
      }
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: "  PID TT ARGS\n  100 ttys001  bash\n  200 ttys002  codex --model o3\n",
          stderr: "",
        });
      }
      return Promise.reject(new Error("unexpected"));
    });
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("does not match similar process names like codex-something", async () => {
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "list-panes") {
        return Promise.resolve({ stdout: "/dev/ttys001\n", stderr: "" });
      }
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: "  PID TT ARGS\n  100 ttys001  /usr/bin/codex-helper\n",
          stderr: "",
        });
      }
      return Promise.reject(new Error("unexpected"));
    });
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("handles string PID by converting to number", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(await agent.isProcessRunning(makeProcessHandle("456"))).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(456, 0);
    killSpy.mockRestore();
  });

  it("returns false for non-numeric PID", async () => {
    expect(await agent.isProcessRunning(makeProcessHandle("not-a-pid"))).toBe(false);
  });
});

// =========================================================================
// detectActivity — terminal output classification
// =========================================================================
describe("detectActivity", () => {
  const agent = create();

  // -- Idle states --
  it("returns idle for empty terminal output", () => {
    expect(agent.detectActivity("")).toBe("idle");
  });

  it("returns idle for whitespace-only terminal output", () => {
    expect(agent.detectActivity("   \n  ")).toBe("idle");
  });

  it("returns idle when last line is a bare > prompt", () => {
    expect(agent.detectActivity("some output\n> ")).toBe("idle");
  });

  it("returns idle when last line is a bare $ prompt", () => {
    expect(agent.detectActivity("some output\n$ ")).toBe("idle");
  });

  it("returns idle when last line is a bare # prompt", () => {
    expect(agent.detectActivity("some output\n# ")).toBe("idle");
  });

  it("returns idle when prompt follows historical activity indicators", () => {
    // Key regression test: historical active output in the buffer
    // should NOT override an idle prompt on the last line.
    expect(agent.detectActivity("✶ Reading files\nDone.\n> ")).toBe("idle");
    expect(agent.detectActivity("Working on task (esc to interrupt)\nFinished.\n$ ")).toBe("idle");
  });

  // -- Waiting input states --
  it("returns waiting_input for approval required text", () => {
    expect(agent.detectActivity("some output\napproval required\n")).toBe("waiting_input");
  });

  it("returns waiting_input for (y)es / (n)o prompt", () => {
    expect(agent.detectActivity("Do you want to continue?\n(y)es / (n)o\n")).toBe("waiting_input");
  });

  it("returns waiting_input when permission prompt follows historical activity", () => {
    // Permission prompt at the bottom should NOT be overridden by historical
    // spinner/esc output higher in the buffer.
    expect(agent.detectActivity("✶ Writing files\nDone.\napproval required\n")).toBe(
      "waiting_input",
    );
    expect(agent.detectActivity("Working (esc to interrupt)\nFinished\n(y)es / (n)o\n")).toBe(
      "waiting_input",
    );
  });

  // -- Active states --
  it("returns active for non-empty terminal output with no special patterns", () => {
    expect(agent.detectActivity("codex is running some task\n")).toBe("active");
  });

  it("returns active when (esc to interrupt) is present", () => {
    expect(agent.detectActivity("Working on task (esc to interrupt)\n")).toBe("active");
  });

  it("returns active for spinner symbols with -ing words", () => {
    expect(agent.detectActivity("✶ Reading files\n")).toBe("active");
    expect(agent.detectActivity("⏺ Writing to disk\n")).toBe("active");
    expect(agent.detectActivity("✽ Searching codebase\n")).toBe("active");
    expect(agent.detectActivity("⏳ Installing packages\n")).toBe("active");
  });

  it("returns active (not idle) for spinner symbol without -ing word", () => {
    // Spinner symbols alone without -ing words should still fall through to active
    expect(agent.detectActivity("✶ done\n")).toBe("active");
  });

  it("returns active for multi-line output with activity in the middle", () => {
    expect(agent.detectActivity("Starting\n(esc to interrupt)\nstill going\n")).toBe("active");
  });
});

// =========================================================================
// getActivityState
// =========================================================================
describe("getActivityState", () => {
  const agent = create();

  it("returns exited when no runtimeHandle", async () => {
    const session = makeSession({ runtimeHandle: null });
    const result = await agent.getActivityState(session);
    expect(result?.state).toBe("exited");
    expect(result?.timestamp).toBeInstanceOf(Date);
  });

  it("returns exited when process is not running", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("tmux not running"));
    const session = makeSession({ runtimeHandle: makeTmuxHandle() });
    const result = await agent.getActivityState(session);
    expect(result?.state).toBe("exited");
    expect(result?.timestamp).toBeInstanceOf(Date);
  });

  it("returns null when process is running but no workspacePath", async () => {
    mockTmuxWithProcess("codex");
    const session = makeSession({ runtimeHandle: makeTmuxHandle(), workspacePath: undefined });
    expect(await agent.getActivityState(session)).toBeNull();
  });

  it("returns null when process is running but no session file found", async () => {
    mockTmuxWithProcess("codex");
    mockReaddir.mockRejectedValue(new Error("ENOENT"));
    const session = makeSession({
      runtimeHandle: makeTmuxHandle(),
      workspacePath: "/workspace/test",
    });
    expect(await agent.getActivityState(session)).toBeNull();
  });

  it("returns active when session file was recently modified", async () => {
    mockTmuxWithProcess("codex");
    const content = '{"type":"session_meta","cwd":"/workspace/test"}\n';
    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    setupMockOpen(content);
    mockStat.mockResolvedValue({ mtimeMs: Date.now(), mtime: new Date() });
    // Mock readLastJsonlEntry to return a recent entry
    mockReadLastJsonlEntry.mockResolvedValue({
      lastType: "tool_call",
      modifiedAt: new Date(),
    });

    const session = makeSession({
      runtimeHandle: makeTmuxHandle(),
      workspacePath: "/workspace/test",
    });
    const result = await agent.getActivityState(session);
    expect(result?.state).toBe("active");
    expect(result?.timestamp).toBeInstanceOf(Date);
  });

  it("returns idle when session file is stale", async () => {
    mockTmuxWithProcess("codex");
    const content = '{"type":"session_meta","cwd":"/workspace/test"}\n';
    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    setupMockOpen(content);
    const staleTime = Date.now() - 600_000;
    mockStat.mockResolvedValue({ mtimeMs: staleTime, mtime: new Date(staleTime) });
    // Mock readLastJsonlEntry to return a stale entry
    mockReadLastJsonlEntry.mockResolvedValue({
      lastType: "assistant_message",
      modifiedAt: new Date(staleTime),
    });

    const session = makeSession({
      runtimeHandle: makeTmuxHandle(),
      workspacePath: "/workspace/test",
    });
    const result = await agent.getActivityState(session);
    expect(result?.state).toBe("idle");
    expect(result?.timestamp).toBeInstanceOf(Date);
  });

  it("returns waiting_input for approval_request entry type", async () => {
    mockTmuxWithProcess("codex");
    const content = '{"type":"session_meta","cwd":"/workspace/test"}\n';
    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    setupMockOpen(content);
    mockStat.mockResolvedValue({ mtimeMs: Date.now(), mtime: new Date() });
    mockReadLastJsonlEntry.mockResolvedValue({
      lastType: "approval_request",
      modifiedAt: new Date(),
    });

    const session = makeSession({
      runtimeHandle: makeTmuxHandle(),
      workspacePath: "/workspace/test",
    });
    const result = await agent.getActivityState(session);
    expect(result?.state).toBe("waiting_input");
  });

  it("returns blocked for error entry type", async () => {
    mockTmuxWithProcess("codex");
    const content = '{"type":"session_meta","cwd":"/workspace/test"}\n';
    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    setupMockOpen(content);
    mockStat.mockResolvedValue({ mtimeMs: Date.now(), mtime: new Date() });
    mockReadLastJsonlEntry.mockResolvedValue({
      lastType: "error",
      modifiedAt: new Date(),
    });

    const session = makeSession({
      runtimeHandle: makeTmuxHandle(),
      workspacePath: "/workspace/test",
    });
    const result = await agent.getActivityState(session);
    expect(result?.state).toBe("blocked");
  });

  it("returns ready for assistant_message entry type", async () => {
    mockTmuxWithProcess("codex");
    const content = '{"type":"session_meta","cwd":"/workspace/test"}\n';
    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    setupMockOpen(content);
    mockStat.mockResolvedValue({ mtimeMs: Date.now(), mtime: new Date() });
    mockReadLastJsonlEntry.mockResolvedValue({
      lastType: "assistant_message",
      modifiedAt: new Date(),
    });

    const session = makeSession({
      runtimeHandle: makeTmuxHandle(),
      workspacePath: "/workspace/test",
    });
    const result = await agent.getActivityState(session);
    expect(result?.state).toBe("ready");
  });

  it("returns waiting_input when payload.type is approval_request on event_msg", async () => {
    // Real Codex writes {"type":"event_msg","payload":{"type":"approval_request",...}}
    // Without payloadType handling, this decays to ready/idle via the event_msg case.
    mockTmuxWithProcess("codex");
    const content = '{"type":"session_meta","cwd":"/workspace/test"}\n';
    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    setupMockOpen(content);
    mockStat.mockResolvedValue({ mtimeMs: Date.now(), mtime: new Date() });
    mockReadLastJsonlEntry.mockResolvedValue({
      lastType: "event_msg",
      payloadType: "approval_request",
      modifiedAt: new Date(),
    });

    const session = makeSession({
      runtimeHandle: makeTmuxHandle(),
      workspacePath: "/workspace/test",
    });
    const result = await agent.getActivityState(session);
    expect(result?.state).toBe("waiting_input");
  });

  it("returns waiting_input for exec_approval_request payload type", async () => {
    mockTmuxWithProcess("codex");
    const content = '{"type":"session_meta","cwd":"/workspace/test"}\n';
    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    setupMockOpen(content);
    mockStat.mockResolvedValue({ mtimeMs: Date.now(), mtime: new Date() });
    mockReadLastJsonlEntry.mockResolvedValue({
      lastType: "event_msg",
      payloadType: "exec_approval_request",
      modifiedAt: new Date(),
    });

    const session = makeSession({
      runtimeHandle: makeTmuxHandle(),
      workspacePath: "/workspace/test",
    });
    const result = await agent.getActivityState(session);
    expect(result?.state).toBe("waiting_input");
  });

  it("returns blocked when payload.type is error on event_msg", async () => {
    // Real Codex writes {"type":"event_msg","payload":{"type":"error",...}}
    mockTmuxWithProcess("codex");
    const content = '{"type":"session_meta","cwd":"/workspace/test"}\n';
    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    setupMockOpen(content);
    mockStat.mockResolvedValue({ mtimeMs: Date.now(), mtime: new Date() });
    mockReadLastJsonlEntry.mockResolvedValue({
      lastType: "event_msg",
      payloadType: "error",
      modifiedAt: new Date(),
    });

    const session = makeSession({
      runtimeHandle: makeTmuxHandle(),
      workspacePath: "/workspace/test",
    });
    const result = await agent.getActivityState(session);
    expect(result?.state).toBe("blocked");
  });

  it("returns active when payload.type is task_started on a recent event_msg", async () => {
    mockTmuxWithProcess("codex");
    const content = '{"type":"session_meta","cwd":"/workspace/test"}\n';
    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    setupMockOpen(content);
    mockStat.mockResolvedValue({ mtimeMs: Date.now(), mtime: new Date() });
    mockReadLastJsonlEntry.mockResolvedValue({
      lastType: "event_msg",
      payloadType: "task_started",
      modifiedAt: new Date(),
    });

    const session = makeSession({
      runtimeHandle: makeTmuxHandle(),
      workspacePath: "/workspace/test",
    });
    const result = await agent.getActivityState(session);
    expect(result?.state).toBe("active");
  });

  it("returns ready when payload.type is task_complete on a recent event_msg", async () => {
    mockTmuxWithProcess("codex");
    const content = '{"type":"session_meta","cwd":"/workspace/test"}\n';
    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    setupMockOpen(content);
    mockStat.mockResolvedValue({ mtimeMs: Date.now(), mtime: new Date() });
    mockReadLastJsonlEntry.mockResolvedValue({
      lastType: "event_msg",
      payloadType: "task_complete",
      modifiedAt: new Date(),
    });

    const session = makeSession({
      runtimeHandle: makeTmuxHandle(),
      workspacePath: "/workspace/test",
    });
    const result = await agent.getActivityState(session);
    expect(result?.state).toBe("ready");
  });

  it("detects activity from payload-wrapped Codex session_meta files", async () => {
    mockTmuxWithProcess("codex");
    const content = `${JSON.stringify({
      type: "session_meta",
      payload: {
        cwd: "/workspace/test",
        id: "thread-123",
        base_instructions: "x".repeat(8_000),
      },
    })}\n`;
    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    setupMockOpen(content);
    mockStat.mockResolvedValue({ mtimeMs: Date.now(), mtime: new Date() });
    mockReadLastJsonlEntry.mockResolvedValue({
      lastType: "event_msg",
      modifiedAt: new Date(),
    });

    const session = makeSession({
      runtimeHandle: makeTmuxHandle(),
      workspacePath: "/workspace/test",
    });
    const result = await agent.getActivityState(session);
    expect(result?.state).toBe("ready");
  });

  it("handles multi-byte UTF-8 characters straddling an 8KB chunk boundary", async () => {
    mockTmuxWithProcess("codex");
    // Each 日 is 3 bytes. Padding with enough CJK chars to push the json
    // payload past the 8192-byte chunk size, guaranteeing a multi-byte
    // character will straddle a read boundary. Without StringDecoder,
    // the split character decodes to U+FFFD and JSON.parse fails.
    const padding = "日".repeat(3_000); // 9000 bytes of padding
    const content = `${JSON.stringify({
      type: "session_meta",
      payload: {
        cwd: "/workspace/test",
        id: "thread-utf8",
        base_instructions: padding,
      },
    })}\n`;
    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    setupMockOpen(content);
    mockStat.mockResolvedValue({ mtimeMs: Date.now(), mtime: new Date() });
    mockReadLastJsonlEntry.mockResolvedValue({
      lastType: "event_msg",
      modifiedAt: new Date(),
    });

    const session = makeSession({
      runtimeHandle: makeTmuxHandle(),
      workspacePath: "/workspace/test",
    });
    const result = await agent.getActivityState(session);
    // If UTF-8 boundary handling is broken, JSON.parse fails, cwd never
    // matches, no session file is selected, and state falls through to null.
    expect(result?.state).toBe("ready");
  });

  it("returns exited when process handle has dead PID", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    const session = makeSession({ runtimeHandle: makeProcessHandle(999) });
    const result = await agent.getActivityState(session);
    expect(result?.state).toBe("exited");
    expect(result?.timestamp).toBeInstanceOf(Date);
    killSpy.mockRestore();
  });
});

// =========================================================================
// getSessionInfo — Codex JSONL parsing
// =========================================================================
describe("getSessionInfo", () => {
  const agent = create();

  // Helper to build JSONL content from lines
  function jsonl(...lines: Record<string, unknown>[]): string {
    return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  }

  it("returns null when workspacePath is null", async () => {
    expect(await agent.getSessionInfo(makeSession({ workspacePath: null }))).toBeNull();
  });

  it("returns null when workspacePath is undefined", async () => {
    expect(await agent.getSessionInfo(makeSession({ workspacePath: undefined }))).toBeNull();
  });

  it("returns null when ~/.codex/sessions/ directory does not exist", async () => {
    mockReaddir.mockRejectedValue(new Error("ENOENT"));
    expect(await agent.getSessionInfo(makeSession())).toBeNull();
  });

  it("returns null when sessions directory is empty", async () => {
    mockReaddir.mockResolvedValue([]);
    expect(await agent.getSessionInfo(makeSession())).toBeNull();
  });

  it("returns null when no session files match the workspace cwd", async () => {
    mockReaddir.mockResolvedValue(["session-abc.jsonl"]);
    const content = jsonl({ type: "session_meta", cwd: "/other/workspace", model: "gpt-4o" });
    setupMockOpen(content);
    mockReadFile.mockResolvedValue(content);
    expect(
      await agent.getSessionInfo(makeSession({ workspacePath: "/workspace/test" })),
    ).toBeNull();
  });

  it("returns session info with cost and model when matching session found", async () => {
    const sessionContent = jsonl(
      { type: "session_meta", cwd: "/workspace/test", model: "o3-mini" },
      {
        type: "event_msg",
        msg: {
          type: "token_count",
          input_tokens: 1000,
          output_tokens: 500,
          cached_tokens: 200,
          reasoning_tokens: 100,
        },
      },
      {
        type: "event_msg",
        msg: {
          type: "token_count",
          input_tokens: 2000,
          output_tokens: 300,
          cached_tokens: 0,
          reasoning_tokens: 0,
        },
      },
    );

    mockReaddir.mockResolvedValue(["session-123.jsonl"]);
    setupMockOpen(sessionContent);
    setupMockStream(sessionContent);
    mockReadFile.mockResolvedValue(sessionContent);
    mockStat.mockResolvedValue({ mtimeMs: 1000 });

    const result = await agent.getSessionInfo(makeSession({ workspacePath: "/workspace/test" }));

    expect(result).not.toBeNull();
    expect(result!.agentSessionId).toBe("session-123");
    expect(result!.summary).toBe("Codex session (o3-mini)");
    expect(result!.summaryIsFallback).toBe(true);
    expect(result!.cost).toBeDefined();
    // cached tokens count toward effective input spend
    // input: 1000 + 2000 + 200 = 3200
    // output: 500 + 300 = 800
    expect(result!.cost!.inputTokens).toBe(3200);
    expect(result!.cost!.outputTokens).toBe(800);
    expect(result!.cost!.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("parses payload-wrapped Codex session files", async () => {
    const sessionContent = jsonl(
      {
        type: "session_meta",
        payload: {
          cwd: "/workspace/test",
          id: "thread-payload-123",
          model_provider: "openai",
        },
      },
      {
        type: "turn_context",
        payload: {
          model: "gpt-5.3-codex",
          cwd: "/workspace/test",
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 3000,
              output_tokens: 800,
              cached_input_tokens: 200,
              reasoning_output_tokens: 100,
            },
          },
        },
      },
    );

    mockReaddir.mockResolvedValue(["rollout-abc.jsonl"]);
    setupMockOpen(sessionContent);
    setupMockStream(sessionContent);
    mockStat.mockResolvedValue({ mtimeMs: 1000 });

    const result = await agent.getSessionInfo(makeSession({ workspacePath: "/workspace/test" }));

    expect(result).not.toBeNull();
    expect(result!.agentSessionId).toBe("rollout-abc");
    expect(result!.summary).toBe("Codex session (gpt-5.3-codex)");
    expect(result!.cost).toBeDefined();
    expect(result!.cost!.inputTokens).toBe(3000);
    expect(result!.cost!.outputTokens).toBe(800);
  });

  it("does not treat model_provider as the session model", async () => {
    const sessionContent = jsonl({
      type: "session_meta",
      payload: {
        cwd: "/workspace/test",
        id: "thread-payload-123",
        model_provider: "openai",
      },
    });

    mockReaddir.mockResolvedValue(["rollout-abc.jsonl"]);
    setupMockOpen(sessionContent);
    setupMockStream(sessionContent);
    mockStat.mockResolvedValue({ mtimeMs: 1000 });

    const result = await agent.getSessionInfo(makeSession({ workspacePath: "/workspace/test" }));

    expect(result).not.toBeNull();
    expect(result!.summary).toBeNull();
  });

  it("picks the most recently modified matching session file", async () => {
    const oldContent = jsonl({ type: "session_meta", cwd: "/workspace/test", model: "gpt-4o" });
    const newContent = jsonl({ type: "session_meta", cwd: "/workspace/test", model: "o3" });

    mockReaddir.mockResolvedValue(["old-session.jsonl", "new-session.jsonl"]);
    mockOpen.mockImplementation(async (path: string) => {
      if (path.includes("old-session")) return makeFakeFileHandle(oldContent);
      if (path.includes("new-session")) return makeFakeFileHandle(newContent);
      throw new Error("ENOENT");
    });
    mockReadFile.mockImplementation((path: string) => {
      if (path.includes("old-session")) return Promise.resolve(oldContent);
      if (path.includes("new-session")) return Promise.resolve(newContent);
      return Promise.reject(new Error("ENOENT"));
    });
    mockCreateReadStream.mockImplementation((path: string) => {
      if (path.includes("old-session")) return makeContentStream(oldContent);
      if (path.includes("new-session")) return makeContentStream(newContent);
      return makeContentStream("");
    });
    mockStat.mockImplementation((path: string) => {
      if (path.includes("old-session")) return Promise.resolve({ mtimeMs: 1000 });
      if (path.includes("new-session")) return Promise.resolve({ mtimeMs: 2000 });
      return Promise.reject(new Error("ENOENT"));
    });

    const result = await agent.getSessionInfo(makeSession({ workspacePath: "/workspace/test" }));

    expect(result).not.toBeNull();
    expect(result!.agentSessionId).toBe("new-session");
    expect(result!.summary).toBe("Codex session (o3)");
  });

  it("handles corrupt/malformed JSONL lines gracefully", async () => {
    const content =
      '{"type":"session_meta","cwd":"/workspace/test","model":"gpt-4o"}\n' +
      "not valid json\n" +
      '{"type":"event_msg","msg":{"type":"token_count","input_tokens":500,"output_tokens":200}}\n';

    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    setupMockOpen(content);
    setupMockStream(content);
    mockReadFile.mockResolvedValue(content);
    mockStat.mockResolvedValue({ mtimeMs: 1000 });

    const result = await agent.getSessionInfo(makeSession({ workspacePath: "/workspace/test" }));

    expect(result).not.toBeNull();
    expect(result!.cost!.inputTokens).toBe(500);
    expect(result!.cost!.outputTokens).toBe(200);
  });

  it("returns null summary when no model in session_meta", async () => {
    const content = jsonl(
      { type: "session_meta", cwd: "/workspace/test" },
      { type: "event_msg", msg: { type: "token_count", input_tokens: 100, output_tokens: 50 } },
    );

    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    setupMockOpen(content);
    setupMockStream(content);
    mockStat.mockResolvedValue({ mtimeMs: 1000 });

    const result = await agent.getSessionInfo(makeSession({ workspacePath: "/workspace/test" }));

    expect(result).not.toBeNull();
    expect(result!.summary).toBeNull();
    // Verify cost was actually parsed from the stream (not just defaulting to undefined)
    expect(result!.cost).toBeDefined();
    expect(result!.cost!.inputTokens).toBe(100);
    expect(result!.cost!.outputTokens).toBe(50);
  });

  it("returns undefined cost when no token_count events", async () => {
    const content = jsonl(
      { type: "session_meta", cwd: "/workspace/test", model: "gpt-4o" },
      { type: "event_msg", msg: { type: "other_event" } },
    );

    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    setupMockOpen(content);
    setupMockStream(content);
    mockStat.mockResolvedValue({ mtimeMs: 1000 });

    const result = await agent.getSessionInfo(makeSession({ workspacePath: "/workspace/test" }));

    expect(result).not.toBeNull();
    expect(result!.cost).toBeUndefined();
    // Verify model was actually parsed from the stream (not just defaulting to null)
    expect(result!.summary).toContain("gpt-4o");
  });

  it("handles unreadable session files gracefully", async () => {
    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    // open() finds matching session_meta, but readFile fails for full parse
    setupMockOpen(jsonl({ type: "session_meta", cwd: "/workspace/test" }));
    mockStat.mockResolvedValue({ mtimeMs: 1000 });
    mockReadFile.mockRejectedValue(new Error("EACCES"));
    mockCreateReadStream.mockImplementation(() => {
      throw new Error("EACCES");
    });

    expect(
      await agent.getSessionInfo(makeSession({ workspacePath: "/workspace/test" })),
    ).toBeNull();
  });

  it("skips session files when stat throws", async () => {
    const content = jsonl({ type: "session_meta", cwd: "/workspace/test", model: "gpt-4o" });
    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    setupMockOpen(content);
    mockReadFile.mockResolvedValue(content);
    mockStat.mockRejectedValue(new Error("EACCES"));

    const result = await agent.getSessionInfo(makeSession({ workspacePath: "/workspace/test" }));
    // stat failed so no bestMatch can be established
    expect(result).toBeNull();
  });

  it("returns null when session JSONL has only empty/malformed lines", async () => {
    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    // open() finds matching session_meta for cwd check
    setupMockOpen(jsonl({ type: "session_meta", cwd: "/workspace/test" }));
    // readFile (full parse) returns only garbage
    mockReadFile.mockResolvedValue("not json\n\n   \n");
    setupMockStream("not json\n\n   \n");
    mockStat.mockResolvedValue({ mtimeMs: 1000 });

    const result = await agent.getSessionInfo(makeSession({ workspacePath: "/workspace/test" }));
    // With streaming parser, garbage lines are skipped gracefully and a result
    // is returned with null summary and undefined cost (no valid data extracted).
    expect(result).not.toBeNull();
    expect(result!.summary).toBeNull();
    expect(result!.cost).toBeUndefined();
  });

  it("finds session files in date-sharded subdirectories (YYYY/MM/DD)", async () => {
    // Simulate ~/.codex/sessions/2026/02/24/rollout-abc.jsonl
    mockReaddir.mockImplementation((dir: string) => {
      if (dir.endsWith("sessions")) return Promise.resolve(["2026"]);
      if (dir.endsWith("2026")) return Promise.resolve(["02"]);
      if (dir.endsWith("02")) return Promise.resolve(["24"]);
      if (dir.endsWith("24")) return Promise.resolve(["rollout-abc.jsonl"]);
      return Promise.resolve([]);
    });
    // lstat is used by collectJsonlFiles to check subdirectories (avoids symlink cycles)
    mockLstat.mockResolvedValue({ isDirectory: () => true });
    // stat is used by findCodexSessionFile to get mtimeMs of matching JSONL files
    mockStat.mockResolvedValue({ mtimeMs: 2000 });
    const content = jsonl({ type: "session_meta", cwd: "/workspace/test", model: "o3-mini" });
    setupMockOpen(content);
    setupMockStream(content);
    mockReadFile.mockResolvedValue(content);

    const result = await agent.getSessionInfo(makeSession({ workspacePath: "/workspace/test" }));
    expect(result).not.toBeNull();
    expect(result!.agentSessionId).toBe("rollout-abc");
    expect(result!.summary).toBe("Codex session (o3-mini)");
  });

  it("ignores non-JSONL files in sessions directory", async () => {
    mockReaddir.mockResolvedValue(["notes.txt", "config.json", "sess.jsonl"]);
    const content = jsonl({ type: "session_meta", cwd: "/workspace/test", model: "gpt-4o" });
    setupMockOpen(content);
    setupMockStream(content);
    mockReadFile.mockResolvedValue(content);
    // Non-JSONL entries trigger lstat to check isDirectory()
    mockLstat.mockResolvedValue({ isDirectory: () => false });
    // stat is used to get mtimeMs for matching JSONL files
    mockStat.mockResolvedValue({ mtimeMs: 1000 });

    const result = await agent.getSessionInfo(makeSession({ workspacePath: "/workspace/test" }));
    expect(result).not.toBeNull();
    // With streaming parser, readFile is no longer used for full parse;
    // cwd check uses open(), data extraction uses createReadStream.
    const readFileCalls = mockReadFile.mock.calls.filter(
      (call: string[]) => typeof call[0] === "string" && call[0].includes("sessions/"),
    );
    expect(readFileCalls.length).toBe(0); // streaming replaces readFile for full parse
  });
});

// =========================================================================
// getRestoreCommand — conversation resume
// =========================================================================
describe("getRestoreCommand", () => {
  const agent = create();

  function jsonl(...lines: Record<string, unknown>[]): string {
    return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  }

  function makeProjectConfig(overrides: Record<string, unknown> = {}) {
    return {
      name: "test-project",
      repo: "owner/repo",
      path: "/workspace/repo",
      defaultBranch: "main",
      sessionPrefix: "test",
      ...overrides,
    };
  }

  it("returns null when workspacePath is null", async () => {
    const session = makeSession({ workspacePath: null });
    expect(await agent.getRestoreCommand!(session, makeProjectConfig())).toBeNull();
  });

  it("returns null when workspacePath is undefined", async () => {
    const session = makeSession({ workspacePath: undefined });
    expect(await agent.getRestoreCommand!(session, makeProjectConfig())).toBeNull();
  });

  it("returns null when no matching session file found", async () => {
    mockReaddir.mockRejectedValue(new Error("ENOENT"));
    const session = makeSession({ workspacePath: "/workspace/test" });
    expect(await agent.getRestoreCommand!(session, makeProjectConfig())).toBeNull();
  });

  it("returns null when session has no threadId", async () => {
    const content = jsonl(
      { type: "session_meta", cwd: "/workspace/test", model: "gpt-4o" },
      { role: "user", content: "Some prompt" },
    );
    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    setupMockOpen(content);
    setupMockStream(content);
    mockStat.mockResolvedValue({ mtimeMs: 1000 });

    const session = makeSession({ workspacePath: "/workspace/test" });
    // Native resume requires a threadId
    expect(await agent.getRestoreCommand!(session, makeProjectConfig())).toBeNull();
  });

  it("builds native resume command with codex resume <threadId>", async () => {
    const content = jsonl(
      { type: "session_meta", cwd: "/workspace/test", model: "gpt-4o" },
      { threadId: "thread-abc-123" },
    );
    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    setupMockOpen(content);
    setupMockStream(content);
    mockReadFile.mockResolvedValue(content);
    mockStat.mockResolvedValue({ mtimeMs: 1000 });

    const session = makeSession({ workspacePath: "/workspace/test" });
    const cmd = await agent.getRestoreCommand!(session, makeProjectConfig());

    expect(cmd).not.toBeNull();
    expect(cmd).toContain("'codex' resume");
    expect(cmd).toContain("-c check_for_update_on_startup=false");
    expect(cmd).toContain("thread-abc-123");
  });

  it("uses persisted Codex thread ID without scanning session files", async () => {
    const session = makeSession({
      workspacePath: "/workspace/test",
      metadata: { codexThreadId: "persisted-thread", codexModel: "gpt-5.3-codex" },
    });

    const cmd = await agent.getRestoreCommand!(session, makeProjectConfig());

    expect(cmd).toContain("'codex' resume");
    expect(cmd).toContain("--model 'gpt-5.3-codex'");
    expect(cmd).toContain("persisted-thread");
    expect(mockReaddir).not.toHaveBeenCalled();
  });

  it("builds native resume command from payload-wrapped Codex session id", async () => {
    const content = jsonl(
      {
        type: "session_meta",
        payload: {
          cwd: "/workspace/test",
          id: "thread-payload-999",
          model_provider: "openai",
        },
      },
      {
        type: "turn_context",
        payload: {
          model: "gpt-5.3-codex",
        },
      },
    );
    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    setupMockOpen(content);
    setupMockStream(content);
    mockStat.mockResolvedValue({ mtimeMs: 1000 });

    const session = makeSession({ workspacePath: "/workspace/test" });
    const cmd = await agent.getRestoreCommand!(session, makeProjectConfig());

    expect(cmd).not.toBeNull();
    expect(cmd).toContain("'codex' resume");
    expect(cmd).toContain("thread-payload-999");
  });

  it("does not append --model from model_provider-only payload data", async () => {
    const content = jsonl({
      type: "session_meta",
      payload: {
        cwd: "/workspace/test",
        id: "thread-payload-999",
        model_provider: "openai",
      },
    });
    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    setupMockOpen(content);
    setupMockStream(content);
    mockStat.mockResolvedValue({ mtimeMs: 1000 });

    const session = makeSession({ workspacePath: "/workspace/test" });
    const cmd = await agent.getRestoreCommand!(session, makeProjectConfig());

    expect(cmd).not.toBeNull();
    expect(cmd).not.toContain("--model 'openai'");
  });

  it("includes bypass flag when project config permissions=permissionless", async () => {
    const content = jsonl(
      { type: "session_meta", cwd: "/workspace/test", model: "gpt-4o" },
      { threadId: "thread-1" },
    );
    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    setupMockOpen(content);
    setupMockStream(content);
    mockReadFile.mockResolvedValue(content);
    mockStat.mockResolvedValue({ mtimeMs: 1000 });

    const session = makeSession({
      workspacePath: "/workspace/test",
      metadata: { role: "orchestrator" },
    });
    const cmd = await agent.getRestoreCommand!(
      session,
      makeProjectConfig({
        agentConfig: { permissions: "permissionless" },
      }),
    );

    expect(cmd).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(cmd).not.toContain("--ask-for-approval");
  });

  it("treats legacy project config permissions=skip as permissionless", async () => {
    const content = jsonl(
      { type: "session_meta", cwd: "/workspace/test", model: "gpt-4o" },
      { threadId: "thread-1" },
    );
    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    setupMockOpen(content);
    setupMockStream(content);
    mockReadFile.mockResolvedValue(content);
    mockStat.mockResolvedValue({ mtimeMs: 1000 });

    const session = makeSession({
      workspacePath: "/workspace/test",
      metadata: { role: "orchestrator" },
    });
    const cmd = await agent.getRestoreCommand!(
      session,
      makeProjectConfig({
        agentConfig: { permissions: "skip" as unknown as AgentSpecificConfig["permissions"] },
      }),
    );

    expect(cmd).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("uses dangerous bypass for worker restore permissionless mode", async () => {
    const content = jsonl(
      { type: "session_meta", cwd: "/workspace/test", model: "gpt-4o" },
      { threadId: "thread-1" },
    );
    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    setupMockOpen(content);
    setupMockStream(content);
    mockReadFile.mockResolvedValue(content);
    mockStat.mockResolvedValue({ mtimeMs: 1000 });

    const session = makeSession({ workspacePath: "/workspace/test", metadata: { role: "worker" } });
    const cmd = await agent.getRestoreCommand!(
      session,
      makeProjectConfig({
        agentConfig: { permissions: "permissionless" },
      }),
    );

    expect(cmd).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(cmd).not.toContain("--ask-for-approval");
  });

  it("keeps auto-edit restore policy at ask-for-approval never", async () => {
    const content = jsonl(
      { type: "session_meta", cwd: "/workspace/test", model: "gpt-4o" },
      { threadId: "thread-1" },
    );
    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    setupMockOpen(content);
    setupMockStream(content);
    mockReadFile.mockResolvedValue(content);
    mockStat.mockResolvedValue({ mtimeMs: 1000 });

    const session = makeSession({ workspacePath: "/workspace/test" });
    const cmd = await agent.getRestoreCommand!(
      session,
      makeProjectConfig({
        agentConfig: { permissions: "auto-edit" },
      }),
    );

    expect(cmd).toContain("--ask-for-approval never");
    expect(cmd).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("includes --ask-for-approval untrusted from project config", async () => {
    const content = jsonl(
      { type: "session_meta", cwd: "/workspace/test", model: "gpt-4o" },
      { threadId: "thread-1" },
    );
    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    setupMockOpen(content);
    setupMockStream(content);
    mockReadFile.mockResolvedValue(content);
    mockStat.mockResolvedValue({ mtimeMs: 1000 });

    const session = makeSession({ workspacePath: "/workspace/test" });
    const cmd = await agent.getRestoreCommand!(
      session,
      makeProjectConfig({
        agentConfig: { permissions: "suggest" },
      }),
    );

    expect(cmd).toContain("--ask-for-approval untrusted");
  });

  it("places flags before positional threadId in resume command", async () => {
    const content = jsonl(
      { type: "session_meta", cwd: "/workspace/test", model: "o3-mini" },
      { threadId: "thread-order-test" },
    );
    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    setupMockOpen(content);
    setupMockStream(content);
    mockReadFile.mockResolvedValue(content);
    mockStat.mockResolvedValue({ mtimeMs: 1000 });

    const session = makeSession({ workspacePath: "/workspace/test" });
    const cmd = await agent.getRestoreCommand!(
      session,
      makeProjectConfig({
        agentConfig: { permissions: "auto-edit", model: "o3-mini" },
      }),
    );

    expect(cmd).not.toBeNull();
    // threadId should come after all flags
    const threadIdIdx = cmd!.indexOf("thread-order-test");
    const flagIdx = cmd!.indexOf("--ask-for-approval");
    const modelIdx = cmd!.indexOf("--model");
    expect(flagIdx).toBeLessThan(threadIdIdx);
    expect(modelIdx).toBeLessThan(threadIdIdx);
  });

  it("includes model from project config (overrides session model)", async () => {
    const content = jsonl(
      { type: "session_meta", cwd: "/workspace/test", model: "gpt-4o" },
      { threadId: "thread-1" },
    );
    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    setupMockOpen(content);
    setupMockStream(content);
    mockReadFile.mockResolvedValue(content);
    mockStat.mockResolvedValue({ mtimeMs: 1000 });

    const session = makeSession({ workspacePath: "/workspace/test" });
    const cmd = await agent.getRestoreCommand!(
      session,
      makeProjectConfig({
        agentConfig: { model: "o3-mini" },
      }),
    );

    expect(cmd).toContain("--model 'o3-mini'");
    expect(cmd).toContain("-c model_reasoning_effort=high");
  });

  it("falls back to session model when project config has no model", async () => {
    const content = jsonl(
      { type: "session_meta", cwd: "/workspace/test", model: "o4-mini" },
      { threadId: "thread-1" },
    );
    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    setupMockOpen(content);
    setupMockStream(content);
    mockReadFile.mockResolvedValue(content);
    mockStat.mockResolvedValue({ mtimeMs: 1000 });

    const session = makeSession({ workspacePath: "/workspace/test" });
    const cmd = await agent.getRestoreCommand!(session, makeProjectConfig());

    expect(cmd).toContain("--model 'o4-mini'");
    expect(cmd).toContain("-c model_reasoning_effort=high");
  });

  it("handles unreadable session files gracefully", async () => {
    mockReaddir.mockResolvedValue(["sess.jsonl"]);
    // open() finds matching session_meta for cwd check
    setupMockOpen(jsonl({ type: "session_meta", cwd: "/workspace/test" }));
    // readFile (full parse) fails
    mockReadFile.mockRejectedValue(new Error("EACCES"));
    mockCreateReadStream.mockImplementation(() => {
      throw new Error("EACCES");
    });
    mockStat.mockResolvedValue({ mtimeMs: 1000 });

    const session = makeSession({ workspacePath: "/workspace/test" });
    expect(await agent.getRestoreCommand!(session, makeProjectConfig())).toBeNull();
  });
});

// =========================================================================
// resolveCodexBinary
// =========================================================================
describe("resolveCodexBinary", () => {
  it("returns path from `which` when codex is found", async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: "/usr/local/bin/codex\n", stderr: "" });
    const result = await resolveCodexBinary();
    expect(result).toBe("/usr/local/bin/codex");
    expect(mockExecFileAsync).toHaveBeenCalledWith("which", ["codex"], { timeout: 10_000 });
  });

  it("falls back to common locations when `which` fails", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("not found"));
    mockStat.mockImplementation((path: string) => {
      if (path === "/usr/local/bin/codex") {
        return Promise.resolve({ mtimeMs: 1000 });
      }
      return Promise.reject(new Error("ENOENT"));
    });

    const result = await resolveCodexBinary();
    expect(result).toBe("/usr/local/bin/codex");
  });

  it("checks /opt/homebrew/bin/codex as fallback", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("not found"));
    mockStat.mockImplementation((path: string) => {
      if (path === "/opt/homebrew/bin/codex") {
        return Promise.resolve({ mtimeMs: 1000 });
      }
      return Promise.reject(new Error("ENOENT"));
    });

    const result = await resolveCodexBinary();
    expect(result).toBe("/opt/homebrew/bin/codex");
  });

  it("checks ~/.cargo/bin/codex as fallback (Rust-based codex)", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("not found"));
    mockStat.mockImplementation((path: string) => {
      if (path === "/mock/home/.cargo/bin/codex") {
        return Promise.resolve({ mtimeMs: 1000 });
      }
      return Promise.reject(new Error("ENOENT"));
    });

    const result = await resolveCodexBinary();
    expect(result).toBe("/mock/home/.cargo/bin/codex");
  });

  it("checks ~/.npm/bin/codex as fallback", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("not found"));
    mockStat.mockImplementation((path: string) => {
      if (path === "/mock/home/.npm/bin/codex") {
        return Promise.resolve({ mtimeMs: 1000 });
      }
      return Promise.reject(new Error("ENOENT"));
    });

    const result = await resolveCodexBinary();
    expect(result).toBe("/mock/home/.npm/bin/codex");
  });

  it("returns 'codex' when not found anywhere", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("not found"));
    mockStat.mockRejectedValue(new Error("ENOENT"));

    const result = await resolveCodexBinary();
    expect(result).toBe("codex");
  });

  it("returns 'codex' when `which` returns empty stdout", async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });
    mockStat.mockRejectedValue(new Error("ENOENT"));

    const result = await resolveCodexBinary();
    expect(result).toBe("codex");
  });
});

// =========================================================================
// postLaunchSetup — binary resolution
// =========================================================================
describe("postLaunchSetup", () => {
  it("has postLaunchSetup method", () => {
    const agent = create();
    expect(typeof agent.postLaunchSetup).toBe("function");
  });

  it("runs setup when session has workspacePath", async () => {
    const agent = create();
    // which fails, stat fails → resolves to "codex"
    mockExecFileAsync.mockRejectedValue(new Error("not found"));
    mockStat.mockRejectedValue(new Error("ENOENT"));
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    // Should not throw — binary resolution runs even if it falls back to "codex"
    await expect(
      agent.postLaunchSetup!(makeSession({ workspacePath: "/workspace/test" })),
    ).resolves.toBeUndefined();
  });

  it("returns early when session has no workspacePath", async () => {
    const agent = create();
    mockExecFileAsync.mockRejectedValue(new Error("not found"));
    mockStat.mockRejectedValue(new Error("ENOENT"));
    await agent.postLaunchSetup!(makeSession({ workspacePath: undefined }));
    expect(mockMkdir).not.toHaveBeenCalled();
  });

  it("resolves binary and uses it in getLaunchCommand after postLaunchSetup", async () => {
    const agent = create();
    mockExecFileAsync.mockResolvedValue({ stdout: "/opt/bin/codex\n", stderr: "" });
    mockReadFile.mockRejectedValue(new Error("ENOENT"));

    // Before postLaunchSetup, binary is "codex"
    expect(agent.getLaunchCommand(makeLaunchConfig())).toBe(
      "'codex' -c check_for_update_on_startup=false",
    );

    // After postLaunchSetup resolves the binary
    await agent.postLaunchSetup!(makeSession({ workspacePath: "/workspace/test" }));

    // Now getLaunchCommand should use the resolved binary
    expect(agent.getLaunchCommand(makeLaunchConfig())).toBe(
      "'/opt/bin/codex' -c check_for_update_on_startup=false",
    );
  });
});

// =========================================================================
// setupWorkspaceHooks — file writing behavior
// =========================================================================
describe("setupWorkspaceHooks", () => {
  const agent = create();

  it("has setupWorkspaceHooks method", () => {
    expect(typeof agent.setupWorkspaceHooks).toBe("function");
  });

  it("is a no-op (PATH wrappers are installed by session-manager)", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    await agent.setupWorkspaceHooks!("/workspace/test", {
      dataDir: "/data",
      sessionId: "sess-1",
    });
    // Plugin no longer writes wrappers — session-manager handles it.
    // mkdir/writeFile/rename should not be called by the plugin.
    expect(mockMkdir).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockRename).not.toHaveBeenCalled();
  });
});

// =========================================================================
// Shell wrapper content verification
// =========================================================================
describe("shell wrapper content", () => {
  beforeEach(() => {
    // Force wrapper installation by making version marker miss
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
  });

  async function getWrapperContent(name: string): Promise<string> {
    // Wrappers are now installed by session-manager via setupPathWrapperWorkspace.
    // Import and call it directly to test wrapper content.
    const { setupPathWrapperWorkspace } = await import("@aoagents/ao-core");
    await setupPathWrapperWorkspace("/workspace/test");

    // With atomic writes, content is written to a .tmp. file
    const call = mockWriteFile.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes(`/${name}.tmp.`),
    );
    return call ? (call[1] as string) : "";
  }

  describe("metadata helper", () => {
    it("contains update_ao_metadata function", async () => {
      const content = await getWrapperContent("ao-metadata-helper.sh");
      expect(content).toContain("update_ao_metadata()");
    });

    it("uses AO_DATA_DIR and AO_SESSION env vars", async () => {
      const content = await getWrapperContent("ao-metadata-helper.sh");
      expect(content).toContain("AO_DATA_DIR");
      expect(content).toContain("AO_SESSION");
    });

    it("escapes sed metacharacters in values", async () => {
      const content = await getWrapperContent("ao-metadata-helper.sh");
      // Should contain the sed escaping logic for &, |, and \
      expect(content).toContain("escaped_value");
      expect(content).toMatch(/sed.*\\\\&/);
    });

    it("uses atomic temp file + mv pattern", async () => {
      const content = await getWrapperContent("ao-metadata-helper.sh");
      expect(content).toContain("temp_file");
      expect(content).toContain("mv");
    });

    it("validates session name has no path separators", async () => {
      const content = await getWrapperContent("ao-metadata-helper.sh");
      // Rejects session names containing / or ..
      expect(content).toContain("*/*");
      expect(content).toContain("*..*");
    });

    it("validates ao_dir is an absolute path under expected locations", async () => {
      const content = await getWrapperContent("ao-metadata-helper.sh");
      // Only allows paths under $HOME/.ao/, $HOME/.agent-orchestrator/, or /tmp/
      expect(content).toContain('$HOME"/.ao/*');
      expect(content).toContain('$HOME"/.agent-orchestrator/*');
      expect(content).toContain("/tmp/*");
    });

    it("resolves symlinks and verifies file stays within ao_dir", async () => {
      const content = await getWrapperContent("ao-metadata-helper.sh");
      expect(content).toContain("pwd -P");
      expect(content).toContain("real_ao_dir");
      expect(content).toContain("real_dir");
    });
  });

  describe("gh wrapper", () => {
    it("uses grep -Fxv for PATH cleaning (not regex grep)", async () => {
      const content = await getWrapperContent("gh");
      expect(content).toContain("grep -Fxv");
      expect(content).not.toMatch(/grep -v "\^\$ao_bin_dir\$"/);
    });

    it("only captures output for pr/create", async () => {
      const content = await getWrapperContent("gh");
      expect(content).toContain('case "$1/$2" in');
      expect(content).toContain("pr/create)");
    });

    it("passes through non-PR commands to real gh", async () => {
      const content = await getWrapperContent("gh");
      expect(content).toContain('"$real_gh" "$@"');
    });

    it("prefers GH_PATH when provided and executable", async () => {
      const content = await getWrapperContent("gh");
      expect(content).toContain("GH_PATH");
      expect(content).toContain('-x "$GH_PATH"');
      expect(content).toContain('real_gh="$GH_PATH"');
    });

    it("guards against recursive GH_PATH pointing to ao wrapper dir", async () => {
      const content = await getWrapperContent("gh");
      expect(content).toContain('if [[ "$gh_dir" != "$ao_bin_dir" ]]');
    });

    it("extracts PR URL from gh pr create output", async () => {
      const content = await getWrapperContent("gh");
      expect(content).toContain(
        "grep -Eo 'https?://[^/]+/[^/]+/[^/]+/pull/[0-9]+'",
      );
      expect(content).toContain("update_ao_metadata pr");
    });

    it("records agent-reported PR metadata on gh pr create", async () => {
      const content = await getWrapperContent("gh");
      expect(content).toContain("update_ao_metadata agentReportedState");
      expect(content).toContain("update_ao_metadata agentReportedPrUrl");
      expect(content).toContain("update_ao_metadata agentReportedPrIsDraft");
    });

    it("cleans up temp file on exit", async () => {
      const content = await getWrapperContent("gh");
      expect(content).toContain("trap");
      expect(content).toContain("rm -f");
    });
  });

  describe("git wrapper", () => {
    it("uses grep -Fxv for PATH cleaning (not regex grep)", async () => {
      const content = await getWrapperContent("git");
      expect(content).toContain("grep -Fxv");
      expect(content).not.toMatch(/grep -v "\^\$ao_bin_dir\$"/);
    });

    it("captures branch name from checkout -b", async () => {
      const content = await getWrapperContent("git");
      expect(content).toContain("checkout/-b");
      expect(content).toContain("update_ao_metadata branch");
    });

    it("captures branch name from switch -c", async () => {
      const content = await getWrapperContent("git");
      expect(content).toContain("switch/-c");
    });

    it("only updates metadata on success (exit code 0)", async () => {
      const content = await getWrapperContent("git");
      expect(content).toContain("exit_code -eq 0");
    });

    it("sources the metadata helper", async () => {
      const content = await getWrapperContent("git");
      expect(content).toContain("source");
      expect(content).toContain("ao-metadata-helper.sh");
    });
  });
});
