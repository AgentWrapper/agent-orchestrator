import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join as pathJoin } from "node:path";
import {
  createActivitySignal,
  type Session,
  type RuntimeHandle,
  type AgentLaunchConfig,
  type WorkspaceHooksConfig,
} from "@aoagents/ao-core";

// ---------------------------------------------------------------------------
// Hoisted mocks — available inside vi.mock factories
// ---------------------------------------------------------------------------
const {
  mockExecFileAsync,
  mockReaddir,
  mockReadFile,
  mockReadFileSync,
  mockStat,
  mockHomedir,
  mockWriteFile,
  mockMkdir,
  mockChmod,
  mockExistsSync,
  mockIsWindows,
} = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
  mockReaddir: vi.fn(),
  mockReadFile: vi.fn(),
  mockReadFileSync: vi.fn(() => ""),
  mockStat: vi.fn(),
  mockHomedir: vi.fn(() => "/mock/home"),
  mockWriteFile: vi.fn().mockResolvedValue(undefined),
  mockMkdir: vi.fn().mockResolvedValue(undefined),
  mockChmod: vi.fn().mockResolvedValue(undefined),
  mockExistsSync: vi.fn().mockReturnValue(false),
  mockIsWindows: vi.fn(() => false),
}));

vi.mock("node:child_process", () => {
  const fn = Object.assign((..._args: unknown[]) => {}, {
    [Symbol.for("nodejs.util.promisify.custom")]: mockExecFileAsync,
  });
  return { execFile: fn };
});

vi.mock("node:fs/promises", () => ({
  readdir: mockReaddir,
  readFile: mockReadFile,
  stat: mockStat,
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
  chmod: mockChmod,
}));

vi.mock("node:fs", () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
}));

vi.mock("node:os", () => ({
  homedir: mockHomedir,
}));

vi.mock("@aoagents/ao-core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    isWindows: mockIsWindows,
  };
});

import {
  create,
  manifest,
  default as defaultExport,
  resetPsCache,
  toClaudeProjectPath,
  METADATA_UPDATER_SCRIPT,
  METADATA_UPDATER_SCRIPT_NODE,
  ACTIVITY_UPDATER_SCRIPT,
  ACTIVITY_UPDATER_SCRIPT_NODE,
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
    prs: [],
    workspacePath: "/workspace/test-project",
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

function mockTmuxWithProcess(processName = "claude", tty = "/dev/ttys001", pid = 12345) {
  mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === "tmux" && args[0] === "list-panes") {
      return Promise.resolve({ stdout: `${tty}\n`, stderr: "" });
    }
    if (cmd === "ps") {
      const ttyShort = tty.replace(/^\/dev\//, "");
      // Matches `ps -eo pid,tty,args` output format
      return Promise.resolve({
        stdout: `  PID TT       ARGS\n  ${pid} ${ttyShort}  ${processName}\n`,
        stderr: "",
      });
    }
    return Promise.reject(new Error(`Unexpected: ${cmd} ${args.join(" ")}`));
  });
}

function mockJsonlFiles(
  jsonlContent: string,
  files = ["session-abc123.jsonl"],
  mtime = new Date(1700000000000),
) {
  mockReaddir.mockResolvedValue(files);
  mockStat.mockResolvedValue({ mtimeMs: mtime.getTime(), mtime });
  mockReadFile.mockResolvedValue(jsonlContent);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.clearAllMocks();
  resetPsCache();
  mockHomedir.mockReturnValue("/mock/home");
  // Default: non-Windows so existing tests are unaffected
  mockIsWindows.mockReturnValue(false);
});

describe("toClaudeProjectPath", () => {
  it("encodes a plain unix path", () => {
    expect(toClaudeProjectPath("/Users/dev/projects/foo")).toBe("-Users-dev-projects-foo");
  });

  it("collapses dot directories like .worktrees into a leading double dash", () => {
    expect(toClaudeProjectPath("/Users/dev/.worktrees/ao/ao-3")).toBe(
      "-Users-dev--worktrees-ao-ao-3",
    );
  });

  it("normalizes underscores to dashes (issue #1611)", () => {
    // AO project data dirs are named `<sanitized>_<hash>`. Claude Code converts
    // underscores to dashes when computing its on-disk project slug; without
    // matching that here the slug points to a non-existent directory and
    // restore loses the conversation.
    expect(
      toClaudeProjectPath(
        "/Users/dev/.agent-orchestrator/projects/graph-isomorphism_d185b44d56/worktrees/gi-orchestrator",
      ),
    ).toBe(
      "-Users-dev--agent-orchestrator-projects-graph-isomorphism-d185b44d56-worktrees-gi-orchestrator",
    );
  });

  it("encodes Windows drive colons and backslashes as dashes", () => {
    // Verified on-disk: Claude Code on Windows produces `C--Users-dev-foo`
    // (the colon position is a dash, not stripped). See commit 582c5373.
    expect(toClaudeProjectPath("C:\\Users\\dev\\foo")).toBe("C--Users-dev-foo");
  });

  it("collapses any other non-alphanumeric character into a dash", () => {
    expect(toClaudeProjectPath("/Users/dev/proj@v2/foo bar")).toBe("-Users-dev-proj-v2-foo-bar");
  });
});

describe("plugin manifest & exports", () => {
  it("has correct manifest", () => {
    expect(manifest).toEqual({
      name: "claude-code",
      slot: "agent",
      description: "Agent plugin: Claude Code CLI",
      version: "0.1.0",
      displayName: "Claude Code",
    });
  });

  it("create() returns an agent with correct name and processName", () => {
    const agent = create();
    expect(agent.name).toBe("claude-code");
    expect(agent.processName).toBe("claude");
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

  it("generates base command without shell syntax", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "default" }));
    expect(cmd).toBe("claude");
    // Must not contain shell operators (execFile-safe)
    expect(cmd).not.toContain("&&");
    expect(cmd).not.toContain("unset");
  });

  it("includes --dangerously-skip-permissions when permissions=permissionless", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "permissionless" }));
    expect(cmd).toContain("--dangerously-skip-permissions");
  });

  it("treats legacy permissions=skip as permissionless", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ permissions: "skip" as unknown as AgentLaunchConfig["permissions"] }),
    );
    expect(cmd).toContain("--dangerously-skip-permissions");
  });

  it("maps permissions=auto-edit to no-prompt mode on Claude", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "auto-edit" }));
    expect(cmd).toContain("--dangerously-skip-permissions");
  });

  it("shell-escapes model argument", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ model: "claude-opus-4-6" }));
    expect(cmd).toContain("--model 'claude-opus-4-6'");
  });

  it("includes prompt as positional argument with -- separator (not -p flag)", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "Fix the bug" }));
    expect(cmd).not.toContain("-p");
    expect(cmd).toContain("-- 'Fix the bug'");
  });

  it("combines all options with prompt as positional arg after --", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ permissions: "permissionless", model: "opus", prompt: "Hello" }),
    );
    expect(cmd).toBe("claude --dangerously-skip-permissions --model 'opus' -- 'Hello'");
  });

  it("handles prompts starting with dashes safely via -- separator", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "--investigate this" }));
    expect(cmd).toContain("-- '--investigate this'");
  });

  it("omits --dangerously-skip-permissions when permissions=default", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "default" }));
    expect(cmd).not.toContain("--dangerously-skip-permissions");
  });

  it("omits optional flags when not provided", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).not.toContain("--model");
    expect(cmd).not.toContain("-p");
  });

  it("includes --append-system-prompt and prompt as positional arg after --", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ systemPrompt: "You are a helper", prompt: "Do the task" }),
    );
    expect(cmd).toContain("--append-system-prompt");
    expect(cmd).toContain("You are a helper");
    expect(cmd).not.toMatch(/\s-p\s/);
    expect(cmd).toContain("-- 'Do the task'");
  });

  it("uses systemPromptFile via shell substitution with prompt after --", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ systemPromptFile: "/tmp/prompt.md", prompt: "Do the task" }),
    );
    expect(cmd).toContain('--append-system-prompt "$(cat');
    expect(cmd).toContain("/tmp/prompt.md");
    expect(cmd).not.toMatch(/\s-p\s/);
    expect(cmd).toContain("-- 'Do the task'");
  });

  it("inlines systemPromptFile content on Windows instead of $(cat ...)", () => {
    mockIsWindows.mockReturnValueOnce(true);
    mockReadFileSync.mockReturnValueOnce("You are a helpful assistant.");
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ systemPromptFile: "C:\\prompts\\system.md", prompt: "Do the task" }),
    );
    expect(cmd).toContain("--append-system-prompt");
    expect(cmd).toContain("You are a helpful assistant.");
    expect(cmd).not.toContain("$(cat");
  });
});

// =========================================================================
// getEnvironment
// =========================================================================
describe("getEnvironment", () => {
  const agent = create();

  it("sets CLAUDECODE to empty string (replaces unset in command)", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["CLAUDECODE"]).toBe("");
  });

  it("sets AO_SESSION_ID but not AO_PROJECT_ID (caller's responsibility)", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["AO_SESSION_ID"]).toBe("sess-1");
    expect(env["AO_PROJECT_ID"]).toBeUndefined();
  });

  it("sets AO_ISSUE_ID when provided", () => {
    const env = agent.getEnvironment(makeLaunchConfig({ issueId: "INT-100" }));
    expect(env["AO_ISSUE_ID"]).toBe("INT-100");
  });

  it("does not set AO_ISSUE_ID when not provided", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["AO_ISSUE_ID"]).toBeUndefined();
  });
});

// =========================================================================
// isProcessRunning
// =========================================================================
describe("isProcessRunning", () => {
  const agent = create();

  it("returns true when claude is found on tmux pane TTY", async () => {
    mockTmuxWithProcess("claude");
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("returns false when no claude on tmux pane TTY", async () => {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") return Promise.resolve({ stdout: "/dev/ttys002\n", stderr: "" });
      if (cmd === "ps")
        return Promise.resolve({
          stdout: "  PID TT       ARGS\n  999 ttys002  bash\n",
          stderr: "",
        });
      return Promise.reject(new Error("unexpected"));
    });
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  // Coverage for the broadened process regex — these are real install shapes
  // the previous narrow regex `/(?:^|\/)claude(?:\s|$)/` would have missed,
  // causing AO to declare sessions `exited` while Claude was still running.
  it.each([
    ["bare binary", "claude"],
    ["absolute path", "/opt/homebrew/bin/claude"],
    ["dot-prefix shim", "/usr/local/lib/.claude"],
    ["windows exe", "claude.exe"],
    ["js shim", "claude.js"],
    ["hyphenated name", "claude-code"],
    ["node-shim npm install", "node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js"],
  ])("returns true for %s (%s)", async (_label, args) => {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") return Promise.resolve({ stdout: "/dev/ttys001\n", stderr: "" });
      if (cmd === "ps")
        return Promise.resolve({
          stdout: `  PID TT       ARGS\n  123 ttys001  ${args}\n`,
          stderr: "",
        });
      return Promise.reject(new Error("unexpected"));
    });
    resetPsCache();
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("still rejects look-alike names (claudia, claudine)", async () => {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") return Promise.resolve({ stdout: "/dev/ttys001\n", stderr: "" });
      if (cmd === "ps")
        return Promise.resolve({
          stdout: "  PID TT       ARGS\n  123 ttys001  claudia\n  124 ttys001  /bin/claudine\n",
          stderr: "",
        });
      return Promise.reject(new Error("unexpected"));
    });
    resetPsCache();
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("returns false when tmux list-panes returns empty", async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("returns true for process runtime with alive PID", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(await agent.isProcessRunning(makeProcessHandle(999))).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(999, 0);
    killSpy.mockRestore();
  });

  it("returns false for process runtime with dead PID", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    expect(await agent.isProcessRunning(makeProcessHandle(999))).toBe(false);
    killSpy.mockRestore();
  });

  it("returns false for unknown runtime without PID (no pgrep fallback)", async () => {
    const handle: RuntimeHandle = { id: "x", runtimeName: "other", data: {} };
    expect(await agent.isProcessRunning(handle)).toBe(false);
    // Must NOT call pgrep — could match wrong session
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it("returns indeterminate when tmux command fails", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("fail"));
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe("indeterminate");
  });

  it("returns indeterminate when cached ps command fails", async () => {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") return Promise.resolve({ stdout: "/dev/ttys002\n", stderr: "" });
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

  it("finds claude on any pane in multi-pane session", async () => {
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "list-panes") {
        return Promise.resolve({ stdout: "/dev/ttys001\n/dev/ttys002\n", stderr: "" });
      }
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: "  PID TT ARGS\n  100 ttys001  bash\n  200 ttys002  claude -p test\n",
          stderr: "",
        });
      }
      return Promise.reject(new Error("unexpected"));
    });
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("returns false for tmux handle on Windows without spawning ps", async () => {
    mockIsWindows.mockReturnValue(true);
    // ps should never be called — getCachedProcessList guards against Windows
    mockExecFileAsync.mockRejectedValue(new Error("ps not available on Windows"));
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
    expect(mockExecFileAsync).not.toHaveBeenCalledWith("ps", expect.anything(), expect.anything());
    mockIsWindows.mockReturnValue(false);
  });
});

// =========================================================================
// detectActivity — terminal output classification
// =========================================================================
describe("detectActivity (retired — see #1941)", () => {
  // Claude activity is derived from platform-event hooks (PermissionRequest,
  // StopFailure, Notification, Stop, ...) which write directly to
  // .ao/activity.jsonl with source: "hook". The terminal-regex layer was
  // structurally fragile (every Claude UI tweak regressed it; #1932 spent
  // 15 commits patching its sharpest edges) and has been retired.
  //
  // The `detectActivity` method is kept on the Agent interface for other
  // plugins (Aider, OpenCode, Codex fallback) but is a stable no-signal
  // stub for Claude — returns "idle" for every input so the lifecycle
  // manager's terminal-output path stays neutral and the JSONL-backed
  // cascade is the only source of truth for active/ready/waiting_input/blocked.
  const agent = create();

  it("returns idle for empty terminal output", () => {
    expect(agent.detectActivity("")).toBe("idle");
  });

  it("returns idle for whitespace-only terminal output", () => {
    expect(agent.detectActivity("   \n  \n  ")).toBe("idle");
  });

  it.each([
    "Working... esc to interrupt\n",
    "Thinking...\n",
    "Reading file src/index.ts\n",
    "Writing to src/main.ts\n",
    "Searching codebase...\n",
    "Do you want to proceed? (Y)es / (N)o\n",
    "bypass all future permissions for this session\n",
    "  ⎿  Unable to connect to API (ConnectionRefused)\n",
    "     Retrying in 19s · attempt 7/10\n",
    "✻ Fluttering… (6m 49s · ↓ 26.9k tokens)\n",
    "some random terminal output\n",
  ])("returns idle for ALL non-empty input (no terminal-regex active/waiting_input/blocked): %s", (input) => {
    expect(agent.detectActivity(input)).toBe("idle");
  });
});

// =========================================================================
// getSessionInfo — JSONL parsing
// =========================================================================
describe("getSessionInfo", () => {
  const agent = create();

  it("returns null when workspacePath is null", async () => {
    expect(await agent.getSessionInfo(makeSession({ workspacePath: null }))).toBeNull();
  });

  it("returns null when project directory does not exist", async () => {
    mockReaddir.mockRejectedValue(new Error("ENOENT"));
    expect(await agent.getSessionInfo(makeSession())).toBeNull();
  });

  it("returns null when no JSONL files in project dir", async () => {
    mockReaddir.mockResolvedValue(["readme.txt", "config.yaml"]);
    expect(await agent.getSessionInfo(makeSession())).toBeNull();
  });

  it("filters out agent- prefixed JSONL files", async () => {
    mockReaddir.mockResolvedValue(["agent-toolkit.jsonl"]);
    expect(await agent.getSessionInfo(makeSession())).toBeNull();
  });

  it("returns null when JSONL file is empty", async () => {
    mockJsonlFiles("");
    expect(await agent.getSessionInfo(makeSession())).toBeNull();
  });

  it("returns null when JSONL has only malformed lines", async () => {
    mockJsonlFiles("not json\nalso not json\n");
    expect(await agent.getSessionInfo(makeSession())).toBeNull();
  });

  describe("path conversion", () => {
    it("converts workspace path to Claude project dir path", async () => {
      mockJsonlFiles('{"type":"user","message":{"content":"hello"}}');
      await agent.getSessionInfo(makeSession({ workspacePath: "/Users/dev/.worktrees/ao/ao-3" }));
      expect(mockReaddir).toHaveBeenCalledWith(
        pathJoin("/mock/home", ".claude", "projects", "-Users-dev--worktrees-ao-ao-3"),
      );
    });

    it("normalizes underscores to dashes (matches Claude Code on-disk slug, issue #1611)", async () => {
      mockJsonlFiles('{"type":"user","message":{"content":"hello"}}');
      await agent.getSessionInfo(
        makeSession({
          workspacePath:
            "/Users/dev/.agent-orchestrator/projects/graph-isomorphism_d185b44d56/worktrees/gi-orchestrator",
        }),
      );
      expect(mockReaddir).toHaveBeenCalledWith(
        pathJoin(
          "/mock/home",
          ".claude",
          "projects",
          "-Users-dev--agent-orchestrator-projects-graph-isomorphism-d185b44d56-worktrees-gi-orchestrator",
        ),
      );
    });
  });

  describe("summary extraction", () => {
    it("extracts summary from last summary event and marks as not fallback", async () => {
      const jsonl = [
        '{"type":"summary","summary":"First summary"}',
        '{"type":"user","message":{"content":"do something"}}',
        '{"type":"summary","summary":"Latest summary"}',
      ].join("\n");
      mockJsonlFiles(jsonl);
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.summary).toBe("Latest summary");
      expect(result?.summaryIsFallback).toBe(false);
    });

    it("falls back to first user message and marks as fallback", async () => {
      const jsonl = [
        '{"type":"user","message":{"content":"Implement the login feature"}}',
        '{"type":"assistant","message":{"content":"I will implement..."}}',
      ].join("\n");
      mockJsonlFiles(jsonl);
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.summary).toBe("Implement the login feature");
      expect(result?.summaryIsFallback).toBe(true);
    });

    it("truncates long user message to 120 chars", async () => {
      const longMsg = "A".repeat(200);
      const jsonl = `{"type":"user","message":{"content":"${longMsg}"}}`;
      mockJsonlFiles(jsonl);
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.summary).toBe("A".repeat(120) + "...");
      expect(result!.summary!.length).toBe(123);
      expect(result?.summaryIsFallback).toBe(true);
    });

    it("returns null summary when no summary and no user messages", async () => {
      const jsonl = '{"type":"assistant","message":{"content":"Hello"}}';
      mockJsonlFiles(jsonl);
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.summary).toBeNull();
      expect(result?.summaryIsFallback).toBeUndefined();
    });

    it("skips user messages with empty content", async () => {
      const jsonl = [
        '{"type":"user","message":{"content":"   "}}',
        '{"type":"user","message":{"content":"Real content"}}',
      ].join("\n");
      mockJsonlFiles(jsonl);
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.summary).toBe("Real content");
      expect(result?.summaryIsFallback).toBe(true);
    });
  });

  describe("session ID extraction", () => {
    it("extracts session ID from filename", async () => {
      mockJsonlFiles('{"type":"user","message":{"content":"hi"}}', ["abc-def-123.jsonl"]);
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.agentSessionId).toBe("abc-def-123");
      expect(result?.metadata?.claudeSessionUuid).toBe("abc-def-123");
    });
  });

  describe("getRestoreCommand metadata", () => {
    it("uses persisted Claude session UUID without scanning project files", async () => {
      const agent = create();
      const session = makeSession({
        workspacePath: "/workspace/test-project",
        metadata: { claudeSessionUuid: "persisted-uuid" },
      });

      const command = await agent.getRestoreCommand!(session, {
        name: "test-project",
        repo: "owner/repo",
        path: "/workspace/test-project",
        defaultBranch: "main",
        sessionPrefix: "test",
      });

      expect(command).toBe("claude --resume 'persisted-uuid'");
      expect(mockReaddir).not.toHaveBeenCalled();
    });
  });

  describe("cost estimation", () => {
    it("aggregates usage.input_tokens and usage.output_tokens", async () => {
      const jsonl = [
        '{"type":"user","message":{"content":"hi"}}',
        '{"type":"assistant","usage":{"input_tokens":1000,"output_tokens":500}}',
        '{"type":"assistant","usage":{"input_tokens":2000,"output_tokens":300}}',
      ].join("\n");
      mockJsonlFiles(jsonl);
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.cost?.inputTokens).toBe(3000);
      expect(result?.cost?.outputTokens).toBe(800);
      expect(result?.cost?.estimatedCostUsd).toBeCloseTo(0.009 + 0.012, 6);
    });

    it("includes cache tokens in input count", async () => {
      const jsonl = [
        '{"type":"user","message":{"content":"hi"}}',
        '{"type":"assistant","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":500,"cache_creation_input_tokens":200}}',
      ].join("\n");
      mockJsonlFiles(jsonl);
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.cost?.inputTokens).toBe(800);
      expect(result?.cost?.outputTokens).toBe(50);
    });

    it("uses model-aware pricing when cached tokens are present", async () => {
      const jsonl = [
        '{"type":"assistant","model":"claude-sonnet-4-5","usage":{"input_tokens":1000,"output_tokens":100,"cache_read_input_tokens":10000,"cache_creation_input_tokens":2000}}',
      ].join("\n");
      mockJsonlFiles(jsonl);
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.cost?.inputTokens).toBe(13000);
      expect(result?.cost?.outputTokens).toBe(100);
      expect(result?.cost?.estimatedCostUsd).toBeGreaterThan(0);
    });

    it("uses costUSD field when present", async () => {
      const jsonl = [
        '{"type":"user","message":{"content":"hi"}}',
        '{"costUSD":0.05}',
        '{"costUSD":0.03}',
      ].join("\n");
      mockJsonlFiles(jsonl);
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.cost?.estimatedCostUsd).toBeCloseTo(0.08);
    });

    it("prefers costUSD over estimatedCostUsd to avoid double-counting", async () => {
      const jsonl = [
        '{"type":"user","message":{"content":"hi"}}',
        '{"costUSD":0.10,"estimatedCostUsd":0.10}',
      ].join("\n");
      mockJsonlFiles(jsonl);
      const result = await agent.getSessionInfo(makeSession());
      // Should use costUSD only, not sum both
      expect(result?.cost?.estimatedCostUsd).toBeCloseTo(0.1);
    });

    it("falls back to estimatedCostUsd when costUSD is absent", async () => {
      const jsonl = [
        '{"type":"user","message":{"content":"hi"}}',
        '{"estimatedCostUsd":0.12}',
      ].join("\n");
      mockJsonlFiles(jsonl);
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.cost?.estimatedCostUsd).toBeCloseTo(0.12);
    });

    it("uses direct inputTokens/outputTokens fields", async () => {
      const jsonl = [
        '{"type":"user","message":{"content":"hi"}}',
        '{"inputTokens":5000,"outputTokens":1000}',
      ].join("\n");
      mockJsonlFiles(jsonl);
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.cost?.inputTokens).toBe(5000);
      expect(result?.cost?.outputTokens).toBe(1000);
    });

    it("returns undefined cost when no usage data", async () => {
      const jsonl = '{"type":"user","message":{"content":"hi"}}';
      mockJsonlFiles(jsonl);
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.cost).toBeUndefined();
    });
  });

  describe("file selection", () => {
    it("picks the most recently modified JSONL file", async () => {
      mockReaddir.mockResolvedValue(["old.jsonl", "new.jsonl"]);
      mockStat.mockImplementation((path: string) => {
        if (path.endsWith("old.jsonl")) {
          return Promise.resolve({ mtimeMs: 1000, mtime: new Date(1000) });
        }
        return Promise.resolve({ mtimeMs: 2000, mtime: new Date(2000) });
      });
      mockReadFile.mockResolvedValue('{"type":"user","message":{"content":"hi"}}');
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.agentSessionId).toBe("new");
    });

    it("skips JSONL files that fail stat", async () => {
      mockReaddir.mockResolvedValue(["broken.jsonl", "good.jsonl"]);
      mockStat.mockImplementation((path: string) => {
        if (path.endsWith("broken.jsonl")) {
          return Promise.reject(new Error("ENOENT"));
        }
        return Promise.resolve({ mtimeMs: 1000, mtime: new Date(1000) });
      });
      mockReadFile.mockResolvedValue('{"type":"user","message":{"content":"hi"}}');
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.agentSessionId).toBe("good");
    });
  });

  describe("malformed JSONL handling", () => {
    it("skips malformed lines and parses valid ones", async () => {
      const jsonl = [
        "not valid json",
        '{"type":"summary","summary":"Good summary"}',
        "{truncated",
        "",
      ].join("\n");
      mockJsonlFiles(jsonl);
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.summary).toBe("Good summary");
    });

    it("skips JSON null, array, and primitive values", async () => {
      const jsonl = [
        "null",
        "42",
        '"just a string"',
        "[1,2,3]",
        '{"type":"summary","summary":"Valid object"}',
      ].join("\n");
      mockJsonlFiles(jsonl);
      const result = await agent.getSessionInfo(makeSession());
      expect(result?.summary).toBe("Valid object");
    });

    it("handles readFile failure gracefully", async () => {
      mockReaddir.mockResolvedValue(["session.jsonl"]);
      mockStat.mockResolvedValue({ mtimeMs: 1000, mtime: new Date(1000) });
      mockReadFile.mockRejectedValue(new Error("EACCES"));
      const result = await agent.getSessionInfo(makeSession());
      expect(result).toBeNull();
    });
  });
});

// =========================================================================
// METADATA_UPDATER_SCRIPT — content verification (unit tests)
// =========================================================================
describe("METADATA_UPDATER_SCRIPT content", () => {
  it("contains clean_command stripping logic for cd prefixes", () => {
    expect(METADATA_UPDATER_SCRIPT).toContain('clean_command="$command"');
    expect(METADATA_UPDATER_SCRIPT).toMatch(/while.*clean_command.*cd/);
  });

  it("uses $clean_command (not $command) for all regex-based command detection", () => {
    const lines = METADATA_UPDATER_SCRIPT.split("\n");
    for (const line of lines) {
      // Skip comment lines, the initial assignment, and the stripping logic itself
      if (line.trim().startsWith("#")) continue;
      if (line.includes('clean_command="$command"')) continue;
      if (line.includes("while") && line.includes("clean_command")) continue;

      // Any regex match line (=~) should use $clean_command, NOT $command
      if (line.includes("=~") && line.includes("command")) {
        expect(line).toContain("clean_command");
        expect(line).not.toMatch(/"\$command"/);
      }
    }
  });

  it("does NOT use ^-anchored regexes directly on $command for gh/git detection", () => {
    // The old buggy patterns matched $command with ^ anchor.
    // After the fix, ^ is still used but on $clean_command (which has cd stripped).
    expect(METADATA_UPDATER_SCRIPT).not.toMatch(/"\$command"\s*=~\s*\^gh/);
    expect(METADATA_UPDATER_SCRIPT).not.toMatch(/"\$command"\s*=~\s*\^git/);
  });

  it("strips cd prefixes with both && and ; delimiters", () => {
    expect(METADATA_UPDATER_SCRIPT).toMatch(/&&\|;/);
  });

  it("handles multiple chained cd commands via while loop", () => {
    expect(METADATA_UPDATER_SCRIPT).toMatch(/while.*clean_command/);
  });

  it("detects gh pr create on clean_command", () => {
    expect(METADATA_UPDATER_SCRIPT).toMatch(/"\$clean_command"\s*=~\s*\^gh\[/);
  });

  it("detects git checkout -b on clean_command", () => {
    expect(METADATA_UPDATER_SCRIPT).toMatch(/"\$clean_command"\s*=~\s*\^git\[.*checkout/);
  });

  it("detects gh pr merge on clean_command", () => {
    expect(METADATA_UPDATER_SCRIPT).toMatch(/"\$clean_command"\s*=~\s*\^gh\[.*merge/);
  });
});

// =========================================================================
// setupWorkspaceHooks / postLaunchSetup — hook path (symlink safety)
// =========================================================================
describe("hook setup — relative path (symlink-safe)", () => {
  const agent = create();

  /** Extract the hook command from the settings.json that was written */
  function getWrittenHookCommand(): string {
    const settingsWrite = mockWriteFile.mock.calls.find(
      ([path]: unknown[]) => typeof path === "string" && path.endsWith("settings.json"),
    );
    expect(settingsWrite).toBeDefined();
    const parsed = JSON.parse(settingsWrite![1] as string);
    return parsed.hooks.PostToolUse[0].hooks[0].command;
  }

  it("setupWorkspaceHooks writes a relative hook command (not absolute)", async () => {
    await agent.setupWorkspaceHooks!(
      "/Users/equinox/.worktrees/integrator/integrator-5",
      {} as WorkspaceHooksConfig,
    );

    const hookCommand = getWrittenHookCommand();
    expect(hookCommand).toBe(".claude/metadata-updater.sh");
    expect(hookCommand).not.toMatch(/^\//);
  });

  it("postLaunchSetup is a no-op (hooks installed pre-launch via setupWorkspaceHooks)", async () => {
    mockWriteFile.mockClear();
    await agent.postLaunchSetup!(
      makeSession({ workspacePath: "/Users/equinox/.worktrees/integrator/integrator-10" }),
    );

    // No files should be written — hooks are installed before launch
    const settingsWrites = mockWriteFile.mock.calls.filter(
      ([path]: unknown[]) => typeof path === "string" && path.endsWith("settings.json"),
    );
    expect(settingsWrites).toHaveLength(0);
  });

  it("different worktree paths produce identical settings.json content", async () => {
    await agent.setupWorkspaceHooks!(
      "/Users/equinox/.worktrees/integrator/integrator-5",
      {} as WorkspaceHooksConfig,
    );
    const settingsWrite1 = mockWriteFile.mock.calls.find(
      ([path]: unknown[]) => typeof path === "string" && path.endsWith("settings.json"),
    );
    const content1 = settingsWrite1![1] as string;

    mockWriteFile.mockClear();

    await agent.setupWorkspaceHooks!(
      "/Users/equinox/.worktrees/integrator/integrator-10",
      {} as WorkspaceHooksConfig,
    );
    const settingsWrite2 = mockWriteFile.mock.calls.find(
      ([path]: unknown[]) => typeof path === "string" && path.endsWith("settings.json"),
    );
    const content2 = settingsWrite2![1] as string;

    expect(content1).toBe(content2);
  });

  it("updates an existing absolute hook path to relative", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: "Bash",
              hooks: [
                {
                  type: "command",
                  command:
                    "/Users/equinox/.worktrees/integrator/integrator-5/.claude/metadata-updater.sh",
                  timeout: 5000,
                },
              ],
            },
          ],
        },
      }),
    );

    await agent.setupWorkspaceHooks!(
      "/Users/equinox/.worktrees/integrator/integrator-10",
      {} as WorkspaceHooksConfig,
    );

    const hookCommand = getWrittenHookCommand();
    expect(hookCommand).toBe(".claude/metadata-updater.sh");
  });

  it("still writes the script file to the correct absolute filesystem path", async () => {
    await agent.setupWorkspaceHooks!(
      "/Users/equinox/.worktrees/integrator/integrator-5",
      {} as WorkspaceHooksConfig,
    );

    const scriptWrite = mockWriteFile.mock.calls.find(
      ([path]: unknown[]) => typeof path === "string" && path.endsWith("metadata-updater.sh"),
    );
    expect(scriptWrite).toBeDefined();
    expect(scriptWrite![0]).toBe(
      pathJoin(
        "/Users/equinox/.worktrees/integrator/integrator-5",
        ".claude",
        "metadata-updater.sh",
      ),
    );
  });

  it("skips postLaunchSetup when workspacePath is null", async () => {
    await agent.postLaunchSetup!(makeSession({ workspacePath: null }));
    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});

// =========================================================================
// setupWorkspaceHooks — activity-updater registration (#1941)
// =========================================================================
describe("setupWorkspaceHooks — activity-updater (#1941)", () => {
  const agent = create();

  function getParsedSettings(): Record<string, unknown> {
    const settingsWrite = mockWriteFile.mock.calls.find(
      ([path]: unknown[]) => typeof path === "string" && path.endsWith("settings.json"),
    );
    expect(settingsWrite).toBeDefined();
    return JSON.parse(settingsWrite![1] as string) as Record<string, unknown>;
  }

  /** Activity-updater command paths (unix vs win32) */
  const ACTIVITY_CMD_UNIX = ".claude/activity-updater.sh";
  const ACTIVITY_CMD_WIN = "node .claude/activity-updater.cjs";

  /**
   * Every Claude Code hook event the script knows how to translate into an
   * activity state. The dashboard / lifecycle reducer relies on these firing
   * so platform events replace terminal-output regex.
   */
  const ACTIVITY_EVENTS = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "PostToolBatch",
    "Notification",
    "PermissionRequest",
    "Stop",
    "StopFailure",
    "SubagentStart",
    "SubagentStop",
    "PreCompact",
    "PostCompact",
  ] as const;

  it("writes the activity-updater script to .claude/", async () => {
    await agent.setupWorkspaceHooks!("/workspace/test", {} as WorkspaceHooksConfig);

    const scriptWrite = mockWriteFile.mock.calls.find(
      ([path]: unknown[]) => typeof path === "string" && path.endsWith("activity-updater.sh"),
    );
    expect(scriptWrite).toBeDefined();
    expect(scriptWrite![1]).toBe(ACTIVITY_UPDATER_SCRIPT);
  });

  it("makes the activity-updater script executable on unix (chmod 0o755)", async () => {
    await agent.setupWorkspaceHooks!("/workspace/test", {} as WorkspaceHooksConfig);

    const chmodCall = mockChmod.mock.calls.find(
      ([path]: unknown[]) => typeof path === "string" && path.endsWith("activity-updater.sh"),
    );
    expect(chmodCall).toBeDefined();
    expect(chmodCall![1]).toBe(0o755);
  });

  it.each(ACTIVITY_EVENTS)(
    "registers the activity-updater hook on %s",
    async (event) => {
      mockWriteFile.mockClear();
      await agent.setupWorkspaceHooks!("/workspace/test", {} as WorkspaceHooksConfig);

      const settings = getParsedSettings();
      const hookGroup = (settings.hooks as Record<string, unknown>)[event] as Array<{
        matcher: string;
        hooks: Array<{ command: string; timeout?: number }>;
      }>;
      expect(hookGroup).toBeDefined();
      const activity = hookGroup.flatMap((g) => g.hooks).find((h) => h.command === ACTIVITY_CMD_UNIX);
      expect(activity).toBeDefined();
      // The script does a single JSON parse + append — short timeout keeps a
      // stuck hook from slowing the turn down.
      expect(activity!.timeout).toBe(2000);
    },
  );

  it("registers activity-updater PostToolUse alongside metadata-updater", async () => {
    mockWriteFile.mockClear();
    await agent.setupWorkspaceHooks!("/workspace/test", {} as WorkspaceHooksConfig);

    const settings = getParsedSettings();
    const postToolUse = (settings.hooks as Record<string, unknown>)["PostToolUse"] as Array<{
      matcher: string;
      hooks: Array<{ command: string }>;
    }>;
    expect(postToolUse.length).toBeGreaterThanOrEqual(2);

    const metadataEntry = postToolUse.find((g) =>
      g.hooks.some((h) => h.command.includes("metadata-updater")),
    );
    const activityEntry = postToolUse.find((g) =>
      g.hooks.some((h) => h.command.includes("activity-updater")),
    );

    expect(metadataEntry).toBeDefined();
    expect(metadataEntry!.matcher).toBe("Bash"); // unchanged from before #1941
    expect(activityEntry).toBeDefined();
    expect(activityEntry!.matcher).toBe(""); // fires on every PostToolUse, not just Bash
  });

  it("is idempotent — calling twice keeps exactly one activity-updater entry per event", async () => {
    mockWriteFile.mockClear();
    await agent.setupWorkspaceHooks!("/workspace/test", {} as WorkspaceHooksConfig);
    const firstSettings = mockWriteFile.mock.calls.find(
      ([path]: unknown[]) => typeof path === "string" && path.endsWith("settings.json"),
    );
    mockExistsSync.mockReturnValueOnce(true);
    mockReadFile.mockResolvedValueOnce(firstSettings![1] as string);
    mockWriteFile.mockClear();

    await agent.setupWorkspaceHooks!("/workspace/test", {} as WorkspaceHooksConfig);

    const settings = getParsedSettings();
    for (const event of ACTIVITY_EVENTS) {
      const hookGroup = (settings.hooks as Record<string, unknown>)[event] as Array<{
        hooks: Array<{ command: string }>;
      }>;
      const activityHooks = hookGroup.flatMap((g) => g.hooks).filter(
        (h) => h.command === ACTIVITY_CMD_UNIX,
      );
      expect(activityHooks).toHaveLength(1);
    }
  });

  it("preserves a user-installed Stop hook when adding our activity-updater", async () => {
    const existingSettings = {
      hooks: {
        Stop: [
          {
            matcher: "",
            hooks: [{ type: "command", command: "echo user-hook", timeout: 1000 }],
          },
        ],
      },
    };
    mockExistsSync.mockReturnValueOnce(true);
    mockReadFile.mockResolvedValueOnce(JSON.stringify(existingSettings));
    mockWriteFile.mockClear();

    await agent.setupWorkspaceHooks!("/workspace/test", {} as WorkspaceHooksConfig);

    const settings = getParsedSettings();
    const stopGroup = (settings.hooks as Record<string, unknown>)["Stop"] as Array<{
      hooks: Array<{ command: string }>;
    }>;
    const commands = stopGroup.flatMap((g) => g.hooks).map((h) => h.command);
    expect(commands).toContain("echo user-hook"); // user hook preserved
    expect(commands).toContain(ACTIVITY_CMD_UNIX); // our hook added
  });

  it("tolerates malformed hooks.<event> (object instead of array)", async () => {
    // A user could hand-edit settings.json or an older plugin could have
    // written a non-array shape there. We must not crash — start fresh.
    const malformed = {
      hooks: {
        // Object where an array is expected
        Stop: { matcher: "", command: "broken" },
      },
    };
    mockExistsSync.mockReturnValueOnce(true);
    mockReadFile.mockResolvedValueOnce(JSON.stringify(malformed));
    mockWriteFile.mockClear();

    await expect(
      agent.setupWorkspaceHooks!("/workspace/test", {} as WorkspaceHooksConfig),
    ).resolves.not.toThrow();

    const settings = getParsedSettings();
    const stopGroup = (settings.hooks as Record<string, unknown>)["Stop"] as Array<{
      hooks: Array<{ command: string }>;
    }>;
    expect(Array.isArray(stopGroup)).toBe(true);
    const commands = stopGroup.flatMap((g) => g.hooks).map((h) => h.command);
    expect(commands).toContain(ACTIVITY_CMD_UNIX);
  });

  it("preserves matcher of an entry where user co-located their own def alongside ours", async () => {
    // User has added their own hook def into the SAME { matcher, hooks: [...] }
    // object that contains our activity-updater. If we naively reset
    // entry.matcher to ours (""), the user's def starts firing on every
    // PreToolUse event instead of only "Edit|Write".
    const existingSettings = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Edit|Write",
            hooks: [
              { type: "command", command: ".claude/activity-updater.sh", timeout: 2000 },
              { type: "command", command: "echo user-edits-only", timeout: 1000 },
            ],
          },
        ],
      },
    };
    mockExistsSync.mockReturnValueOnce(true);
    mockReadFile.mockResolvedValueOnce(JSON.stringify(existingSettings));
    mockWriteFile.mockClear();

    await agent.setupWorkspaceHooks!("/workspace/test", {} as WorkspaceHooksConfig);

    const settings = getParsedSettings();
    const pre = (settings.hooks as Record<string, unknown>)["PreToolUse"] as Array<{
      matcher: string;
      hooks: Array<{ command: string }>;
    }>;
    const sharedEntry = pre.find((g) =>
      g.hooks.some((h) => h.command === "echo user-edits-only"),
    );
    expect(sharedEntry).toBeDefined();
    // Matcher must NOT be overwritten — user's hook keeps firing on "Edit|Write"
    expect(sharedEntry!.matcher).toBe("Edit|Write");
    // Both defs still present
    expect(sharedEntry!.hooks.map((h) => h.command)).toEqual([
      ACTIVITY_CMD_UNIX,
      "echo user-edits-only",
    ]);
  });

  it("on Windows writes activity-updater.cjs (not .sh) and uses node invocation", async () => {
    mockIsWindows.mockReturnValue(true);
    mockWriteFile.mockClear();

    await agent.setupWorkspaceHooks!("C:\\\\Users\\\\dev\\\\workspace", {} as WorkspaceHooksConfig);

    const cjsWrite = mockWriteFile.mock.calls.find(
      ([path]: unknown[]) => typeof path === "string" && path.endsWith("activity-updater.cjs"),
    );
    expect(cjsWrite).toBeDefined();
    expect(cjsWrite![1]).toBe(ACTIVITY_UPDATER_SCRIPT_NODE);

    const shWrite = mockWriteFile.mock.calls.find(
      ([path]: unknown[]) => typeof path === "string" && path.endsWith("activity-updater.sh"),
    );
    expect(shWrite).toBeUndefined();

    const settings = getParsedSettings();
    const stopGroup = (settings.hooks as Record<string, unknown>)["Stop"] as Array<{
      hooks: Array<{ command: string }>;
    }>;
    expect(stopGroup.flatMap((g) => g.hooks).some((h) => h.command === ACTIVITY_CMD_WIN)).toBe(true);

    mockIsWindows.mockReturnValue(false);
  });

  it("does not chmod on Windows (Windows uses extension for executability)", async () => {
    mockIsWindows.mockReturnValue(true);
    mockChmod.mockClear();

    await agent.setupWorkspaceHooks!("C:\\\\Users\\\\dev\\\\workspace", {} as WorkspaceHooksConfig);

    const chmodCalls = mockChmod.mock.calls.filter(
      ([path]: unknown[]) => typeof path === "string" && path.endsWith("activity-updater.cjs"),
    );
    expect(chmodCalls).toHaveLength(0);

    mockIsWindows.mockReturnValue(false);
  });
});

// =========================================================================
// setupWorkspaceHooks on win32 — Node.js hook script
// =========================================================================
describe("setupWorkspaceHooks on win32", () => {
  const agent = create();

  /** Extract the hook command written to settings.json */
  function getWrittenHookCommand(): string {
    const settingsWrite = mockWriteFile.mock.calls.find(
      ([path]: unknown[]) => typeof path === "string" && path.endsWith("settings.json"),
    );
    expect(settingsWrite).toBeDefined();
    const parsed = JSON.parse(settingsWrite![1] as string);
    return parsed.hooks.PostToolUse[0].hooks[0].command;
  }

  /** Get the content written to the hook script file */
  function getWrittenScriptContent(ext: string): string | undefined {
    const scriptWrite = mockWriteFile.mock.calls.find(
      ([path]: unknown[]) => typeof path === "string" && path.endsWith(ext),
    );
    return scriptWrite ? (scriptWrite[1] as string) : undefined;
  }

  beforeEach(() => {
    mockIsWindows.mockReturnValue(true);
  });

  afterEach(() => {
    mockIsWindows.mockReturnValue(false);
  });

  it("writes a Node.js hook script instead of bash on Windows", async () => {
    await agent.setupWorkspaceHooks!("C:\\\\Users\\\\dev\\\\workspace", {} as WorkspaceHooksConfig);

    // The .cjs file must have been written (.cjs forces CJS mode in ESM workspaces)
    const cjsContent = getWrittenScriptContent("metadata-updater.cjs");
    expect(cjsContent).toBeDefined();
    expect(cjsContent).toContain("#!/usr/bin/env node");

    // Must not contain bash-isms
    expect(cjsContent).not.toContain("#!/usr/bin/env bash");
    expect(cjsContent).not.toContain("jq");
    expect(cjsContent).not.toContain("grep");
    expect(cjsContent).not.toContain("sed");

    // The .sh and .js files must NOT have been written
    const shContent = getWrittenScriptContent("metadata-updater.sh");
    expect(shContent).toBeUndefined();
    const jsContent = getWrittenScriptContent("metadata-updater.js");
    expect(jsContent).toBeUndefined();
  });

  it("uses node command in settings.json hook command on Windows", async () => {
    await agent.setupWorkspaceHooks!("C:\\\\Users\\\\dev\\\\workspace", {} as WorkspaceHooksConfig);

    const hookCommand = getWrittenHookCommand();
    expect(hookCommand).toBe("node .claude/metadata-updater.cjs");
    expect(hookCommand).not.toContain(".sh");
  });

  it("skips chmod on win32", async () => {
    await agent.setupWorkspaceHooks!("C:\\\\Users\\\\dev\\\\workspace", {} as WorkspaceHooksConfig);

    expect(mockChmod).not.toHaveBeenCalled();
  });

  it("exports METADATA_UPDATER_SCRIPT_NODE with Node.js shebang", () => {
    expect(METADATA_UPDATER_SCRIPT_NODE).toContain("#!/usr/bin/env node");
    expect(METADATA_UPDATER_SCRIPT_NODE).not.toContain("jq");
    expect(METADATA_UPDATER_SCRIPT_NODE).not.toContain("grep");
    expect(METADATA_UPDATER_SCRIPT_NODE).not.toContain("sed");
  });

  it("Node.js hook script handles gh pr create detection", () => {
    expect(METADATA_UPDATER_SCRIPT_NODE).toContain("gh");
    expect(METADATA_UPDATER_SCRIPT_NODE).toContain("pr");
    expect(METADATA_UPDATER_SCRIPT_NODE).toContain("create");
    expect(METADATA_UPDATER_SCRIPT_NODE).toContain("updateMetadataKey");
    expect(METADATA_UPDATER_SCRIPT_NODE).toContain("pr_open");
  });

  it("Node.js hook script handles git checkout -b detection", () => {
    expect(METADATA_UPDATER_SCRIPT_NODE).toContain("checkout");
    expect(METADATA_UPDATER_SCRIPT_NODE).toContain("-b");
  });

  it("Node.js hook script handles gh pr merge detection", () => {
    expect(METADATA_UPDATER_SCRIPT_NODE).toContain("pr\\s+merge");
    expect(METADATA_UPDATER_SCRIPT_NODE).toContain("merged");
  });

  it("Node.js hook script validates AO_DATA_DIR against allowed directories", () => {
    // Must contain the allowlist check mirroring ao-metadata-helper.sh and
    // the Node.js wrappers in agent-workspace-hooks.ts (C-1 security fix)
    expect(METADATA_UPDATER_SCRIPT_NODE).toContain("allowedBases");
    expect(METADATA_UPDATER_SCRIPT_NODE).toContain("realpathSync");
    expect(METADATA_UPDATER_SCRIPT_NODE).toContain(".ao");
    expect(METADATA_UPDATER_SCRIPT_NODE).toContain(".agent-orchestrator");
    expect(METADATA_UPDATER_SCRIPT_NODE).toContain("os.tmpdir");
  });

  it("does not add duplicate hook entry when called twice on Windows", async () => {
    // First call creates the hook
    await agent.setupWorkspaceHooks!("C:\\\\Users\\\\dev\\\\workspace", {} as WorkspaceHooksConfig);

    // Simulate second call: settings.json now contains the .cjs hook
    const firstSettings = mockWriteFile.mock.calls.find(
      ([path]: unknown[]) => typeof path === "string" && path.endsWith("settings.json"),
    );
    expect(firstSettings).toBeDefined();
    mockReadFile.mockResolvedValueOnce(firstSettings![1] as string);
    vi.clearAllMocks();
    mockIsWindows.mockReturnValue(true);

    // Second call — should UPDATE the existing hook, not add a duplicate
    await agent.setupWorkspaceHooks!("C:\\\\Users\\\\dev\\\\workspace", {} as WorkspaceHooksConfig);

    const secondSettings = mockWriteFile.mock.calls.find(
      ([path]: unknown[]) => typeof path === "string" && path.endsWith("settings.json"),
    );
    expect(secondSettings).toBeDefined();
    const parsed = JSON.parse(secondSettings![1] as string);
    const hookEntries = parsed.hooks.PostToolUse as Array<{ hooks: Array<{ command: string }> }>;
    // Count all hook commands matching our metadata updater
    const metadataHooks = hookEntries
      .flatMap((e) => e.hooks)
      .filter((h) => h.command.includes("metadata-updater"));
    // Must be exactly 1 — no duplicates
    expect(metadataHooks).toHaveLength(1);
  });
});
