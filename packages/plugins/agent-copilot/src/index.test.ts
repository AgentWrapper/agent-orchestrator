import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  PROCESS_PROBE_INDETERMINATE,
  isWindows,
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

const itIfNotWindows = isWindows() ? it.skip : it;

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
        model: "gpt-5.4",
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

function extractResumeId(command: string): string {
  const match = command.match(/--resume='([^']+)'/);
  if (!match?.[1]) throw new Error(`missing resume id in ${command}`);
  return match[1];
}

function extractNameId(command: string): string {
  const match = command.match(/--name '([^']+)'/);
  if (!match?.[1]) throw new Error(`missing name id in ${command}`);
  return match[1];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockWhichSync.mockReset();
  mockReadLastActivityEntry.mockResolvedValue(null);
});

describe("manifest", () => {
  it("has correct Copilot manifest", () => {
    expect(manifest).toEqual({
      name: pluginName,
      slot: "agent",
      description: packageJson.description,
      version: packageJson.version,
      displayName: "GitHub Copilot CLI",
    });
  });
});

describe("create", () => {
  it("uses copilot as process name and inline prompt mode", () => {
    const agent = create();
    expect(agent.name).toBe(pluginName);
    expect(agent.processName).toBe(pluginName);
    expect(agent.promptDelivery).toBe("inline");
  });

  it("exports plugin module shape", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
    expect(typeof defaultExport.detect).toBe("function");
  });
});

describe("detect", () => {
  it("returns true when which resolves", () => {
    mockWhichSync.mockReturnValue("/usr/local/bin/copilot");
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

  it("uses interactive launch with a stable Copilot session name", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).toMatch(/^copilot --no-auto-update --name '[0-9a-f-]+' --model 'gpt-5\.4'$/);
    expect(extractNameId(cmd)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("uses launch-time model override when provided", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ model: "claude-sonnet-4.6" }));
    expect(cmd).toContain("--model 'claude-sonnet-4.6'");
  });

  it("maps permissionless mode to Copilot all-permissions mode", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "permissionless" }));
    expect(cmd).toContain("--allow-all");
  });

  it("uses project agentConfig permissions when launch permissions are absent", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        projectConfig: {
          ...makeLaunchConfig().projectConfig,
          agentConfig: { permissions: "permissionless" },
        },
      }),
    );
    expect(cmd).toContain("--allow-all");
  });

  it("maps auto-edit mode to Copilot write approval", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "auto-edit" }));
    expect(cmd).toContain("--allow-tool=write");
  });

  it("passes the initial prompt to interactive mode", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        prompt: "Do work",
        systemPrompt: "You are helpful",
      }),
    );
    expect(cmd).not.toContain(" -p ");
    expect(cmd).not.toContain(" --prompt");
    expect(cmd).toContain("--interactive 'You are helpful\n\n## User Request\nDo work'");
  });

  it("does not pass an interactive prompt when restoring", async () => {
    const session = makeSession({ id: "sess-1", issueId: "123" });
    const project = makeLaunchConfig().projectConfig;
    const restore = await agent.getRestoreCommand?.(session, project);
    expect(restore).not.toContain("--interactive");
  });
});

describe("getEnvironment", () => {
  const agent = create();

  it("writes AO session keys and Copilot flags", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["AO_SESSION_ID"]).toBe("sess-1");
    expect(env["AO_ISSUE_ID"]).toBeUndefined();
    expect(env["COPILOT_AUTO_UPDATE"]).toBe("false");
    expect(env["GH_PATH"]).toBeUndefined();
    expect(env["PATH"]).toBeUndefined();
  });

  it("includes AO_ISSUE_ID when provided", () => {
    const env = agent.getEnvironment(makeLaunchConfig({ issueId: "INT-42" }));
    expect(env["AO_ISSUE_ID"]).toBe("INT-42");
  });
});

describe("isProcessRunning", () => {
  const agent = create();

  itIfNotWindows("returns true when copilot is on tmux pane", async () => {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") {
        return Promise.resolve({ stdout: "/dev/ttys003\n", stderr: "" });
      }
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: "  PID TT       ARGS\n  789 ttys003  /usr/local/bin/copilot --no-auto-update\n",
          stderr: "",
        });
      }
      return Promise.reject(new Error("unexpected"));
    });

    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  itIfNotWindows("returns false when tmux process is missing", async () => {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") return Promise.resolve({ stdout: "/dev/ttys003\n", stderr: "" });
      if (cmd === "ps") {
        return Promise.resolve({ stdout: "  PID TT      ARGS\n  789 ttys003  bash\n", stderr: "" });
      }
      return Promise.reject(new Error("unexpected"));
    });
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  itIfNotWindows("returns indeterminate when tmux probing fails", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("tmux timed out"));
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(PROCESS_PROBE_INDETERMINATE);
  });

  it("returns true when process handle pid is alive", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(await agent.isProcessRunning(makeProcessHandle(123))).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(123, 0);
    killSpy.mockRestore();
  });

  it("treats EPERM as alive for process handles", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
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

describe("recordActivity", () => {
  const agent = create();

  it("classifies idle terminal output when recording activity", async () => {
    await agent.recordActivity?.(makeSession(), "done\n> ");
    expect(mockRecordTerminalActivity).toHaveBeenCalledWith(
      "/workspace/test",
      "done\n> ",
      expect.any(Function),
    );
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("done\n> ")).toBe("idle");
  });

  it("classifies active terminal output when recording activity", async () => {
    await agent.recordActivity?.(makeSession(), "GitHub Copilot is working on your request");
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("GitHub Copilot is working on your request")).toBe("active");
  });

  it("classifies folder trust prompts as waiting_input", async () => {
    await agent.recordActivity?.(
      makeSession(),
      "Confirm folder trust\nDo you trust the files in this folder?\nCurrent selection: 1. Yes\n↑↓ to navigate · Enter to select",
    );
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(
      classify?.(
        "Confirm folder trust\nDo you trust the files in this folder?\nCurrent selection: 1. Yes\n↑↓ to navigate · Enter to select",
      ),
    ).toBe("waiting_input");
  });

  it("classifies authentication failures as blocked", async () => {
    await agent.recordActivity?.(makeSession(), "Error: not authenticated");
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("Error: not authenticated")).toBe("blocked");
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

  itIfNotWindows("returns null when process probe is indeterminate", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("tmux timed out"));
    const state = await agent.getActivityState(makeSession({ runtimeHandle: makeTmuxHandle() }));
    expect(state).toBeNull();
  });

  it("falls back to activity JSONL waiting_input state", async () => {
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

  it("returns active from JSONL fallback", async () => {
    const activityAt = new Date();
    mockReadLastActivityEntry.mockResolvedValue(makeActivityResult("active", activityAt));
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const state = await agent.getActivityState(
      makeSession({ runtimeHandle: makeProcessHandle(101) }),
    );
    expect(state?.state).toBe("active");
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

describe("getSessionInfo", () => {
  const agent = create();

  it("returns the stable Copilot session id without summary or cost", async () => {
    const info = await agent.getSessionInfo(makeSession({ id: "sess-1" }));
    expect(info).toEqual({
      agentSessionId: extractNameId(
        agent.getLaunchCommand(makeLaunchConfig({ sessionId: "sess-1" })),
      ),
      summary: null,
    });
  });
});

describe("getRestoreCommand", () => {
  const agent = create();

  it("builds restore command using the stable Copilot session id", async () => {
    const session = makeSession({ id: "sess-1", issueId: "123" });
    const project = makeLaunchConfig().projectConfig;
    const restore = await agent.getRestoreCommand?.(session, project);
    expect(restore).toMatch(
      /^copilot --no-auto-update --resume='[0-9a-f-]+' --model 'gpt-5\.4'$/,
    );
    expect(extractResumeId(restore ?? "")).toBe(
      extractNameId(agent.getLaunchCommand(makeLaunchConfig({ sessionId: "sess-1" }))),
    );
  });
});

describe("workspace hooks", () => {
  const agent = create();

  it("sets up path wrapper workspace hooks", async () => {
    await agent.setupWorkspaceHooks?.("/workspace/test", { dataDir: "/data", sessionId: "sess-1" });
    expect(mockSetupPathWrapperWorkspace).toHaveBeenCalledWith("/workspace/test");
  });

  it("postLaunchSetup sets up path wrapper hooks when workspace exists", async () => {
    await agent.postLaunchSetup?.(makeSession({ workspacePath: "/workspace/test" }));
    expect(mockSetupPathWrapperWorkspace).toHaveBeenCalledWith("/workspace/test");
  });

  it("postLaunchSetup skips sessions without a workspace", async () => {
    await agent.postLaunchSetup?.(makeSession({ workspacePath: null }));
    expect(mockSetupPathWrapperWorkspace).not.toHaveBeenCalled();
  });
});
