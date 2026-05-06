import { describe, it, expect, vi, beforeEach } from "vitest";
import { createActivitySignal, type Session, type RuntimeHandle, type AgentLaunchConfig } from "@aoagents/ao-core";

const { mockAppendActivityEntry, mockReadLastActivityEntry, mockRecordTerminalActivity } =
  vi.hoisted(() => ({
    mockAppendActivityEntry: vi.fn().mockResolvedValue(undefined),
    mockReadLastActivityEntry: vi.fn().mockResolvedValue(null),
    mockRecordTerminalActivity: vi.fn().mockResolvedValue(undefined),
  }));

const mockExecFileAsync = vi.fn();

vi.mock("@aoagents/ao-core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    appendActivityEntry: mockAppendActivityEntry,
    readLastActivityEntry: mockReadLastActivityEntry,
    recordTerminalActivity: mockRecordTerminalActivity,
  };
});

vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => {
    const callback = args[args.length - 1];
    if (typeof callback === "function") {
      const result = mockExecFileAsync(...args.slice(0, -1));
      if (result && typeof result.then === "function") {
        result
          .then((r: { stdout: string; stderr: string }) => callback(null, r))
          .catch((e: Error) => callback(e));
      }
    }
  },
}));

import { create, manifest, default as defaultExport, resetOpenCodeSessionListCache } from "./index.js";

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
  mockExecFileAsync.mockImplementation((cmd: string) => {
    if (cmd === "tmux") return Promise.resolve({ stdout: "/dev/ttys003\n", stderr: "" });
    if (cmd === "ps") {
      const line = found ? `  789 ttys003  ${processName}` : "  789 ttys003  bash";
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
  resetOpenCodeSessionListCache();
});

describe("plugin manifest & exports", () => {
  it("has correct manifest", () => {
    expect(manifest).toEqual({
      name: "opencode",
      slot: "agent",
      description: "Agent plugin: OpenCode",
      version: "0.1.0",
      displayName: "OpenCode",
    });
  });

  it("create() returns agent with correct name and processName", () => {
    const agent = create();
    expect(agent.name).toBe("opencode");
    expect(agent.processName).toBe("opencode");
  });

  it("default export is a valid PluginModule", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
  });
});

describe("getLaunchCommand", () => {
  const agent = create();

  it("generates base command without prompt", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).toContain("opencode run --format json --title 'AO:sess-1'");
    expect(cmd).toContain('exec opencode --session "$SES_ID"');
    expect(cmd).toContain("opencode session list --format json");
    expect(cmd).toContain("AO:sess-1");
  });

  it("uses --prompt with shell-escaped prompt", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "Fix it" }));
    expect(cmd).toContain("opencode run --format json --title 'AO:sess-1'");
    expect(cmd).toContain("exec opencode --session \"$SES_ID\" --prompt 'Fix it'");
  });

  it("includes --model with shell-escaped value", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ model: "claude-sonnet-4-5-20250929" }));
    expect(cmd).toContain("--model 'claude-sonnet-4-5-20250929'");
  });

  it("combines prompt and model", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ prompt: "Go", model: "claude-sonnet-4-5-20250929" }),
    );
    expect(cmd).toContain(
      "opencode run --format json --title 'AO:sess-1' --model 'claude-sonnet-4-5-20250929'",
    );
    expect(cmd).toContain(
      "exec opencode --session \"$SES_ID\" --prompt 'Go' --model 'claude-sonnet-4-5-20250929'",
    );
    expect(cmd).toContain("--model 'claude-sonnet-4-5-20250929'");
  });

  it("escapes single quotes in prompt (POSIX shell escaping)", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "it's broken" }));
    expect(cmd).toContain("opencode run --format json --title 'AO:sess-1'");
    expect(cmd).toContain("exec opencode --session \"$SES_ID\" --prompt 'it'\\''s broken'");
  });

  it("omits optional flags when not provided", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).not.toContain("--model");
    expect(cmd).not.toContain("--agent");
  });

  it("includes --agent flag when subagent is provided", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ subagent: "sisyphus" }));
    expect(cmd).toContain("--agent 'sisyphus'");
  });

  it("generates command with agent and prompt", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ subagent: "sisyphus", prompt: "fix bug" }),
    );
    expect(cmd).toContain(
      "opencode run --format json --title 'AO:sess-1' --agent 'sisyphus'",
    );
    expect(cmd).toContain(
      "exec opencode --session \"$SES_ID\" --prompt 'fix bug' --agent 'sisyphus'",
    );
    expect(cmd).toContain("--agent 'sisyphus'");
  });

  it("generates command with agent, model, and prompt", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        subagent: "sisyphus",
        model: "claude-sonnet-4-5-20250929",
        prompt: "fix the bug",
      }),
    );
    expect(cmd).toContain(
      "opencode run --format json --title 'AO:sess-1' --agent 'sisyphus' --model 'claude-sonnet-4-5-20250929'",
    );
    expect(cmd).toContain(
      "exec opencode --session \"$SES_ID\" --prompt 'fix the bug' --agent 'sisyphus' --model 'claude-sonnet-4-5-20250929'",
    );
    expect(cmd).toContain("--agent 'sisyphus");
    expect(cmd).toContain("--model 'claude-sonnet-4-5-20250929");
  });

  it("shell-escapes sessionId in the discovery failure message", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ sessionId: "sess-1; rm -rf /" }));

    expect(cmd).toContain(
      "echo 'failed to discover OpenCode session ID for AO:sess-1; rm -rf /' >&2",
    );
  });

  it("keeps the fallback if-block shell-valid on one line", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());

    expect(cmd).toContain('if [ -z "$SES_ID" ]; then SES_ID=$(opencode session list --format json');
    expect(cmd).not.toContain("then;");
  });

  it("works with different agent names: oracle", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ subagent: "oracle", prompt: "review code" }),
    );
    expect(cmd).toContain("--agent 'oracle'");
    expect(cmd).toContain("'review code'");
  });

  it("works with different agent names: librarian", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ subagent: "librarian", prompt: "find usages" }),
    );
    expect(cmd).toContain("--agent 'librarian");
    expect(cmd).toContain("'find usages'");
  });

  it("backward compatible: no agent flag when subagent not provided", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "fix it" }));
    expect(cmd).not.toContain("--agent");
    expect(cmd).toContain("opencode run --format json --title 'AO:sess-1'");
    expect(cmd).toContain("exec opencode --session \"$SES_ID\" --prompt 'fix it'");
  });

  it("combines model and prompt without agent (backward compatible)", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ prompt: "Go", model: "claude-sonnet-4-5-20250929" }),
    );
    expect(cmd).not.toContain("--agent");
    expect(cmd).toContain(
      "opencode run --format json --title 'AO:sess-1' --model 'claude-sonnet-4-5-20250929'",
    );
    expect(cmd).toContain(
      "exec opencode --session \"$SES_ID\" --prompt 'Go' --model 'claude-sonnet-4-5-20250929'",
    );
    expect(cmd).toContain("--model 'claude-sonnet-4-5-20250929");
  });

  it("uses run bootstrap when systemPrompt is provided", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ systemPrompt: "You are an orchestrator" }),
    );
    expect(cmd).toContain("opencode run --format json --title 'AO:sess-1'");
    expect(cmd).toContain('exec opencode --session "$SES_ID"');
    expect(cmd).not.toContain("--prompt 'You are an orchestrator'");
    expect(cmd).not.toContain("--agent");
  });

  it("generates command with systemPrompt and task prompt", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ systemPrompt: "You are an orchestrator", prompt: "do the task" }),
    );
    expect(cmd).toContain("opencode run --format json --title 'AO:sess-1'");
    expect(cmd).toContain(`exec opencode --session "$SES_ID" --prompt 'do the task'`);
    expect(cmd).not.toContain("--agent");
  });

  it("escapes single quotes in systemPrompt", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ systemPrompt: "it's important" }));
    expect(cmd).not.toContain("it'\\''s important");
    expect(cmd).not.toContain("--agent");
  });

  it("handles very long systemPrompt", () => {
    const longPrompt = "A".repeat(500);
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ systemPrompt: longPrompt }));
    expect(cmd).toContain("opencode run --format json --title 'AO:sess-1'");
    expect(cmd.length).toBeGreaterThan(500);
  });

  it("generates command with systemPromptFile via shell substitution", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ systemPromptFile: "/tmp/prompt.md" }));
    expect(cmd).toContain("opencode run --format json --title 'AO:sess-1'");
    expect(cmd).toContain('exec opencode --session "$SES_ID"');
    expect(cmd).not.toContain("$(cat '/tmp/prompt.md')");
    expect(cmd).not.toContain("--agent");
  });

  it("escapes path in systemPromptFile", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ systemPromptFile: "/tmp/it's-prompt.md" }),
    );
    expect(cmd).not.toContain("/tmp/it'\\''s-prompt.md");
    expect(cmd).not.toContain("--agent");
  });

  it("systemPromptFile takes precedence over systemPrompt", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        systemPrompt: "direct prompt",
        systemPromptFile: "/tmp/file-prompt.md",
      }),
    );
    expect(cmd).toContain("opencode run --format json --title 'AO:sess-1'");
    expect(cmd).toContain('exec opencode --session "$SES_ID"');
    expect(cmd).not.toContain("direct prompt");
  });

  it("keeps subagent and prompt separate when systemPromptFile is set", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        systemPromptFile: "/tmp/orchestrator.md",
        subagent: "sisyphus",
        prompt: "fix the bug",
      }),
    );
    expect(cmd).toContain(
      "opencode run --format json --title 'AO:sess-1' --agent 'sisyphus'",
    );
    expect(cmd).toContain(
      `exec opencode --session "$SES_ID" --prompt 'fix the bug' --agent 'sisyphus'`,
    );
  });

  it("generates orchestrator-style systemPromptFile launch", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        sessionId: "my-orchestrator",
        permissions: "permissionless",
        systemPromptFile: "/tmp/orchestrator.md",
      }),
    );
    expect(cmd).toContain("opencode run --format json --title 'AO:my-orchestrator'");
    expect(cmd).toContain('exec opencode --session "$SES_ID"');
    expect(cmd).not.toContain("--agent");
  });

  it("does not inline systemPromptFile when subagent and prompt are both set", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        systemPromptFile: "/tmp/orchestrator.md",
        subagent: "sisyphus",
        prompt: "fix the bug",
      }),
    );
    expect(cmd).toContain(
      "opencode run --format json --title 'AO:sess-1' --agent 'sisyphus'",
    );
    expect(cmd).toContain(
      `exec opencode --session "$SES_ID" --prompt 'fix the bug' --agent 'sisyphus'`,
    );
    expect(cmd).not.toContain("$(cat '/tmp/orchestrator.md'");
  });

  it("handles prompt with special characters", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ prompt: "fix $PATH/to/file and `rm -rf /unquoted/path`" }),
    );
    expect(cmd).toContain("'fix $PATH/to/file and `rm -rf /unquoted/path`");
  });

  it("handles prompt with newlines", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "line1\nline2\nline3" }));
    expect(cmd).toContain("opencode run --format json --title 'AO:sess-1'");
    expect(cmd).toContain("'line1");
  });

  it("handles prompt with backticks", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "use `backticks` and $vars`" }));
    expect(cmd).toContain("'use `backticks` and $vars`");
  });

  it("handles prompt with dollar signs", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "cost is $100" }));
    expect(cmd).toContain("'cost is $100'");
  });

  it("handles prompt with double quotes", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: 'say "hello" and "goodbye"' }));
    expect(cmd).toContain('\'say "hello" and "goodbye"\'');
  });

  it("handles prompt with unicode characters", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "fix bug in café.js file" }));
    expect(cmd).toContain("'fix bug in café.js file'");
  });

  it("handles prompt with semicolons", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "line1; line2; line3" }));
    expect(cmd).toContain("'line1; line2; line3");
  });

  it("handles empty prompt", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "" }));
    expect(cmd).toContain("opencode run --format json --title 'AO:sess-1'");
    expect(cmd).toContain('exec opencode --session "$SES_ID"');
    expect(cmd).toContain("opencode session list --format json");
    expect(cmd).toContain("AO:sess-1");
  });

  it("uses existing session id", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        projectConfig: {
          name: "my-project",
          repo: "owner/repo",
          path: "/workspace/repo",
          defaultBranch: "main",
          sessionPrefix: "my",
          agentConfig: { opencodeSessionId: "ses_abc123" },
        },
        prompt: "continue",
      }),
    );

    expect(cmd).toBe("opencode --session 'ses_abc123' --prompt 'continue'");
  });

  it("uses existing session id with --title fallback", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).toContain("opencode run --format json --title 'AO:sess-1'");
    expect(cmd).toContain('exec opencode --session "$SES_ID"');
  });
});

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
});

describe("isProcessRunning", () => {
  const agent = create();

  it("returns true when opencode found on tmux pane TTY", async () => {
    mockTmuxWithProcess("opencode");
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("returns false when opencode not on tmux pane TTY", async () => {
    mockTmuxWithProcess("opencode", false);
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

  it("finds opencode on any pane in multi-pane session", async () => {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") {
        return Promise.resolve({ stdout: "/dev/ttys001\n/dev/ttys002\n", stderr: "" });
      }
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: "  PID TT ARGS\n  100 ttys001  bash\n  200 ttys002  opencode run hello\n",
          stderr: "",
        });
      }
      return Promise.reject(new Error("unexpected"));
    });
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });
});

describe("detectActivity — terminal output classification", () => {
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

  it("returns waiting_input for Y/N confirmation", () => {
    expect(agent.detectActivity("Apply changes?\n(Y)es/(N)o")).toBe("waiting_input");
  });

  it("returns waiting_input for approval required", () => {
    expect(agent.detectActivity("output\napproval required for this action")).toBe("waiting_input");
  });

  it("returns waiting_input for proceed prompt", () => {
    expect(agent.detectActivity("Do you want to proceed?")).toBe("waiting_input");
  });

  it("returns waiting_input for allow prompt", () => {
    expect(agent.detectActivity("Allow file creation?")).toBe("waiting_input");
  });

  it("returns active for non-empty terminal output", () => {
    expect(agent.detectActivity("opencode is working\n")).toBe("active");
  });
});

describe("getActivityState", () => {
  const agent = create();

  function mockOpencodeSessionRows(rows: Array<Record<string, unknown>>) {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") return Promise.resolve({ stdout: "/dev/ttys003\n", stderr: "" });
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: "  PID TT       ARGS\n  789 ttys003  opencode\n",
          stderr: "",
        });
      }
      if (cmd === "opencode") {
        return Promise.resolve({
          stdout: JSON.stringify(rows),
          stderr: "",
        });
      }
      return Promise.reject(new Error("unexpected"));
    });
  }

  function mockOpencodeSessionList(updated: string | number) {
    mockOpencodeSessionRows([{ id: "ses_abc123", updated }]);
  }

  it("returns idle when last activity is older than ready threshold", async () => {
    mockOpencodeSessionList(new Date(Date.now() - 120_000).toISOString());

    const state = await agent.getActivityState(
      makeSession({
        runtimeHandle: makeTmuxHandle(),
        metadata: { opencodeSessionId: "ses_abc123" },
      }),
      60_000,
    );

    expect(state?.state).toBe("idle");
  });

  it("returns ready when last activity is between active window and ready threshold", async () => {
    mockOpencodeSessionList(new Date(Date.now() - 45_000).toISOString());

    const state = await agent.getActivityState(
      makeSession({
        runtimeHandle: makeTmuxHandle(),
        metadata: { opencodeSessionId: "ses_abc123" },
      }),
      60_000,
    );

    expect(state?.state).toBe("ready");
  });

  it("returns active when last activity is recent", async () => {
    mockOpencodeSessionList(new Date(Date.now() - 10_000).toISOString());

    const state = await agent.getActivityState(
      makeSession({
        runtimeHandle: makeTmuxHandle(),
        metadata: { opencodeSessionId: "ses_abc123" },
      }),
      60_000,
    );

    expect(state?.state).toBe("active");
  });

  it("returns null when matching session has invalid updated timestamp", async () => {
    mockOpencodeSessionRows([{ id: "ses_abc123", updated: "not-a-date" }]);

    const state = await agent.getActivityState(
      makeSession({
        runtimeHandle: makeTmuxHandle(),
        metadata: { opencodeSessionId: "ses_abc123" },
      }),
      60_000,
    );

    expect(state).toBeNull();
  });

  it("falls back to AO session title when opencodeSessionId metadata is missing", async () => {
    mockOpencodeSessionRows([
      {
        id: "ses_different",
        title: "AO:test-1",
        updated: new Date(Date.now() - 5_000).toISOString(),
      },
    ]);

    const state = await agent.getActivityState(
      makeSession({
        runtimeHandle: makeTmuxHandle(),
        metadata: {},
      }),
      60_000,
    );

    expect(state?.state).toBe("active");
  });

  it("returns null when opencode session list output is malformed JSON", async () => {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") return Promise.resolve({ stdout: "/dev/ttys003\n", stderr: "" });
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: "  PID TT       ARGS\n  789 ttys003  opencode\n",
          stderr: "",
        });
      }
      if (cmd === "opencode") return Promise.resolve({ stdout: "not json", stderr: "" });
      return Promise.reject(new Error("unexpected"));
    });

    const state = await agent.getActivityState(
      makeSession({
        runtimeHandle: makeTmuxHandle(),
        metadata: { opencodeSessionId: "ses_abc123" },
      }),
    );

    expect(state).toBeNull();
  });
});

describe("getSessionInfo", () => {
  const agent = create();

  function mockOpencodeSessionRows(rows: Array<Record<string, unknown>>) {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "opencode") {
        return Promise.resolve({ stdout: JSON.stringify(rows), stderr: "" });
      }
      return Promise.reject(new Error("unexpected"));
    });
  }

  it("returns session info when matching session found by metadata ID", async () => {
    mockOpencodeSessionRows([
      { id: "ses_abc123", title: "AO:test-1", updated: new Date().toISOString() },
    ]);

    const info = await agent.getSessionInfo(
      makeSession({ metadata: { opencodeSessionId: "ses_abc123" } }),
    );
    expect(info).not.toBeNull();
    expect(info!.agentSessionId).toBe("ses_abc123");
    expect(info!.summary).toBe("AO:test-1");
    expect(info!.summaryIsFallback).toBe(true);
  });

  it("returns session info when matching session found by title", async () => {
    mockOpencodeSessionRows([
      { id: "ses_xyz789", title: "AO:test-1", updated: new Date().toISOString() },
    ]);

    const info = await agent.getSessionInfo(makeSession({ metadata: {} }));
    expect(info).not.toBeNull();
    expect(info!.agentSessionId).toBe("ses_xyz789");
  });

  it("returns null when no matching session", async () => {
    mockOpencodeSessionRows([
      { id: "ses_other", title: "AO:different", updated: new Date().toISOString() },
    ]);

    const info = await agent.getSessionInfo(makeSession({ metadata: {} }));
    expect(info).toBeNull();
  });

  it("returns null when opencode command fails", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("opencode not found"));
    const info = await agent.getSessionInfo(makeSession());
    expect(info).toBeNull();
  });
});

// =========================================================================
// getRestoreCommand
// =========================================================================
describe("getRestoreCommand", () => {
  const agent = create();

  it("returns restore command from metadata session ID", async () => {
    const cmd = await agent.getRestoreCommand!(
      makeSession({ metadata: { opencodeSessionId: "ses_abc123" } }),
      { name: "proj", repo: "o/r", path: "/p", defaultBranch: "main", sessionPrefix: "p" },
    );
    expect(cmd).toBe("opencode --session 'ses_abc123'");
  });

  it("includes model flag from project config", async () => {
    const cmd = await agent.getRestoreCommand!(
      makeSession({ metadata: { opencodeSessionId: "ses_abc123" } }),
      {
        name: "proj",
        repo: "o/r",
        path: "/p",
        defaultBranch: "main",
        sessionPrefix: "p",
        agentConfig: { model: "claude-sonnet-4-5-20250929" },
      },
    );
    expect(cmd).toContain("--model 'claude-sonnet-4-5-20250929'");
  });

  it("returns null when no session ID found", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("opencode not found"));
    const cmd = await agent.getRestoreCommand!(
      makeSession({ metadata: {} }),
      { name: "proj", repo: "o/r", path: "/p", defaultBranch: "main", sessionPrefix: "p" },
    );
    expect(cmd).toBeNull();
  });

  it("falls back to title-based lookup", async () => {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "opencode") {
        return Promise.resolve({
          stdout: JSON.stringify([{ id: "ses_found", title: "AO:test-1" }]),
          stderr: "",
        });
      }
      return Promise.reject(new Error("unexpected"));
    });

    const cmd = await agent.getRestoreCommand!(
      makeSession({ metadata: {} }),
      { name: "proj", repo: "o/r", path: "/p", defaultBranch: "main", sessionPrefix: "p" },
    );
    expect(cmd).toBe("opencode --session 'ses_found'");
  });
});

// =========================================================================
// setupWorkspaceHooks + postLaunchSetup
// =========================================================================
describe("setupWorkspaceHooks", () => {
  const agent = create();

  it("is defined (delegates to shared setupPathWrapperWorkspace)", () => {
    expect(agent.setupWorkspaceHooks).toBeDefined();
    expect(typeof agent.setupWorkspaceHooks).toBe("function");
  });
});

describe("postLaunchSetup", () => {
  const agent = create();

  it("is defined", () => {
    expect(agent.postLaunchSetup).toBeDefined();
  });

  it("does nothing when workspacePath is null", async () => {
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

describe("session ID capture from JSON stream", () => {
  it("validates session_id format with ses_ prefix", () => {
    const agent = create();
    const cmd = agent.getLaunchCommand(makeLaunchConfig());

    expect(cmd).toContain("session_id");
    expect(cmd).toContain("sessionID");
    expect(cmd).toContain("/^ses_[A-Za-z0-9_-]+$/");
  });

  it("parses JSON lines and extracts session_id or sessionID field", () => {
    const agent = create();
    const cmd = agent.getLaunchCommand(makeLaunchConfig());

    expect(cmd).toContain("JSON.parse(trimmed)");
    expect(cmd).toContain("obj.session_id");
    expect(cmd).toContain("obj.sessionID");
  });

  it("handles buffer accumulation for partial lines", () => {
    const agent = create();
    const cmd = agent.getLaunchCommand(makeLaunchConfig());

    expect(cmd).toContain("buffer.split");
    expect(cmd).toContain("buffer = lines.pop()");
  });
});

describe("title-based fallback sorting with newest-first", () => {
  it("sorts by updated timestamp (newest first) when multiple sessions have the same title", () => {
    const agent = create();
    const cmd = agent.getLaunchCommand(makeLaunchConfig());

    expect(cmd).toContain("opencode session list --format json");

    expect(cmd).toContain("sort((a, b) =>");
    expect(cmd).toContain("tb - ta");
  });

  it("validates session IDs with ses_ prefix pattern", () => {
    const agent = create();
    const cmd = agent.getLaunchCommand(makeLaunchConfig());

    expect(cmd).toContain("isValidId");
    expect(cmd).toContain("/^ses_[A-Za-z0-9_-]+$/");
  });

  it("handles numeric and string timestamps in sorting", () => {
    const agent = create();
    const cmd = agent.getLaunchCommand(makeLaunchConfig());

    expect(cmd).toContain("typeof value ===");
    expect(cmd).toContain("Number.isFinite");
    expect(cmd).toContain("Date.parse(value)");
  });
});

describe("invalid session ID rejection", () => {
  it("does not include --session for invalid opencodeSessionId in launch command", () => {
    const agent = create();

    const invalidIds = ["invalid", "SES_uppercase", "ses_", "ses spaces here", "", "ses-123"];

    for (const invalidId of invalidIds) {
      const cmd = agent.getLaunchCommand(
        makeLaunchConfig({
          projectConfig: {
            name: "my-project",
            repo: "owner/repo",
            path: "/workspace/repo",
            defaultBranch: "main",
            sessionPrefix: "my",
            agentConfig: { opencodeSessionId: invalidId },
          },
          prompt: "continue",
        }),
      );

      expect(cmd).not.toContain(`--session '${invalidId}'`);
      expect(cmd).toContain("opencode run --format json --title 'AO:sess-1'");
    }
  });

  it("only accepts valid ses_ prefix session IDs", () => {
    const agent = create();

    const validIds = ["ses_abc123", "ses_test-session", "ses_12345"];

    for (const validId of validIds) {
      const cmd = agent.getLaunchCommand(
        makeLaunchConfig({
          projectConfig: {
            name: "my-project",
            repo: "owner/repo",
            path: "/workspace/repo",
            defaultBranch: "main",
            sessionPrefix: "my",
            agentConfig: { opencodeSessionId: validId },
          },
          prompt: "continue",
        }),
      );

      expect(cmd).toContain(`--session '${validId}'`);
    }
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
    await agent.recordActivity!(makeSession(), "opencode is working");
    expect(mockRecordTerminalActivity).toHaveBeenCalledWith(
      "/workspace/test",
      "opencode is working",
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
    mockTmuxWithProcess("opencode");
    mockReadLastActivityEntry.mockResolvedValueOnce({
      entry: { ts: new Date().toISOString(), state: "waiting_input", source: "terminal" },
      modifiedAt: new Date(),
    });

    const result = await agent.getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle() }),
    );
    expect(result?.state).toBe("waiting_input");
  });

  it("returns blocked from activity JSONL", async () => {
    mockTmuxWithProcess("opencode");
    mockReadLastActivityEntry.mockResolvedValueOnce({
      entry: { ts: new Date().toISOString(), state: "blocked", source: "terminal" },
      modifiedAt: new Date(),
    });

    const result = await agent.getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle() }),
    );
    expect(result?.state).toBe("blocked");
  });

  it("falls back to opencode API when activity JSONL is empty", async () => {
    mockReadLastActivityEntry.mockResolvedValueOnce(null);
    // Mock opencode session list returning recent activity
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") return Promise.resolve({ stdout: "/dev/ttys003\n", stderr: "" });
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: "  PID TT       ARGS\n  789 ttys003  opencode\n",
          stderr: "",
        });
      }
      if (cmd === "opencode") {
        return Promise.resolve({
          stdout: JSON.stringify([
            { id: "ses_abc123", title: "AO:test-1", updated: new Date(Date.now() - 5_000).toISOString() },
          ]),
          stderr: "",
        });
      }
      return Promise.reject(new Error("unexpected"));
    });

    const result = await agent.getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle(), metadata: { opencodeSessionId: "ses_abc123" } }),
      60_000,
    );
    expect(result?.state).toBe("active");
  });

  it("falls back to JSONL entry state when session list fails", async () => {
    mockTmuxWithProcess("opencode");
    mockReadLastActivityEntry.mockResolvedValueOnce({
      entry: { ts: new Date().toISOString(), state: "active", source: "terminal" },
      modifiedAt: new Date(),
    });
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") return Promise.resolve({ stdout: "/dev/ttys003\n", stderr: "" });
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: "  PID TT       ARGS\n  789 ttys003  opencode\n",
          stderr: "",
        });
      }
      if (cmd === "opencode") return Promise.resolve({ stdout: "[]", stderr: "" });
      return Promise.reject(new Error("unexpected"));
    });

    const result = await agent.getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle() }),
      60_000,
    );
    expect(result?.state).toBe("active");
  });

  it("falls back to JSONL entry with age decay — old entry becomes idle", async () => {
    mockTmuxWithProcess("opencode");
    mockReadLastActivityEntry.mockResolvedValueOnce({
      entry: { ts: new Date(Date.now() - 120_000).toISOString(), state: "active", source: "terminal" },
      modifiedAt: new Date(Date.now() - 120_000),
    });
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") return Promise.resolve({ stdout: "/dev/ttys003\n", stderr: "" });
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: "  PID TT       ARGS\n  789 ttys003  opencode\n",
          stderr: "",
        });
      }
      if (cmd === "opencode") return Promise.resolve({ stdout: "[]", stderr: "" });
      return Promise.reject(new Error("unexpected"));
    });

    const result = await agent.getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle() }),
      60_000,
    );
    expect(result?.state).toBe("idle");
  });

  it("returns null when both session list and JSONL are unavailable", async () => {
    mockTmuxWithProcess("opencode");
    mockReadLastActivityEntry.mockResolvedValueOnce(null);
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") return Promise.resolve({ stdout: "/dev/ttys003\n", stderr: "" });
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: "  PID TT       ARGS\n  789 ttys003  opencode\n",
          stderr: "",
        });
      }
      if (cmd === "opencode") return Promise.resolve({ stdout: "[]", stderr: "" });
      return Promise.reject(new Error("unexpected"));
    });

    const result = await agent.getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle() }),
      60_000,
    );
    expect(result).toBeNull();
  });
});
