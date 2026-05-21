import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  PROCESS_PROBE_INDETERMINATE,
  type AgentLaunchConfig,
  type RuntimeHandle,
  type Session,
} from "@aoagents/ao-core";
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
  mockExecFileAsync,
  mockWhichSync,
} = vi.hoisted(() => ({
  mockReadLastActivityEntry: vi.fn().mockResolvedValue(null),
  mockRecordTerminalActivity: vi.fn().mockResolvedValue(undefined),
  mockExecFileAsync: vi.fn(),
  mockWhichSync: vi.fn(),
}));

vi.mock("@aoagents/ao-core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    readLastActivityEntry: mockReadLastActivityEntry,
    recordTerminalActivity: mockRecordTerminalActivity,
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

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "test-1",
    projectId: "test-project",
    status: "working",
    activity: "active",
    activitySignal: {
      state: "valid",
      activity: "active",
      source: "runtime",
      timestamp: new Date(),
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
        model: "provider/gpt-4o-mini",
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
});

describe("manifest", () => {
  it("has correct Continue CLI manifest", () => {
    expect(manifest).toEqual({
      name: pluginName,
      slot: "agent",
      description: packageJson.description,
      version: packageJson.version,
      displayName: "Continue CLI",
    });
  });
});

describe("create", () => {
  it("uses cn as process name and inline prompt mode", () => {
    const agent = create();
    expect(agent.name).toBe(pluginName);
    expect(agent.processName).toBe(pluginName);
    expect(agent.promptDelivery).toBeUndefined();
  });

  it("exports plugin module shape", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
  });
});

describe("detect", () => {
  it("returns true when which resolves", () => {
    mockWhichSync.mockReturnValue("/usr/local/bin/cn");
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

  it("uses interactive launch without session metadata", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).toBe("cn");
  });

  it("still launches fresh when session metadata is present", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        projectConfig: {
          ...makeLaunchConfig().projectConfig,
          agentConfig: { continueSessionId: "2dbd6c3b-89bf-4fa1-b5dd-d5a84859befa" },
        },
      }),
    );
    expect(cmd).toBe("cn");
  });

  it("passes the system prompt file and task prompt to Continue CLI on launch", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        prompt: "Do work",
        systemPrompt: "You are helpful",
        systemPromptFile: "/tmp/prompt.md",
      }),
    );
    expect(cmd).toBe("cn --prompt '/tmp/prompt.md' 'Do work'");
  });

  it("shell-escapes prompt arguments", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        prompt: "fix it's broken",
        systemPromptFile: "/tmp/prompt with spaces.md",
      }),
    );
    expect(cmd).toBe("cn --prompt '/tmp/prompt with spaces.md' 'fix it'\\''s broken'");
  });
});

describe("getEnvironment", () => {
  const agent = create();

  it("writes AO session keys and Continue CLI flags", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["AO_SESSION_ID"]).toBe("sess-1");
    expect(env["AO_ISSUE_ID"]).toBeUndefined();
    expect(env["PATH"]).toBeUndefined();
    expect(env["GH_PATH"]).toBeUndefined();
    expect(env["CONTINUE_CLI_ENABLE_TELEMETRY"]).toBe("0");
    expect(env["CONTINUE_METRICS_ENABLED"]).toBe("0");
    expect(env["CONTINUE_ALLOW_ANONYMOUS_TELEMETRY"]).toBe("0");
  });

  it("includes AO_ISSUE_ID when provided", () => {
    const env = agent.getEnvironment(makeLaunchConfig({ issueId: "INT-42" }));
    expect(env["AO_ISSUE_ID"]).toBe("INT-42");
  });
});

describe("isProcessRunning", () => {
  const agent = create();

  it("returns true when cn is on tmux pane", async () => {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") {
        return Promise.resolve({ stdout: "/dev/ttys003\n", stderr: "" });
      }
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: `  PID TT       ARGS\n  789 ttys003  cn\n`,
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
      if (cmd === "ps") {
        return Promise.resolve({ stdout: "  PID TT      ARGS\n  789 ttys003  bash\n", stderr: "" });
      }
      return Promise.reject(new Error("unexpected"));
    });
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("returns indeterminate when tmux probing fails", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("tmux failed"));
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(PROCESS_PROBE_INDETERMINATE);
  });

  it("returns true when process handle pid is alive", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(await agent.isProcessRunning(makeProcessHandle(123))).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(123, 0);
    killSpy.mockRestore();
  });

  it("treats EPERM as a live process", async () => {
    const err = Object.assign(new Error("EPERM"), { code: "EPERM" });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw err;
    });
    expect(await agent.isProcessRunning(makeProcessHandle(123))).toBe(true);
    killSpy.mockRestore();
  });

  it("returns false when process handle pid is dead", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    });
    expect(await agent.isProcessRunning(makeProcessHandle(123))).toBe(false);
    killSpy.mockRestore();
  });
});

describe("detectActivity", () => {
  const agent = create();

  it("classifies the current Continue permission prompt as waiting_input", () => {
    expect(agent.detectActivity("Would you like to continue?\n> Continue (tab)")).toBe(
      "waiting_input",
    );
  });

  it("ignores stale permission prompts when latest output is active", () => {
    expect(agent.detectActivity("Would you like to continue?\nBuilding package")).toBe("active");
  });

  it("ignores stale auth prompts when latest output is active", () => {
    expect(
      agent.detectActivity("Not authenticated. Please run 'cn login' first.\nBuilding package"),
    ).toBe("active");
  });

  it("ignores stale error lines when latest output is active", () => {
    expect(agent.detectActivity("Error: request failed\nBuilding package")).toBe("active");
  });
});

describe("recordActivity", () => {
  const agent = create();

  it("classifies idle terminal output when recording activity", async () => {
    await agent.recordActivity?.(makeSession(), "Continue\nEnter text...");
    expect(mockRecordTerminalActivity).toHaveBeenCalledWith(
      "/workspace/test",
      "Continue\nEnter text...",
      expect.any(Function),
    );
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("Continue\nEnter text...")).toBe("idle");
  });

  it("classifies tool permission prompts as waiting_input", async () => {
    await agent.recordActivity?.(makeSession(), "Would you like to continue?\n> Continue (tab)");
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("Would you like to continue?\n> Continue (tab)")).toBe("waiting_input");
  });

  it("ignores stale tool permission prompts when later output is active", async () => {
    await agent.recordActivity?.(makeSession(), "Would you like to continue?\nBuilding package");
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("Would you like to continue?\nBuilding package")).toBe("active");
  });

  it("classifies auth failures as blocked", async () => {
    await agent.recordActivity?.(makeSession(), "Not authenticated. Please run 'cn login' first.");
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("Not authenticated. Please run 'cn login' first.")).toBe("blocked");
  });

  it("ignores stale auth failures when later output is active", async () => {
    await agent.recordActivity?.(
      makeSession(),
      "Not authenticated. Please run 'cn login' first.\nRetrying request",
    );
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("Not authenticated. Please run 'cn login' first.\nRetrying request")).toBe(
      "active",
    );
  });

  it("classifies ordinary output as active", async () => {
    await agent.recordActivity?.(makeSession(), "Thinking about your request");
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("Thinking about your request")).toBe("active");
  });

  it("keeps normal progress lines that mention errors active", async () => {
    await agent.recordActivity?.(makeSession(), "Fixing error in authentication module");
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("Fixing error in authentication module")).toBe("active");
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

  it("returns null when liveness probing is indeterminate", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("tmux failed"));
    const state = await agent.getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle(), metadata: {} }),
    );
    expect(state).toBeNull();
  });

  it("uses activity JSONL state", async () => {
    const activityAt = new Date();
    mockReadLastActivityEntry.mockResolvedValue(makeActivityResult("waiting_input", activityAt));
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const state = await agent.getActivityState(
      makeSession({ runtimeHandle: makeProcessHandle(101) }),
    );
    expect(state?.state).toBe("waiting_input");
    expect(state?.timestamp?.toISOString()).toBe(activityAt.toISOString());
    killSpy.mockRestore();
  });

  it("decays stale fallback state to idle", async () => {
    const activityAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
    mockReadLastActivityEntry.mockResolvedValue(makeActivityResult("active", activityAt));
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const state = await agent.getActivityState(
      makeSession({ runtimeHandle: makeProcessHandle(101) }),
    );
    expect(state?.state).toBe("idle");
    expect(state?.timestamp?.toISOString()).toBe(activityAt.toISOString());
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
});

describe("session and restore", () => {
  const agent = create();

  it("does not expose session info without a stable current Continue session id source", async () => {
    await expect(agent.getSessionInfo(makeSession())).resolves.toBeNull();
  });

  it("does not build a restore command from AO metadata", async () => {
    const cmd = await agent.getRestoreCommand?.(
      makeSession({ metadata: { continueSessionId: "abc" } }),
      {
        name: "my-project",
        repo: "owner/repo",
        path: "/workspace/repo",
        defaultBranch: "main",
        sessionPrefix: "my",
        agentConfig: {},
      },
    );
    expect(cmd).toBeNull();
  });
});
