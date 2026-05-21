import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  PROCESS_PROBE_INDETERMINATE,
  createActivitySignal,
  type Session,
  type RuntimeHandle,
  type AgentLaunchConfig,
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
  execFileSync: vi.fn(),
}));

import { create, detect, manifest, default as defaultExport } from "./index.js";

const VALID_CLINE_SESSION_ID = "cline-session-123";

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
  it("has correct Cline manifest", () => {
    expect(manifest).toEqual({
      name: pluginName,
      slot: "agent",
      description: packageJson.description,
      version: packageJson.version,
      displayName: "Cline",
    });
  });
});

describe("create", () => {
  it("uses cline as process name and post-launch prompt mode", () => {
    const agent = create();
    expect(agent.name).toBe(pluginName);
    expect(agent.processName).toBe(pluginName);
    expect(agent.promptDelivery).toBe("post-launch");
  });

  it("exports plugin module shape", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
    expect(typeof defaultExport.detect).toBe("function");
  });
});

describe("detect", () => {
  it("returns true when which resolves", () => {
    mockWhichSync.mockReturnValue("/usr/local/bin/cline");
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

  it("uses interactive TUI launch without a configured Cline session id", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).toBe("cline --tui");
  });

  it("uses --id when a Cline session id is configured", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        projectConfig: {
          ...makeLaunchConfig().projectConfig,
          agentConfig: { clineSessionId: VALID_CLINE_SESSION_ID },
        },
      }),
    );
    expect(cmd).toBe(`cline --tui --id '${VALID_CLINE_SESSION_ID}'`);
  });

  it("does not include prompt flags in launch command", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        prompt: "Do work",
        systemPrompt: "You are helpful",
        systemPromptFile: "/tmp/prompt.md",
      }),
    );
    expect(cmd).toBe("cline --tui");
    expect(cmd).not.toContain("Do work");
    expect(cmd).not.toContain("--system");
  });
});

describe("getEnvironment", () => {
  const agent = create();

  it("writes AO session keys without overriding centralized PATH settings", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["AO_SESSION_ID"]).toBe("sess-1");
    expect(env["AO_ISSUE_ID"]).toBeUndefined();
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

  it("returns true when cline is on tmux pane", async () => {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") {
        return Promise.resolve({ stdout: "/dev/ttys003\n", stderr: "" });
      }
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: "  PID TT       ARGS\n  789 ttys003  node /usr/local/bin/cline --tui\n",
          stderr: "",
        });
      }
      return Promise.reject(new Error("unexpected"));
    });

    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
    expect(mockExecFileAsync).toHaveBeenNthCalledWith(
      1,
      "tmux",
      ["list-panes", "-t", "=test-session", "-F", "#{pane_tty}"],
      expect.objectContaining({ windowsHide: true }),
    );
    expect(mockExecFileAsync).toHaveBeenNthCalledWith(
      2,
      "ps",
      ["-eo", "pid,tty,args"],
      expect.objectContaining({ windowsHide: true }),
    );
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
    mockExecFileAsync.mockRejectedValue(new Error("tmux unavailable"));
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(PROCESS_PROBE_INDETERMINATE);
  });

  it("returns indeterminate when tmux returns no panes", async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: "\n", stderr: "" });
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(PROCESS_PROBE_INDETERMINATE);
  });

  it("returns true when process handle pid is alive", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(await agent.isProcessRunning(makeProcessHandle(123))).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(123, 0);
    killSpy.mockRestore();
  });

  it("treats EPERM as a running process", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    });
    expect(await agent.isProcessRunning(makeProcessHandle(123))).toBe(true);
    killSpy.mockRestore();
  });

  it("returns false when process handle pid is dead", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });
    expect(await agent.isProcessRunning(makeProcessHandle(123))).toBe(false);
    killSpy.mockRestore();
  });

  it("returns indeterminate when process probing fails unexpectedly", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("invalid signal"), { code: "EINVAL" });
    });
    expect(await agent.isProcessRunning(makeProcessHandle(123))).toBe(PROCESS_PROBE_INDETERMINATE);
    killSpy.mockRestore();
  });
});

describe("recordActivity", () => {
  const agent = create();

  it("classifies idle terminal output when recording activity", async () => {
    await agent.recordActivity?.(makeSession(), "Press h + Enter to show shortcuts\n> ");
    expect(mockRecordTerminalActivity).toHaveBeenCalledWith(
      "/workspace/test",
      "Press h + Enter to show shortcuts\n> ",
      expect.any(Function),
    );
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("\u001b[32m>\u001b[0m ")).toBe("idle");
  });

  it("classifies active terminal output when recording activity", async () => {
    await agent.recordActivity?.(makeSession(), "[read_file] package.json");
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("[read_file] package.json")).toBe("active");
  });

  it("classifies waiting_input terminal output when recording activity", async () => {
    await agent.recordActivity?.(makeSession(), 'Approve "write_to_file" {"path":"x"} [y/N] ');
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.('Approve "write_to_file" {"path":"x"} [y/N] ')).toBe("waiting_input");
  });

  it("classifies blocked terminal output when recording activity", async () => {
    await agent.recordActivity?.(makeSession(), "error: interactive mode requires a TTY");
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("error: interactive mode requires a TTY")).toBe("blocked");
  });

  it("classifies completed terminal output as ready", async () => {
    await agent.recordActivity?.(makeSession(), "Task completed");
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("Task completed")).toBe("ready");
  });

  it("does not classify generic done or complete text as ready", async () => {
    await agent.recordActivity?.(makeSession(), "tests done: 3/5");
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("tests done: 3/5")).toBe("active");
    expect(classify?.("implementation almost complete")).toBe("active");
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

  it("returns exited when process is no longer running", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    });
    const state = await agent.getActivityState(
      makeSession({ runtimeHandle: makeProcessHandle(101) }),
    );
    expect(state).toMatchObject({ state: "exited" });
    killSpy.mockRestore();
  });

  it("returns null when process probing is indeterminate", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("tmux unavailable"));
    const state = await agent.getActivityState(makeSession({ runtimeHandle: makeTmuxHandle() }));
    expect(state).toBeNull();
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
    expect(state?.timestamp?.toISOString()).toBe(activityAt.toISOString());
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

describe("getSessionInfo", () => {
  const agent = create();

  it("returns null without a Cline session id", async () => {
    expect(await agent.getSessionInfo(makeSession())).toBeNull();
  });

  it("uses Cline history title as the summary", async () => {
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "cline" && args[0] === "history") {
        return Promise.resolve({
          stdout: JSON.stringify([
            {
              sessionId: VALID_CLINE_SESSION_ID,
              prompt: "fallback prompt",
              metadata: { title: "Implement dashboard fix" },
            },
          ]),
          stderr: "",
        });
      }
      return Promise.reject(new Error("unexpected"));
    });

    const info = await agent.getSessionInfo(
      makeSession({ metadata: { clineSessionId: VALID_CLINE_SESSION_ID } }),
    );
    expect(info).toMatchObject({
      agentSessionId: VALID_CLINE_SESSION_ID,
      summary: "Implement dashboard fix",
      summaryIsFallback: false,
    });
  });

  it("uses prompt as fallback summary when history has no title", async () => {
    mockExecFileAsync.mockResolvedValue({
      stdout: JSON.stringify([{ sessionId: VALID_CLINE_SESSION_ID, prompt: "fallback prompt" }]),
      stderr: "",
    });

    const info = await agent.getSessionInfo(
      makeSession({ metadata: { clineSessionId: VALID_CLINE_SESSION_ID } }),
    );
    expect(info).toMatchObject({
      agentSessionId: VALID_CLINE_SESSION_ID,
      summary: "fallback prompt",
      summaryIsFallback: true,
    });
  });

  it("treats Cline history lookup as unavailable when command fails", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("history unavailable"));
    const info = await agent.getSessionInfo(
      makeSession({ metadata: { clineSessionId: VALID_CLINE_SESSION_ID } }),
    );
    expect(info).toMatchObject({
      agentSessionId: VALID_CLINE_SESSION_ID,
      summary: null,
    });
  });
});

describe("getRestoreCommand", () => {
  const agent = create();

  it("builds restore command using the Cline session id only", async () => {
    const cmd = await agent.getRestoreCommand?.(
      makeSession({ metadata: { clineSessionId: VALID_CLINE_SESSION_ID } }),
      {
        name: "my-project",
        repo: "owner/repo",
        path: "/workspace/repo",
        defaultBranch: "main",
        sessionPrefix: "my",
        agentConfig: { model: "provider/gpt-4o" },
      },
    );
    expect(cmd).toBe(`cline --tui --id '${VALID_CLINE_SESSION_ID}'`);
  });

  it("returns null when no Cline session id is stored", async () => {
    const cmd = await agent.getRestoreCommand?.(makeSession(), {
      name: "my-project",
      repo: "owner/repo",
      path: "/workspace/repo",
      defaultBranch: "main",
      sessionPrefix: "my",
      agentConfig: { model: "provider/gpt-4o" },
    });
    expect(cmd).toBeNull();
  });
});

describe("workspace hooks", () => {
  const agent = create();

  it("sets up PATH wrapper hooks for the workspace", async () => {
    await agent.setupWorkspaceHooks?.("/workspace/test", { dataDir: "/tmp/data" });
    expect(mockSetupPathWrapperWorkspace).toHaveBeenCalledWith("/workspace/test");
  });

  it("sets up PATH wrappers after launch when workspace path exists", async () => {
    await agent.postLaunchSetup?.(makeSession({ workspacePath: "/workspace/test" }));
    expect(mockSetupPathWrapperWorkspace).toHaveBeenCalledWith("/workspace/test");
  });

  it("skips post-launch setup when workspace path is absent", async () => {
    await agent.postLaunchSetup?.(makeSession({ workspacePath: null }));
    expect(mockSetupPathWrapperWorkspace).not.toHaveBeenCalled();
  });
});
