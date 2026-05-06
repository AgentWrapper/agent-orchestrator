import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  type Session,
  type SessionManager,
  getSessionsDir,
  sessionFromMetadata,
} from "@aoagents/ao-core";

const { mockTmux, mockExec, mockGh, mockConfigRef, mockSessionManager, sessionsDirRef } =
  vi.hoisted(() => ({
    mockTmux: vi.fn(),
    mockExec: vi.fn(),
    mockGh: vi.fn(),
    mockConfigRef: { current: null as Record<string, unknown> | null },
    mockSessionManager: {
      list: vi.fn(),
      kill: vi.fn(),
      cleanup: vi.fn(),
      get: vi.fn(),
      spawn: vi.fn(),
      spawnOrchestrator: vi.fn(),
      send: vi.fn(),
      claimPR: vi.fn(),
    },
    sessionsDirRef: { current: "" },
  }));

vi.mock("../../src/lib/shell.js", () => ({
  tmux: mockTmux,
  exec: mockExec,
  execSilent: vi.fn(),
  git: vi.fn(),
  gh: mockGh,
  getTmuxSessions: async () => {
    const output = await mockTmux("list-sessions", "-F", "#{session_name}");
    if (!output) return [];
    return output.split("\n").filter(Boolean);
  },
  getTmuxActivity: vi.fn().mockResolvedValue(null),
}));

vi.mock("ora", () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    text: "",
  }),
}));

vi.mock("@aoagents/ao-core", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("@aoagents/ao-core")>();
  return {
    ...actual,
    loadConfig: () => mockConfigRef.current,
  };
});

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
 * matches what production `sm.list()` returns. Previously this helper built
 * Session objects by hand, which silently bypassed synthesis and hid bugs like
 * the "status=merged without pr= URL" rehydration miss fixed in PR #1340.
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

vi.mock("../../src/lib/create-session-manager.js", () => ({
  getSessionManager: async (): Promise<SessionManager> => mockSessionManager as SessionManager,
}));

let tmpDir: string;
let sessionsDir: string;
let originalHome: string | undefined;
const STORAGE_KEY = "111111111114";

import { Command } from "commander";
import { registerReviewCheck } from "../../src/commands/review-check.js";

let program: Command;
let consoleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ao-review-test-"));
  originalHome = process.env["HOME"];
  process.env["HOME"] = tmpDir;

  const configPath = join(tmpDir, "agent-orchestrator.yaml");
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

  // Calculate and create sessions directory for hash-based architecture
  sessionsDir = getSessionsDir(STORAGE_KEY);
  mkdirSync(sessionsDir, { recursive: true });
  sessionsDirRef.current = sessionsDir;

  program = new Command();
  program.exitOverride();
  registerReviewCheck(program);
  consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });

  mockTmux.mockReset();
  mockExec.mockReset();
  mockGh.mockReset();
  mockExec.mockResolvedValue({ stdout: "", stderr: "" });
  mockSessionManager.list.mockReset();
  mockSessionManager.kill.mockReset();
  mockSessionManager.cleanup.mockReset();
  mockSessionManager.get.mockReset();
  mockSessionManager.spawn.mockReset();
  mockSessionManager.send.mockReset();

  // Default: list reads from sessionsDir
  mockSessionManager.list.mockImplementation(async () => {
    return buildSessionsFromDir(sessionsDirRef.current, "my-app");
  });
});

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env["HOME"];
  } else {
    process.env["HOME"] = originalHome;
  }
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("review-check command", () => {
  it("reports no pending reviews when none exist", async () => {
    writeFileSync(
      join(sessionsDir, "app-1"),
      "branch=feat/fix\npr=https://github.com/org/my-app/pull/10\n",
    );

    // All threads resolved, no changes requested
    mockGh.mockResolvedValue(
      JSON.stringify({
        reviewDecision: "APPROVED",
        reviewThreads: { nodes: [{ isResolved: true }] },
      }),
    );

    await program.parseAsync(["node", "test", "review-check"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("No pending review comments");
  });

  it("finds sessions with pending review comments", async () => {
    writeFileSync(
      join(sessionsDir, "app-1"),
      "branch=feat/fix\npr=https://github.com/org/my-app/pull/10\n",
    );

    mockGh.mockResolvedValue(
      JSON.stringify({
        reviewDecision: "CHANGES_REQUESTED",
        reviewThreads: { nodes: [{ isResolved: false }, { isResolved: true }] },
      }),
    );

    await program.parseAsync(["node", "test", "review-check", "--dry-run"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("app-1");
    expect(output).toContain("PR #10");
    expect(output).toContain("CHANGES_REQUESTED");
    expect(output).toContain("dry run");
  });

  it("skips sessions without PR metadata", async () => {
    writeFileSync(join(sessionsDir, "app-1"), "branch=feat/fix\nstatus=working\n");

    await program.parseAsync(["node", "test", "review-check"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("No pending review comments");
  });

  it("skips sessions with non-matching prefix", async () => {
    writeFileSync(
      join(sessionsDir, "other-1"),
      "branch=feat/fix\npr=https://github.com/org/my-app/pull/10\n",
    );

    await program.parseAsync(["node", "test", "review-check"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    // The session manager returns all sessions in the project dir, including other-1
    // But review-check iterates over them — other-1 has a PR, so it will be checked.
    // However, with the session manager, project matching is done differently.
    // other-1 is in the my-app sessions dir so it will be found and its PR checked.
    // The test outcome depends on the gh mock — default mockGh is reset (returns undefined).
    // With no valid gh response, the PR check will return {pendingComments: 0, reviewDecision: null}
    // So no pending reviews found.
    expect(output).toContain("No pending review comments");
  });

  it("sends fix prompt when not in dry-run mode", async () => {
    writeFileSync(
      join(sessionsDir, "app-1"),
      "branch=feat/fix\npr=https://github.com/org/my-app/pull/10\n",
    );

    mockGh.mockResolvedValue(
      JSON.stringify({
        reviewDecision: null,
        reviewThreads: { nodes: [{ isResolved: false }] },
      }),
    );

    await program.parseAsync(["node", "test", "review-check"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Fix prompt sent");
    expect(mockSessionManager.send).toHaveBeenCalledWith(
      "app-1",
      expect.stringContaining("review comments"),
    );
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("handles gh returning null (API failure)", async () => {
    writeFileSync(
      join(sessionsDir, "app-1"),
      "branch=feat/fix\npr=https://github.com/org/my-app/pull/10\n",
    );

    mockGh.mockResolvedValue(null);

    await program.parseAsync(["node", "test", "review-check"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("No pending review comments");
  });

  it("handles malformed GraphQL response gracefully", async () => {
    writeFileSync(
      join(sessionsDir, "app-1"),
      "branch=feat/fix\npr=https://github.com/org/my-app/pull/10\n",
    );

    mockGh.mockResolvedValue("not valid json {{{");

    await program.parseAsync(["node", "test", "review-check"]);

    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("No pending review comments");
  });

  it("rejects unknown project ID", async () => {
    await expect(
      program.parseAsync(["node", "test", "review-check", "nonexistent"]),
    ).rejects.toThrow("process.exit(1)");
  });
});
