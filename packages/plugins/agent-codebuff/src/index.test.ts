import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentLaunchConfig, RuntimeHandle, Session } from "@aoagents/ao-core";
import { EventEmitter } from "node:events";
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
    return new EventEmitter();
  },
}));

import { create, detect, manifest, default as defaultExport } from "./index.js";

const CODEBUFF_CONVERSATION_ID = "chat_1234567890abcdef";

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

function makeSystemPromptFile(content: string): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "ao-codebuff-test-"));
  const file = join(dir, "orchestrator prompt.md");
  writeFileSync(file, content, "utf8");
  return { dir, file };
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
  mockIsWindows.mockReturnValue(false);
});

describe("manifest", () => {
  it("has correct Codebuff manifest", () => {
    expect(manifest).toEqual({
      name: pluginName,
      slot: "agent",
      description: packageJson.description,
      version: packageJson.version,
      displayName: "Codebuff",
    });
  });
});

describe("create", () => {
  it("uses codebuff as process name without a prompt-delivery side channel", () => {
    const agent = create();
    expect(agent.name).toBe(pluginName);
    expect(agent.processName).toBe(pluginName);
    expect((agent as { promptDelivery?: unknown }).promptDelivery).toBeUndefined();
  });

  it("exports plugin module shape", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
    expect(typeof defaultExport.detect).toBe("function");
  });
});

describe("detect", () => {
  it("returns true when which resolves", () => {
    mockWhichSync.mockReturnValue("/usr/local/bin/codebuff");
    expect(detect()).toBe(true);
    expect(mockWhichSync).toHaveBeenCalledWith("codebuff");
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

  it("uses interactive launch without session metadata or prompt", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).toBe("codebuff");
  });

  it("passes the initial prompt as Codebuff's documented positional prompt", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "Fix the bug" }));
    expect(cmd).toBe("codebuff 'Fix the bug'");
  });

  it("combines an inline system prompt and task prompt into Codebuff's positional prompt", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ prompt: "Fix the bug", systemPrompt: "Follow AO instructions" }),
    );
    expect(cmd).toBe("codebuff 'Follow AO instructions\n\nFix the bug'");
  });

  it("combines the system prompt file and task prompt into Codebuff's positional prompt", () => {
    const { dir, file } = makeSystemPromptFile("Follow file instructions");
    try {
      const cmd = agent.getLaunchCommand(
        makeLaunchConfig({ prompt: "Fix the bug", systemPromptFile: file }),
      );
      expect(cmd).toBe("codebuff 'Follow file instructions\n\nFix the bug'");
      expect(cmd).not.toContain("$(");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes the system prompt file as the positional prompt when no task prompt is present", () => {
    const { dir, file } = makeSystemPromptFile("File only instructions");
    try {
      const cmd = agent.getLaunchCommand(makeLaunchConfig({ systemPromptFile: file }));
      expect(cmd).toBe("codebuff 'File only instructions'");
      expect(cmd).not.toContain("$(");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses --continue when configured with a conversation id", () => {
    const baseConfig = makeLaunchConfig();
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        projectConfig: {
          ...baseConfig.projectConfig,
          agentConfig: { codebuffConversationId: CODEBUFF_CONVERSATION_ID },
        },
      }),
    );
    expect(cmd).toBe(`codebuff --continue '${CODEBUFF_CONVERSATION_ID}'`);
  });

  it("uses --continue and still delivers the prompt when both are configured", () => {
    const baseConfig = makeLaunchConfig();
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        prompt: "Continue this task",
        projectConfig: {
          ...baseConfig.projectConfig,
          agentConfig: { codebuffConversationId: CODEBUFF_CONVERSATION_ID },
        },
      }),
    );
    expect(cmd).toBe(`codebuff --continue '${CODEBUFF_CONVERSATION_ID}' 'Continue this task'`);
  });

  it("does not include unsupported prompt flags in launch command", () => {
    const { dir, file } = makeSystemPromptFile("File instructions");
    try {
      const cmd = agent.getLaunchCommand(
        makeLaunchConfig({
          prompt: "Do work",
          systemPrompt: "You are helpful",
          systemPromptFile: file,
        }),
      );
      expect(cmd).toBe("codebuff 'File instructions\n\nDo work'");
      expect(cmd).not.toContain("-p");
      expect(cmd).not.toContain("--prompt");
      expect(cmd).not.toContain("$(");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("getEnvironment", () => {
  const agent = create();

  it("writes only AO session keys", () => {
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

  it("short-circuits tmux liveness checks on Windows", async () => {
    mockIsWindows.mockReturnValue(true);

    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it("returns true when codebuff is on a tmux pane", async () => {
    mockExecFileAsync.mockImplementation((cmd: string) => {
      if (cmd === "tmux") return Promise.resolve({ stdout: "/dev/ttys003\n", stderr: "" });
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: "  PID TT       ARGS\n  789 ttys003  codebuff\n",
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

  it("returns true when process handle pid is alive", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(await agent.isProcessRunning(makeProcessHandle(123))).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(123, 0);
    killSpy.mockRestore();
  });

  it("treats EPERM from process handles as running", async () => {
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

  it("classifies Codebuff input prompts as waiting_input", async () => {
    await agent.recordActivity?.(makeSession(), "Enter a coding task or / for commands");
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("Enter a coding task or / for commands")).toBe("waiting_input");
  });

  it("classifies confirmation prompts as waiting_input", async () => {
    await agent.recordActivity?.(makeSession(), "Run command npm test? [y/n]:");
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("Run command npm test? [y/n]:")).toBe("waiting_input");
  });

  it("classifies error output as blocked", async () => {
    await agent.recordActivity?.(makeSession(), "Unhandled exception");
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("Unhandled exception")).toBe("blocked");
  });

  it("skips recording when workspacePath is missing", async () => {
    await agent.recordActivity?.(
      makeSession({ workspacePath: null }),
      "Enter a coding task or / for commands",
    );
    expect(mockRecordTerminalActivity).not.toHaveBeenCalled();
  });
});

describe("getActivityState", () => {
  const agent = create();

  it("falls back to exited when runtime handle is missing", async () => {
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

  it("returns null without a Codebuff conversation id", async () => {
    expect(await agent.getSessionInfo(makeSession())).toBeNull();
  });

  it("returns the known Codebuff conversation id without summary metadata", async () => {
    const info = await agent.getSessionInfo(
      makeSession({ metadata: { codebuffConversationId: CODEBUFF_CONVERSATION_ID } }),
    );
    expect(info).toEqual({
      agentSessionId: CODEBUFF_CONVERSATION_ID,
      summary: null,
    });
  });
});

describe("getRestoreCommand", () => {
  const agent = create();

  it("returns null without a Codebuff conversation id", async () => {
    const cmd = await agent.getRestoreCommand?.(makeSession(), makeLaunchConfig().projectConfig);
    expect(cmd).toBeNull();
  });

  it("builds restore command using the conversation id only", async () => {
    const cmd = await agent.getRestoreCommand?.(
      makeSession({ metadata: { codebuffConversationId: CODEBUFF_CONVERSATION_ID } }),
      makeLaunchConfig().projectConfig,
    );
    expect(cmd).toBe(`codebuff --continue '${CODEBUFF_CONVERSATION_ID}'`);
  });
});

describe("workspace setup", () => {
  const agent = create();

  it("sets up workspace hooks before launch", async () => {
    await expect(
      agent.setupWorkspaceHooks?.("/workspace/test", { dataDir: "/data", sessionId: "sess-1" }),
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
