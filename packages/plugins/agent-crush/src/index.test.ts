import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session, RuntimeHandle, AgentLaunchConfig } from "@aoagents/ao-core";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

import { create, detect, manifest, default as defaultExport } from "./index.js";

const CRUSH_SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";

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
  it("has correct Crush manifest", () => {
    expect(manifest).toEqual({
      name: pluginName,
      slot: "agent",
      description: packageJson.description,
      version: packageJson.version,
      displayName: "Crush",
    });
  });
});

describe("create", () => {
  it("uses crush as process name and inline prompt mode", () => {
    const agent = create();
    expect(agent.name).toBe(pluginName);
    expect(agent.processName).toBe(pluginName);
    expect(agent.promptDelivery).toBe("inline");
    expect(agent.promptDeliveryDelayMs).toBeUndefined();
  });

  it("exports plugin module shape", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
  });
});

describe("detect", () => {
  it("returns true when which resolves", () => {
    mockWhichSync.mockReturnValue("/usr/local/bin/crush");
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

  it("uses interactive launch without session id", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).toBe("crush");
  });

  it("uses --session when configured", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        projectConfig: {
          ...makeLaunchConfig().projectConfig,
          agentConfig: { crushSessionId: CRUSH_SESSION_ID },
        },
      }),
    );
    expect(cmd).toBe(`crush --session '${CRUSH_SESSION_ID}'`);
  });

  it("passes the combined prompt to crush run before continuing the session", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-crush-test-"));
    const promptFile = join(dir, "worker-prompt.md");
    writeFileSync(promptFile, "System prompt", "utf-8");

    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        prompt: "Do work",
        systemPromptFile: promptFile,
      }),
    );

    rmSync(dir, { recursive: true, force: true });

    expect(cmd).not.toContain("|");
    expect(cmd).not.toContain("&&");
    expect(cmd).not.toContain("cat ");
    expect(cmd).not.toContain("printf");
    expect(cmd).toBe(
      "crush run --quiet 'System prompt\n\nDo work'; crush --continue",
    );
  });

  it("delivers prompt to a configured crush session before restoring it", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        prompt: "Don'" + "t split this",
        projectConfig: {
          ...makeLaunchConfig().projectConfig,
          agentConfig: { crushSessionId: CRUSH_SESSION_ID },
        },
      }),
    );
    expect(cmd).toBe(
      `crush run --quiet --session '${CRUSH_SESSION_ID}' 'Don'\\''t split this'; crush --session '${CRUSH_SESSION_ID}'`,
    );
  });
});

describe("getEnvironment", () => {
  const agent = create();

  it("writes AO session keys and PATH/GH_PATH", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["AO_SESSION_ID"]).toBe("sess-1");
    expect(env["AO_ISSUE_ID"]).toBeUndefined();
    expect(env["PATH"]).toContain(".ao/bin");
    expect(env["GH_PATH"]).toBeDefined();
  });

  it("includes AO_ISSUE_ID when provided", () => {
    const env = agent.getEnvironment(makeLaunchConfig({ issueId: "INT-42" }));
    expect(env["AO_ISSUE_ID"]).toBe("INT-42");
  });
});

describe("isProcessRunning", () => {
  const agent = create();

  it("returns true when crush is on tmux pane", async () => {
    mockExecFileAsync.mockImplementation((cmd: string, _args: string[]) => {
      if (cmd === "tmux") {
        return Promise.resolve({ stdout: "/dev/ttys003\n", stderr: "" });
      }
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: `  PID TT       ARGS\n  789 ttys003  /Users/me/.npm-global/lib/node_modules/@charmland/crush/bin/crush\n`,
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

  it("short-circuits tmux checks on Windows", async () => {
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

  it("returns true when process handle pid check is denied", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
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

  it("classifies documented permission prompts as waiting_input", async () => {
    await agent.recordActivity?.(
      makeSession(),
      "Crush wants to run: bash\nCommand: npm install lodash\n\nAllow? [y/n/always]",
    );
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(
      classify?.("Crush wants to run: bash\nCommand: npm install lodash\n\nAllow? [y/n/always]"),
    ).toBe("waiting_input");
  });

  it("classifies ansi-colored permission prompts as waiting_input", async () => {
    await agent.recordActivity?.(makeSession(), "\u001b[33mAllow? [y/n/always]\u001b[39m");
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("\u001b[33mAllow? [y/n/always]\u001b[39m")).toBe("waiting_input");
  });

  it("classifies active and blocked output", async () => {
    await agent.recordActivity?.(makeSession(), "Working on your request");
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("Working on your request")).toBe("active");
    expect(classify?.("Request failed")).toBe("blocked");
  });

  it("skips recording when workspacePath is missing", async () => {
    await agent.recordActivity?.(makeSession({ workspacePath: null }), "still running");
    expect(mockRecordTerminalActivity).not.toHaveBeenCalled();
  });
});

describe("getSessionInfo", () => {
  const agent = create();

  it("returns null without session id", async () => {
    expect(await agent.getSessionInfo(makeSession())).toBeNull();
  });

  it("uses crush session meta title as summary", async () => {
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "crush" && args[0] === "session" && args[1] === "show") {
        return Promise.resolve({
          stdout: JSON.stringify({
            meta: {
              id: "abc1234",
              uuid: CRUSH_SESSION_ID,
              title: "Refactor auth module",
            },
            messages: [],
          }),
          stderr: "",
        });
      }
      return Promise.reject(new Error("unexpected"));
    });

    const info = await agent.getSessionInfo(
      makeSession({ metadata: { crushSessionId: "abc1234" } }),
    );
    expect(info).toEqual({
      agentSessionId: CRUSH_SESSION_ID,
      summary: "Refactor auth module",
      summaryIsFallback: false,
      metadata: { crushSessionId: CRUSH_SESSION_ID },
    });
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "crush",
      ["session", "show", "abc1234", "--json"],
      expect.objectContaining({
        shell: false,
        windowsHide: true,
      }),
    );
  });

  it("uses a shell for crush session metadata on Windows", async () => {
    mockIsWindows.mockReturnValue(true);
    mockExecFileAsync.mockResolvedValue({
      stdout: JSON.stringify({
        meta: { uuid: CRUSH_SESSION_ID, title: "Windows metadata" },
        messages: [],
      }),
      stderr: "",
    });

    const info = await agent.getSessionInfo(
      makeSession({ metadata: { crushSessionId: CRUSH_SESSION_ID } }),
    );

    expect(info?.summary).toBe("Windows metadata");
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "crush",
      ["session", "show", CRUSH_SESSION_ID, "--json"],
      expect.objectContaining({
        shell: true,
        windowsHide: true,
      }),
    );
  });

  it("keeps compatibility with legacy top-level session fields", async () => {
    mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "crush" && args[0] === "session" && args[1] === "show") {
        return Promise.resolve({
          stdout: JSON.stringify({
            id: "abc1234",
            uuid: CRUSH_SESSION_ID,
            title: "Refactor auth module",
          }),
          stderr: "",
        });
      }
      return Promise.reject(new Error("unexpected"));
    });

    const info = await agent.getSessionInfo(
      makeSession({ metadata: { crushSessionId: "abc1234" } }),
    );
    expect(info).toMatchObject({
      agentSessionId: CRUSH_SESSION_ID,
      summary: "Refactor auth module",
      metadata: { crushSessionId: CRUSH_SESSION_ID },
    });
  });

  it("treats session metadata lookup as unavailable when command fails", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("timed out"));
    const info = await agent.getSessionInfo(
      makeSession({ metadata: { crushSessionId: CRUSH_SESSION_ID } }),
    );
    expect(info).toMatchObject({
      agentSessionId: CRUSH_SESSION_ID,
      summary: null,
      summaryIsFallback: undefined,
    });
  });
});

describe("getRestoreCommand", () => {
  const agent = create();

  it("builds restore command using the session id only", async () => {
    const cmd = await agent.getRestoreCommand?.(
      makeSession({ metadata: { crushSessionId: CRUSH_SESSION_ID } }),
      {
        name: "my-project",
        repo: "owner/repo",
        path: "/workspace/repo",
        defaultBranch: "main",
        sessionPrefix: "my",
        agentConfig: {},
      },
    );
    expect(cmd).toBe(`crush --session '${CRUSH_SESSION_ID}'`);
  });

  it("returns null without session id", async () => {
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

  it("sets up workspace hooks before launch", async () => {
    await expect(
      agent.setupWorkspaceHooks?.("/workspace/test", { dataDir: "/data" }),
    ).resolves.toBeUndefined();
    expect(mockSetupPathWrapperWorkspace).toHaveBeenCalledWith("/workspace/test");
  });

  it("sets up workspace hooks after launch", async () => {
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
        metadata: { crushSessionId: CRUSH_SESSION_ID },
      }),
    );
    expect(state?.state).toBe("waiting_input");
    killSpy.mockRestore();
  });

  it("returns blocked from recent activity JSONL", async () => {
    const activityAt = new Date();
    mockReadLastActivityEntry.mockResolvedValue(makeActivityResult("blocked", activityAt));
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const state = await agent.getActivityState(
      makeSession({
        runtimeHandle: makeProcessHandle(101),
        metadata: { crushSessionId: CRUSH_SESSION_ID },
      }),
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
      makeSession({
        runtimeHandle: makeProcessHandle(101),
        metadata: { crushSessionId: CRUSH_SESSION_ID },
      }),
    );
    expect(state?.state).toBe("idle");
    expect(state?.timestamp?.toISOString()).toBe(activityAt.toISOString());
    killSpy.mockRestore();
  });

  it("returns null when no JSONL activity data is available", async () => {
    mockReadLastActivityEntry.mockResolvedValue(null);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const state = await agent.getActivityState(
      makeSession({
        runtimeHandle: makeProcessHandle(101),
        metadata: { crushSessionId: CRUSH_SESSION_ID },
      }),
    );
    expect(state).toBeNull();
    killSpy.mockRestore();
  });
});
