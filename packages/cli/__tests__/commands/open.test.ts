import type * as ChildProcess from "node:child_process";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockExec,
  mockSpawn,
  mockConfigRef,
  mockListRef,
  mockOpenUrl,
  mockIsMacRef,
  mockIsWindowsRef,
  mockRunningRef,
} = vi.hoisted(() => ({
  mockExec: vi.fn(),
  mockSpawn: vi.fn(),
  mockConfigRef: { current: null as Record<string, unknown> | null },
  mockListRef: { current: [] as Array<{ id: string; projectId: string; lifecycle: { session: { state: string } } }> },
  mockOpenUrl: vi.fn(),
  mockIsMacRef: { current: true },
  mockIsWindowsRef: { current: false },
  mockRunningRef: { current: { pid: 1, port: 3000, projects: [] } as { pid: number; port: number; projects: string[] } | null },
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return { ...actual, spawn: mockSpawn };
});

vi.mock("../../src/lib/shell.js", () => ({
  exec: mockExec,
  execSilent: vi.fn(),
  tmux: vi.fn(),
  git: vi.fn(),
  gh: vi.fn(),
  getTmuxSessions: vi.fn(),
  getTmuxActivity: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../src/lib/create-session-manager.js", () => ({
  getSessionManager: async () => ({
    list: async () => mockListRef.current,
  }),
}));

vi.mock("../../src/lib/web-dir.js", () => ({
  openUrl: mockOpenUrl,
}));

vi.mock("../../src/lib/running-state.js", () => ({
  getRunning: async () => mockRunningRef.current,
}));

vi.mock("@aoagents/ao-core", () => ({
  loadConfig: () => mockConfigRef.current,
  isMac: () => mockIsMacRef.current,
  isWindows: () => mockIsWindowsRef.current,
  isTerminalSession: (s: { lifecycle?: { session?: { state?: string } } }) =>
    s.lifecycle?.session?.state === "terminated" || s.lifecycle?.session?.state === "done",
}));

import { Command } from "commander";
import { registerOpen } from "../../src/commands/open.js";

// Fictional fixture path used only inside the in-memory mock config below.
// Not anyone's real filesystem path — assertions reference this constant so
// the test verifies "config.projects[id].path flows through to wt's -d flag",
// independent of the literal value.
const TEST_REPO_PATH = "/fixtures/test-repo";

let program: Command;
let consoleSpy: ReturnType<typeof vi.spyOn>;

function makeSession(id: string, projectId: string, state = "working") {
  const sessionState =
    state === "terminated"
      ? {
          state,
          reason: "runtime_lost",
          terminatedAt: "2026-05-04T19:51:10.488Z",
        }
      : { state, reason: "task_in_progress", terminatedAt: null };
  const runtimeState =
    state === "terminated"
      ? { state: "missing", reason: "process_missing" }
      : { state: "alive", reason: "process_running" };
  return {
    id,
    projectId,
    lifecycle: {
      session: sessionState,
      runtime: runtimeState,
    },
  };
}

function makeSpawnChild() {
  const handlers: Record<string, () => void> = {};
  return {
    on: vi.fn((event: string, cb: () => void) => {
      handlers[event] = cb;
      return undefined;
    }),
    unref: vi.fn(),
  };
}

beforeEach(() => {
  mockConfigRef.current = {
    dataDir: "/tmp/ao",
    worktreeDir: "/tmp/wt",
    port: 3000,
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: ["desktop"],
    },
    projects: {
      "my-app": {
        name: "My App",
        repo: "org/my-app",
        path: "/home/user/my-app",
        defaultBranch: "main",
        sessionPrefix: "app",
      },
      backend: {
        name: "Backend",
        repo: "org/backend",
        path: "/home/user/backend",
        defaultBranch: "main",
      },
      "test-repo": {
        name: "Test Repo",
        repo: "org/test-repo",
        path: TEST_REPO_PATH,
        defaultBranch: "main",
      },
    },
    notifiers: {},
    notificationRouting: {},
    reactions: {},
  } as Record<string, unknown>;

  program = new Command();
  program.exitOverride();
  registerOpen(program);
  consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });

  mockExec.mockReset();
  mockSpawn.mockReset();
  mockOpenUrl.mockReset();
  mockListRef.current = [];
  mockIsMacRef.current = true;
  mockIsWindowsRef.current = false;
  mockRunningRef.current = { pid: 1, port: 3000, projects: [] };
  mockExec.mockResolvedValue({ stdout: "", stderr: "" });
  mockSpawn.mockReturnValue(makeSpawnChild());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("open command (macOS)", () => {
  it("opens all sessions when target is 'all'", async () => {
    mockListRef.current = [
      makeSession("app-1", "my-app"),
      makeSession("app-2", "my-app"),
      makeSession("backend-1", "backend"),
    ];

    await program.parseAsync(["node", "test", "open", "all"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Opening 3 sessions");
    expect(output).toContain("app-1");
    expect(output).toContain("app-2");
    expect(output).toContain("backend-1");
  });

  it("opens all sessions when no target given", async () => {
    mockListRef.current = [makeSession("app-1", "my-app")];

    await program.parseAsync(["node", "test", "open"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Opening 1 session");
  });

  it("opens sessions for a specific project", async () => {
    mockListRef.current = [
      makeSession("app-1", "my-app"),
      makeSession("app-2", "my-app"),
      makeSession("backend-1", "backend"),
    ];

    await program.parseAsync(["node", "test", "open", "my-app"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Opening 2 sessions");
    expect(output).toContain("app-1");
    expect(output).toContain("app-2");
    expect(output).not.toContain("backend-1");
  });

  it("opens a single session by name", async () => {
    mockListRef.current = [makeSession("app-1", "my-app"), makeSession("app-2", "my-app")];

    await program.parseAsync(["node", "test", "open", "app-1"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Opening 1 session");
    expect(output).toContain("app-1");
  });

  it("rejects unknown target", async () => {
    mockListRef.current = [makeSession("app-1", "my-app")];

    await expect(program.parseAsync(["node", "test", "open", "nonexistent"])).rejects.toThrow(
      "process.exit(1)",
    );
  });

  it("passes --new-window flag to open-iterm-tab", async () => {
    mockListRef.current = [makeSession("app-1", "my-app")];

    await program.parseAsync(["node", "test", "open", "-w", "app-1"]);

    expect(mockExec).toHaveBeenCalledWith("open-iterm-tab", ["--new-window", "app-1"]);
  });

  it("falls back gracefully when open-iterm-tab fails", async () => {
    mockListRef.current = [makeSession("app-1", "my-app")];
    mockExec.mockRejectedValue(new Error("command not found"));

    await program.parseAsync(["node", "test", "open", "app-1"]);

    expect(mockOpenUrl).toHaveBeenCalledWith(
      "http://localhost:3000/projects/my-app/sessions/app-1",
    );
  });

  it("excludes terminated sessions from aggregate targets", async () => {
    mockListRef.current = [
      makeSession("app-1", "my-app"),
      makeSession("app-dead", "my-app", "terminated"),
    ];

    await program.parseAsync(["node", "test", "open", "all"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Opening 1 session");
    expect(output).toContain("app-1");
    expect(output).not.toContain("app-dead");
  });

  it("includes a terminated session when looked up by name (opens dashboard with death reason)", async () => {
    mockListRef.current = [makeSession("app-dead", "my-app", "terminated")];

    await program.parseAsync(["node", "test", "open", "app-dead"]);

    expect(mockExec).not.toHaveBeenCalled();
    expect(mockOpenUrl).toHaveBeenCalledWith(
      "http://localhost:3000/projects/my-app/sessions/app-dead",
    );
    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("(terminated)");
    expect(output).toContain("session=runtime_lost");
    expect(output).toContain("runtime=process_missing");
    expect(output).toContain("ao session restore app-dead");
  });

  it("--browser forces dashboard URL even on macOS", async () => {
    mockListRef.current = [makeSession("app-1", "my-app")];

    await program.parseAsync(["node", "test", "open", "-b", "app-1"]);

    expect(mockExec).not.toHaveBeenCalled();
    expect(mockOpenUrl).toHaveBeenCalledWith(
      "http://localhost:3000/projects/my-app/sessions/app-1",
    );
  });

  it("uses the live daemon's port from running-state, not config", async () => {
    mockListRef.current = [makeSession("app-1", "my-app")];
    mockExec.mockRejectedValue(new Error("no iterm"));
    mockRunningRef.current = { pid: 42, port: 4173, projects: ["my-app"] };

    await program.parseAsync(["node", "test", "open", "app-1"]);

    expect(mockOpenUrl).toHaveBeenCalledWith(
      "http://localhost:4173/projects/my-app/sessions/app-1",
    );
  });

  it("warns when daemon is not running (URL fallback may not load)", async () => {
    mockListRef.current = [makeSession("app-1", "my-app")];
    mockExec.mockRejectedValue(new Error("no iterm"));
    mockRunningRef.current = null;

    await program.parseAsync(["node", "test", "open", "app-1"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("daemon does not appear to be running");
  });

  it("shows 'No sessions to open' when none exist", async () => {
    mockListRef.current = [];

    await program.parseAsync(["node", "test", "open", "my-app"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("No sessions to open");
  });
});

describe("open command (Windows)", () => {
  beforeEach(() => {
    mockIsMacRef.current = false;
    mockIsWindowsRef.current = true;
  });

  it("spawns Windows Terminal running `ao session attach <id>`", async () => {
    mockListRef.current = [makeSession("tr-orchestrator", "test-repo")];

    await program.parseAsync(["node", "test", "open", "tr-orchestrator"]);

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [cmd, args] = mockSpawn.mock.calls[0];
    expect(cmd).toBe("wt.exe");
    expect(args).toEqual([
      "-w", "0", "new-tab",
      "--title", "ao:tr-orchestrator",
      "-d", TEST_REPO_PATH,
      "cmd.exe", "/k", "ao", "session", "attach", "tr-orchestrator",
    ]);
    expect(mockOpenUrl).not.toHaveBeenCalled();
  });

  it("falls back to `cmd /k` when wt.exe is unavailable", async () => {
    mockListRef.current = [makeSession("tr-orchestrator", "test-repo")];
    mockSpawn.mockImplementationOnce(() => {
      throw new Error("ENOENT: wt.exe not found");
    });
    mockSpawn.mockImplementationOnce(() => makeSpawnChild());

    await program.parseAsync(["node", "test", "open", "tr-orchestrator"]);

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(mockSpawn.mock.calls[1][0]).toBe("cmd.exe");
    expect(mockSpawn.mock.calls[1][1]).toEqual([
      "/c", "start", "ao:tr-orchestrator",
      "/d", TEST_REPO_PATH,
      "cmd.exe", "/k", "ao", "session", "attach", "tr-orchestrator",
    ]);
  });

  it("falls back to dashboard URL when both terminal launchers fail", async () => {
    mockListRef.current = [makeSession("tr-orchestrator", "test-repo")];
    mockSpawn.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    await program.parseAsync(["node", "test", "open", "tr-orchestrator"]);

    expect(mockOpenUrl).toHaveBeenCalledWith(
      "http://localhost:3000/projects/test-repo/sessions/tr-orchestrator",
    );
  });

  it("--browser skips terminal spawn and opens URL directly", async () => {
    mockListRef.current = [makeSession("tr-orchestrator", "test-repo")];

    await program.parseAsync(["node", "test", "open", "-b", "tr-orchestrator"]);

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockOpenUrl).toHaveBeenCalledWith(
      "http://localhost:3000/projects/test-repo/sessions/tr-orchestrator",
    );
  });

  it("opens dashboard URL for terminated sessions instead of attempting attach", async () => {
    mockListRef.current = [makeSession("tr-orchestrator", "test-repo", "terminated")];

    await program.parseAsync(["node", "test", "open", "tr-orchestrator"]);

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockOpenUrl).toHaveBeenCalledWith(
      "http://localhost:3000/projects/test-repo/sessions/tr-orchestrator",
    );
    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("(terminated)");
  });
});

describe("open command (Linux)", () => {
  beforeEach(() => {
    mockIsMacRef.current = false;
    mockIsWindowsRef.current = false;
  });

  it("opens the dashboard URL (no terminal-spawn helper exists)", async () => {
    mockListRef.current = [makeSession("app-1", "my-app")];

    await program.parseAsync(["node", "test", "open", "app-1"]);

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockExec).not.toHaveBeenCalled();
    expect(mockOpenUrl).toHaveBeenCalledWith(
      "http://localhost:3000/projects/my-app/sessions/app-1",
    );
  });
});
