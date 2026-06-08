import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentLaunchConfig, RuntimeHandle, Session } from "@aoagents/ao-core";
import packageJson from "../../package.json" with { type: "json" };

const PACKAGE_NAME_PREFIX = "@aoagents/ao-plugin-agent-";
const pluginName = packageJson.name.startsWith(PACKAGE_NAME_PREFIX)
  ? packageJson.name.slice(PACKAGE_NAME_PREFIX.length)
  : packageJson.name;

const {
  mockReadLastActivityEntry,
  mockRecordTerminalActivity,
  mockSetupPathWrapperWorkspace,
  mockExecFileAsync,
  mockWhichSync,
  mockIsWindows,
} = vi.hoisted(() => ({
  mockReadLastActivityEntry: vi.fn().mockResolvedValue(null),
  mockRecordTerminalActivity: vi.fn().mockResolvedValue(undefined),
  mockSetupPathWrapperWorkspace: vi.fn().mockResolvedValue(undefined),
  mockExecFileAsync: vi.fn(),
  mockWhichSync: vi.fn(),
  mockIsWindows: vi.fn(() => false),
}));

vi.mock("@aoagents/ao-core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    readLastActivityEntry: mockReadLastActivityEntry,
    recordTerminalActivity: mockRecordTerminalActivity,
    setupPathWrapperWorkspace: mockSetupPathWrapperWorkspace,
    isWindows: mockIsWindows,
  };
});

vi.mock("which", () => ({
  default: {
    sync: mockWhichSync,
  },
  sync: mockWhichSync,
}));

vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => {
    const callback = args[args.length - 1];
    const result = mockExecFileAsync(...args.slice(0, -1));
    if (typeof callback === "function" && result && typeof result.then === "function") {
      result.then(
        (value: { stdout: string; stderr: string }) => callback(null, value),
        (err: Error) => callback(err),
      );
    }
  },
}));

import { create, detect, manifest, default as defaultExport } from "../index.js";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "test-1",
    projectId: "test-project",
    status: "working",
    activity: "active",
    activitySignal: {
      state: "valid",
      activity: "active",
      timestamp: new Date(),
      source: "runtime",
    },
    lifecycle: {} as Session["lifecycle"],
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
      agentConfig: {
        model: "grok-4.1-fast",
      },
    },
    ...overrides,
  };
}

function makeActivityResult(
  state: "active" | "ready" | "idle" | "waiting_input" | "blocked",
  ts: Date,
): {
  entry: {
    state: "active" | "ready" | "idle" | "waiting_input" | "blocked";
    ts: string;
    source: string;
  };
  modifiedAt: Date;
} {
  return {
    entry: {
      state,
      ts: ts.toISOString(),
      source: "terminal",
    },
    modifiedAt: ts,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockWhichSync.mockReset();
  mockExecFileAsync.mockReset();
  mockIsWindows.mockReset();
  mockIsWindows.mockReturnValue(false);
});

describe("manifest", () => {
  it("has correct Grok manifest", () => {
    expect(manifest.version).toBe(packageJson.version);
    expect(manifest).toEqual({
      name: pluginName,
      slot: "agent",
      description: packageJson.description,
      version: packageJson.version,
      displayName: "Grok",
    });
  });
});

describe("create", () => {
  it("uses grok as process name and post-launch prompt mode", () => {
    const agent = create();
    expect(agent.name).toBe(pluginName);
    expect(agent.processName).toBe(pluginName);
    expect(agent.promptDelivery).toBe("post-launch");
  });

  it("exports plugin module shape", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
  });
});

describe("detect", () => {
  it("returns true when which resolves", () => {
    mockWhichSync.mockReturnValue("/usr/local/bin/grok");
    expect(detect()).toBe(true);
  });

  it("returns false when which fails", () => {
    mockWhichSync.mockImplementation(() => {
      throw new Error("not found");
    });
    expect(detect()).toBe(false);
  });
});

describe("getLaunchCommand", () => {
  const agent = create();

  it("uses interactive launch without a session id", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ projectConfig: { ...makeLaunchConfig().projectConfig, agentConfig: {} } }),
    );
    expect(cmd).toBe("grok --no-alt-screen --worktree");
  });

  it("uses configured model and rules file when provided", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        model: "grok-4.1",
        systemPromptFile: "/tmp/ao prompt.md",
      }),
    );
    expect(cmd).toBe(
      "grok --no-alt-screen --worktree --model 'grok-4.1' --rules '@/tmp/ao prompt.md'",
    );
  });

  it("uses --resume when a configured Grok session id is present", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        projectConfig: {
          ...makeLaunchConfig().projectConfig,
          agentConfig: { grokSessionId: "01HXGROKSESSION" },
        },
      }),
    );
    expect(cmd).toBe("grok --no-alt-screen --resume '01HXGROKSESSION'");
  });

  it("does not include prompt flags when prompt delivery is post-launch", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        prompt: "Do work",
        systemPrompt: "You are helpful",
      }),
    );
    expect(cmd).toContain("--rules 'You are helpful'");
    expect(cmd).not.toContain("-p");
    expect(cmd).not.toContain("--single");
    expect(cmd).not.toContain("--prompt");
  });
});

describe("getEnvironment", () => {
  const agent = create();

  it("writes AO session keys and leaves shared wrapper paths to session-manager", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["AO_SESSION_ID"]).toBe("sess-1");
    expect(env["AO_ISSUE_ID"]).toBeUndefined();
    expect(env["PATH"]).toBeUndefined();
    expect(env["GH_PATH"]).toBeUndefined();
    expect(env["GROK_SANDBOX"]).toBeUndefined();
  });

  it("includes AO_ISSUE_ID and GROK_SANDBOX when provided", () => {
    const env = agent.getEnvironment(
      makeLaunchConfig({
        issueId: "INT-42",
        projectConfig: {
          ...makeLaunchConfig().projectConfig,
          agentConfig: { grokSandbox: "workspace-write" },
        },
      }),
    );
    expect(env["AO_ISSUE_ID"]).toBe("INT-42");
    expect(env["GROK_SANDBOX"]).toBe("workspace-write");
  });
});

describe("isProcessRunning", () => {
  const agent = create();

  it("returns true when grok is on tmux pane", async () => {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") return Promise.resolve({ stdout: "/dev/ttys003\n", stderr: "" });
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: "  PID TT       ARGS\n  789 ttys003  /Users/me/.grok/bin/grok\n",
          stderr: "",
        });
      }
      return Promise.reject(new Error("unexpected"));
    });

    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("returns false when tmux process is missing", async () => {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") return Promise.resolve({ stdout: "/dev/ttys003\n", stderr: "" });
      if (cmd === "ps")
        return Promise.resolve({ stdout: "  PID TT      ARGS\n  789 ttys003  bash\n", stderr: "" });
      return Promise.reject(new Error("unexpected"));
    });
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("returns indeterminate when tmux probing fails", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("tmux unavailable"));

    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe("indeterminate");
  });

  it("returns indeterminate for tmux handles on Windows", async () => {
    mockIsWindows.mockReturnValue(true);

    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe("indeterminate");
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it("returns true when process handle pid is alive", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(await agent.isProcessRunning(makeProcessHandle(123))).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(123, 0);
    killSpy.mockRestore();
  });

  it("treats EPERM as running for process handles", async () => {
    const err = Object.assign(new Error("EPERM"), { code: "EPERM" });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw err;
    });
    expect(await agent.isProcessRunning(makeProcessHandle(123))).toBe(true);
    killSpy.mockRestore();
  });

  it("returns false when process handle pid is dead", async () => {
    const err = Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw err;
    });
    expect(await agent.isProcessRunning(makeProcessHandle(123))).toBe(false);
    killSpy.mockRestore();
  });
});

describe("recordActivity", () => {
  const agent = create();

  it("classifies idle terminal output when recording activity", async () => {
    await agent.recordActivity?.(makeSession(), "foo\n› ");
    expect(mockRecordTerminalActivity).toHaveBeenCalledWith(
      "/workspace/test",
      "foo\n› ",
      expect.any(Function),
    );
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("foo\n› ")).toBe("idle");
  });

  it("classifies active terminal output when recording activity", async () => {
    await agent.recordActivity?.(makeSession(), "Thinking through the plan");
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("Thinking through the plan")).toBe("active");
  });

  it("classifies waiting_input terminal output when recording activity", async () => {
    await agent.recordActivity?.(
      makeSession(),
      "Signing in with Grok...\n\nOpen this URL to sign in:\n  https://auth.x.ai/oauth2/authorize?...",
    );
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("Allow this command? y/N:")).toBe("waiting_input");
    expect(classify?.("Open this URL to sign in: https://auth.x.ai/oauth2/authorize")).toBe(
      "waiting_input",
    );
  });

  it("classifies blocked terminal output when recording activity", async () => {
    await agent.recordActivity?.(makeSession(), "Error: Device not configured");
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("Error: Device not configured")).toBe("blocked");
  });

  it("skips recording when workspacePath is missing", async () => {
    await agent.recordActivity?.(makeSession({ workspacePath: null }), "still running");
    expect(mockRecordTerminalActivity).not.toHaveBeenCalled();
  });
});

describe("getActivityState", () => {
  const agent = create();

  it("falls back to exited when runtime handle is missing", async () => {
    const state = await agent.getActivityState(makeSession({ runtimeHandle: null }));
    expect(state).toMatchObject({ state: "exited" });
  });

  it("returns waiting_input from recent activity JSONL", async () => {
    const activityAt = new Date();
    mockReadLastActivityEntry.mockResolvedValue(makeActivityResult("waiting_input", activityAt));
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const state = await agent.getActivityState(
      makeSession({ runtimeHandle: makeProcessHandle(101) }),
    );
    expect(state?.state).toBe("waiting_input");
    killSpy.mockRestore();
  });

  it("returns blocked from recent activity JSONL", async () => {
    const activityAt = new Date();
    mockReadLastActivityEntry.mockResolvedValue(makeActivityResult("blocked", activityAt));
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const state = await agent.getActivityState(
      makeSession({ runtimeHandle: makeProcessHandle(101) }),
    );
    expect(state?.state).toBe("blocked");
    expect(state?.timestamp.toISOString()).toBe(activityAt.toISOString());
    killSpy.mockRestore();
  });

  it("returns active from JSONL fallback", async () => {
    const activityAt = new Date();
    mockReadLastActivityEntry.mockResolvedValue(makeActivityResult("active", activityAt));
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const state = await agent.getActivityState(
      makeSession({ runtimeHandle: makeProcessHandle(101) }),
    );
    expect(state?.state).toBe("active");
    expect(state?.timestamp.toISOString()).toBe(activityAt.toISOString());
    killSpy.mockRestore();
  });

  it("decays JSONL fallback state to idle when the entry is stale", async () => {
    const activityAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
    mockReadLastActivityEntry.mockResolvedValue(makeActivityResult("active", activityAt));
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const state = await agent.getActivityState(
      makeSession({ runtimeHandle: makeProcessHandle(101) }),
    );
    expect(state?.state).toBe("idle");
    expect(state?.timestamp.toISOString()).toBe(activityAt.toISOString());
    killSpy.mockRestore();
  });

  it("returns null when no activity data is available", async () => {
    mockReadLastActivityEntry.mockResolvedValue(null);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const state = await agent.getActivityState(
      makeSession({ runtimeHandle: makeProcessHandle(101) }),
    );
    expect(state).toBeNull();
    killSpy.mockRestore();
  });

  it("treats indeterminate process probes as no process verdict", async () => {
    mockReadLastActivityEntry.mockResolvedValue(null);
    mockExecFileAsync.mockRejectedValue(new Error("tmux unavailable"));

    const state = await agent.getActivityState(makeSession({ runtimeHandle: makeTmuxHandle() }));

    expect(state).toBeNull();
  });
});

describe("getSessionInfo", () => {
  const agent = create();

  it("returns null without Grok session metadata", async () => {
    expect(await agent.getSessionInfo(makeSession())).toBeNull();
  });

  it("returns a known Grok session id from metadata", async () => {
    const info = await agent.getSessionInfo(
      makeSession({ metadata: { grokSessionId: "01HXGROKSESSION" } }),
    );
    expect(info).toEqual({
      agentSessionId: "01HXGROKSESSION",
      summary: null,
    });
  });
});

describe("getRestoreCommand", () => {
  const agent = create();

  it("returns null without Grok session metadata", async () => {
    const cmd = await agent.getRestoreCommand?.(makeSession(), makeLaunchConfig().projectConfig);
    expect(cmd).toBeNull();
  });

  it("builds restore command using the Grok session id", async () => {
    const cmd = await agent.getRestoreCommand?.(
      makeSession({ metadata: { grokSessionId: "01HXGROKSESSION" } }),
      makeLaunchConfig({ model: "grok-4.1" }).projectConfig,
    );
    expect(cmd).toBe("grok --no-alt-screen --model 'grok-4.1-fast' --resume '01HXGROKSESSION'");
  });
});

describe("workspace hooks", () => {
  const agent = create();

  it("sets up PATH wrapper workspace hooks", async () => {
    await agent.setupWorkspaceHooks?.("/workspace/test", { dataDir: "/sessions" });
    expect(mockSetupPathWrapperWorkspace).toHaveBeenCalledWith("/workspace/test");
  });

  it("runs post-launch workspace hook setup", async () => {
    await agent.postLaunchSetup?.(makeSession({ workspacePath: "/workspace/test" }));
    expect(mockSetupPathWrapperWorkspace).toHaveBeenCalledWith("/workspace/test");
  });

  it("waits for Grok worktree readiness before post-launch prompt delivery", async () => {
    mockExecFileAsync.mockResolvedValue({
      stdout: "Worktree ready: /Users/me/.grok/worktrees/project/smoke\n",
      stderr: "",
    });

    await agent.postLaunchSetup?.(
      makeSession({ workspacePath: "/workspace/test", runtimeHandle: makeTmuxHandle("ao-smoke") }),
    );

    expect(mockSetupPathWrapperWorkspace).toHaveBeenCalledWith("/workspace/test");
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "tmux",
      ["capture-pane", "-t", "ao-smoke", "-p", "-S", "-120"],
      { timeout: 5_000 },
    );
  });
});
