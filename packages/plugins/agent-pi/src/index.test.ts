import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentLaunchConfig, RuntimeHandle, Session } from "@aoagents/ao-core";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  mockIsWindows,
} = vi.hoisted(() => ({
  mockReadLastActivityEntry: vi.fn().mockResolvedValue(null),
  mockRecordTerminalActivity: vi.fn().mockResolvedValue(undefined),
  mockSetupPathWrapperWorkspace: vi.fn().mockResolvedValue(undefined),
  mockExecFileAsync: vi.fn(),
  mockWhichSync: vi.fn(),
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

const VALID_PI_SESSION_ID = "019e29c4-125d-750d-bb67-24c58b841553";

function makeLifecycle(): Session["lifecycle"] {
  const now = new Date().toISOString();
  return {
    version: 2,
    session: {
      kind: "worker",
      state: "working",
      reason: "task_in_progress",
      startedAt: now,
      completedAt: null,
      terminatedAt: null,
      lastTransitionAt: now,
    },
    pr: {
      state: "none",
      reason: "not_created",
      number: null,
      url: null,
      lastObservedAt: null,
    },
    runtime: {
      state: "alive",
      reason: "process_running",
      lastObservedAt: now,
      handle: null,
      tmuxName: null,
    },
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess-1",
    projectId: "test-project",
    status: "working",
    activity: "active",
    activitySignal: { state: "valid", activity: "active", source: "terminal" },
    lifecycle: makeLifecycle(),
    branch: "feat/test",
    issueId: null,
    pr: null,
    workspacePath: "/workspace/repo",
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

function makeLaunchConfig(overrides: Partial<AgentLaunchConfig> = {}): AgentLaunchConfig {
  return {
    sessionId: "sess-1",
    workspacePath: "/workspace/repo",
    projectConfig: {
      name: "my-project",
      repo: "owner/repo",
      path: "/workspace/source",
      defaultBranch: "main",
      sessionPrefix: "my",
      agentConfig: {},
    },
    ...overrides,
  };
}

function makeTmuxHandle(id = "test-session"): RuntimeHandle {
  return { id, runtimeName: "tmux", data: {} };
}

function makeProcessHandle(pid?: number | string): RuntimeHandle {
  return { id: "proc-1", runtimeName: "process", data: pid !== undefined ? { pid } : {} };
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

async function writePiSessionFile(
  dir: string,
  options: {
    id?: string;
    userText?: string;
    inputTokens?: number;
    outputTokens?: number;
    costTotal?: number;
  } = {},
): Promise<string> {
  const id = options.id ?? VALID_PI_SESSION_ID;
  const filePath = join(dir, `2026-05-15T03-52-56-157Z_${id}.jsonl`);
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id,
      timestamp: "2026-05-15T03:52:56.157Z",
      cwd: "/workspace/repo",
    }),
    JSON.stringify({
      type: "message",
      id: "user-1",
      timestamp: "2026-05-15T03:52:56.196Z",
      message: {
        role: "user",
        content: [{ type: "text", text: options.userText ?? "Implement the feature" }],
      },
    }),
    JSON.stringify({
      type: "message",
      id: "assistant-1",
      timestamp: "2026-05-15T03:52:59.710Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Done" }],
        usage: {
          input: options.inputTokens ?? 1200,
          output: options.outputTokens ?? 34,
          cost: { total: options.costTotal ?? 0.0123 },
        },
      },
    }),
  ];
  await writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
  return filePath;
}

let tempDirs: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  mockWhichSync.mockReset();
  mockExecFileAsync.mockReset();
  mockIsWindows.mockReturnValue(false);
});

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ao-pi-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("manifest", () => {
  it("has correct Pi manifest", () => {
    expect(manifest).toEqual({
      name: pluginName,
      slot: "agent",
      description: packageJson.description,
      version: packageJson.version,
      displayName: "Pi",
    });
  });
});

describe("create", () => {
  it("uses pi as process name and inline prompt mode", () => {
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
  it("returns true when which resolves pi", () => {
    mockWhichSync.mockReturnValue("/usr/local/bin/pi");
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

  it("uses interactive launch with an AO-owned session directory", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).toBe("pi --session-dir '/workspace/repo/.ao/pi-sessions/sess-1'");
  });

  it("passes the AO system prompt file", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ systemPromptFile: "/tmp/system prompt.md" }),
    );
    expect(cmd).toBe(
      "pi --session-dir '/workspace/repo/.ao/pi-sessions/sess-1' --append-system-prompt '/tmp/system prompt.md'",
    );
  });

  it("uses --session when configured with Pi session metadata", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        projectConfig: {
          ...makeLaunchConfig().projectConfig,
          agentConfig: { piSessionId: VALID_PI_SESSION_ID },
        },
      }),
    );
    expect(cmd).toBe(
      `pi --session-dir '/workspace/repo/.ao/pi-sessions/sess-1' --session '${VALID_PI_SESSION_ID}'`,
    );
  });

  it("passes the task prompt as Pi's positional initial message", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        prompt: "Do work",
        systemPrompt: "You are helpful",
        systemPromptFile: "/tmp/prompt.md",
      }),
    );
    expect(cmd).toBe(
      "pi --session-dir '/workspace/repo/.ao/pi-sessions/sess-1' --append-system-prompt '/tmp/prompt.md' 'Do work'",
    );
    expect(cmd).not.toContain("-p ");
    expect(cmd).not.toContain("--print");
  });
});

describe("getEnvironment", () => {
  const agent = create();

  it("writes AO session keys and Pi session-dir env", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["AO_SESSION_ID"]).toBe("sess-1");
    expect(env["AO_ISSUE_ID"]).toBeUndefined();
    expect(env["PI_CODING_AGENT_SESSION_DIR"]).toBe("/workspace/repo/.ao/pi-sessions/sess-1");
    expect(env["PATH"]).toBeUndefined();
    expect(env["GH_PATH"]).toBeUndefined();
  });

  it("includes AO_ISSUE_ID when provided", () => {
    const env = agent.getEnvironment(makeLaunchConfig({ issueId: "42" }));
    expect(env["AO_ISSUE_ID"]).toBe("42");
  });
});

describe("isProcessRunning", () => {
  const agent = create();

  it("returns true when pi is on tmux pane", async () => {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") return Promise.resolve({ stdout: "/dev/ttys003\n", stderr: "" });
      if (cmd === "ps") {
        return Promise.resolve({
          stdout:
            "  PID TT       ARGS\n  789 ttys003  node /x/@earendil-works/pi-coding-agent/dist/cli.js --session-dir /tmp/pi\n",
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
        return Promise.resolve({
          stdout: "  PID TT       ARGS\n  789 ttys003  bash\n",
          stderr: "",
        });
      return Promise.reject(new Error("unexpected"));
    });

    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("returns indeterminate for tmux handles on Windows", async () => {
    mockIsWindows.mockReturnValue(true);
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe("indeterminate");
  });

  it("returns true when process handle pid is alive", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(await agent.isProcessRunning(makeProcessHandle(123))).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(123, 0);
    killSpy.mockRestore();
  });

  it("treats EPERM as a running process", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("EPERM") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    });
    expect(await agent.isProcessRunning(makeProcessHandle(123))).toBe(true);
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

  it("classifies Pi's ready prompt as idle", async () => {
    await agent.recordActivity?.(
      makeSession(),
      "How can I help?\nShare what you want to do in this repo",
    );
    expect(mockRecordTerminalActivity).toHaveBeenCalledWith(
      "/workspace/repo",
      "How can I help?\nShare what you want to do in this repo",
      expect.any(Function),
    );
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("How can I help?\nShare what you want to do in this repo")).toBe("idle");
  });

  it("classifies active output", async () => {
    await agent.recordActivity?.(makeSession(), "Reading package.json");
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("Reading package.json")).toBe("active");
  });

  it("classifies waiting-input terminal prompts", async () => {
    await agent.recordActivity?.(
      makeSession(),
      "Warning: legacy settings\nPress any key to continue...",
    );
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("Warning: legacy settings\nPress any key to continue...")).toBe(
      "waiting_input",
    );
  });

  it("does not classify stale waiting-input prompts in scrollback as waiting_input", async () => {
    await agent.recordActivity?.(
      makeSession(),
      "Press any key to continue...\nReading package.json",
    );
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("Press any key to continue...\nReading package.json")).toBe("active");
  });

  it("does not classify stale idle prompts in scrollback as idle", async () => {
    await agent.recordActivity?.(makeSession(), "How can I help?\nReading package.json");
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("How can I help?\nReading package.json")).toBe("active");
  });

  it("classifies blocked terminal output", async () => {
    await agent.recordActivity?.(makeSession(), "Error: API key is missing");
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("Error: API key is missing")).toBe("blocked");
  });

  it("does not classify old errors in terminal history as blocked", async () => {
    await agent.recordActivity?.(makeSession(), "Error: old failure\nReading package.json");
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("Error: old failure\nReading package.json")).toBe("active");
  });

  it("skips recording when workspacePath is missing", async () => {
    await agent.recordActivity?.(makeSession({ workspacePath: null }), "Reading package.json");
    expect(mockRecordTerminalActivity).not.toHaveBeenCalled();
  });
});

describe("getActivityState", () => {
  const agent = create();

  it("returns exited when runtime handle is missing", async () => {
    const state = await agent.getActivityState(makeSession({ runtimeHandle: null }));
    expect(state).toMatchObject({ state: "exited" });
  });

  it("returns exited when process is not running", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    const state = await agent.getActivityState(
      makeSession({ runtimeHandle: makeProcessHandle(101) }),
    );
    expect(state).toMatchObject({ state: "exited" });
    killSpy.mockRestore();
  });

  it("returns waiting_input from activity JSONL", async () => {
    mockReadLastActivityEntry.mockResolvedValue(makeActivityResult("waiting_input", new Date()));
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const state = await agent.getActivityState(
      makeSession({ runtimeHandle: makeProcessHandle(101) }),
    );
    expect(state?.state).toBe("waiting_input");
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

  it("decays JSONL fallback state to idle when stale", async () => {
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

  it("returns null when no reliable activity data exists", async () => {
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

  it("returns null when no session directory is available", async () => {
    expect(await agent.getSessionInfo(makeSession({ workspacePath: null }))).toBeNull();
  });

  it("extracts Pi session id, fallback summary, cost, and metadata", async () => {
    const dir = await makeTempDir();
    await writePiSessionFile(dir, {
      userText: "Implement agent-pi plugin",
      inputTokens: 300,
      outputTokens: 20,
      costTotal: 0.004,
    });
    const info = await agent.getSessionInfo(makeSession({ metadata: { piSessionDir: dir } }));

    expect(info).toMatchObject({
      agentSessionId: VALID_PI_SESSION_ID,
      summary: "Implement agent-pi plugin",
      summaryIsFallback: true,
      metadata: {
        piSessionId: VALID_PI_SESSION_ID,
        piSessionDir: dir,
      },
      cost: {
        inputTokens: 300,
        outputTokens: 20,
        estimatedCostUsd: 0.004,
      },
    });
  });

  it("discovers Pi session files in cwd slug subdirectories", async () => {
    const dir = await makeTempDir();
    const nestedDir = join(dir, "--workspace--repo--");
    await mkdir(nestedDir);
    await writePiSessionFile(nestedDir, { userText: "Nested Pi session" });

    const info = await agent.getSessionInfo(makeSession({ metadata: { piSessionDir: dir } }));

    expect(info).toMatchObject({
      agentSessionId: VALID_PI_SESSION_ID,
      summary: "Nested Pi session",
      metadata: {
        piSessionId: VALID_PI_SESSION_ID,
        piSessionDir: dir,
      },
    });
  });

  it("returns null when Pi session metadata is unavailable", async () => {
    const dir = await makeTempDir();
    expect(await agent.getSessionInfo(makeSession({ metadata: { piSessionDir: dir } }))).toBeNull();
  });
});

describe("getRestoreCommand", () => {
  const agent = create();

  it("builds restore command from persisted Pi session metadata", async () => {
    const dir = await makeTempDir();
    const cmd = await agent.getRestoreCommand?.(
      makeSession({ metadata: { piSessionId: VALID_PI_SESSION_ID, piSessionDir: dir } }),
      makeLaunchConfig().projectConfig,
    );
    expect(cmd).toBe(`pi --session-dir '${dir}' --session '${VALID_PI_SESSION_ID}'`);
  });

  it("discovers a Pi session id from the AO-owned session directory", async () => {
    const dir = await makeTempDir();
    await writePiSessionFile(dir);
    const cmd = await agent.getRestoreCommand?.(
      makeSession({ metadata: { piSessionDir: dir } }),
      makeLaunchConfig().projectConfig,
    );
    expect(cmd).toBe(`pi --session-dir '${dir}' --session '${VALID_PI_SESSION_ID}'`);
  });

  it("discovers a Pi session id from nested cwd session directories", async () => {
    const dir = await makeTempDir();
    const nestedDir = join(dir, "--workspace--repo--");
    await mkdir(nestedDir);
    await writePiSessionFile(nestedDir);
    const cmd = await agent.getRestoreCommand?.(
      makeSession({ metadata: { piSessionDir: dir } }),
      makeLaunchConfig().projectConfig,
    );
    expect(cmd).toBe(`pi --session-dir '${dir}' --session '${VALID_PI_SESSION_ID}'`);
  });

  it("returns null when no session id can be found", async () => {
    const dir = await makeTempDir();
    const cmd = await agent.getRestoreCommand?.(
      makeSession({ metadata: { piSessionDir: dir } }),
      makeLaunchConfig().projectConfig,
    );
    expect(cmd).toBeNull();
  });
});

describe("workspace hooks", () => {
  const agent = create();

  it("sets up path-wrapper workspace hooks", async () => {
    await agent.setupWorkspaceHooks?.("/workspace/repo", {
      dataDir: "/tmp/ao",
      sessionId: "sess-1",
    });
    expect(mockSetupPathWrapperWorkspace).toHaveBeenCalledWith("/workspace/repo");
  });

  it("runs path-wrapper setup after launch when workspace exists", async () => {
    await agent.postLaunchSetup?.(makeSession({ workspacePath: "/workspace/repo" }));
    expect(mockSetupPathWrapperWorkspace).toHaveBeenCalledWith("/workspace/repo");
  });
});
