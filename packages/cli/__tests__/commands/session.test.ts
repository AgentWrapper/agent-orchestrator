import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type * as ChildProcessModule from "node:child_process";
import {
  type Session,
  type CleanupResult,
  type SessionManager,
  SessionNotFoundError,
  createInitialCanonicalLifecycle,
  createActivitySignal,
  getSessionsDir,
  getProjectBaseDir,
  sessionFromMetadata,
} from "@aoagents/ao-core";

const {
  mockTmux,
  mockGit,
  mockGh,
  mockExec,
  mockSpawn,
  mockConfigRef,
  mockSessionManager,
  sessionsDirRef,
} = vi.hoisted(() => ({
  mockTmux: vi.fn(),
  mockGit: vi.fn(),
  mockGh: vi.fn(),
  mockExec: vi.fn(),
  mockSpawn: vi.fn(),
  mockConfigRef: { current: null as Record<string, unknown> | null },
  mockSessionManager: {
    list: vi.fn(),
    kill: vi.fn(),
    cleanup: vi.fn(),
    restore: vi.fn(),
    remap: vi.fn(),
    get: vi.fn(),
    spawn: vi.fn(),
    spawnOrchestrator: vi.fn(),
    send: vi.fn(),
    claimPR: vi.fn(),
  },
  sessionsDirRef: { current: "" },
}));

function makeMockChild(exitCode: number): EventEmitter {
  const child = new EventEmitter();
  queueMicrotask(() => {
    child.emit("exit", exitCode);
  });
  return child;
}

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => mockSpawn(...args),
  };
});

vi.mock("../../src/lib/shell.js", () => ({
  tmux: mockTmux,
  exec: mockExec,
  execSilent: vi.fn(),
  git: mockGit,
  gh: mockGh,
  getTmuxSessions: async () => {
    const output = await mockTmux("list-sessions", "-F", "#{session_name}");
    if (!output) return [];
    return output.split("\n").filter(Boolean);
  },
  getTmuxActivity: async (session: string) => {
    const output = await mockTmux("display-message", "-t", session, "-p", "#{session_activity}");
    if (!output) return null;
    const ts = parseInt(output, 10);
    return isNaN(ts) ? null : ts * 1000;
  },
}));

vi.mock("@aoagents/ao-core", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("@aoagents/ao-core")>();
  return {
    ...actual,
    loadConfig: () => mockConfigRef.current,
  };
});

vi.mock("../../src/lib/create-session-manager.js", () => ({
  getSessionManager: async (): Promise<SessionManager> => mockSessionManager as SessionManager,
}));

/** Parse a key=value metadata file into a Record<string, string>. */
function parseMetadata(content: string): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const idx = line.indexOf("=");
    if (idx > 0) {
      meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return meta;
}

/**
 * Build Session objects from metadata files in sessionsDir.
 *
 * Routes through the real `sessionFromMetadata()` so lifecycle reconstruction
 * (parseCanonicalLifecycle → synthesize*State → deriveLegacyStatus) runs
 * exactly as it does in production `sm.list()`. Tests that assert filter
 * behavior against on-disk metadata therefore exercise the full path, not a
 * shortcut that bypasses lifecycle synthesis.
 */
function buildSessionsFromDir(dir: string, projectId: string): Session[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => !f.startsWith(".") && f !== "archive");
  return files.map((name) => {
    const content = readFileSync(join(dir, name), "utf-8");
    const meta = parseMetadata(content);
    return sessionFromMetadata(name, meta, {
      projectId,
      runtimeHandle: { id: name, runtimeName: "tmux", data: {} },
    });
  });
}

let tmpDir: string;
let configPath: string;
let sessionsDir: string;
let originalHome: string | undefined;
const STORAGE_KEY = "111111111112";

import { Command } from "commander";
import { registerSession } from "../../src/commands/session.js";

let program: Command;
let consoleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ao-session-test-"));
  originalHome = process.env["HOME"];
  process.env["HOME"] = tmpDir;

  configPath = join(tmpDir, "agent-orchestrator.yaml");
  writeFileSync(configPath, "projects: {}");

  mockConfigRef.current = {
    configPath,
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
        path: join(tmpDir, "main-repo"),
        storageKey: STORAGE_KEY,
        defaultBranch: "main",
        sessionPrefix: "app",
      },
    },
    notifiers: {},
    notificationRouting: {},
    reactions: {},
  } as Record<string, unknown>;

  mkdirSync(join(tmpDir, "main-repo"), { recursive: true });

  // Calculate and create sessions directory for hash-based architecture
  sessionsDir = getSessionsDir(STORAGE_KEY);
  mkdirSync(sessionsDir, { recursive: true });
  sessionsDirRef.current = sessionsDir;

  program = new Command();
  program.exitOverride();
  registerSession(program);
  consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });

  mockTmux.mockReset();
  mockGit.mockReset();
  mockGh.mockReset();
  mockExec.mockReset();
  mockSpawn.mockReset();
  mockSessionManager.list.mockReset();
  mockSessionManager.kill.mockReset();
  mockSessionManager.cleanup.mockReset();
  mockSessionManager.restore.mockReset();
  mockSessionManager.remap.mockReset();
  mockSessionManager.get.mockReset();
  mockSessionManager.spawn.mockReset();
  mockSessionManager.send.mockReset();
  mockSessionManager.claimPR.mockReset();

  mockSpawn.mockImplementation(() => makeMockChild(0));

  // Default: list reads from sessionsDir
  mockSessionManager.list.mockImplementation(async () => {
    return buildSessionsFromDir(sessionsDirRef.current, "my-app");
  });

  // Default: kill resolves
  mockSessionManager.kill.mockResolvedValue(undefined);

  // Default: cleanup returns empty
  mockSessionManager.cleanup.mockResolvedValue({
    killed: [],
    skipped: [],
    errors: [],
  } satisfies CleanupResult);
  mockSessionManager.restore.mockResolvedValue(undefined);
  mockSessionManager.remap.mockResolvedValue("ses_mock");
  mockSessionManager.claimPR.mockResolvedValue({
    sessionId: "app-1",
    projectId: "my-app",
    pr: {
      number: 42,
      url: "https://github.com/org/repo/pull/42",
      title: "Existing PR",
      owner: "org",
      repo: "repo",
      branch: "feat/existing-pr",
      baseBranch: "main",
      isDraft: false,
    },
    branchChanged: true,
    githubAssigned: false,
    takenOverFrom: [],
  });
});

afterEach(() => {
  process.env["HOME"] = originalHome;
  // Clean up hash-based directories in ~/.agent-orchestrator
  const projectBaseDir = getProjectBaseDir(STORAGE_KEY);
  if (existsSync(projectBaseDir)) {
    rmSync(projectBaseDir, { recursive: true, force: true });
  }

  // Clean up tmpDir
  rmSync(tmpDir, { recursive: true, force: true });

  vi.restoreAllMocks();
});

describe("session ls", () => {
  it("shows project name as header when sessions exist", async () => {
    writeFileSync(join(sessionsDir, "app-1"), "branch=main\nstatus=working\n");

    mockTmux.mockResolvedValue(null);
    mockGit.mockResolvedValue(null);

    await program.parseAsync(["node", "test", "session", "ls"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("My App");
  });

  it("shows 'no active sessions' when none exist", async () => {
    mockTmux.mockResolvedValue(null);

    await program.parseAsync(["node", "test", "session", "ls"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("no active sessions");
  });

  it("lists sessions with metadata", async () => {
    writeFileSync(join(sessionsDir, "app-1"), "branch=feat/INT-100\nstatus=working\n");

    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1";
      if (args[0] === "display-message") {
        return String(Math.floor(Date.now() / 1000) - 60);
      }
      return null;
    });
    mockGit.mockResolvedValue(null);

    await program.parseAsync(["node", "test", "session", "ls"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("app-1");
    expect(output).toContain("feat/INT-100");
    expect(output).toContain("[working]");
  });

  it("gets live branch from worktree", async () => {
    writeFileSync(join(sessionsDir, "app-1"), "worktree=/tmp/wt\nbranch=old\nstatus=idle\n");

    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1";
      return null;
    });
    mockGit.mockResolvedValue("live-branch");

    await program.parseAsync(["node", "test", "session", "ls"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("live-branch");
  });

  it("shows PR URL when available", async () => {
    writeFileSync(
      join(sessionsDir, "app-1"),
      "branch=fix\nstatus=pr_open\npr=https://github.com/org/repo/pull/42\n",
    );

    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1";
      return null;
    });
    mockGit.mockResolvedValue(null);

    await program.parseAsync(["node", "test", "session", "ls"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("https://github.com/org/repo/pull/42");
  });

  it("outputs structured JSON when requested", async () => {
    writeFileSync(
      join(sessionsDir, "app-1"),
      "worktree=/tmp/wt\nbranch=feat/INT-100\nstatus=working\nissue=INT-100\npr=https://github.com/org/repo/pull/42\n",
    );

    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "display-message") {
        return "1710000000";
      }
      return null;
    });
    mockGit.mockResolvedValue("live-branch");

    await program.parseAsync(["node", "test", "session", "ls", "--json"]);

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(consoleSpy.mock.calls[0][0]))).toEqual({
      data: [
        {
          id: "app-1",
          projectId: "my-app",
          projectName: "My App",
          role: "worker",
          branch: "live-branch",
          // "working" on disk + a pr= URL reconstructs to pr_open via the
          // canonical lifecycle, which is what production sm.list() returns.
          status: "pr_open",
          issueId: "INT-100",
          pr: "https://github.com/org/repo/pull/42",
          workspacePath: "/tmp/wt",
          lastActivityAt: "2024-03-09T16:00:00.000Z",
        },
      ],
      meta: { hiddenTerminatedCount: 0 },
    });
  });

  it("filters terminal sessions from JSON by default and reports hidden count", async () => {
    writeFileSync(join(sessionsDir, "app-1"), "branch=main\nstatus=working\n");
    writeFileSync(join(sessionsDir, "app-done"), "branch=main\nstatus=merged\nactivity=exited\n");

    mockTmux.mockResolvedValue(null);
    mockGit.mockResolvedValue(null);

    await program.parseAsync(["node", "test", "session", "ls", "--json"]);

    const parsed = JSON.parse(String(consoleSpy.mock.calls[0][0])) as {
      data: Array<{ id: string }>;
      meta: { hiddenTerminatedCount: number };
    };
    expect(parsed.data.map((entry) => entry.id)).toEqual(["app-1"]);
    expect(parsed.meta.hiddenTerminatedCount).toBe(1);
  });

  it("marks metadata-based orchestrators correctly in JSON output", async () => {
    writeFileSync(
      join(sessionsDir, "app-control"),
      "branch=control\nstatus=working\nrole=orchestrator\n",
    );

    mockTmux.mockResolvedValue(null);
    mockGit.mockResolvedValue(null);

    await program.parseAsync(["node", "test", "session", "ls", "--json"]);

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(consoleSpy.mock.calls[0][0]))).toEqual({
      data: [
        {
          id: "app-control",
          projectId: "my-app",
          projectName: "My App",
          role: "orchestrator",
          branch: "control",
          status: "working",
          issueId: null,
          pr: null,
          workspacePath: null,
          lastActivityAt: null,
        },
      ],
      meta: { hiddenTerminatedCount: 0 },
    });
  });

  it("returns an empty JSON data array when there are no active sessions", async () => {
    mockTmux.mockResolvedValue(null);

    await program.parseAsync(["node", "test", "session", "ls", "--json"]);

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(consoleSpy.mock.calls[0][0]))).toEqual({
      data: [],
      meta: { hiddenTerminatedCount: 0 },
    });
  });

  it("hides terminated sessions by default and prints a footer", async () => {
    writeFileSync(join(sessionsDir, "app-1"), "branch=feat/a\nstatus=working\n");
    writeFileSync(join(sessionsDir, "app-2"), "branch=feat/b\nstatus=merged\n");
    writeFileSync(join(sessionsDir, "app-3"), "branch=feat/c\nstatus=killed\n");

    mockTmux.mockResolvedValue(null);
    mockGit.mockResolvedValue(null);

    await program.parseAsync(["node", "test", "session", "ls"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("app-1");
    expect(output).not.toContain("app-2");
    expect(output).not.toContain("app-3");
    expect(output).toContain("2 terminated sessions hidden");
    expect(output).toContain("--include-terminated");
  });

  it("shows terminated sessions when --include-terminated is passed", async () => {
    writeFileSync(join(sessionsDir, "app-1"), "branch=feat/a\nstatus=working\n");
    writeFileSync(join(sessionsDir, "app-2"), "branch=feat/b\nstatus=merged\n");

    mockTmux.mockResolvedValue(null);
    mockGit.mockResolvedValue(null);

    await program.parseAsync([
      "node",
      "test",
      "session",
      "ls",
      "--include-terminated",
    ]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("app-1");
    expect(output).toContain("app-2");
    expect(output).not.toContain("terminated sessions hidden");
  });

  it("reports hiddenTerminatedCount in JSON output when filtering terminal sessions", async () => {
    writeFileSync(join(sessionsDir, "app-1"), "branch=feat/a\nstatus=working\n");
    writeFileSync(join(sessionsDir, "app-2"), "branch=feat/b\nstatus=done\n");
    writeFileSync(join(sessionsDir, "app-3"), "branch=feat/c\nstatus=killed\n");

    mockTmux.mockResolvedValue(null);
    mockGit.mockResolvedValue(null);

    await program.parseAsync(["node", "test", "session", "ls", "--json"]);

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(String(consoleSpy.mock.calls[0][0]));
    expect(parsed.data).toHaveLength(1);
    expect(parsed.data[0].id).toBe("app-1");
    expect(parsed.meta.hiddenTerminatedCount).toBe(2);
  });

  it("returns hiddenTerminatedCount=0 in JSON when --include-terminated is passed", async () => {
    writeFileSync(join(sessionsDir, "app-1"), "branch=feat/a\nstatus=working\n");
    writeFileSync(join(sessionsDir, "app-2"), "branch=feat/b\nstatus=merged\n");

    mockTmux.mockResolvedValue(null);
    mockGit.mockResolvedValue(null);

    await program.parseAsync([
      "node",
      "test",
      "session",
      "ls",
      "--json",
      "--include-terminated",
    ]);

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(String(consoleSpy.mock.calls[0][0]));
    expect(parsed.data).toHaveLength(2);
    expect(parsed.meta.hiddenTerminatedCount).toBe(0);
  });

  it("hides legacy on-disk metadata with status=merged even when pr= URL is absent", async () => {
    // Regression test for the reviewer's smoke-test case on PR #1340: a metadata
    // file with `status=merged` but no `pr=` was still showing as active because
    // lifecycle reconstruction (synthesizePRState) collapsed pr.state to "none"
    // when the URL was missing, which made isTerminalSession() return false.
    writeFileSync(join(sessionsDir, "app-1"), "branch=feat/a\nstatus=working\n");
    writeFileSync(join(sessionsDir, "app-2"), "branch=feat/b\nstatus=merged\n"); // no pr=
    writeFileSync(join(sessionsDir, "app-3"), "branch=feat/c\nstatus=done\n");

    mockTmux.mockResolvedValue(null);
    mockGit.mockResolvedValue(null);

    await program.parseAsync(["node", "test", "session", "ls", "--json"]);

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(String(consoleSpy.mock.calls[0][0]));
    expect(parsed.data.map((e: { id: string }) => e.id)).toEqual(["app-1"]);
    expect(parsed.meta.hiddenTerminatedCount).toBe(2);
  });

  it("filters lifecycle-driven terminal sessions (runtime exited, pr merged, session terminated)", async () => {
    // Seed three sessions whose legacy status is non-terminal ("working"), but
    // whose canonical lifecycle marks them as terminal in three distinct ways.
    // This exercises the lifecycle branch of isTerminalSession (types.ts:250),
    // which short-circuits before TERMINAL_STATUSES is consulted.
    const makeLifecycleSession = (
      id: string,
      mutate: (lc: ReturnType<typeof createInitialCanonicalLifecycle>) => void,
    ): Session => {
      const lifecycle = createInitialCanonicalLifecycle("worker", new Date());
      lifecycle.session.state = "working";
      lifecycle.session.reason = "task_in_progress";
      lifecycle.runtime.state = "alive";
      lifecycle.runtime.reason = "process_running";
      mutate(lifecycle);
      return {
        id,
        projectId: "my-app",
        status: "working",
        activity: null,
        activitySignal: createActivitySignal("unavailable"),
        lifecycle,
        branch: null,
        issueId: null,
        pr: null,
        workspacePath: null,
        runtimeHandle: null,
        agentInfo: null,
        createdAt: new Date(),
        lastActivityAt: new Date(),
        metadata: {},
      } satisfies Session;
    };

    mockSessionManager.list.mockResolvedValue([
      makeLifecycleSession("app-1", () => {
        // alive — should remain visible
      }),
      makeLifecycleSession("app-2", (lc) => {
        lc.runtime.state = "exited";
        lc.runtime.reason = "process_not_running";
      }),
      makeLifecycleSession("app-3", (lc) => {
        lc.pr.state = "merged";
        lc.pr.reason = "merged_by_user";
      }),
      makeLifecycleSession("app-4", (lc) => {
        lc.session.state = "terminated";
        lc.session.reason = "manually_killed";
      }),
    ]);

    mockTmux.mockResolvedValue(null);
    mockGit.mockResolvedValue(null);

    await program.parseAsync(["node", "test", "session", "ls", "--json"]);

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(String(consoleSpy.mock.calls[0][0]));
    expect(parsed.data.map((e: { id: string }) => e.id)).toEqual(["app-1"]);
    expect(parsed.meta.hiddenTerminatedCount).toBe(3);
  });

  it("hides terminal-status sessions by default", async () => {
    writeFileSync(join(sessionsDir, "app-1"), "branch=main\nstatus=working\n");
    writeFileSync(join(sessionsDir, "app-done"), "branch=main\nstatus=merged\n");

    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-1\napp-done";
      if (args[0] === "display-message") {
        return String(Math.floor(Date.now() / 1000) - 60);
      }
      return null;
    });
    mockGit.mockResolvedValue(null);

    await program.parseAsync(["node", "test", "session", "ls"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("app-1");
    expect(output).not.toContain("app-done");
  });

  it("lists terminal sessions when --include-terminated is set", async () => {
    writeFileSync(join(sessionsDir, "app-done"), "branch=main\nstatus=merged\n");

    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-done";
      return null;
    });
    mockGit.mockResolvedValue(null);

    await program.parseAsync(["node", "test", "session", "ls", "--include-terminated"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("app-done");
  });

  it("prints a hint when only terminal sessions exist", async () => {
    writeFileSync(join(sessionsDir, "app-done"), "branch=main\nstatus=merged\n");

    mockTmux.mockImplementation(async (...args: string[]) => {
      if (args[0] === "list-sessions") return "app-done";
      return null;
    });

    await program.parseAsync(["node", "test", "session", "ls"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("--include-terminated");
    expect(output).not.toContain("app-done");
  });

  it("prints a hint when terminal sessions are hidden alongside active ones", async () => {
    writeFileSync(join(sessionsDir, "app-1"), "branch=main\nstatus=working\n");
    writeFileSync(join(sessionsDir, "app-done"), "branch=main\nstatus=merged\n");

    mockTmux.mockResolvedValue(null);
    mockGit.mockResolvedValue(null);

    await program.parseAsync(["node", "test", "session", "ls"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("app-1");
    expect(output).toContain("terminated session");
    expect(output).toContain("--include-terminated");
  });
});

describe("session kill", () => {
  it("rejects unknown session (no matching project)", async () => {
    mockSessionManager.kill.mockRejectedValue(new SessionNotFoundError("unknown-1"));

    await expect(
      program.parseAsync(["node", "test", "session", "kill", "unknown-1"]),
    ).rejects.toThrow("process.exit(1)");
  });

  it("kills session and reports success", async () => {
    writeFileSync(
      join(sessionsDir, "app-1"),
      "worktree=/tmp/wt\nbranch=feat/fix\nstatus=working\n",
    );

    mockSessionManager.kill.mockResolvedValue(undefined);

    await program.parseAsync(["node", "test", "session", "kill", "app-1"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Session app-1 killed.");
    expect(mockSessionManager.kill).toHaveBeenCalledWith("app-1", { purgeOpenCode: false });
  });

  it("calls session manager kill with the session name", async () => {
    writeFileSync(join(sessionsDir, "app-1"), "worktree=/tmp/test-wt\nbranch=main\n");

    mockSessionManager.kill.mockResolvedValue(undefined);

    await program.parseAsync(["node", "test", "session", "kill", "app-1"]);

    expect(mockSessionManager.kill).toHaveBeenCalledWith("app-1", { purgeOpenCode: false });
  });

  it("passes purge flag for OpenCode cleanup", async () => {
    mockSessionManager.kill.mockResolvedValue(undefined);

    await program.parseAsync(["node", "test", "session", "kill", "app-1", "--purge-session"]);

    expect(mockSessionManager.kill).toHaveBeenCalledWith("app-1", { purgeOpenCode: true });
  });
});

describe("session attach", () => {
  it("attaches to resolved runtime target when session exists", async () => {
    mockSessionManager.get.mockResolvedValue({
      id: "app-1",
      projectId: "my-app",
      status: "working",
      activity: null,
      branch: null,
      issueId: null,
      pr: null,
      workspacePath: null,
      runtimeHandle: { id: "tmux-target-1", runtimeName: "tmux", data: {} },
      agentInfo: null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      metadata: {},
    } satisfies Session);

    mockTmux.mockResolvedValue("");

    await program.parseAsync(["node", "test", "session", "attach", "app-1"]);

    expect(mockTmux).toHaveBeenCalledWith("has-session", "-t", "tmux-target-1");
    expect(mockSpawn).toHaveBeenCalledWith("tmux", ["attach", "-t", "tmux-target-1"], {
      stdio: "inherit",
    });
  });

  it("fails when tmux session does not exist", async () => {
    mockSessionManager.get.mockResolvedValue(null);
    mockTmux.mockResolvedValue(null);

    await expect(
      program.parseAsync(["node", "test", "session", "attach", "unknown-1"]),
    ).rejects.toThrow("process.exit(1)");
  });
});

describe("session claim-pr", () => {
  afterEach(() => {
    delete process.env["AO_SESSION_NAME"];
    delete process.env["AO_SESSION"];
  });

  it("claims a PR for an explicit session", async () => {
    await program.parseAsync([
      "node",
      "test",
      "session",
      "claim-pr",
      "42",
      "app-2",
      "--assign-on-github",
    ]);

    expect(mockSessionManager.claimPR).toHaveBeenCalledWith("app-2", "42", {
      assignOnGithub: true,
    });

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Session app-2 claimed PR #42");
    expect(output).toContain("feat/existing-pr");
  });

  it("uses AO_SESSION_NAME when session argument is omitted", async () => {
    process.env["AO_SESSION_NAME"] = "app-7";

    await program.parseAsync(["node", "test", "session", "claim-pr", "42"]);

    expect(mockSessionManager.claimPR).toHaveBeenCalledWith("app-7", "42", {
      assignOnGithub: undefined,
    });
  });

  it("fails when no session can be resolved", async () => {
    await expect(program.parseAsync(["node", "test", "session", "claim-pr", "42"])).rejects.toThrow(
      "process.exit(1)",
    );
  });
});

describe("session cleanup", () => {
  it("kills sessions with merged PRs", async () => {
    writeFileSync(
      join(sessionsDir, "app-1"),
      "branch=feat/fix\nstatus=merged\npr=https://github.com/org/repo/pull/42\n",
    );

    mockSessionManager.cleanup.mockResolvedValue({
      killed: ["app-1"],
      skipped: [],
      errors: [],
    } satisfies CleanupResult);

    await program.parseAsync(["node", "test", "session", "cleanup"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Cleaned: app-1");
    expect(output).toContain("Cleanup complete. 1 sessions cleaned");
  });

  it("does not kill sessions with open PRs", async () => {
    writeFileSync(
      join(sessionsDir, "app-1"),
      "branch=feat/fix\nstatus=pr_open\npr=https://github.com/org/repo/pull/42\n",
    );

    mockSessionManager.cleanup.mockResolvedValue({
      killed: [],
      skipped: ["app-1"],
      errors: [],
    } satisfies CleanupResult);

    await program.parseAsync(["node", "test", "session", "cleanup"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("No sessions to clean up");
  });

  it("dry run shows what would be cleaned without doing it", async () => {
    writeFileSync(
      join(sessionsDir, "app-1"),
      "branch=feat/fix\nstatus=merged\npr=https://github.com/org/repo/pull/42\n",
    );

    // Dry-run now delegates to sm.cleanup({ dryRun: true })
    mockSessionManager.cleanup.mockResolvedValue({
      killed: ["app-1"],
      skipped: [],
      errors: [],
    } satisfies CleanupResult);

    await program.parseAsync(["node", "test", "session", "cleanup", "--dry-run"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Would kill app-1");

    // Metadata should still exist (dry-run doesn't actually kill)
    expect(existsSync(join(sessionsDir, "app-1"))).toBe(true);

    // Verify dryRun option was passed
    expect(mockSessionManager.cleanup).toHaveBeenCalledWith(undefined, { dryRun: true });
  });

  it("reports errors from cleanup", async () => {
    writeFileSync(
      join(sessionsDir, "app-1"),
      "branch=feat/a\npr=https://github.com/org/repo/pull/10\n",
    );
    writeFileSync(
      join(sessionsDir, "app-2"),
      "branch=feat/b\npr=https://github.com/org/repo/pull/20\n",
    );

    mockSessionManager.cleanup.mockResolvedValue({
      killed: ["app-2"],
      skipped: [],
      errors: [{ sessionId: "app-1", error: "tmux error" }],
    } satisfies CleanupResult);

    await program.parseAsync(["node", "test", "session", "cleanup"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    const errOutput = vi
      .mocked(console.error)
      .mock.calls.map((c) => String(c[0]))
      .join("\n");
    // Error for first session reported
    expect(errOutput).toContain("Error cleaning app-1");
    // Second session cleaned
    expect(output).toContain("Cleaned: app-2");
  });

  it("suppresses orchestrator cleanup output while preserving worker cleanup output", async () => {
    mockSessionManager.cleanup.mockResolvedValue({
      killed: ["app-orchestrator", "app-2"],
      skipped: [],
      errors: [{ sessionId: "app-orchestrator", error: "should never surface" }],
    } satisfies CleanupResult);

    await program.parseAsync(["node", "test", "session", "cleanup"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    const errOutput = vi
      .mocked(console.error)
      .mock.calls.map((c) => String(c[0]))
      .join("\n");

    expect(output).toContain("Cleaned: app-2");
    expect(output).not.toContain("app-orchestrator");
    expect(output).toContain("Cleanup complete. 1 sessions cleaned");
    expect(errOutput).not.toContain("app-orchestrator");
  });

  it("treats orchestrator-only cleanup results as no-op output", async () => {
    mockSessionManager.cleanup.mockResolvedValue({
      killed: ["app-orchestrator"],
      skipped: [],
      errors: [],
    } satisfies CleanupResult);

    await program.parseAsync(["node", "test", "session", "cleanup"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("No sessions to clean up");
    expect(output).not.toContain("app-orchestrator");
  });

  it("suppresses orchestrators in cleanup dry-run output", async () => {
    mockSessionManager.cleanup.mockResolvedValue({
      killed: ["app-orchestrator", "app-3"],
      skipped: [],
      errors: [],
    } satisfies CleanupResult);

    await program.parseAsync(["node", "test", "session", "cleanup", "--dry-run"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Would kill app-3");
    expect(output).not.toContain("app-orchestrator");
    expect(output).toContain("1 session would be cleaned");
  });

  it("suppresses project-prefixed orchestrator cleanup results", async () => {
    mockSessionManager.cleanup.mockResolvedValue({
      killed: ["my-app:app-orchestrator", "my-app:app-4"],
      skipped: [],
      errors: [{ sessionId: "my-app:app-orchestrator", error: "should never surface" }],
    } satisfies CleanupResult);

    await program.parseAsync(["node", "test", "session", "cleanup"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    const errOutput = vi
      .mocked(console.error)
      .mock.calls.map((c) => String(c[0]))
      .join("\n");

    expect(output).toContain("Cleaned: my-app:app-4");
    expect(output).not.toContain("my-app:app-orchestrator");
    expect(output).toContain("Cleanup complete. 1 sessions cleaned");
    expect(errOutput).not.toContain("my-app:app-orchestrator");
  });

  it("skips sessions without metadata", async () => {
    // No metadata files exist — list returns empty, cleanup returns empty
    mockSessionManager.cleanup.mockResolvedValue({
      killed: [],
      skipped: [],
      errors: [],
    } satisfies CleanupResult);

    await program.parseAsync(["node", "test", "session", "cleanup"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("No sessions to clean up");
  });
});

describe("session remap", () => {
  it("remaps OpenCode session and reports mapped id", async () => {
    mockSessionManager.remap.mockResolvedValue("ses_123");

    await program.parseAsync(["node", "test", "session", "remap", "app-1"]);

    expect(mockSessionManager.remap).toHaveBeenCalledWith("app-1", false);
    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Session app-1 remapped.");
    expect(output).toContain("OpenCode session: ses_123");
  });

  it("passes force flag to remap", async () => {
    mockSessionManager.remap.mockResolvedValue("ses_123");

    await program.parseAsync(["node", "test", "session", "remap", "app-1", "--force"]);

    expect(mockSessionManager.remap).toHaveBeenCalledWith("app-1", true);
  });

  it("fails with exit code when remap errors", async () => {
    mockSessionManager.remap.mockRejectedValue(new Error("mapping failed"));

    await expect(program.parseAsync(["node", "test", "session", "remap", "app-1"])).rejects.toThrow(
      "process.exit(1)",
    );
  });
});
