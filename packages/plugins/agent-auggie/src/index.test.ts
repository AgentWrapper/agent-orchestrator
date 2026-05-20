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
  mockExecFileSync,
  mockIsWindows,
} = vi.hoisted(() => ({
  mockReadLastActivityEntry: vi.fn().mockResolvedValue(null),
  mockRecordTerminalActivity: vi.fn().mockResolvedValue(undefined),
  mockSetupPathWrapperWorkspace: vi.fn().mockResolvedValue(undefined),
  mockExecFileAsync: vi.fn(),
  mockExecFileSync: vi.fn(),
  mockIsWindows: vi.fn().mockReturnValue(false),
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
  execFileSync: mockExecFileSync,
}));

import { create, detect, manifest, default as defaultExport } from "./index.js";

const AUGGIE_SESSION_ID = "01HX4AUGGIE-session_1";

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
        model: "claude-sonnet-4.5",
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
  mockExecFileAsync.mockReset();
  mockExecFileSync.mockReset();
  mockIsWindows.mockReturnValue(false);
  mockReadLastActivityEntry.mockResolvedValue(null);
});

describe("manifest", () => {
  it("has correct Auggie manifest", () => {
    expect(manifest).toEqual({
      name: pluginName,
      slot: "agent",
      description: packageJson.description,
      version: packageJson.version,
      displayName: "Auggie",
    });
  });
});

describe("create", () => {
  it("uses auggie as process name and post-launch prompt mode", () => {
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
  it("returns true when the Auggie version command succeeds", async () => {
    mockExecFileSync.mockReturnValue(Buffer.from(""));
    expect(detect()).toBe(true);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "auggie",
      ["--version"],
      expect.objectContaining({
        stdio: "ignore",
        shell: false,
        windowsHide: true,
      }),
    );
  });

  it("uses shell detection on Windows so .cmd shims resolve", async () => {
    mockIsWindows.mockReturnValue(true);
    mockExecFileSync.mockReturnValue(Buffer.from(""));
    expect(detect()).toBe(true);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "auggie",
      ["--version"],
      expect.objectContaining({
        shell: true,
        windowsHide: true,
      }),
    );
  });

  it("returns false when the Auggie version command fails", async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("not found");
    });
    expect(detect()).toBe(false);
  });
});

describe("getLaunchCommand", () => {
  const agent = create();

  it("uses interactive launch without session id", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ projectConfig: { ...makeLaunchConfig().projectConfig, agentConfig: {} } }),
    );
    expect(cmd).toBe("auggie --allow-indexing");
  });

  it("passes configured model when present", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).toBe("auggie --allow-indexing --model 'claude-sonnet-4.5'");
  });

  it("uses --resume when configured with a session id", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        projectConfig: {
          ...makeLaunchConfig().projectConfig,
          agentConfig: { auggieSessionId: AUGGIE_SESSION_ID },
        },
      }),
    );
    expect(cmd).toBe(`auggie --allow-indexing --resume '${AUGGIE_SESSION_ID}'`);
  });

  it("does not include prompt flags in launch command", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        projectConfig: { ...makeLaunchConfig().projectConfig, agentConfig: {} },
        prompt: "Do work",
        systemPrompt: "You are helpful",
        systemPromptFile: "/tmp/prompt.md",
      }),
    );
    expect(cmd).toBe("auggie --allow-indexing");
    expect(cmd).not.toContain("-p");
    expect(cmd).not.toContain("--print");
    expect(cmd).not.toContain("--instruction");
  });
});

describe("getEnvironment", () => {
  const agent = create();

  it("writes AO session keys and path values", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["AO_SESSION_ID"]).toBe("sess-1");
    expect(env["AO_ISSUE_ID"]).toBeUndefined();
    expect(env["PATH"]).toContain(".ao/bin");
    expect(env["GH_PATH"]).toContain("gh");
    expect(env["AUGMENT_DISABLE_AUTO_UPDATE"]).toBe("1");
  });

  it("includes AO_ISSUE_ID when provided", () => {
    const env = agent.getEnvironment(makeLaunchConfig({ issueId: "INT-42" }));
    expect(env["AO_ISSUE_ID"]).toBe("INT-42");
  });
});

describe("isProcessRunning", () => {
  const agent = create();

  it("returns true when auggie is on tmux pane", async () => {
    mockExecFileAsync.mockImplementation((cmd: string, _args: string[]) => {
      if (cmd === "tmux") {
        return Promise.resolve({ stdout: "/dev/ttys003\n", stderr: "" });
      }
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: `  PID TT       ARGS\n  789 ttys003  auggie --allow-indexing\n`,
          stderr: "",
        });
      }
      return Promise.reject(new Error("unexpected"));
    });

    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("returns true when Auggie npm bin script is on tmux pane", async () => {
    mockExecFileAsync.mockImplementation((cmd: string, _args: string[]) => {
      if (cmd === "tmux") return Promise.resolve({ stdout: "/dev/ttys003\n", stderr: "" });
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: "  PID TT       ARGS\n  789 ttys003  node /bin/augment.mjs\n",
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

  it("returns false for tmux handles on Windows without spawning tmux or ps", async () => {
    mockIsWindows.mockReturnValue(true);
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it("returns true when process handle pid is alive", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(await agent.isProcessRunning(makeProcessHandle(123))).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(123, 0);
    killSpy.mockRestore();
  });

  it("returns false when process handle pid is dead", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    expect(await agent.isProcessRunning(makeProcessHandle(123))).toBe(false);
    killSpy.mockRestore();
  });
});

describe("recordActivity", () => {
  const agent = create();

  it("classifies idle terminal output when recording activity", async () => {
    await agent.recordActivity?.(makeSession(), "Welcome to Auggie\n> ");
    expect(mockRecordTerminalActivity).toHaveBeenCalledWith(
      "/workspace/test",
      "Welcome to Auggie\n> ",
      expect.any(Function),
    );
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("Welcome to Auggie\n> ")).toBe("idle");
  });

  it("classifies active terminal output when recording activity", async () => {
    await agent.recordActivity?.(makeSession(), "Analyzing repository context...");
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("Analyzing repository context...")).toBe("active");
  });

  it("classifies waiting_input terminal output when recording activity", async () => {
    await agent.recordActivity?.(makeSession(), "? Do you want to continue? y/N:");
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("? Do you want to continue? y/N:")).toBe("waiting_input");
  });

  it("classifies authentication prompts as waiting_input", async () => {
    await agent.recordActivity?.(
      makeSession(),
      "→ Login to continue\n\nPress return to open your browser",
    );
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("→ Login to continue\n\nPress return to open your browser")).toBe(
      "waiting_input",
    );
  });

  it("classifies blocked terminal output when recording activity", async () => {
    await agent.recordActivity?.(makeSession(), "Authentication failed");
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("Authentication failed")).toBe("blocked");
  });

  it("skips recording when workspacePath is missing", async () => {
    await agent.recordActivity?.(makeSession({ workspacePath: null }), "still running");
    expect(mockRecordTerminalActivity).not.toHaveBeenCalled();
  });
});

describe("getSessionInfo", () => {
  const agent = create();

  it("returns null without session id metadata", async () => {
    expect(await agent.getSessionInfo(makeSession())).toBeNull();
  });

  it("returns session id when metadata is present", async () => {
    const info = await agent.getSessionInfo(
      makeSession({ metadata: { auggieSessionId: AUGGIE_SESSION_ID } }),
    );
    expect(info).toEqual({
      agentSessionId: AUGGIE_SESSION_ID,
      summary: null,
    });
  });

  it("returns null for invalid session id metadata", async () => {
    expect(
      await agent.getSessionInfo(makeSession({ metadata: { auggieSessionId: "bad id" } })),
    ).toBeNull();
  });
});

describe("getRestoreCommand", () => {
  const agent = create();

  it("builds restore command using the Auggie session id", async () => {
    const cmd = await agent.getRestoreCommand?.(
      makeSession({ metadata: { auggieSessionId: AUGGIE_SESSION_ID } }),
      {
        name: "my-project",
        repo: "owner/repo",
        path: "/workspace/repo",
        defaultBranch: "main",
        sessionPrefix: "my",
        agentConfig: { model: "claude-sonnet-4.5" },
      },
    );
    expect(cmd).toBe(
      `auggie --allow-indexing --model 'claude-sonnet-4.5' --resume '${AUGGIE_SESSION_ID}'`,
    );
  });

  it("returns null without session id metadata", async () => {
    const cmd = await agent.getRestoreCommand?.(makeSession(), {
      name: "my-project",
      repo: "owner/repo",
      path: "/workspace/repo",
      defaultBranch: "main",
      sessionPrefix: "my",
    });
    expect(cmd).toBeNull();
  });
});

describe("postLaunchSetup", () => {
  const agent = create();

  it("sets up workspace hooks", async () => {
    await expect(
      agent.postLaunchSetup?.(makeSession({ workspacePath: "/workspace/test" })),
    ).resolves.toBeUndefined();
    expect(mockSetupPathWrapperWorkspace).toHaveBeenCalledWith("/workspace/test");
  });

  it("skips setup when workspacePath is missing", async () => {
    await expect(
      agent.postLaunchSetup?.(makeSession({ workspacePath: null })),
    ).resolves.toBeUndefined();
    expect(mockSetupPathWrapperWorkspace).not.toHaveBeenCalled();
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

  it("returns null when no JSONL activity data is available", async () => {
    mockReadLastActivityEntry.mockResolvedValue(null);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const state = await agent.getActivityState(
      makeSession({ runtimeHandle: makeProcessHandle(101) }),
    );
    expect(state).toBeNull();
    killSpy.mockRestore();
  });
});
