import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session, RuntimeHandle, AgentLaunchConfig } from "@aoagents/ao-core";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as {
  name: string;
  version: string;
  description: string;
};
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
} = vi.hoisted(() => ({
  mockReadLastActivityEntry: vi.fn().mockResolvedValue(null),
  mockRecordTerminalActivity: vi.fn().mockResolvedValue(undefined),
  mockSetupPathWrapperWorkspace: vi.fn().mockResolvedValue(undefined),
  mockExecFileAsync: vi.fn(),
  mockWhichSync: vi.fn(),
}));

vi.mock("@aoagents/ao-core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    readLastActivityEntry: mockReadLastActivityEntry,
    recordTerminalActivity: mockRecordTerminalActivity,
    setupPathWrapperWorkspace: mockSetupPathWrapperWorkspace,
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

import { create, detect, manifest, default as defaultExport } from "./index.js";

const VALID_AMP_THREAD_ID = "T-amp-thread-123";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "test-1",
    projectId: "test-project",
    status: "working",
    activity: "active",
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
        model: "smart",
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
});

describe("manifest", () => {
  it("has correct Amp manifest", () => {
    expect(manifest).toEqual({
      name: pluginName,
      slot: "agent",
      description: packageJson.description,
      version: packageJson.version,
      displayName: "Amp",
    });
  });
});

describe("create", () => {
  it("uses amp as process name", () => {
    const agent = create();
    expect(agent.name).toBe(pluginName);
    expect(agent.processName).toBe(pluginName);
  });

  it("exports plugin module shape", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
  });
});

describe("detect", () => {
  it("returns true when which resolves", async () => {
    mockWhichSync.mockReturnValue("/usr/local/bin/amp");
    expect(detect()).toBe(true);
  });

  it("returns false when which fails", async () => {
    mockWhichSync.mockImplementation(() => {
      throw new Error("not found");
    });
    expect(detect()).toBe(false);
  });
});

describe("getLaunchCommand", () => {
  const agent = create();

  it("uses interactive launch without thread id", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).toBe("amp");
  });

  it("uses threads continue when configured", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        projectConfig: {
          ...makeLaunchConfig().projectConfig,
          agentConfig: { ampThreadId: VALID_AMP_THREAD_ID },
        },
      }),
    );
    expect(cmd).toBe(`amp threads continue '${VALID_AMP_THREAD_ID}'`);
  });

  it("pipes task prompts into interactive Amp launches", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        prompt: "Do work",
      }),
    );
    expect(cmd).toContain("node -e ");
    expect(cmd).toContain('"args":[]');
    expect(cmd).toContain('"promptParts":[{"type":"text","value":"Do work"}]');
    expect(cmd).not.toContain(" | ");
    expect(cmd).not.toContain("-x");
    expect(cmd).not.toContain("--execute");
  });

  it("pipes system prompt and task prompt into Amp launches", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        prompt: "Do work",
        systemPrompt: "You are helpful",
      }),
    );
    expect(cmd).toContain(
      '"promptParts":[{"type":"text","value":"You are helpful"},{"type":"text","value":"Do work"}]',
    );
    expect(cmd).not.toContain(" | ");
  });

  it("uses system prompt file when provided", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        prompt: "Do work",
        systemPrompt: "You are helpful",
        systemPromptFile: "/tmp/prompt.md",
      }),
    );
    expect(cmd).toContain(
      '"promptParts":[{"type":"file","value":"/tmp/prompt.md"},{"type":"text","value":"Do work"}]',
    );
    expect(cmd).not.toContain(" | ");
  });

  it("uses Node streams to deliver prompts when continuing a configured thread", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        prompt: "Continue work",
        projectConfig: {
          ...makeLaunchConfig().projectConfig,
          agentConfig: { ampThreadId: VALID_AMP_THREAD_ID },
        },
      }),
    );
    expect(cmd).toContain('"args":["threads","continue","T-amp-thread-123"]');
    expect(cmd).toContain('"promptParts":[{"type":"text","value":"Continue work"}]');
    expect(cmd).not.toContain(" | ");
  });
});

describe("getEnvironment", () => {
  const agent = create();

  it("writes AO session keys and amp flags", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["AO_SESSION_ID"]).toBe("sess-1");
    expect(env["AO_ISSUE_ID"]).toBeUndefined();
    expect(env["NO_ANIMATION"]).toBe("1");
    expect(env["PATH"]).toBeUndefined();
    expect(env["GH_PATH"]).toBeUndefined();
  });

  it("includes AO_ISSUE_ID when provided", () => {
    const env = agent.getEnvironment(makeLaunchConfig({ issueId: "INT-42" }));
    expect(env["AO_ISSUE_ID"]).toBe("INT-42");
  });
});

describe("isProcessRunning", () => {
  const agent = create();

  it("returns true when amp is on tmux pane", async () => {
    mockExecFileAsync.mockImplementation((cmd: string, _args: string[]) => {
      if (cmd === "tmux") {
        return Promise.resolve({ stdout: "/dev/ttys003\n", stderr: "" });
      }
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: `  PID TT       ARGS\n  789 ttys003  amp --no-color\n`,
          stderr: "",
        });
      }
      return Promise.reject(new Error("unexpected"));
    });

    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("returns false when tmux process missing", async () => {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") return Promise.resolve({ stdout: "/dev/ttys003\n", stderr: "" });
      if (cmd === "ps") {
        return Promise.resolve({ stdout: "  PID TT      ARGS\n  789 ttys003  bash\n", stderr: "" });
      }
      return Promise.reject(new Error("unexpected"));
    });
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("returns false for tmux handles on Windows without shelling out", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
      expect(mockExecFileAsync).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        configurable: true,
      });
    }
  });

  it("returns true when process handle pid is alive", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(await agent.isProcessRunning(makeProcessHandle(123))).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(123, 0);
    killSpy.mockRestore();
  });

  it("treats EPERM as a running process", async () => {
    const err = Object.assign(new Error("permission denied"), { code: "EPERM" });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw err;
    });
    expect(await agent.isProcessRunning(makeProcessHandle(123))).toBe(true);
    killSpy.mockRestore();
  });

  it("returns false when process handle pid is dead", async () => {
    const err = Object.assign(new Error("not found"), { code: "ESRCH" });
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
    await agent.recordActivity?.(makeSession(), "foo\n> ");
    expect(mockRecordTerminalActivity).toHaveBeenCalledWith(
      "/workspace/test",
      "foo\n> ",
      expect.any(Function),
    );
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("foo\n> ")).toBe("idle");
  });

  it("classifies active terminal output when recording activity", async () => {
    await agent.recordActivity?.(makeSession(), "Reading files\nUpdating implementation");
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("Reading files\nUpdating implementation")).toBe("active");
  });

  it("classifies waiting_input terminal output when recording activity", async () => {
    await agent.recordActivity?.(makeSession(), "Allow Bash command? [y/N]");
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("Allow Bash command? [y/N]")).toBe("waiting_input");
  });

  it("classifies blocked terminal output when recording activity", async () => {
    await agent.recordActivity?.(makeSession(), "Error: API key missing");
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("Error: API key missing")).toBe("blocked");
  });

  it("skips recording when workspacePath is missing", async () => {
    await agent.recordActivity?.(makeSession({ workspacePath: null }), "still running");
    expect(mockRecordTerminalActivity).not.toHaveBeenCalled();
  });
});

describe("getActivityState", () => {
  const agent = create();

  it("falls back to exited when runtime handle missing", async () => {
    const state = await agent.getActivityState(makeSession({ runtimeHandle: null }));
    expect(state).toMatchObject({ state: "exited" });
  });

  it("falls back to activity JSONL state", async () => {
    mockReadLastActivityEntry.mockResolvedValue(makeActivityResult("waiting_input", new Date()));
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const state = await agent.getActivityState(
      makeSession({
        runtimeHandle: makeProcessHandle(101),
        metadata: { ampThreadId: VALID_AMP_THREAD_ID },
      }),
    );
    expect(state?.state).toBe("waiting_input");
    killSpy.mockRestore();
  });

  it("decays JSONL fallback state to idle when the entry is stale", async () => {
    const activityAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
    mockReadLastActivityEntry.mockResolvedValue(makeActivityResult("active", activityAt));
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const state = await agent.getActivityState(
      makeSession({
        runtimeHandle: makeProcessHandle(101),
        metadata: { ampThreadId: VALID_AMP_THREAD_ID },
      }),
    );
    expect(state?.state).toBe("idle");
    expect(state?.timestamp.toISOString()).toBe(activityAt.toISOString());
    killSpy.mockRestore();
  });

  it("returns null when no JSONL activity data is available", async () => {
    mockReadLastActivityEntry.mockResolvedValue(null);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const state = await agent.getActivityState(
      makeSession({
        runtimeHandle: makeProcessHandle(101),
        metadata: { ampThreadId: VALID_AMP_THREAD_ID },
      }),
    );
    expect(state).toBeNull();
    killSpy.mockRestore();
  });
});

describe("getSessionInfo", () => {
  const agent = create();

  it("returns null without thread id", async () => {
    expect(await agent.getSessionInfo(makeSession())).toBeNull();
  });

  it("returns the amp thread id when metadata is available", async () => {
    const info = await agent.getSessionInfo(
      makeSession({ metadata: { ampThreadId: VALID_AMP_THREAD_ID } }),
    );
    expect(info).toEqual({
      agentSessionId: VALID_AMP_THREAD_ID,
      summary: null,
    });
  });
});

describe("getRestoreCommand", () => {
  const agent = create();

  it("builds restore command using the thread id only", async () => {
    const cmd = await agent.getRestoreCommand?.(
      makeSession({ metadata: { ampThreadId: VALID_AMP_THREAD_ID } }),
      {
        name: "my-project",
        repo: "owner/repo",
        path: "/workspace/repo",
        defaultBranch: "main",
        sessionPrefix: "my",
        agentConfig: { model: "smart" },
      },
    );
    expect(cmd).toBe(`amp threads continue '${VALID_AMP_THREAD_ID}'`);
  });

  it("returns null when no thread id is available", async () => {
    const cmd = await agent.getRestoreCommand?.(makeSession(), {
      name: "my-project",
      repo: "owner/repo",
      path: "/workspace/repo",
      defaultBranch: "main",
      sessionPrefix: "my",
      agentConfig: { model: "smart" },
    });
    expect(cmd).toBeNull();
  });
});

describe("workspace hooks", () => {
  const agent = create();

  it("sets up path wrapper workspace hooks", async () => {
    await expect(
      agent.setupWorkspaceHooks?.("/workspace/test", { dataDir: "/data", sessionId: "sess-1" }),
    ).resolves.toBeUndefined();
    expect(mockSetupPathWrapperWorkspace).toHaveBeenCalledWith("/workspace/test");
  });

  it("sets up path wrapper after launch", async () => {
    await expect(
      agent.postLaunchSetup?.(makeSession({ workspacePath: "/workspace/test" })),
    ).resolves.toBeUndefined();
    expect(mockSetupPathWrapperWorkspace).toHaveBeenCalledWith("/workspace/test");
  });

  it("skips post-launch setup when workspacePath is missing", async () => {
    await expect(
      agent.postLaunchSetup?.(makeSession({ workspacePath: null })),
    ).resolves.toBeUndefined();
    expect(mockSetupPathWrapperWorkspace).not.toHaveBeenCalled();
  });
});
