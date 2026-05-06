import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createActivitySignal,
  type Session,
  type RuntimeHandle,
  type AgentLaunchConfig,
  type ProjectConfig,
} from "@aoagents/ao-core";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  utimesSync,
  symlinkSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Mock homedir() so kimiShareDir() points at a per-test temp dir.
// fakeHome is assigned in beforeEach.
// ---------------------------------------------------------------------------
let fakeHome = "";
vi.mock("node:os", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    homedir: () => fakeHome,
  };
});

// ---------------------------------------------------------------------------
// Core activity-log mocks — only the shared helpers, not fs primitives.
// ---------------------------------------------------------------------------
const { mockReadLastActivityEntry, mockRecordTerminalActivity, mockSetupPathWrapperWorkspace } =
  vi.hoisted(() => ({
    mockReadLastActivityEntry: vi.fn().mockResolvedValue(null),
    mockRecordTerminalActivity: vi.fn().mockResolvedValue(undefined),
    mockSetupPathWrapperWorkspace: vi.fn().mockResolvedValue(undefined),
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

// ---------------------------------------------------------------------------
// child_process mocks — tmux/ps for isProcessRunning, execFileSync for detect.
// ---------------------------------------------------------------------------
const { mockExecFileAsync } = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
}));

vi.mock("node:child_process", () => {
  const execFile = Object.assign((..._args: unknown[]) => {}, {
    [Symbol.for("nodejs.util.promisify.custom")]: mockExecFileAsync,
  });
  return {
    execFile,
    execFileSync: vi.fn(),
  };
});

import {
  create,
  manifest,
  default as defaultExport,
  detect,
  _resetSessionMatchCache,
} from "./index.js";

// ---------------------------------------------------------------------------
// Kimi on-disk layout helpers — mirrors the real kimi-cli 1.38 storage
// (~/.kimi/sessions/<md5(cwd)>/<session-uuid>/{context,wire}.jsonl).
// ---------------------------------------------------------------------------
function workspaceHash(workspacePath: string): string {
  return createHash("md5").update(workspacePath).digest("hex");
}

function writeKimiSession(
  workspacePath: string,
  sessionId: string,
  opts: { contextAgeMs?: number; wireAgeMs?: number; wireContent?: string } = {},
): string {
  const bucket = join(fakeHome, ".kimi", "sessions", workspaceHash(workspacePath));
  const sessionDir = join(bucket, sessionId);
  mkdirSync(sessionDir, { recursive: true });

  const contextPath = join(sessionDir, "context.jsonl");
  const wirePath = join(sessionDir, "wire.jsonl");
  writeFileSync(contextPath, '{"role":"_system_prompt","content":"hello"}\n');
  writeFileSync(
    wirePath,
    opts.wireContent ??
      [
        '{"type":"metadata","protocol_version":"1.9"}',
        '{"timestamp":1776875930,"message":{"type":"TurnBegin","payload":{"user_input":"say hello"}}}',
        '{"timestamp":1776875931,"message":{"type":"TurnEnd","payload":{}}}',
      ].join("\n") + "\n",
  );

  if (opts.contextAgeMs !== undefined) {
    const ts = new Date(Date.now() - opts.contextAgeMs);
    utimesSync(contextPath, ts, ts);
  }
  if (opts.wireAgeMs !== undefined) {
    const ts = new Date(Date.now() - opts.wireAgeMs);
    utimesSync(wirePath, ts, ts);
  }
  return sessionDir;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
function makeSession(overrides: Partial<Session> = {}): Session {
  // Minimal Session stub; the plugin never reads `lifecycle`.
  const base = {
    id: "kimi-1",
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
  return base as unknown as Session;
}

function makeTmuxHandle(id = "test-session"): RuntimeHandle {
  return { id, runtimeName: "tmux", data: {} };
}

function makeProcessHandle(pid?: number): RuntimeHandle {
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

function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    name: "proj",
    repo: "o/r",
    path: "/p",
    defaultBranch: "main",
    sessionPrefix: "p",
    ...overrides,
  };
}

function mockTmuxWithProcess(processName: string, found = true) {
  mockExecFileAsync.mockImplementation((cmd: string) => {
    if (cmd === "tmux") return Promise.resolve({ stdout: "/dev/ttys005\n", stderr: "" });
    if (cmd === "ps") {
      const line = found ? `  444 ttys005  ${processName}` : "  444 ttys005  zsh";
      return Promise.resolve({
        stdout: `  PID TT       ARGS\n${line}\n`,
        stderr: "",
      });
    }
    return Promise.reject(new Error(`unexpected ${cmd}`));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetSessionMatchCache();
  mockReadLastActivityEntry.mockResolvedValue(null);
  mockRecordTerminalActivity.mockResolvedValue(undefined);
  mockSetupPathWrapperWorkspace.mockResolvedValue(undefined);
  // realpath so that on macOS we get /private/var/... instead of /var/...
  // (/var is a symlink on macOS). Without this, the plugin hashes
  // realpath(workspacePath) while the test wrote under the unresolved path,
  // and the hashes diverge.
  fakeHome = realpathSync(mkdtempSync(join(tmpdir(), "kimicode-test-")));
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
});

// =============================================================================
// Manifest & exports
// =============================================================================
describe("manifest & exports", () => {
  it("has correct manifest", () => {
    expect(manifest).toEqual({
      name: "kimicode",
      slot: "agent",
      description: "Agent plugin: Kimi Code CLI (MoonshotAI)",
      version: "0.1.0",
      displayName: "Kimi Code",
    });
  });

  it("create() returns agent with correct name and processName", () => {
    const agent = create();
    expect(agent.name).toBe("kimicode");
    expect(agent.processName).toBe("kimi");
  });

  it("uses inline prompt delivery (kimi's -p does not exit after prompt)", () => {
    const agent = create();
    expect(agent.promptDelivery === undefined || agent.promptDelivery === "inline").toBe(true);
  });

  it("default export is a valid PluginModule", () => {
    expect(defaultExport.manifest).toBe(manifest);
    expect(typeof defaultExport.create).toBe("function");
    expect(typeof defaultExport.detect).toBe("function");
  });
});

// =============================================================================
// getLaunchCommand
// =============================================================================
describe("getLaunchCommand", () => {
  const agent = create();

  it("generates base command with --work-dir", () => {
    expect(agent.getLaunchCommand(makeLaunchConfig())).toBe(
      "kimi --work-dir '/workspace/repo'",
    );
  });

  it("adds --yolo when permissions=permissionless", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "permissionless" }));
    expect(cmd).toContain("--yolo");
  });

  it("adds --yolo when permissions=auto-edit", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "auto-edit" }));
    expect(cmd).toContain("--yolo");
  });

  it("omits --yolo when permissions=suggest", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ permissions: "suggest" }));
    expect(cmd).not.toContain("--yolo");
  });

  it("passes --model shell-escaped", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ model: "kimi-k2" }));
    expect(cmd).toContain("--model 'kimi-k2'");
  });

  it("passes --agent-file when systemPromptFile is set", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ systemPromptFile: "/tmp/sp.md" }));
    expect(cmd).toContain("--agent-file '/tmp/sp.md'");
  });

  it("passes --prompt inline (kimi's -p is a prompt string, not a mode switch)", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "do the thing" }));
    expect(cmd).toContain("--prompt 'do the thing'");
  });

  it("shell-escapes prompts with special characters", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ prompt: "it's complicated" }));
    expect(cmd).toContain("--prompt 'it'\\''s complicated'");
  });

  it("passes --agent when config.subagent is set", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ subagent: "okabe" }));
    expect(cmd).toContain("--agent 'okabe'");
  });

  it("combines model + yolo + agent + agent-file + prompt", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        permissions: "permissionless",
        model: "kimi-k2",
        subagent: "default",
        systemPromptFile: "/tmp/sp.md",
        prompt: "Go",
      }),
    );
    expect(cmd).toBe(
      "kimi --work-dir '/workspace/repo' --yolo --model 'kimi-k2' --agent 'default' --agent-file '/tmp/sp.md' --prompt 'Go'",
    );
  });

  // Worktree-mode parity: when AO runs in worktree workspace mode,
  // workspacePath (per-session checkout) differs from projectConfig.path
  // (the original repo root). --work-dir must take the workspacePath so
  // kimi's md5(cwd) bucket matches the one session-discovery scans.
  it("--work-dir prefers workspacePath over projectConfig.path", () => {
    const cmd = agent.getLaunchCommand(
      makeLaunchConfig({
        workspacePath: "/worktrees/sess-1",
      }),
    );
    expect(cmd).toContain("--work-dir '/worktrees/sess-1'");
    expect(cmd).not.toContain("/workspace/repo");
  });

  it("--work-dir falls back to projectConfig.path when workspacePath is undefined", () => {
    const cmd = agent.getLaunchCommand(makeLaunchConfig({ workspacePath: undefined }));
    expect(cmd).toContain("--work-dir '/workspace/repo'");
  });
});

// =============================================================================
// getEnvironment
// =============================================================================
describe("getEnvironment", () => {
  const agent = create();

  it("sets AO_SESSION_ID", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["AO_SESSION_ID"]).toBe("sess-1");
  });

  it("sets AO_ISSUE_ID only when provided", () => {
    expect(agent.getEnvironment(makeLaunchConfig()).AO_ISSUE_ID).toBeUndefined();
    expect(agent.getEnvironment(makeLaunchConfig({ issueId: "GH-42" })).AO_ISSUE_ID).toBe(
      "GH-42",
    );
  });

  it("prepends ~/.ao/bin to PATH", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["PATH"]).toMatch(/\.ao\/bin/);
  });

  it("sets GH_PATH to the preferred gh binary", () => {
    const env = agent.getEnvironment(makeLaunchConfig());
    expect(env["GH_PATH"]).toBe("/usr/local/bin/gh");
  });
});

// =============================================================================
// detectActivity
// =============================================================================
describe("detectActivity", () => {
  const agent = create();

  it("idle for empty/whitespace output", () => {
    expect(agent.detectActivity("")).toBe("idle");
    expect(agent.detectActivity("   \n  ")).toBe("idle");
  });

  it("idle when generic shell/REPL prompt is visible", () => {
    expect(agent.detectActivity("tokens: 1k\n> ")).toBe("idle");
    expect(agent.detectActivity("tokens: 1k\n$ ")).toBe("idle");
  });

  it("idle when kimi-specific prompt is visible", () => {
    expect(agent.detectActivity("output\nkimi> ")).toBe("idle");
    expect(agent.detectActivity("output\nkimi: ")).toBe("idle");
  });

  it("waiting_input for (Y)es/(N)o confirmations", () => {
    expect(agent.detectActivity("Allow edit to foo.ts?\n(Y)es/(N)o")).toBe("waiting_input");
  });

  it("waiting_input for [y/n] style confirmations", () => {
    expect(agent.detectActivity("Continue? [y/n]")).toBe("waiting_input");
  });

  it("waiting_input for a bare 'approve?' prompt line (not mid-sentence)", () => {
    expect(agent.detectActivity("Run rm -rf build/\napprove?")).toBe("waiting_input");
  });

  it("does NOT match 'approve' in agent narration (false-positive guard)", () => {
    const narration = "I approve of this approach and will proceed.\nReading src/index.ts";
    expect(agent.detectActivity(narration)).toBe("active");
  });

  it("waiting_input for 'Do you want to proceed?' prompts", () => {
    expect(agent.detectActivity("This will modify 3 files.\nDo you want to proceed?")).toBe(
      "waiting_input",
    );
  });

  it("blocked on error: prefix", () => {
    expect(agent.detectActivity("error: failed to parse response\n")).toBe("blocked");
  });

  it("blocked on line-anchored 'failed to authenticate'", () => {
    expect(agent.detectActivity("failed to authenticate with Kimi API\n")).toBe("blocked");
  });

  it("does NOT match 'failed to connect' mid-sentence (false-positive guard)", () => {
    const narration =
      "Earlier I failed to connect on the first try, but the retry worked.\nGenerating code...";
    expect(agent.detectActivity(narration)).toBe("active");
  });

  it("active for ongoing work output", () => {
    expect(agent.detectActivity("Generating code...\nReading src/index.ts")).toBe("active");
  });

  it("waiting_input wins when confirmation is shown above a re-rendered kimi> prompt (#6)", () => {
    // Real kimi terminal output: a confirmation request appears, then the
    // UI re-renders `kimi>` on the last line as part of the prompt chrome.
    // Old ordering (idle-first) misclassified this as idle and left the
    // session hanging. Actionable states MUST win.
    const output = [
      "Allow file write?",
      "(Y)es/(N)o",
      "kimi> ",
    ].join("\n");
    expect(agent.detectActivity(output)).toBe("waiting_input");
  });

  it("blocked wins over idle-prompt tail (#6)", () => {
    const output = ["error: LLM quota exceeded", "kimi> "].join("\n");
    expect(agent.detectActivity(output)).toBe("blocked");
  });
});

// =============================================================================
// isProcessRunning
// =============================================================================
describe("isProcessRunning", () => {
  const agent = create();

  it("returns true when `kimi` is running on the pane TTY", async () => {
    mockTmuxWithProcess("kimi");
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("returns true when the dot-prefixed shim `.kimi` is running", async () => {
    mockTmuxWithProcess("/usr/local/bin/.kimi");
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("returns true when invoked as `uv run kimi`", async () => {
    mockTmuxWithProcess("uv run kimi --yolo");
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("returns true when invoked as `python -m kimi`", async () => {
    mockTmuxWithProcess("python -m kimi --print");
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(true);
  });

  it("returns false when `kimi` appears only in argv[>0] (not as the executable)", async () => {
    // A user running `cat kimi.log` or `vim ~/.kimi/config.toml` on the pane
    // must NOT count as kimi running.
    mockTmuxWithProcess("cat kimi.log", true);
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("returns false for `/usr/bin/vim ~/.kimi/config.toml`", async () => {
    mockTmuxWithProcess("/usr/bin/vim /home/harsh/.kimi/config.toml", true);
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("returns false when kimi is not on the pane TTY", async () => {
    mockTmuxWithProcess("zsh", false);
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("returns true for process runtime with alive PID", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(await agent.isProcessRunning(makeProcessHandle(123))).toBe(true);
    killSpy.mockRestore();
  });

  it("returns false for process runtime with dead PID", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    expect(await agent.isProcessRunning(makeProcessHandle(456))).toBe(false);
    killSpy.mockRestore();
  });

  it("returns true for PID that throws EPERM (permission denied ≠ dead)", async () => {
    const err = Object.assign(new Error("EPERM"), { code: "EPERM" });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw err;
    });
    expect(await agent.isProcessRunning(makeProcessHandle(789))).toBe(true);
    killSpy.mockRestore();
  });

  it("returns false on tmux command failure", async () => {
    mockExecFileAsync.mockRejectedValue(new Error("tmux gone"));
    expect(await agent.isProcessRunning(makeTmuxHandle())).toBe(false);
  });

  it("returns false for unknown runtime without PID", async () => {
    const handle: RuntimeHandle = { id: "x", runtimeName: "other", data: {} };
    expect(await agent.isProcessRunning(handle)).toBe(false);
  });
});

// =============================================================================
// getActivityState — the mandatory 5-step cascade plus ordering + decay
// =============================================================================
describe("getActivityState", () => {
  const agent = create();
  const workspace = "/workspace/test";

  it("1. returns exited when process is not running", async () => {
    mockTmuxWithProcess("zsh", false);
    const result = await agent.getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle(), workspacePath: workspace }),
    );
    expect(result?.state).toBe("exited");
  });

  it("1b. returns exited when runtimeHandle is null", async () => {
    const result = await agent.getActivityState(makeSession({ runtimeHandle: null }));
    expect(result?.state).toBe("exited");
  });

  it("2. returns waiting_input from AO activity JSONL", async () => {
    mockTmuxWithProcess("kimi");
    mockReadLastActivityEntry.mockResolvedValueOnce({
      entry: { ts: new Date().toISOString(), state: "waiting_input", source: "terminal" },
      modifiedAt: new Date(),
    });

    const result = await agent.getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle(), workspacePath: workspace }),
    );
    expect(result?.state).toBe("waiting_input");
  });

  it("3. returns blocked from AO activity JSONL", async () => {
    mockTmuxWithProcess("kimi");
    mockReadLastActivityEntry.mockResolvedValueOnce({
      entry: { ts: new Date().toISOString(), state: "blocked", source: "terminal" },
      modifiedAt: new Date(),
    });

    const result = await agent.getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle(), workspacePath: workspace }),
    );
    expect(result?.state).toBe("blocked");
  });

  it("4. returns active from native signal when session files are fresh", async () => {
    mockTmuxWithProcess("kimi");
    writeKimiSession(workspace, "sess-abc"); // fresh (age ~ 0)

    const result = await agent.getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle(), workspacePath: workspace }),
    );
    expect(result?.state).toBe("active");
  });

  it("4b. returns ready from native signal when mtime falls in the ready window", async () => {
    mockTmuxWithProcess("kimi");
    writeKimiSession(workspace, "sess-abc", {
      contextAgeMs: 2 * 60 * 1000,
      wireAgeMs: 2 * 60 * 1000,
    });

    // AO session predates the kimi session — the createdAt floor must not
    // reject a legitimate mtime that's still within the ready window.
    const result = await agent.getActivityState(
      makeSession({
        runtimeHandle: makeTmuxHandle(),
        workspacePath: workspace,
        createdAt: new Date(Date.now() - 10 * 60 * 1000),
      }),
    );
    expect(result?.state).toBe("ready");
  });

  it("4c. returns idle from native signal when mtime is older than readyThreshold", async () => {
    mockTmuxWithProcess("kimi");
    writeKimiSession(workspace, "sess-abc", {
      contextAgeMs: 10 * 60 * 1000,
      wireAgeMs: 10 * 60 * 1000,
    });

    const result = await agent.getActivityState(
      makeSession({
        runtimeHandle: makeTmuxHandle(),
        workspacePath: workspace,
        createdAt: new Date(Date.now() - 30 * 60 * 1000),
      }),
    );
    expect(result?.state).toBe("idle");
  });

  it("cascade: JSONL waiting_input wins over native signal even when a session dir exists", async () => {
    mockTmuxWithProcess("kimi");
    writeKimiSession(workspace, "sess-abc"); // would be "active"

    mockReadLastActivityEntry.mockResolvedValueOnce({
      entry: { ts: new Date().toISOString(), state: "waiting_input", source: "terminal" },
      modifiedAt: new Date(),
    });

    const result = await agent.getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle(), workspacePath: workspace }),
    );
    expect(result?.state).toBe("waiting_input");
  });

  it("native signal prefers the fresher of context.jsonl vs wire.jsonl mtimes", async () => {
    mockTmuxWithProcess("kimi");
    // wire.jsonl is fresh, context.jsonl is stale → mtime = wire (fresh) → active.
    writeKimiSession(workspace, "sess-abc", {
      contextAgeMs: 10 * 60 * 1000,
      wireAgeMs: 0,
    });

    const result = await agent.getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle(), workspacePath: workspace }),
    );
    expect(result?.state).toBe("active");
  });

  it("picks the most recently modified session UUID when multiple exist in the bucket", async () => {
    mockTmuxWithProcess("kimi");
    writeKimiSession(workspace, "sess-old", {
      contextAgeMs: 10 * 60 * 1000,
      wireAgeMs: 10 * 60 * 1000,
    });
    writeKimiSession(workspace, "sess-new"); // fresh

    const result = await agent.getActivityState(
      makeSession({
        runtimeHandle: makeTmuxHandle(),
        workspacePath: workspace,
        createdAt: new Date(Date.now() - 30 * 60 * 1000),
      }),
    );
    expect(result?.state).toBe("active");
  });

  it("ignores UUIDs older than session.createdAt (stray/crash leftovers)", async () => {
    mockTmuxWithProcess("kimi");
    // A UUID dir that belonged to a previous AO session. Must not attach
    // to the current session — its summary/UUID would be wrong.
    writeKimiSession(workspace, "old-leftover", {
      contextAgeMs: 60 * 60 * 1000,
      wireAgeMs: 60 * 60 * 1000,
    });

    const result = await agent.getActivityState(
      makeSession({
        runtimeHandle: makeTmuxHandle(),
        workspacePath: workspace,
        // AO session started just now, 60min AFTER the leftover session's
        // last activity → leftover fails the createdAt - 60s floor.
        createdAt: new Date(),
      }),
    );
    // Falls through to the JSONL fallback (which is null in this test).
    expect(result).toBeNull();
  });

  it("pin file (.ao/kimi-session-id.json) wins over recency", async () => {
    const realWorkspace = join(fakeHome, "workspace-pin-1");
    mkdirSync(join(realWorkspace, ".ao"), { recursive: true });
    writeKimiSession(realWorkspace, "sess-newer"); // newer, but not pinned
    writeKimiSession(realWorkspace, "pinned-uuid", {
      contextAgeMs: 2 * 60 * 1000,
      wireAgeMs: 2 * 60 * 1000,
    });
    writeFileSync(
      join(realWorkspace, ".ao", "kimi-session-id.json"),
      JSON.stringify({ sessionId: "pinned-uuid", pinnedAt: "2026-04-01T00:00:00.000Z" }),
    );

    mockTmuxWithProcess("kimi");
    const info = await agent.getSessionInfo(
      makeSession({ workspacePath: realWorkspace }),
    );
    expect(info?.agentSessionId).toBe("pinned-uuid");
  });

  it("first successful match writes the pin file (locks in the recency winner)", async () => {
    const realWorkspace = join(fakeHome, "workspace-pin-write");
    mkdirSync(realWorkspace, { recursive: true });
    writeKimiSession(realWorkspace, "ao-spawned");

    mockTmuxWithProcess("kimi");
    const info = await agent.getSessionInfo(
      makeSession({ workspacePath: realWorkspace }),
    );
    expect(info?.agentSessionId).toBe("ao-spawned");

    const pin = JSON.parse(
      readFileSync(join(realWorkspace, ".ao", "kimi-session-id.json"), "utf-8"),
    );
    expect(pin.sessionId).toBe("ao-spawned");
    expect(typeof pin.pinnedAt).toBe("string");
  });

  // Regression: even if a different (e.g. manual `kimi`) UUID becomes the
  // freshest in the bucket later, the pinned UUID stays put.
  it("pin file holds even when a newer non-pinned UUID appears later", async () => {
    const realWorkspace = join(fakeHome, "workspace-pin-stable");
    mkdirSync(join(realWorkspace, ".ao"), { recursive: true });
    writeKimiSession(realWorkspace, "ao-original", {
      contextAgeMs: 2 * 60 * 1000,
      wireAgeMs: 2 * 60 * 1000,
    });
    writeFileSync(
      join(realWorkspace, ".ao", "kimi-session-id.json"),
      JSON.stringify({ sessionId: "ao-original", pinnedAt: "2026-04-01T00:00:00.000Z" }),
    );

    // A manual kimi run lands a newer UUID in the same bucket.
    writeKimiSession(realWorkspace, "manual-newer");

    mockTmuxWithProcess("kimi");
    _resetSessionMatchCache();
    const info = await agent.getSessionInfo(
      makeSession({ workspacePath: realWorkspace }),
    );
    expect(info?.agentSessionId).toBe("ao-original");
  });

  it("negative cache window is short (~2s) — picks up a session that appears mid-poll", async () => {
    mockTmuxWithProcess("kimi");
    const session = makeSession({
      runtimeHandle: makeTmuxHandle(),
      workspacePath: workspace,
    });

    // First call: no session dir exists yet → null, cached negatively.
    const first = await agent.getActivityState(session);
    expect(first).toBeNull();

    // Session appears.
    writeKimiSession(workspace, "sess-abc");

    // Negative TTL is 2s; wait it out, then expect the match to surface.
    await new Promise((r) => setTimeout(r, 2_100));
    const second = await agent.getActivityState(session);
    expect(second?.state).toBe("active");
  }, 10_000);

  it("baseline file: pre-existing UUIDs are partitioned out (manual kimi run in same dir)", async () => {
    mockTmuxWithProcess("kimi");

    // Use a real on-disk workspace so the plugin can read the baseline file.
    const realWorkspace = join(fakeHome, "workspace-baseline-1");
    mkdirSync(join(realWorkspace, ".ao"), { recursive: true });

    writeKimiSession(realWorkspace, "manual-run-uuid"); // pre-AO
    writeKimiSession(realWorkspace, "ao-launched-uuid"); // post-AO

    writeFileSync(
      join(realWorkspace, ".ao", "kimi-baseline.json"),
      JSON.stringify({
        preExistingUuids: ["manual-run-uuid"],
        capturedAt: new Date().toISOString(),
      }),
    );

    const info = await agent.getSessionInfo(
      makeSession({ workspacePath: realWorkspace }),
    );
    expect(info?.agentSessionId).toBe("ao-launched-uuid");
  });

  it("baseline file: returns null if every UUID was pre-existing", async () => {
    mockTmuxWithProcess("kimi");

    const realWorkspace = join(fakeHome, "workspace-baseline-2");
    mkdirSync(join(realWorkspace, ".ao"), { recursive: true });

    writeKimiSession(realWorkspace, "old-1");
    writeKimiSession(realWorkspace, "old-2");

    writeFileSync(
      join(realWorkspace, ".ao", "kimi-baseline.json"),
      JSON.stringify({
        preExistingUuids: ["old-1", "old-2"],
        capturedAt: new Date().toISOString(),
      }),
    );

    const result = await agent.getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle(), workspacePath: realWorkspace }),
    );
    expect(result).toBeNull();
  });

  it("preLaunchSetup writes a baseline that excludes pre-existing UUIDs from later discovery", async () => {
    const realWorkspace = join(fakeHome, "workspace-baseline-3");
    mkdirSync(realWorkspace, { recursive: true });

    // Pre-existing UUID before AO ever ran.
    writeKimiSession(realWorkspace, "pre-existing");

    // preLaunchSetup snapshots the bucket — captures "pre-existing" in baseline.
    await agent.preLaunchSetup!(realWorkspace);

    // Later, AO's kimi spawn creates a new UUID dir.
    writeKimiSession(realWorkspace, "ao-spawned");

    mockTmuxWithProcess("kimi");
    const info = await agent.getSessionInfo(
      makeSession({ workspacePath: realWorkspace }),
    );
    expect(info?.agentSessionId).toBe("ao-spawned");
  });

  // Regression: captureKimiBaseline used to run in postLaunchSetup, which
  // races against kimi's own startup — kimi may create its UUID dir before
  // postLaunchSetup runs, in which case the new UUID lands in
  // preExistingUuids and gets filtered out forever, so discovery returns
  // null permanently. Pre-launch capture closes that window.
  it("preLaunchSetup runs before kimi creates UUIDs — new UUID is attached, not partitioned out", async () => {
    const realWorkspace = join(fakeHome, "workspace-baseline-race");
    mkdirSync(realWorkspace, { recursive: true });

    // Pre-existing UUID (created by a prior run, manual kimi, etc.).
    writeKimiSession(realWorkspace, "pre-existing-uuid");

    // Step 1: preLaunchSetup runs FIRST, snapshots only the pre-existing UUID.
    await agent.preLaunchSetup!(realWorkspace);

    // Step 2: simulate kimi launching and creating a new UUID dir.
    writeKimiSession(realWorkspace, "kimi-just-created-this");

    mockTmuxWithProcess("kimi");
    const info = await agent.getSessionInfo(
      makeSession({ workspacePath: realWorkspace }),
    );
    // The newly-created UUID must NOT have been treated as pre-existing —
    // pre-launch baseline didn't see it. Discovery must attach to it.
    expect(info?.agentSessionId).toBe("kimi-just-created-this");
  });

  it("preLaunchSetup is write-once — restore preserves the original baseline", async () => {
    const realWorkspace = join(fakeHome, "workspace-baseline-4");
    mkdirSync(join(realWorkspace, ".ao"), { recursive: true });

    const originalBaseline = {
      preExistingUuids: ["original-pre-existing"],
      capturedAt: "2026-04-01T00:00:00.000Z",
    };
    writeFileSync(
      join(realWorkspace, ".ao", "kimi-baseline.json"),
      JSON.stringify(originalBaseline),
    );

    // Add a UUID that would be in the bucket on restore (the one AO created
    // during the original launch). If preLaunchSetup overwrote the baseline
    // here, this UUID would be partitioned out as "pre-existing" — wrong.
    writeKimiSession(realWorkspace, "ao-created-on-first-launch");

    await agent.preLaunchSetup!(realWorkspace);

    const baselineNow = JSON.parse(
      readFileSync(join(realWorkspace, ".ao", "kimi-baseline.json"), "utf-8"),
    );
    expect(baselineNow.preExistingUuids).toEqual(["original-pre-existing"]);
    expect(baselineNow.capturedAt).toBe("2026-04-01T00:00:00.000Z");
  });

  it("pinned UUID that no longer exists returns null (no fallback to recency)", async () => {
    const realWorkspace = join(fakeHome, "workspace-pin-missing");
    mkdirSync(join(realWorkspace, ".ao"), { recursive: true });
    writeKimiSession(realWorkspace, "some-other-uuid"); // exists but not pinned
    writeFileSync(
      join(realWorkspace, ".ao", "kimi-session-id.json"),
      JSON.stringify({ sessionId: "pinned-missing", pinnedAt: "2026-04-01T00:00:00.000Z" }),
    );

    mockTmuxWithProcess("kimi");
    const info = await agent.getSessionInfo(
      makeSession({ workspacePath: realWorkspace }),
    );
    expect(info).toBeNull();
  });

  it("5. returns active from JSONL entry fallback when native signal is unavailable (fresh entry)", async () => {
    mockTmuxWithProcess("kimi");
    // No ~/.kimi/sessions/<hash>/ dir for this workspace — fakeHome is empty.

    const now = new Date();
    mockReadLastActivityEntry.mockResolvedValueOnce({
      entry: { ts: now.toISOString(), state: "active", source: "terminal" },
      modifiedAt: now,
    });

    const result = await agent.getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle(), workspacePath: workspace }),
    );
    expect(result?.state).toBe("active");
  });

  it("6. returns idle from JSONL entry fallback with age decay (old entry)", async () => {
    mockTmuxWithProcess("kimi");

    const old = new Date(Date.now() - 10 * 60 * 1000);
    mockReadLastActivityEntry.mockResolvedValueOnce({
      entry: { ts: old.toISOString(), state: "active", source: "terminal" },
      modifiedAt: old,
    });

    const result = await agent.getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle(), workspacePath: workspace }),
    );
    expect(result?.state).toBe("idle");
  });

  it("7. returns null when both native signal and JSONL are unavailable", async () => {
    mockTmuxWithProcess("kimi");
    mockReadLastActivityEntry.mockResolvedValueOnce(null);

    const result = await agent.getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle(), workspacePath: workspace }),
    );
    expect(result).toBeNull();
  });

  it("returns null when workspacePath is missing (no source of truth)", async () => {
    mockTmuxWithProcess("kimi");
    const result = await agent.getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle(), workspacePath: null }),
    );
    expect(result).toBeNull();
  });

  it("resolves symlinked workspace paths before hashing (kimi sees realpath as cwd)", async () => {
    mockTmuxWithProcess("kimi");
    // Create a real target dir + a symlink pointing at it. Kimi's process
    // resolves symlinks via os.getcwd(), so its MD5 bucket is keyed by the
    // realpath. Our plugin must match by realpath too.
    const real = join(fakeHome, "workspaces", "real-project");
    mkdirSync(real, { recursive: true });
    const link = join(fakeHome, "workspaces", "link-to-project");
    symlinkSync(real, link);

    // Write a session under the realpath bucket, then look it up via the
    // symlink path — our resolveWorkspacePath should make them equivalent.
    writeKimiSession(real, "sess-abc");

    const result = await agent.getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle(), workspacePath: link }),
    );
    expect(result?.state).toBe("active");
  });

  it("rejects session dirs that have no live-signal files (stray/incomplete)", async () => {
    mockTmuxWithProcess("kimi");
    const bucket = join(fakeHome, ".kimi", "sessions", workspaceHash(workspace));
    // UUID dir exists but context.jsonl / wire.jsonl haven't been created.
    // Could be a crash leftover or a stray temp dir — must NOT be trusted
    // (#3 from illegalcall's review). The JSONL activity fallback covers
    // the startup race window instead.
    mkdirSync(join(bucket, "empty-session"), { recursive: true });

    const result = await agent.getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle(), workspacePath: workspace }),
    );
    expect(result).toBeNull();
  });

  // Defensive: a symlinked context.jsonl / wire.jsonl inside the bucket
  // would let stat() / createReadStream() follow it to /etc/passwd, /dev/zero,
  // a FIFO, etc. — escaping the kimi-sessions sandbox. lstat-based checks
  // reject anything that isn't a regular file.
  it("rejects session dirs whose live-signal files are symlinks (sandbox escape)", async () => {
    mockTmuxWithProcess("kimi");
    const bucket = join(fakeHome, ".kimi", "sessions", workspaceHash(workspace));
    const sessionDir = join(bucket, "symlinked-session");
    mkdirSync(sessionDir, { recursive: true });

    // Create symlinks where context.jsonl / wire.jsonl should be — pointing
    // at unrelated files outside the sessions tree.
    const decoy = join(fakeHome, "decoy.txt");
    writeFileSync(decoy, "should never be read");
    symlinkSync(decoy, join(sessionDir, "context.jsonl"));
    symlinkSync(decoy, join(sessionDir, "wire.jsonl"));

    const result = await agent.getActivityState(
      makeSession({ runtimeHandle: makeTmuxHandle(), workspacePath: workspace }),
    );
    expect(result).toBeNull();
  });
});

// =============================================================================
// recordActivity
// =============================================================================
describe("recordActivity", () => {
  const agent = create();

  it("delegates to recordTerminalActivity", async () => {
    await agent.recordActivity!(makeSession(), "kimi is generating");
    expect(mockRecordTerminalActivity).toHaveBeenCalledWith(
      "/workspace/test",
      "kimi is generating",
      expect.any(Function),
    );
  });

  it("is a no-op when workspacePath is null", async () => {
    await agent.recordActivity!(makeSession({ workspacePath: null }), "output");
    expect(mockRecordTerminalActivity).not.toHaveBeenCalled();
  });
});

// =============================================================================
// getSessionInfo
// =============================================================================
describe("getSessionInfo", () => {
  const agent = create();
  const workspace = "/workspace/test";

  it("returns null when workspacePath is missing", async () => {
    expect(await agent.getSessionInfo(makeSession({ workspacePath: null }))).toBeNull();
  });

  it("returns null when no matching kimi session dir exists", async () => {
    expect(await agent.getSessionInfo(makeSession({ workspacePath: workspace }))).toBeNull();
  });

  it("returns the session UUID as agentSessionId", async () => {
    writeKimiSession(workspace, "6ec34626-aedf-4659-a061-c5fbfa4cf166");
    const info = await agent.getSessionInfo(makeSession({ workspacePath: workspace }));
    expect(info).not.toBeNull();
    expect(info!.agentSessionId).toBe("6ec34626-aedf-4659-a061-c5fbfa4cf166");
    expect(info!.summaryIsFallback).toBe(true);
    expect(info!.cost).toBeUndefined();
  });

  it("extracts the first user input from wire.jsonl as a summary", async () => {
    writeKimiSession(workspace, "sess-abc", {
      wireContent:
        [
          '{"type":"metadata","protocol_version":"1.9"}',
          '{"timestamp":1,"message":{"type":"TurnBegin","payload":{"user_input":"fix the login bug"}}}',
          '{"timestamp":2,"message":{"type":"TurnEnd","payload":{}}}',
        ].join("\n") + "\n",
    });
    const info = await agent.getSessionInfo(makeSession({ workspacePath: workspace }));
    expect(info!.summary).toBe("fix the login bug");
  });

  it("truncates a long user input to 120 chars + ellipsis", async () => {
    const longInput = "A".repeat(200);
    writeKimiSession(workspace, "sess-abc", {
      wireContent:
        [
          '{"type":"metadata","protocol_version":"1.9"}',
          `{"timestamp":1,"message":{"type":"TurnBegin","payload":{"user_input":"${longInput}"}}}`,
        ].join("\n") + "\n",
    });
    const info = await agent.getSessionInfo(makeSession({ workspacePath: workspace }));
    expect(info!.summary).toHaveLength(123);
    expect(info!.summary!.endsWith("...")).toBe(true);
  });

  it("returns null summary when wire.jsonl has no TurnBegin entry", async () => {
    writeKimiSession(workspace, "sess-abc", {
      wireContent: '{"type":"metadata","protocol_version":"1.9"}\n',
    });
    const info = await agent.getSessionInfo(makeSession({ workspacePath: workspace }));
    expect(info!.summary).toBeNull();
    expect(info!.agentSessionId).toBe("sess-abc");
  });

  it("prefers kimi.json last_session_id over recency when populated", async () => {
    const realWorkspace = join(fakeHome, "workspace-kimijson-1");
    mkdirSync(realWorkspace, { recursive: true });

    // Two sessions: "newer-uuid" is more recent, but kimi.json says
    // "older-uuid" is the last_session_id for this workspace.
    writeKimiSession(realWorkspace, "newer-uuid");
    writeKimiSession(realWorkspace, "older-uuid", {
      contextAgeMs: 2 * 60 * 1000,
      wireAgeMs: 2 * 60 * 1000,
    });

    // Write kimi.json pointing at the older session.
    writeFileSync(
      join(fakeHome, ".kimi", "kimi.json"),
      JSON.stringify({
        work_dirs: [
          { path: realWorkspace, kaos: "local", last_session_id: "older-uuid" },
        ],
      }),
    );

    const info = await agent.getSessionInfo(
      makeSession({
        workspacePath: realWorkspace,
        createdAt: new Date(Date.now() - 10 * 60 * 1000),
      }),
    );
    expect(info?.agentSessionId).toBe("older-uuid");
  });

  it("falls back to recency when kimi.json last_session_id is null", async () => {
    const realWorkspace = join(fakeHome, "workspace-kimijson-2");
    mkdirSync(realWorkspace, { recursive: true });

    writeKimiSession(realWorkspace, "only-uuid");

    writeFileSync(
      join(fakeHome, ".kimi", "kimi.json"),
      JSON.stringify({
        work_dirs: [
          { path: realWorkspace, kaos: "local", last_session_id: null },
        ],
      }),
    );

    const info = await agent.getSessionInfo(
      makeSession({ workspacePath: realWorkspace }),
    );
    expect(info?.agentSessionId).toBe("only-uuid");
  });

  it("falls back to recency when kimi.json is missing", async () => {
    // No kimi.json exists — hash-based discovery should still work.
    writeKimiSession(workspace, "hash-found-uuid");

    const info = await agent.getSessionInfo(
      makeSession({ workspacePath: workspace }),
    );
    expect(info?.agentSessionId).toBe("hash-found-uuid");
  });

  // Regression: a stale kimi.json last_session_id pointing at a baseline
  // UUID (e.g. left over from a prior manual `kimi` run) used to bypass
  // the baseline filter and get pinned permanently. The pin file is
  // long-lived, so this would route every subsequent getActivityState /
  // getSessionInfo / getRestoreCommand call at the wrong conversation
  // with no self-healing path. The soft-pin candidate must pass the same
  // baseline + createdAt filters as the recency contest.
  it("rejects kimi.json soft-pin when it points at a baseline UUID", async () => {
    const realWorkspace = join(fakeHome, "workspace-kimijson-stale");
    mkdirSync(join(realWorkspace, ".ao"), { recursive: true });

    // "stale-uuid" was left in the bucket and in kimi.json by an earlier
    // manual run. "ao-spawned" is the UUID kimi created for this AO session.
    writeKimiSession(realWorkspace, "stale-uuid");
    writeKimiSession(realWorkspace, "ao-spawned");

    // Baseline (captured by preLaunchSetup) flags "stale-uuid" as pre-AO.
    writeFileSync(
      join(realWorkspace, ".ao", "kimi-baseline.json"),
      JSON.stringify({
        preExistingUuids: ["stale-uuid"],
        capturedAt: new Date().toISOString(),
      }),
    );

    // kimi.json still points at the stale UUID — kimi-cli hasn't yet
    // updated last_session_id for the new AO-spawned session.
    writeFileSync(
      join(fakeHome, ".kimi", "kimi.json"),
      JSON.stringify({
        work_dirs: [
          { path: realWorkspace, kaos: "local", last_session_id: "stale-uuid" },
        ],
      }),
    );

    const info = await agent.getSessionInfo(
      makeSession({ workspacePath: realWorkspace }),
    );
    expect(info?.agentSessionId).toBe("ao-spawned");

    // And the AO pin file must record "ao-spawned", not "stale-uuid" —
    // otherwise every later call would resolve to the wrong conversation.
    const pin = JSON.parse(
      readFileSync(join(realWorkspace, ".ao", "kimi-session-id.json"), "utf-8"),
    );
    expect(pin.sessionId).toBe("ao-spawned");
  });

  // Companion case: kimi.json points at a UUID older than the AO session's
  // createdAt. The soft-pin must be filtered by the createdAt floor too.
  it("rejects kimi.json soft-pin when its UUID predates session.createdAt", async () => {
    const realWorkspace = join(fakeHome, "workspace-kimijson-old");
    mkdirSync(join(realWorkspace, ".ao"), { recursive: true });

    // "old-uuid" exists with mtime far before session.createdAt; nothing
    // is in the baseline file, but the createdAt floor should still
    // reject it. "fresh-uuid" is the legitimate post-launch session.
    writeKimiSession(realWorkspace, "old-uuid", {
      contextAgeMs: 30 * 60 * 1000,
      wireAgeMs: 30 * 60 * 1000,
    });
    writeKimiSession(realWorkspace, "fresh-uuid");

    writeFileSync(
      join(fakeHome, ".kimi", "kimi.json"),
      JSON.stringify({
        work_dirs: [
          { path: realWorkspace, kaos: "local", last_session_id: "old-uuid" },
        ],
      }),
    );

    const info = await agent.getSessionInfo(
      makeSession({
        workspacePath: realWorkspace,
        // createdAt 5 minutes ago — old-uuid (30 min) is well below the
        // createdAt - 60s floor; fresh-uuid is well above.
        createdAt: new Date(Date.now() - 5 * 60 * 1000),
      }),
    );
    expect(info?.agentSessionId).toBe("fresh-uuid");
  });

  it("skips malformed wire.jsonl lines without crashing", async () => {
    writeKimiSession(workspace, "sess-abc", {
      wireContent:
        [
          "not json at all",
          '{"type":"metadata","protocol_version":"1.9"}',
          '{"timestamp":1,"message":{"type":"TurnBegin","payload":{"user_input":"recovered"}}}',
        ].join("\n") + "\n",
    });
    const info = await agent.getSessionInfo(makeSession({ workspacePath: workspace }));
    expect(info!.summary).toBe("recovered");
  });

  // Defensive: a symlinked wire.jsonl in the bucket (e.g. pointing at
  // /etc/passwd, /dev/zero, or a FIFO) must not be opened by
  // extractKimiSummary. lstat-rejects symlinks before createReadStream.
  it("returns null summary when wire.jsonl is a symlink (sandbox escape)", async () => {
    mockTmuxWithProcess("kimi");
    const bucket = join(fakeHome, ".kimi", "sessions", workspaceHash(workspace));
    const sessionDir = join(bucket, "symlinked-wire");
    mkdirSync(sessionDir, { recursive: true });
    // context.jsonl is real so getKimiLiveSignalMtime succeeds and the dir
    // is selected. Then extractKimiSummary tries to open the symlinked
    // wire.jsonl and must refuse.
    writeFileSync(join(sessionDir, "context.jsonl"), '{"role":"_system_prompt"}\n');
    const decoy = join(fakeHome, "decoy-wire.txt");
    writeFileSync(decoy, '{"timestamp":1,"message":{"type":"TurnBegin","payload":{"user_input":"leaked"}}}\n');
    symlinkSync(decoy, join(sessionDir, "wire.jsonl"));

    const info = await agent.getSessionInfo(makeSession({ workspacePath: workspace }));
    // Discovery still produced a match (context.jsonl is fine), but the
    // summary read MUST NOT have followed the symlink.
    expect(info?.summary).toBeNull();
  });
});

// =============================================================================
// getRestoreCommand
// =============================================================================
describe("getRestoreCommand", () => {
  const agent = create();
  const workspace = "/workspace/test";

  it("returns null when workspacePath is missing", async () => {
    const result = await agent.getRestoreCommand!(
      makeSession({ workspacePath: null }),
      makeProject(),
    );
    expect(result).toBeNull();
  });

  it("returns null when no kimi session dir exists", async () => {
    const result = await agent.getRestoreCommand!(
      makeSession({ workspacePath: workspace }),
      makeProject(),
    );
    expect(result).toBeNull();
  });

  it("uses --resume <session_uuid>", async () => {
    writeKimiSession(workspace, "6ec34626-aedf-4659-a061-c5fbfa4cf166");
    const result = await agent.getRestoreCommand!(
      makeSession({ workspacePath: workspace }),
      makeProject(),
    );
    expect(result).toBe("kimi --resume '6ec34626-aedf-4659-a061-c5fbfa4cf166'");
  });

  it("passes --yolo and --model from project.agentConfig", async () => {
    writeKimiSession(workspace, "sess-abc");
    const result = await agent.getRestoreCommand!(
      makeSession({ workspacePath: workspace }),
      makeProject({
        agentConfig: { permissions: "permissionless", model: "kimi-k2" },
      }),
    );
    expect(result).toContain("kimi --resume 'sess-abc'");
    expect(result).toContain("--yolo");
    expect(result).toContain("--model 'kimi-k2'");
  });

  it("picks the most recently modified session UUID when multiple exist", async () => {
    writeKimiSession(workspace, "sess-old", {
      contextAgeMs: 60 * 60 * 1000,
      wireAgeMs: 60 * 60 * 1000,
    });
    writeKimiSession(workspace, "sess-new");

    const result = await agent.getRestoreCommand!(
      makeSession({ workspacePath: workspace }),
      makeProject(),
    );
    expect(result).toBe("kimi --resume 'sess-new'");
  });

  // Worktree-mode end-to-end: AO's workspace plugin gives the session a
  // per-session checkout (workspacePath) different from the project root
  // (projectConfig.path). kimi launched with --work-dir=<workspacePath>
  // hashes that path for its bucket — so discovery must hash the
  // workspacePath, NOT the project root, or it will look in the wrong
  // bucket and find nothing.
  it("worktree mode: discovery hashes workspacePath, not projectConfig.path", async () => {
    const workspaceWorktree = join(fakeHome, "worktrees", "sess-wt");
    mkdirSync(workspaceWorktree, { recursive: true });

    // kimi launched with --work-dir=workspaceWorktree wrote its session
    // under md5(workspaceWorktree).
    writeKimiSession(workspaceWorktree, "wt-uuid");

    // Project root is somewhere completely different — md5(projectRoot)
    // must NOT be where discovery looks.
    const projectRoot = join(fakeHome, "repos", "main-repo");
    mkdirSync(projectRoot, { recursive: true });

    const result = await agent.getRestoreCommand!(
      makeSession({ workspacePath: workspaceWorktree }),
      makeProject({ path: projectRoot }),
    );
    expect(result).toBe("kimi --resume 'wt-uuid'");
  });
});

// =============================================================================
// setupWorkspaceHooks / postLaunchSetup
// =============================================================================
describe("workspace hooks", () => {
  const agent = create();

  it("setupWorkspaceHooks delegates to setupPathWrapperWorkspace", async () => {
    await agent.setupWorkspaceHooks!("/workspace/test", { dataDir: "/tmp/ao-data", sessionId: "s" });
    expect(mockSetupPathWrapperWorkspace).toHaveBeenCalledWith("/workspace/test");
  });

  it("postLaunchSetup is a no-op when workspacePath is null", async () => {
    await agent.postLaunchSetup!(makeSession({ workspacePath: null }));
    expect(mockSetupPathWrapperWorkspace).not.toHaveBeenCalled();
  });

  it("postLaunchSetup installs PATH wrappers", async () => {
    await agent.postLaunchSetup!(makeSession());
    expect(mockSetupPathWrapperWorkspace).toHaveBeenCalledWith("/workspace/test");
  });
});

// =============================================================================
// detect()
// =============================================================================
describe("detect", () => {
  it("returns true when `kimi info` prints the kimi-cli vendor string", async () => {
    const { execFileSync } = await import("node:child_process");
    vi.mocked(execFileSync).mockImplementationOnce(
      () =>
        "kimi-cli version: 1.38.0\nagent spec versions: 1\n" as unknown as ReturnType<
          typeof execFileSync
        >,
    );
    expect(detect()).toBe(true);
  });

  it("returns true for kimi-code vendor string", async () => {
    const { execFileSync } = await import("node:child_process");
    vi.mocked(execFileSync).mockImplementationOnce(
      () => "package: kimi-code\n" as unknown as ReturnType<typeof execFileSync>,
    );
    expect(detect()).toBe(true);
  });

  it("returns true when output mentions Moonshot", async () => {
    const { execFileSync } = await import("node:child_process");
    vi.mocked(execFileSync).mockImplementationOnce(
      () => "moonshot kimi 1.38\n" as unknown as ReturnType<typeof execFileSync>,
    );
    expect(detect()).toBe(true);
  });

  it("returns false when `kimi info` throws (binary missing or unrelated)", async () => {
    const { execFileSync } = await import("node:child_process");
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw new Error("command not found");
    });
    expect(detect()).toBe(false);
  });

  it("rejects an unrelated `kimi` binary whose output lacks the vendor marker", async () => {
    // E.g. a hypothetical keyboard-input-manager named `kimi` whose output
    // contains plain "kimi" but no kimi-cli / kimi-code / moonshot marker.
    const { execFileSync } = await import("node:child_process");
    vi.mocked(execFileSync).mockImplementationOnce(
      () =>
        "kimi v0.1 — keyboard input manager\n" as unknown as ReturnType<typeof execFileSync>,
    );
    expect(detect()).toBe(false);
  });
});
