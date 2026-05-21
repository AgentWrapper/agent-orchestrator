import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentLaunchConfig, RuntimeHandle, Session } from "@aoagents/ao-core";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  mockIsWindows,
  mockWhichSync,
} = vi.hoisted(() => ({
  mockReadLastActivityEntry: vi.fn().mockResolvedValue(null),
  mockRecordTerminalActivity: vi.fn().mockResolvedValue(undefined),
  mockSetupPathWrapperWorkspace: vi.fn().mockResolvedValue(undefined),
  mockExecFileAsync: vi.fn(),
  mockIsWindows: vi.fn().mockReturnValue(false),
  mockWhichSync: vi.fn(),
}));

vi.mock("@aoagents/ao-core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    isWindows: mockIsWindows,
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

const KIRO_SESSION_ID = "f2946a26-3735-4b08-8d05-c928010302d5";

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
      agentConfig: {},
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
  it("has correct Kiro manifest", () => {
    expect(manifest).toEqual({
      name: pluginName,
      slot: "agent",
      description: packageJson.description,
      version: packageJson.version,
      displayName: "Kiro",
    });
  });
});

describe("create", () => {
  it("uses kiro-cli as process name", () => {
    const agent = create();
    expect(agent.name).toBe(pluginName);
    expect(agent.processName).toBe("kiro-cli");
  });

  it("exports plugin module shape", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
  });
});

describe("detect", () => {
  it("returns true when which resolves kiro-cli", () => {
    mockWhichSync.mockReturnValue("/usr/local/bin/kiro-cli");
    expect(detect()).toBe(true);
    expect(mockWhichSync).toHaveBeenCalledWith("kiro-cli");
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

  it("uses fresh interactive chat launch without session id", () => {
    expect(agent.getLaunchCommand(makeLaunchConfig())).toBe("kiro-cli chat");
  });

  it("uses --resume-id when configured with a known Kiro session id", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        projectConfig: {
          ...makeLaunchConfig().projectConfig,
          agentConfig: { kiroSessionId: KIRO_SESSION_ID },
        },
      }),
    );
    expect(cmd).toBe(`kiro-cli chat --resume-id '${KIRO_SESSION_ID}'`);
  });

  it("passes task prompt as Kiro chat positional input without prompt flags", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        prompt: "Fix Bob's issue",
      }),
    );
    expect(cmd).toBe("kiro-cli chat 'Fix Bob'\\''s issue'");
    expect(cmd).not.toContain("-p");
    expect(cmd).not.toContain("--prompt");
  });

  it("combines system prompt text with task prompt as Kiro input", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        systemPrompt: "Follow AO rules",
        prompt: "Fix the bug",
      }),
    );
    expect(cmd).toBe("kiro-cli chat 'Follow AO rules\n\nFix the bug'");
  });

  it("reads systemPromptFile and combines it with task prompt as Kiro input", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ao-kiro-test-"));
    try {
      const systemPromptFile = join(tmp, "system.md");
      writeFileSync(systemPromptFile, "Use repo instructions\n", "utf8");
      const cmd = agent.getLaunchCommand(
        makeLaunchConfig({
          systemPromptFile,
          prompt: "Fix the bug",
        }),
      );
      expect(cmd).toBe("kiro-cli chat 'Use repo instructions\n\nFix the bug'");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("passes prompt when restoring from configured Kiro session id", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        prompt: "Continue the task",
        projectConfig: {
          ...makeLaunchConfig().projectConfig,
          agentConfig: { kiroSessionId: KIRO_SESSION_ID },
        },
      }),
    );
    expect(cmd).toBe(`kiro-cli chat --resume-id '${KIRO_SESSION_ID}' 'Continue the task'`);
  });
});

describe("getEnvironment", () => {
  const agent = create();

  it("writes AO session keys and Kiro flags", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["AO_SESSION_ID"]).toBe("sess-1");
    expect(env["AO_ISSUE_ID"]).toBeUndefined();
    expect(env["PATH"]).toContain(".ao/bin");
    expect(env["GH_PATH"]).toContain("/gh");
    expect(env["KIRO_LOG_NO_COLOR"]).toBe("1");
  });

  it("includes AO_ISSUE_ID when provided", () => {
    const env = agent.getEnvironment(makeLaunchConfig({ issueId: "INT-42" }));
    expect(env["AO_ISSUE_ID"]).toBe("INT-42");
  });
});

describe("isProcessRunning", () => {
  const agent = create();

  it("returns true when kiro-cli is on tmux pane", async () => {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") {
        return Promise.resolve({ stdout: "/dev/ttys003\n", stderr: "" });
      }
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: "  PID TT       ARGS\n  789 ttys003  kiro-cli chat\n",
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

  it("returns false without POSIX tmux checks on Windows", async () => {
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
    await agent.recordActivity?.(makeSession(), "assistant answer\n> ");
    expect(mockRecordTerminalActivity).toHaveBeenCalledWith(
      "/workspace/test",
      "assistant answer\n> ",
      expect.any(Function),
    );
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("assistant answer\n> ")).toBe("idle");
  });

  it("classifies active terminal output when recording activity", async () => {
    await agent.recordActivity?.(makeSession(), "Running npm test...");
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("Running npm test...")).toBe("active");
  });

  it("classifies waiting_input terminal output when approval is required", async () => {
    await agent.recordActivity?.(makeSession(), "Shell command requires approval\nYes  Trust  No");
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("Shell command requires approval\nYes  Trust  No")).toBe("waiting_input");
  });

  it("classifies blocked terminal output", async () => {
    await agent.recordActivity?.(makeSession(), "Something failed");
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("Something failed")).toBe("blocked");
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

  it("returns null when no reliable activity data is available", async () => {
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

  it("returns null without known Kiro session id metadata", async () => {
    expect(await agent.getSessionInfo(makeSession())).toBeNull();
  });

  it("returns the known Kiro session id from metadata without inventing summary data", async () => {
    const info = await agent.getSessionInfo(
      makeSession({ metadata: { kiroSessionId: KIRO_SESSION_ID } }),
    );
    expect(info).toEqual({
      agentSessionId: KIRO_SESSION_ID,
      summary: null,
    });
  });
});

describe("getRestoreCommand", () => {
  const agent = create();

  it("builds restore command using the Kiro session id", async () => {
    const cmd = await agent.getRestoreCommand?.(
      makeSession({ metadata: { kiroSessionId: KIRO_SESSION_ID } }),
      {
        name: "my-project",
        repo: "owner/repo",
        path: "/workspace/repo",
        defaultBranch: "main",
        sessionPrefix: "my",
        agentConfig: {},
      },
    );
    expect(cmd).toBe(`kiro-cli chat --resume-id '${KIRO_SESSION_ID}'`);
  });

  it("returns null without a known Kiro session id", async () => {
    const cmd = await agent.getRestoreCommand?.(makeSession(), {
      name: "my-project",
      repo: "owner/repo",
      path: "/workspace/repo",
      defaultBranch: "main",
      sessionPrefix: "my",
      agentConfig: {},
    });
    expect(cmd).toBeNull();
  });
});

describe("workspace hooks", () => {
  const agent = create();

  it("sets up path wrapper workspace in setupWorkspaceHooks", async () => {
    await agent.setupWorkspaceHooks?.("/workspace/test", { dataDir: "/data" });
    expect(mockSetupPathWrapperWorkspace).toHaveBeenCalledWith("/workspace/test");
  });

  it("sets up path wrapper workspace after launch when workspace exists", async () => {
    await agent.postLaunchSetup?.(makeSession({ workspacePath: "/workspace/test" }));
    expect(mockSetupPathWrapperWorkspace).toHaveBeenCalledWith("/workspace/test");
  });

  it("skips post launch setup without workspace path", async () => {
    await agent.postLaunchSetup?.(makeSession({ workspacePath: null }));
    expect(mockSetupPathWrapperWorkspace).not.toHaveBeenCalled();
  });
});
