import { describe, it, expect, vi, beforeEach } from "vitest";
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
  mockStat,
  mockHomedir,
  mockWriteFile,
  mockMkdir,
  mockChmod,
  mockExistsSync,
} = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
  mockReaddir: vi.fn(),
  mockReadFile: vi.fn(),
  mockStat: vi.fn(),
  mockHomedir: vi.fn(() => "/mock/home"),
  mockWriteFile: vi.fn().mockResolvedValue(undefined),
  mockMkdir: vi.fn().mockResolvedValue(undefined),
  mockChmod: vi.fn().mockResolvedValue(undefined),
  mockExistsSync: vi.fn().mockReturnValue(false),
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
}));

vi.mock("node:os", () => ({
  homedir: mockHomedir,
}));

import {
  create,
  manifest,
  default as defaultExport,
  resetPsCache,
  toClaudeProjectPath,
  METADATA_UPDATER_SCRIPT,
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

  it("strips Windows drive colons and folds backslashes", () => {
    expect(toClaudeProjectPath("C:\\Users\\dev\\foo")).toBe("C-Users-dev-foo");
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
    expect(agent.promptDelivery).toBe("post-launch");
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

  it("does not include -p flag (prompt delivered post-launch)", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "Fix the bug" }));
    expect(cmd).not.toContain("-p");
    expect(cmd).not.toContain("Fix the bug");
  });

  it("combines all options without prompt", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ permissions: "permissionless", model: "opus", prompt: "Hello" }),
    );
    expect(cmd).toBe("claude --dangerously-skip-permissions --model 'opus'");
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

  it("includes --append-system-prompt alongside omitted -p", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ systemPrompt: "You are a helper", prompt: "Do the task" }),
    );
    expect(cmd).toContain("--append-system-prompt");
    expect(cmd).toContain("You are a helper");
    // -p as a standalone flag (not substring of --append-system-prompt)
    expect(cmd).not.toMatch(/\s-p\s/);
    expect(cmd).not.toContain("Do the task");
  });

  it("uses systemPromptFile via shell substitution alongside omitted -p", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ systemPromptFile: "/tmp/prompt.md", prompt: "Do the task" }),
    );
    expect(cmd).toContain('--append-system-prompt "$(cat');
    expect(cmd).toContain("/tmp/prompt.md");
    expect(cmd).not.toMatch(/\s-p\s/);
    expect(cmd).not.toContain("Do the task");
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

  it("returns false when tmux command fails", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("fail"));
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

  it("does not match similar process names like claude-code", async () => {
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "tmux" && args[0] === "list-panes") {
        return Promise.resolve({ stdout: "/dev/ttys001\n", stderr: "" });
      }
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: "  PID TT ARGS\n  100 ttys001  /usr/bin/claude-code\n",
          stderr: "",
        });
      }
      return Promise.reject(new Error("unexpected"));
    });
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
    expect(agent.detectActivity("   \n  \n  ")).toBe("idle");
  });

  it("returns active when 'esc to interrupt' is visible", () => {
    expect(agent.detectActivity("Working... esc to interrupt\n")).toBe("active");
  });

  it("returns active when Thinking indicator is visible", () => {
    expect(agent.detectActivity("Thinking...\n")).toBe("active");
  });

  it("returns active when Reading indicator is visible", () => {
    expect(agent.detectActivity("Reading file src/index.ts\n")).toBe("active");
  });

  it("returns active when Writing indicator is visible", () => {
    expect(agent.detectActivity("Writing to src/main.ts\n")).toBe("active");
  });

  it("returns active when Searching indicator is visible", () => {
    expect(agent.detectActivity("Searching codebase...\n")).toBe("active");
  });

  it("returns waiting_input for permission prompt (Y/N)", () => {
    expect(agent.detectActivity("Do you want to proceed? (Y)es / (N)o\n")).toBe("waiting_input");
  });

  it("returns waiting_input for 'Do you want to proceed?' prompt", () => {
    expect(agent.detectActivity("Do you want to proceed?\n")).toBe("waiting_input");
  });

  it("returns waiting_input for bypass permissions prompt", () => {
    expect(agent.detectActivity("bypass all future permissions for this session\n")).toBe(
      "waiting_input",
    );
  });

  it("returns active when queued message indicator is visible", () => {
    expect(agent.detectActivity("Press up to edit queued messages\n")).toBe("active");
  });

  it("returns idle when shell prompt is visible", () => {
    expect(agent.detectActivity("some output\n> ")).toBe("idle");
    expect(agent.detectActivity("some output\n$ ")).toBe("idle");
  });

  it("returns idle when prompt follows historical activity indicators", () => {
    // Key regression test: historical "Reading file..." output in the buffer
    // should NOT override an idle prompt on the last line.
    expect(agent.detectActivity("Reading file src/index.ts\nWriting to out.ts\n❯ ")).toBe("idle");
    expect(agent.detectActivity("Thinking...\nSearching codebase...\n$ ")).toBe("idle");
  });

  it("returns waiting_input when permission prompt follows historical activity", () => {
    // Permission prompt at the bottom should NOT be overridden by historical
    // "Reading"/"Thinking" output higher in the buffer.
    expect(
      agent.detectActivity("Reading file src/index.ts\nThinking...\nDo you want to proceed?\n"),
    ).toBe("waiting_input");
    expect(agent.detectActivity("Searching codebase...\n(Y)es / (N)o\n")).toBe("waiting_input");
    expect(
      agent.detectActivity("Writing to out.ts\nbypass all future permissions for this session\n"),
    ).toBe("waiting_input");
  });

  it("returns active for non-empty output with no special patterns", () => {
    expect(agent.detectActivity("some random terminal output\n")).toBe("active");
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
        "/mock/home/.claude/projects/-Users-dev--worktrees-ao-ao-3",
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
        "/mock/home/.claude/projects/-Users-dev--agent-orchestrator-projects-graph-isomorphism-d185b44d56-worktrees-gi-orchestrator",
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

  it("postLaunchSetup writes a relative hook command (not absolute)", async () => {
    await agent.postLaunchSetup!(
      makeSession({ workspacePath: "/Users/equinox/.worktrees/integrator/integrator-10" }),
    );

    const hookCommand = getWrittenHookCommand();
    expect(hookCommand).toBe(".claude/metadata-updater.sh");
    expect(hookCommand).not.toMatch(/^\//);
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
      "/Users/equinox/.worktrees/integrator/integrator-5/.claude/metadata-updater.sh",
    );
  });

  it("skips postLaunchSetup when workspacePath is null", async () => {
    await agent.postLaunchSetup!(makeSession({ workspacePath: null }));
    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});
