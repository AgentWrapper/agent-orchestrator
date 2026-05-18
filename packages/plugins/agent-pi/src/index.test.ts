import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createActivitySignal,
  type Session,
  type RuntimeHandle,
  type AgentLaunchConfig,
} from "@aoagents/ao-core";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const {
  mockExecFileAsync,
  mockReaddir,
  mockStat,
  mockCreateReadStream,
  mockHomedir,
  mockReadLastJsonlEntry,
  mockReadLastActivityEntry,
} = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
  mockReaddir: vi.fn(),
  mockStat: vi.fn(),
  mockCreateReadStream: vi.fn(),
  mockHomedir: vi.fn(() => "/mock/home"),
  mockReadLastJsonlEntry: vi.fn(),
  mockReadLastActivityEntry: vi.fn(),
}));

vi.mock("node:child_process", () => {
  const fn = Object.assign((..._args: unknown[]) => {}, {
    [Symbol.for("nodejs.util.promisify.custom")]: mockExecFileAsync,
  });
  return { execFile: fn, execFileSync: vi.fn() };
});

vi.mock("node:fs/promises", () => ({
  readdir: mockReaddir,
  stat: mockStat,
}));

vi.mock("node:fs", () => ({
  createReadStream: mockCreateReadStream,
}));

vi.mock("node:os", () => ({
  homedir: mockHomedir,
}));

vi.mock("@aoagents/ao-core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    readLastJsonlEntry: mockReadLastJsonlEntry,
    readLastActivityEntry: mockReadLastActivityEntry,
  };
});

import { Readable } from "node:stream";
import {
  create,
  manifest,
  default as defaultExport,
  _resetSessionFileCache,
} from "./index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
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
    },
    ...overrides,
  };
}

function mockTmuxWithProcess(processName: string, found = true) {
  mockExecFileAsync.mockImplementation((cmd: string, args: string[]) => {
    if (cmd === "tmux" && args[0] === "list-panes") {
      return Promise.resolve({ stdout: "/dev/ttys003\n", stderr: "" });
    }
    if (cmd === "ps") {
      const line = found ? `  789 ttys003  ${processName}` : "  789 ttys003  bash";
      return Promise.resolve({
        stdout: `  PID TT       ARGS\n${line}\n`,
        stderr: "",
      });
    }
    return Promise.reject(new Error(`Unexpected: ${cmd} ${args.join(" ")}`));
  });
}

function makeContentStream(content: string): Readable {
  return Readable.from(Buffer.from(content, "utf-8"));
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetSessionFileCache();
  mockHomedir.mockReturnValue("/mock/home");
  // Default: no session subdirs, no JSONL entries
  mockReaddir.mockResolvedValue([]);
  mockStat.mockRejectedValue(new Error("ENOENT"));
  mockCreateReadStream.mockReturnValue(makeContentStream(""));
  mockReadLastJsonlEntry.mockResolvedValue(null);
  mockReadLastActivityEntry.mockResolvedValue(null);
});

// =========================================================================
// Manifest & Exports
// =========================================================================
describe("plugin manifest & exports", () => {
  it("has correct manifest", () => {
    expect(manifest).toEqual({
      name: "pi",
      slot: "agent",
      description: "Agent plugin: pi.dev coding agent",
      version: "0.1.0",
      displayName: "Pi",
    });
  });

  it("create() returns agent with correct name and processName", () => {
    const agent = create();
    expect(agent.name).toBe("pi");
    expect(agent.processName).toBe("pi");
    expect(agent.promptDelivery).toBe("post-launch");
  });

  it("default export is a valid PluginModule", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
    expect(typeof defaultExport.detect).toBe("function");
  });
});

// =========================================================================
// getLaunchCommand
// =========================================================================
describe("getLaunchCommand", () => {
  const agent = create();

  it("returns shell-escaped pi binary", () => {
    expect(agent.getLaunchCommand(makeLaunchConfig())).toBe("'pi'");
  });

  it("ignores prompt — pi gets it via post-launch sendMessage", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "Fix bug" }));
    expect(cmd).toBe("'pi'");
  });
});

// =========================================================================
// getEnvironment
// =========================================================================
describe("getEnvironment", () => {
  const agent = create();

  it("sets AO_SESSION_ID", () => {
    const env = agent.getEnvironment(makeLaunchConfig({ sessionId: "abc" }));
    expect(env["AO_SESSION_ID"]).toBe("abc");
  });

  it("sets AO_ISSUE_ID when provided", () => {
    const env = agent.getEnvironment(makeLaunchConfig({ sessionId: "abc", issueId: "ISSUE-1" }));
    expect(env["AO_ISSUE_ID"]).toBe("ISSUE-1");
  });

  it("omits AO_ISSUE_ID when not provided", () => {
    const env = agent.getEnvironment(makeLaunchConfig({ sessionId: "abc" }));
    expect(env["AO_ISSUE_ID"]).toBeUndefined();
  });
});

// =========================================================================
// detectActivity
// =========================================================================
describe("detectActivity", () => {
  const agent = create();

  it("returns idle on empty output", () => {
    expect(agent.detectActivity("")).toBe("idle");
  });

  it("returns idle on prompt char", () => {
    expect(agent.detectActivity("> ")).toBe("idle");
  });

  it("returns waiting_input on (y)es/(n)o", () => {
    expect(agent.detectActivity("Apply this change?\n(Y)es / (N)o")).toBe("waiting_input");
  });

  it("returns waiting_input on approval prompt", () => {
    expect(agent.detectActivity("approval required: write /etc/hosts")).toBe("waiting_input");
  });

  it("returns blocked on auth error", () => {
    expect(agent.detectActivity("authentication failed: invalid api key")).toBe("blocked");
  });

  it("returns active by default", () => {
    expect(agent.detectActivity("Thinking...")).toBe("active");
  });
});

// =========================================================================
// isProcessRunning
// =========================================================================
describe("isProcessRunning", () => {
  const agent = create();

  it("returns true when tmux pane runs pi", async () => {
    mockTmuxWithProcess("pi");
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("returns true when tmux pane runs .pi (npm dot-prefixed)", async () => {
    mockTmuxWithProcess("/usr/local/bin/.pi --foo");
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("returns false when no matching process in tmux pane", async () => {
    mockTmuxWithProcess("pi", false);
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("returns true for live PID via process runtime", async () => {
    const realKill = process.kill;
    const killSpy = vi.spyOn(process, "kill").mockImplementation((_pid: number, _sig?: NodeJS.Signals | number) => true);
    try {
      expect(await agent.isProcessRunning(makeProcessHandle(1234))).toBe(true);
    } finally {
      killSpy.mockRestore();
      void realKill;
    }
  });

  it("returns false for dead PID via process runtime", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    try {
      expect(await agent.isProcessRunning(makeProcessHandle(1234))).toBe(false);
    } finally {
      killSpy.mockRestore();
    }
  });
});

// =========================================================================
// getActivityState — the 7 required scenarios
// =========================================================================
describe("getActivityState", () => {
  const agent = create();

  it("1. returns exited when process is not running", async () => {
    mockTmuxWithProcess("pi", false);
    const state = await agent.getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle() }),
    );
    expect(state?.state).toBe("exited");
  });

  it("2. returns waiting_input from AO activity JSONL", async () => {
    mockTmuxWithProcess("pi");
    const now = new Date();
    mockReadLastActivityEntry.mockResolvedValue({
      entry: { state: "waiting_input", ts: now.toISOString() },
      modifiedAt: now,
    });
    const state = await agent.getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle() }),
    );
    expect(state?.state).toBe("waiting_input");
  });

  it("3. returns blocked from AO activity JSONL", async () => {
    mockTmuxWithProcess("pi");
    const now = new Date();
    mockReadLastActivityEntry.mockResolvedValue({
      entry: { state: "blocked", ts: now.toISOString() },
      modifiedAt: now,
    });
    const state = await agent.getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle() }),
    );
    expect(state?.state).toBe("blocked");
  });

  it("4. returns active from native pi JSONL when entry is fresh", async () => {
    mockTmuxWithProcess("pi");
    // Make findPiSessionFile resolve to a path: simulate matching subdir
    mockReaddir.mockImplementation(async (path: string) => {
      if (path === "/mock/home/.pi/agent/sessions/-workspace-test") {
        return ["12345_abc.jsonl"] as unknown as string[];
      }
      return [] as unknown as string[];
    });
    mockStat.mockResolvedValue({ mtimeMs: Date.now(), mtime: new Date() });
    const fresh = new Date();
    mockReadLastJsonlEntry.mockResolvedValue({
      modifiedAt: fresh,
      lastType: "agent_message",
    });
    const state = await agent.getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle() }),
    );
    expect(state?.state).toBe("active");
  });

  it("5. returns idle from native pi JSONL when entry is old", async () => {
    mockTmuxWithProcess("pi");
    mockReaddir.mockImplementation(async (path: string) => {
      if (path === "/mock/home/.pi/agent/sessions/-workspace-test") {
        return ["12345_abc.jsonl"] as unknown as string[];
      }
      return [] as unknown as string[];
    });
    mockStat.mockResolvedValue({ mtimeMs: Date.now() - 10 * 60_000, mtime: new Date() });
    const old = new Date(Date.now() - 10 * 60_000); // 10min old
    mockReadLastJsonlEntry.mockResolvedValue({
      modifiedAt: old,
      lastType: "agent_message",
    });
    const state = await agent.getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle() }),
    );
    expect(state?.state).toBe("idle");
  });

  it("6. returns ready from native pi JSONL when entry is mid-aged", async () => {
    mockTmuxWithProcess("pi");
    mockReaddir.mockImplementation(async (path: string) => {
      if (path === "/mock/home/.pi/agent/sessions/-workspace-test") {
        return ["12345_abc.jsonl"] as unknown as string[];
      }
      return [] as unknown as string[];
    });
    mockStat.mockResolvedValue({ mtimeMs: Date.now() - 90_000, mtime: new Date() });
    const mid = new Date(Date.now() - 90_000); // 90s old
    mockReadLastJsonlEntry.mockResolvedValue({
      modifiedAt: mid,
      lastType: "agent_message",
    });
    const state = await agent.getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle() }),
    );
    expect(state?.state).toBe("ready");
  });

  it("7. returns null when no signal at all (no JSONL, no activity log)", async () => {
    mockTmuxWithProcess("pi");
    // readdir returns nothing; readLastJsonlEntry/readLastActivityEntry return null
    const state = await agent.getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle() }),
    );
    expect(state).toBeNull();
  });
});
