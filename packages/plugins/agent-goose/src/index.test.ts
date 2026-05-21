import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Session, RuntimeHandle, AgentLaunchConfig, ProjectConfig } from "@aoagents/ao-core";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

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
  mockSpawnAsync,
  mockIsWindows,
} = vi.hoisted(() => ({
  mockReadLastActivityEntry: vi.fn().mockResolvedValue(null),
  mockRecordTerminalActivity: vi.fn().mockResolvedValue(undefined),
  mockSetupPathWrapperWorkspace: vi.fn().mockResolvedValue(undefined),
  mockExecFileAsync: vi.fn(),
  mockExecFileSync: vi.fn(),
  mockSpawnAsync: vi.fn(),
  mockIsWindows: vi.fn().mockReturnValue(false),
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
  spawn: (...args: unknown[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();

    const result = mockSpawnAsync(...args);
    if (result && typeof result.then === "function") {
      result.then(
        (value: { stdout: string; stderr: string }) => {
          queueMicrotask(() => {
            if (value.stdout) child.stdout.write(value.stdout);
            child.stdout.end();
            if (value.stderr) child.stderr.write(value.stderr);
            child.stderr.end();
            child.emit("close", 0, null);
          });
        },
        (
          err: Error & { stdout?: string; stderr?: string; code?: number; signal?: NodeJS.Signals },
        ) => {
          queueMicrotask(() => {
            if (err.stdout) child.stdout.write(err.stdout);
            child.stdout.end();
            if (err.stderr) child.stderr.write(err.stderr);
            child.stderr.end();
            child.emit("close", err.code ?? 1, err.signal ?? null);
          });
        },
      );
    }

    return child;
  },
}));

import { create, detect, manifest, default as defaultExport } from "./index.js";

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

function makeProjectConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    name: "my-project",
    repo: "owner/repo",
    path: "/workspace/repo",
    defaultBranch: "main",
    sessionPrefix: "my",
    agentConfig: {
      model: "provider/gpt-4o-mini",
    },
    ...overrides,
  };
}

function makeLaunchConfig(overrides: Partial<AgentLaunchConfig> = {}): AgentLaunchConfig {
  return {
    sessionId: "sess-1",
    projectConfig: makeProjectConfig(),
    ...overrides,
  };
}

function makeSystemPromptFile(content: string): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "ao-goose-test-"));
  const file = join(dir, "system prompt.md");
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

function makeGooseSessionExport({
  id = "20260510_34",
  name = "test-1",
}: {
  id?: string;
  name?: string;
} = {}): string {
  return JSON.stringify({
    id,
    working_dir: "/workspace/test",
    name,
    user_set_name: true,
    total_tokens: 123,
    input_tokens: 100,
    output_tokens: 23,
    provider_name: "litellm",
    model_config: { model_name: "gpt-5.5" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExecFileSync.mockReset();
  mockSpawnAsync.mockReset();
  mockIsWindows.mockReset();
  mockIsWindows.mockReturnValue(false);
});

describe("manifest", () => {
  it("has correct Goose manifest", () => {
    expect(manifest).toEqual({
      name: pluginName,
      slot: "agent",
      description: packageJson.description,
      version: packageJson.version,
      displayName: "Goose",
    });
  });
});

describe("create", () => {
  it("uses goose as process name and default inline prompt mode", () => {
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
  it("returns true when goose version command succeeds", async () => {
    expect(detect()).toBe(true);
    expect(mockExecFileSync).toHaveBeenCalledWith("goose", ["--version"], {
      stdio: "ignore",
      shell: false,
      windowsHide: true,
    });
  });

  it("uses a shell on Windows so .cmd shims resolve", async () => {
    mockIsWindows.mockReturnValue(true);
    expect(detect()).toBe(true);
    expect(mockExecFileSync).toHaveBeenCalledWith("goose", ["--version"], {
      stdio: "ignore",
      shell: true,
      windowsHide: true,
    });
  });

  it("returns false when goose version command fails", async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("not found");
    });
    expect(detect()).toBe(false);
  });
});

describe("getLaunchCommand", () => {
  const agent = create();

  it("starts an interactive named Goose run with empty text when no prompt is present", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig());
    expect(cmd).toBe("goose run --name 'sess-1' --text '' --interactive");
  });

  it("shell-escapes the Goose session name and inline prompt", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({ sessionId: "sess with spaces", prompt: "fix Bob's bug" }),
    );
    expect(cmd).toBe(
      String.raw`goose run --name 'sess with spaces' --text 'fix Bob'\''s bug' --interactive`,
    );
  });

  it("passes short system prompt text via documented --system flag", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        prompt: "Do work",
        systemPrompt: "You are helpful",
      }),
    );
    expect(cmd).toBe(
      "goose run --name 'sess-1' --system 'You are helpful' --text 'Do work' --interactive",
    );
  });

  it("reads system prompt files in Node and passes the content via --system", () => {
    const { dir, file } = makeSystemPromptFile("Follow file instructions");
    try {
      const cmd = agent.getLaunchCommand(
        makeLaunchConfig({
          prompt: "Do work",
          systemPrompt: "You are helpful",
          systemPromptFile: file,
        }),
      );
      expect(cmd).toBe(
        "goose run --name 'sess-1' --system 'Follow file instructions' --text 'Do work' --interactive",
      );
      expect(cmd).not.toContain("$(");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not include unsupported session-id or prompt-only flags in launch command", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "Do work" }));
    expect(cmd).not.toContain("-p");
    expect(cmd).not.toContain("--prompt");
    expect(cmd).not.toContain("--session-id");
  });
});

describe("getEnvironment", () => {
  const agent = create();

  it("writes AO session keys and Goose PATH support", () => {
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

  it("returns false without POSIX tmux checks on Windows", async () => {
    mockIsWindows.mockReturnValue(true);

    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it("returns true when goose is on tmux pane", async () => {
    mockExecFileAsync.mockImplementation((cmd: string, _args: string[]) => {
      if (cmd === "tmux") {
        return Promise.resolve({ stdout: "/dev/ttys003\n", stderr: "" });
      }
      if (cmd === "ps") {
        return Promise.resolve({
          stdout: `  PID TT       ARGS\n  789 ttys003  goose session --name test-1\n`,
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

  it("treats EPERM as a running process", async () => {
    const eperm = Object.assign(new Error("EPERM"), { code: "EPERM" });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw eperm;
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

  it("classifies Goose prompt output as idle when recording activity", async () => {
    await agent.recordActivity?.(makeSession(), "goose is ready\n🪿 ");
    expect(mockRecordTerminalActivity).toHaveBeenCalledWith(
      "/workspace/test",
      "goose is ready\n🪿 ",
      expect.any(Function),
    );
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("goose is ready\n🪿 ")).toBe("idle");
  });

  it("classifies active terminal output when recording activity", async () => {
    await agent.recordActivity?.(makeSession(), "Running shell command");
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("Running shell command")).toBe("active");
  });

  it("classifies waiting_input terminal output when recording activity", async () => {
    await agent.recordActivity?.(makeSession(), "Do you want to proceed? [y/N]");
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("Do you want to proceed? [y/N]")).toBe("waiting_input");
  });

  it("classifies blocked terminal output when recording activity", async () => {
    await agent.recordActivity?.(makeSession(), "Error: provider failed");
    const classify = mockRecordTerminalActivity.mock.calls[0]?.[2] as
      | ((output: string) => string)
      | undefined;
    expect(classify?.("Error: provider failed")).toBe("blocked");
  });

  it("skips recording when workspacePath is missing", async () => {
    await agent.recordActivity?.(makeSession({ workspacePath: null }), "still running");
    expect(mockRecordTerminalActivity).not.toHaveBeenCalled();
  });
});

describe("getSessionInfo", () => {
  const agent = create();

  it("returns Goose session id and no synthetic summary for AO-named sessions", async () => {
    mockSpawnAsync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "session" && args[1] === "export") {
        return Promise.resolve({
          stdout: makeGooseSessionExport({ id: "20260510_34", name: "test-1" }),
          stderr: "",
        });
      }
      return Promise.reject(new Error("unexpected"));
    });

    const info = await agent.getSessionInfo(makeSession({ id: "test-1" }));
    expect(info).toEqual({
      agentSessionId: "20260510_34",
      summary: null,
      summaryIsFallback: undefined,
    });
    expect(mockSpawnAsync).toHaveBeenCalledWith(
      "goose",
      ["session", "export", "--name", "test-1", "--format", "json"],
      expect.objectContaining({
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }),
    );
  });

  it("uses shell spawning for Goose metadata commands on Windows", async () => {
    mockIsWindows.mockReturnValue(true);
    mockSpawnAsync.mockResolvedValue({
      stdout: makeGooseSessionExport({ id: "20260510_36", name: "test-1" }),
      stderr: "",
    });

    await expect(agent.getSessionInfo(makeSession({ id: "test-1" }))).resolves.toMatchObject({
      agentSessionId: "20260510_36",
    });
    expect(mockSpawnAsync).toHaveBeenCalledWith(
      "goose",
      ["session", "export", "--name", "test-1", "--format", "json"],
      expect.objectContaining({
        shell: true,
        windowsHide: true,
      }),
    );
  });

  it("uses a generated Goose name as a real summary when present", async () => {
    mockSpawnAsync.mockResolvedValue({
      stdout: makeGooseSessionExport({ id: "20260510_35", name: "Fix flaky tests" }),
      stderr: "",
    });
    const info = await agent.getSessionInfo(makeSession({ id: "test-1" }));
    expect(info).toMatchObject({
      agentSessionId: "20260510_35",
      summary: "Fix flaky tests",
      summaryIsFallback: false,
    });
  });

  it("returns null when Goose metadata is unavailable", async () => {
    mockSpawnAsync.mockRejectedValue(Object.assign(new Error("no session"), { code: 1 }));
    expect(await agent.getSessionInfo(makeSession())).toBeNull();
  });
});

describe("getRestoreCommand", () => {
  const agent = create();

  it("builds restore command using the AO session name when Goose metadata exists", async () => {
    mockSpawnAsync.mockResolvedValue({
      stdout: makeGooseSessionExport({ id: "20260510_34", name: "test-1" }),
      stderr: "",
    });
    const cmd = await agent.getRestoreCommand?.(makeSession({ id: "test-1" }), makeProjectConfig());
    expect(cmd).toBe("goose run --resume --name 'test-1' --text '' --interactive");
  });

  it("returns null without a session id", async () => {
    const cmd = await agent.getRestoreCommand?.(makeSession({ id: "" }), makeProjectConfig());
    expect(cmd).toBeNull();
  });

  it("returns null when Goose metadata is unavailable", async () => {
    mockSpawnAsync.mockRejectedValue(Object.assign(new Error("no session"), { code: 1 }));
    const cmd = await agent.getRestoreCommand?.(makeSession({ id: "test-1" }), makeProjectConfig());
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

describe("setupWorkspaceHooks", () => {
  const agent = create();

  it("sets up path wrapper workspace hooks", async () => {
    await expect(
      agent.setupWorkspaceHooks?.("/workspace/test", { dataDir: "/data", sessionId: "test-1" }),
    ).resolves.toBeUndefined();
    expect(mockSetupPathWrapperWorkspace).toHaveBeenCalledWith("/workspace/test");
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

  it("returns null when no reliable activity data is available", async () => {
    mockReadLastActivityEntry.mockResolvedValue(null);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const state = await agent.getActivityState(
      makeSession({
        runtimeHandle: makeProcessHandle(101),
      }),
    );
    expect(state).toBeNull();
    expect(mockSpawnAsync).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });
});
