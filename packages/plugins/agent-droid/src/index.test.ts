import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Session, RuntimeHandle, AgentLaunchConfig } from "@aoagents/ao-core";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
    return new EventEmitter();
  },
}));

import { create, detect, manifest, default as defaultExport } from "./index.js";

const VALID_DROID_SESSION_ID = "00893aaf-19fa-41d2-8238-13269b9b3ca0";

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

let tmpDirs: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  mockWhichSync.mockReset();
  mockExecFileAsync.mockReset();
  mockReadLastActivityEntry.mockResolvedValue(null);
});

afterEach(async () => {
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe("manifest", () => {
  it("has correct Droid manifest", () => {
    expect(manifest).toEqual({
      name: pluginName,
      slot: "agent",
      description: packageJson.description,
      version: packageJson.version,
      displayName: "Droid",
    });
  });
});

describe("create", () => {
  it("uses droid as process name and post-launch prompt mode", () => {
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
    mockWhichSync.mockReturnValue("/usr/local/bin/droid");
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

  it("uses interactive launch without workspace metadata", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).toBe("droid");
  });

  it("uses workspace settings when a workspace path is present", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ workspacePath: "/workspace/test" }));
    expect(cmd).toBe("droid --settings '/workspace/test/.ao/droid/settings.json'");
  });

  it("uses --resume when configured with a droid session id", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        workspacePath: "/workspace/test",
        projectConfig: {
          ...makeLaunchConfig().projectConfig,
          agentConfig: { droidSessionId: VALID_DROID_SESSION_ID },
        },
      }),
    );
    expect(cmd).toBe(
      `droid --settings '/workspace/test/.ao/droid/settings.json' --resume '${VALID_DROID_SESSION_ID}'`,
    );
  });

  it("passes supported model, permission, and system-prompt flags", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        workspacePath: "/workspace/test",
        model: "gpt-5.5",
        permissions: "auto-edit",
        systemPromptFile: "/tmp/system prompt.md",
      }),
    );
    expect(cmd).toBe(
      "droid --settings '/workspace/test/.ao/droid/settings.json' --model 'gpt-5.5' --auto 'low' --append-system-prompt-file '/tmp/system prompt.md'",
    );
  });

  it("maps permissionless mode to Droid's unsafe skip flag", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        permissions: "permissionless",
      }),
    );
    expect(cmd).toBe("droid --skip-permissions-unsafe");
  });

  it("does not include user prompt flags in launch command", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        prompt: "Do work",
        systemPrompt: "You are helpful",
      }),
    );
    expect(cmd).toBe("droid --append-system-prompt 'You are helpful'");
    expect(cmd).not.toContain("Do work");
  });
});

describe("getEnvironment", () => {
  const agent = create();

  it("writes AO session keys and agent path", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["AO_SESSION_ID"]).toBe("sess-1");
    expect(env["AO_ISSUE_ID"]).toBeUndefined();
    expect(env["PATH"]).toContain(".ao/bin");
    expect(env["GH_PATH"]).toBeTruthy();
  });

  it("includes AO_ISSUE_ID when provided", () => {
    const env = agent.getEnvironment(makeLaunchConfig({ issueId: "INT-42" }));
    expect(env["AO_ISSUE_ID"]).toBe("INT-42");
  });
});

describe("isProcessRunning", () => {
  const agent = create();

  it("returns true when droid is on tmux pane", async () => {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") {
        return Promise.resolve({ stdout: "/dev/ttys003\n", stderr: "" });
      }
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: `  PID TT       ARGS\n  789 ttys003  droid --settings /tmp/settings.json\n`,
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

  it("returns true when process handle pid is alive", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(await agent.isProcessRunning(makeProcessHandle(123))).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(123, 0);
    killSpy.mockRestore();
  });

  it("treats EPERM as a live process handle", async () => {
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
    await agent.recordActivity?.(
      makeSession(),
      '│ > Try "Review the changes in my current branch" │',
    );
    expect(mockRecordTerminalActivity).toHaveBeenCalledWith(
      "/workspace/test",
      '│ > Try "Review the changes in my current branch" │',
      expect.any(Function),
    );
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.('│ > Try "Review the changes in my current branch" │')).toBe("idle");
  });

  it("classifies active terminal output when recording activity", async () => {
    await agent.recordActivity?.(makeSession(), "⠁ Streaming...  (Press ESC to stop)");
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("⠁ Streaming...  (Press ESC to stop)")).toBe("active");
  });

  it("classifies ready terminal output when recording activity", async () => {
    await agent.recordActivity?.(makeSession(), "Task completed successfully");
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("Task completed successfully")).toBe("ready");
  });

  it("classifies waiting_input terminal output when recording activity", async () => {
    await agent.recordActivity?.(makeSession(), "Droid needs your permission to use Execute");
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("Droid needs your permission to use Execute")).toBe("waiting_input");
  });

  it("classifies ansi-colored permission prompts as waiting_input", async () => {
    await agent.recordActivity?.(makeSession(), "\u001b[33mAllow tool use?\u001b[39m [y/N]");
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("\u001b[33mAllow tool use?\u001b[39m [y/N]")).toBe("waiting_input");
  });

  it("classifies blocked terminal output when recording activity", async () => {
    await agent.recordActivity?.(makeSession(), "Not authenticated. Create an API key.");
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("Not authenticated. Create an API key.")).toBe("blocked");
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
      }),
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
      makeSession({
        runtimeHandle: makeProcessHandle(101),
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
      }),
    );
    expect(state).toBeNull();
    killSpy.mockRestore();
  });
});

describe("getSessionInfo", () => {
  const agent = create();

  it("returns null without droid session id", async () => {
    expect(await agent.getSessionInfo(makeSession())).toBeNull();
  });

  it("returns persisted Droid session metadata", async () => {
    const info = await agent.getSessionInfo(
      makeSession({
        metadata: {
          droidSessionId: VALID_DROID_SESSION_ID,
          droidTranscriptPath: "/Users/me/.factory/projects/session.jsonl",
        },
      }),
    );
    expect(info).toEqual({
      agentSessionId: VALID_DROID_SESSION_ID,
      summary: null,
      metadata: {
        droidSessionId: VALID_DROID_SESSION_ID,
        droidTranscriptPath: "/Users/me/.factory/projects/session.jsonl",
      },
    });
  });

  it("returns null for invalid Droid session metadata", async () => {
    expect(
      await agent.getSessionInfo(makeSession({ metadata: { droidSessionId: "bad id" } })),
    ).toBeNull();
  });
});

describe("getRestoreCommand", () => {
  const agent = create();

  it("builds restore command using the session id and workspace settings", async () => {
    const cmd = await agent.getRestoreCommand?.(
      makeSession({ metadata: { droidSessionId: VALID_DROID_SESSION_ID } }),
      {
        name: "my-project",
        repo: "owner/repo",
        path: "/workspace/repo",
        defaultBranch: "main",
        sessionPrefix: "my",
      },
    );
    expect(cmd).toBe(
      `droid --settings '/workspace/test/.ao/droid/settings.json' --resume '${VALID_DROID_SESSION_ID}'`,
    );
  });

  it("returns null without a valid session id", async () => {
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

describe("preLaunchSetup", () => {
  const agent = create();

  it("writes Droid settings before restore launch", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ao-droid-plugin-"));
    tmpDirs.push(workspace);

    await agent.preLaunchSetup?.(workspace);

    const settingsPath = join(workspace, ".ao/droid/settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain(
      join(workspace, ".ao/droid/session-hook.cjs"),
    );
    expect(mockSetupPathWrapperWorkspace).not.toHaveBeenCalled();
  });
});

describe("setupWorkspaceHooks", () => {
  const agent = create();

  it("installs PATH wrappers and Droid settings hook", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ao-droid-plugin-"));
    tmpDirs.push(workspace);

    await agent.setupWorkspaceHooks?.(workspace, { dataDir: "/tmp/sessions" });

    expect(mockSetupPathWrapperWorkspace).toHaveBeenCalledWith(workspace);
    const settingsPath = join(workspace, ".ao/droid/settings.json");
    const hookPath = join(workspace, ".ao/droid/session-hook.cjs");
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain(hookPath);
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toContain(hookPath);
    expect(await readFile(hookPath, "utf8")).toContain("metadata.droidSessionId = droidSessionId");
  });
});

describe("postLaunchSetup", () => {
  const agent = create();

  it("sets up workspace hooks when workspacePath is present", async () => {
    await expect(agent.postLaunchSetup?.(makeSession())).resolves.toBeUndefined();
    expect(mockSetupPathWrapperWorkspace).toHaveBeenCalledWith("/workspace/test");
  });

  it("does nothing without workspacePath", async () => {
    await expect(
      agent.postLaunchSetup?.(makeSession({ workspacePath: null })),
    ).resolves.toBeUndefined();
    expect(mockSetupPathWrapperWorkspace).not.toHaveBeenCalled();
  });
});
