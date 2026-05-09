import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ProjectConfig, WorkspaceCreateConfig, WorkspaceInfo } from "@aoagents/ao-core/types";

// ---------------------------------------------------------------------------
// Mocks — must be declared before any import that uses the mocked modules
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => {
  const mockExecFile = vi.fn();
  // Set custom promisify so `promisify(execFile)` returns { stdout, stderr }
  (mockExecFile as any)[Symbol.for("nodejs.util.promisify.custom")] = vi.fn();
  return { execFile: mockExecFile };
});

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  lstatSync: vi.fn(),
  statSync: vi.fn(),
  symlinkSync: vi.fn(),
  linkSync: vi.fn(),
  cpSync: vi.fn(),
  rmSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(),
}));

vi.mock("@aoagents/ao-core", () => ({
  getShell: vi.fn(() => ({ cmd: "sh", args: (c: string) => ["-c", c] })),
  isWindows: vi.fn(() => false),
}));

vi.mock("node:os", () => ({
  homedir: () => "/mock-home",
}));

// Force POSIX path semantics in tests so assertions like "/mock-home/..." match
// on Windows too. The real source uses platform-native path.join at runtime; we
// only override it for this test file's scope.
vi.mock("node:path", async () => {
  const actual = (await vi.importActual("node:path")) as { posix: unknown };
  return { ...(actual.posix as Record<string, unknown>), default: actual.posix };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import * as childProcess from "node:child_process";
import {
  existsSync,
  lstatSync,
  statSync,
  symlinkSync,
  linkSync,
  cpSync,
  rmSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import * as core from "@aoagents/ao-core";
import { create, manifest } from "../index.js";

// ---------------------------------------------------------------------------
// Typed mock references
// ---------------------------------------------------------------------------

const mockExecFileAsync = (childProcess.execFile as any)[
  Symbol.for("nodejs.util.promisify.custom")
] as ReturnType<typeof vi.fn>;

const mockExistsSync = existsSync as ReturnType<typeof vi.fn>;
const mockLstatSync = lstatSync as ReturnType<typeof vi.fn>;
const mockStatSync = statSync as ReturnType<typeof vi.fn>;
const mockSymlinkSync = symlinkSync as ReturnType<typeof vi.fn>;
const mockLinkSync = linkSync as ReturnType<typeof vi.fn>;
const mockCpSync = cpSync as ReturnType<typeof vi.fn>;
const mockRmSync = rmSync as ReturnType<typeof vi.fn>;
const mockMkdirSync = mkdirSync as ReturnType<typeof vi.fn>;
const mockReaddirSync = readdirSync as ReturnType<typeof vi.fn>;
const mockGetShell = core.getShell as ReturnType<typeof vi.fn>;
const mockIsWindows = core.isWindows as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockGitSuccess(stdout: string) {
  mockExecFileAsync.mockResolvedValueOnce({ stdout: stdout + "\n", stderr: "" });
}

function mockGitError(message: string) {
  mockExecFileAsync.mockRejectedValueOnce(new Error(message));
}

function mockOriginRemote(fetchSucceeds = true) {
  mockGitSuccess(""); // git remote get-url origin
  if (fetchSucceeds) {
    mockGitSuccess(""); // git fetch origin --quiet
  } else {
    mockGitError("Could not resolve host"); // git fetch origin --quiet
  }
}

function makeProject(overrides?: Partial<ProjectConfig>): ProjectConfig {
  return {
    name: "test-project",
    repo: "test/repo",
    path: "/repo/path",
    defaultBranch: "main",
    sessionPrefix: "test",
    ...overrides,
  };
}

function makeCreateConfig(overrides?: Partial<WorkspaceCreateConfig>): WorkspaceCreateConfig {
  return {
    projectId: "myproject",
    project: makeProject(),
    sessionId: "session-1",
    branch: "feat/TEST-1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Reset mocks before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// Tests
// ===========================================================================

describe("manifest", () => {
  it("has name 'worktree' and slot 'workspace'", () => {
    expect(manifest.name).toBe("worktree");
    expect(manifest.slot).toBe("workspace");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.description).toBe("Workspace plugin: git worktrees");
  });
});

describe("create() factory", () => {
  it("uses ~/.worktrees as default base dir", async () => {
    const ws = create();

    mockOriginRemote();
    mockGitSuccess(""); // git rev-parse --verify --quiet origin/main
    mockGitSuccess(""); // worktree add

    const info = await ws.create(makeCreateConfig());

    expect(info.path).toBe("/mock-home/.worktrees/myproject/session-1");
  });

  it("uses custom worktreeDir from config", async () => {
    const ws = create({ worktreeDir: "/custom/worktrees" });

    mockOriginRemote();
    mockGitSuccess(""); // git rev-parse --verify --quiet origin/main
    mockGitSuccess(""); // worktree add

    const info = await ws.create(makeCreateConfig());

    expect(info.path).toBe("/custom/worktrees/myproject/session-1");
  });

  it("expands tilde in custom worktreeDir", async () => {
    const ws = create({ worktreeDir: "~/custom-path" });

    mockOriginRemote();
    mockGitSuccess(""); // git rev-parse --verify --quiet origin/main
    mockGitSuccess(""); // worktree add

    const info = await ws.create(makeCreateConfig());

    expect(info.path).toBe("/mock-home/custom-path/myproject/session-1");
  });

  it("uses per-call worktreeDir override instead of plugin default", async () => {
    const ws = create(); // default: ~/.worktrees

    mockOriginRemote();
    mockGitSuccess(""); // git rev-parse --verify --quiet origin/main
    mockGitSuccess(""); // worktree add

    const info = await ws.create(
      makeCreateConfig({
        worktreeDir: "/mock-home/.agent-orchestrator/projects/myproject/worktrees",
      }),
    );

    // worktreeDir is used directly (not joined with projectId) — session-manager passes the project-scoped dir
    expect(info.path).toBe("/mock-home/.agent-orchestrator/projects/myproject/worktrees/session-1");
  });

  it("per-call worktreeDir overrides plugin-level worktreeDir", async () => {
    const ws = create({ worktreeDir: "/old/worktrees" });

    mockOriginRemote();
    mockGitSuccess(""); // git rev-parse --verify --quiet origin/main
    mockGitSuccess(""); // worktree add

    const info = await ws.create(makeCreateConfig({ worktreeDir: "/new/v2/worktrees" }));

    expect(info.path).toBe("/new/v2/worktrees/session-1");
  });
});

describe("workspace.create()", () => {
  it("calls git fetch and git worktree add with correct args", async () => {
    const ws = create();

    mockOriginRemote();
    mockGitSuccess(""); // git rev-parse --verify --quiet origin/main
    mockGitSuccess(""); // worktree add

    await ws.create(makeCreateConfig());

    // First call: git remote get-url origin
    expect(mockExecFileAsync).toHaveBeenCalledWith("git", ["remote", "get-url", "origin"], {
      cwd: "/repo/path",
      windowsHide: true, timeout: 30_000,
    });

    // Second call: git fetch origin --quiet
    expect(mockExecFileAsync).toHaveBeenCalledWith("git", ["fetch", "origin", "--quiet"], {
      cwd: "/repo/path",
      windowsHide: true, timeout: 30_000,
    });

    // Third call: git rev-parse --verify --quiet origin/main
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "--verify", "--quiet", "origin/main"],
      { cwd: "/repo/path", windowsHide: true, timeout: 30_000 },
    );

    // Fourth call: git worktree add -b <branch> <path> <baseRef>
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      [
        "worktree",
        "add",
        "-b",
        "feat/TEST-1",
        "/mock-home/.worktrees/myproject/session-1",
        "origin/main",
      ],
      { cwd: "/repo/path", windowsHide: true, timeout: 30_000 },
    );
  });

  it("creates the project worktree directory", async () => {
    const ws = create();

    mockOriginRemote();
    mockGitSuccess(""); // git rev-parse --verify --quiet origin/main
    mockGitSuccess(""); // worktree add

    await ws.create(makeCreateConfig());

    expect(mockMkdirSync).toHaveBeenCalledWith("/mock-home/.worktrees/myproject", {
      recursive: true,
    });
  });

  it("removes a stale unregistered worktree directory before creating a new worktree", async () => {
    const ws = create();

    mockExistsSync.mockReturnValueOnce(true);
    mockGitSuccess(""); // git worktree prune
    mockGitSuccess("worktree /repo/path\nHEAD deadbeef\nbranch refs/heads/main"); // git worktree list --porcelain
    mockOriginRemote();
    mockGitSuccess(""); // git rev-parse --verify --quiet origin/main
    mockGitSuccess(""); // worktree add

    await ws.create(makeCreateConfig());

    expect(mockRmSync).toHaveBeenCalledWith("/mock-home/.worktrees/myproject/session-1", {
      recursive: true,
      force: true,
    });

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      [
        "worktree",
        "add",
        "-b",
        "feat/TEST-1",
        "/mock-home/.worktrees/myproject/session-1",
        "origin/main",
      ],
      { cwd: "/repo/path", windowsHide: true, timeout: 30_000 },
    );
  });

  it("throws a useful error when the existing worktree path is still registered with git", async () => {
    const ws = create();

    mockExistsSync.mockReturnValueOnce(true);
    mockGitSuccess(""); // git worktree prune
    mockGitSuccess(
      "worktree /mock-home/.worktrees/myproject/session-1\nHEAD deadbeef\nbranch refs/heads/feat/TEST-1",
    ); // git worktree list --porcelain

    await expect(ws.create(makeCreateConfig())).rejects.toThrow(
      'Worktree path "/mock-home/.worktrees/myproject/session-1" already exists and is still registered with git',
    );
  });

  it("finds an adoptable worktree in the project-scoped worktree directory", async () => {
    const ws = create();

    mockGitSuccess(
      [
        "worktree /mock-home/.agent-orchestrator/projects/myproject/worktrees/session-1",
        "HEAD deadbeef",
        "branch refs/heads/feat/TEST-1",
      ].join("\n"),
    );
    mockExistsSync.mockReturnValueOnce(true);

    const info = await ws.findManagedWorkspace?.(
      makeCreateConfig({
        worktreeDir: "/mock-home/.agent-orchestrator/projects/myproject/worktrees",
      }),
    );

    expect(info).toEqual({
      path: "/mock-home/.agent-orchestrator/projects/myproject/worktrees/session-1",
      branch: "feat/TEST-1",
      sessionId: "session-1",
      projectId: "myproject",
    });
  });

  it("finds an adoptable worktree in the legacy managed worktree directory", async () => {
    const ws = create();

    mockGitSuccess(
      [
        "worktree /mock-home/.worktrees/myproject/session-1",
        "HEAD deadbeef",
        "branch refs/heads/feat/TEST-1",
      ].join("\n"),
    );
    mockExistsSync.mockReturnValueOnce(true);

    const info = await ws.findManagedWorkspace?.(
      makeCreateConfig({
        worktreeDir: "/mock-home/.agent-orchestrator/projects/myproject/worktrees",
      }),
    );

    expect(info?.path).toBe("/mock-home/.worktrees/myproject/session-1");
  });

  it("returns null when no managed worktree tracks the requested branch", async () => {
    const ws = create();

    mockGitSuccess(
      [
        "worktree /mock-home/.worktrees/myproject/session-2",
        "HEAD deadbeef",
        "branch refs/heads/feat/OTHER",
      ].join("\n"),
    );

    const info = await ws.findManagedWorkspace?.(makeCreateConfig());

    expect(info).toBeNull();
  });

  it("throws when the matching branch is checked out outside AO-managed worktree directories", async () => {
    const ws = create();

    mockGitSuccess(
      [
        "worktree /tmp/manual-worktree",
        "HEAD deadbeef",
        "branch refs/heads/feat/TEST-1",
      ].join("\n"),
    );
    mockExistsSync.mockReturnValueOnce(true);

    await expect(ws.findManagedWorkspace?.(makeCreateConfig())).rejects.toThrow(
      'outside AO-managed worktree directories',
    );
  });

  it("skips worktree entries whose path no longer exists on disk", async () => {
    const ws = create();

    // The worktree is listed by git but the directory was manually deleted
    mockGitSuccess(
      [
        "worktree /mock-home/.worktrees/myproject/session-1",
        "HEAD deadbeef",
        "branch refs/heads/feat/TEST-1",
      ].join("\n"),
    );
    // existsSync returns false for the deleted worktree path
    mockExistsSync.mockReturnValueOnce(false);

    const info = await ws.findManagedWorkspace?.(makeCreateConfig());

    expect(info).toBeNull();
  });

  it("handles CRLF line endings in git worktree list output", async () => {
    const ws = create();

    // Simulate Windows git output with \r\n line endings
    mockGitSuccess(
      [
        "worktree /mock-home/.worktrees/myproject/session-1",
        "HEAD deadbeef",
        "branch refs/heads/feat/TEST-1",
      ].join("\r\n"),
    );
    mockExistsSync.mockReturnValueOnce(true);

    const info = await ws.findManagedWorkspace?.(makeCreateConfig());

    expect(info).toEqual({
      path: "/mock-home/.worktrees/myproject/session-1",
      branch: "feat/TEST-1",
      sessionId: "session-1",
      projectId: "myproject",
    });
  });

  it("continues when fetch fails (offline)", async () => {
    const ws = create();

    mockOriginRemote(false);
    mockGitSuccess(""); // git rev-parse --verify --quiet origin/main
    mockGitSuccess(""); // worktree add succeeds

    const info = await ws.create(makeCreateConfig());

    expect(info.path).toBe("/mock-home/.worktrees/myproject/session-1");
  });

  it("uses refs/heads/<defaultBranch> when origin is missing", async () => {
    const ws = create();

    mockGitError("fatal: not a git repository"); // git remote get-url origin fails
    mockGitSuccess(""); // git rev-parse --verify --quiet refs/heads/main
    mockGitSuccess(""); // worktree add succeeds

    await ws.create(makeCreateConfig());

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "--verify", "--quiet", "refs/heads/main"],
      { cwd: "/repo/path", windowsHide: true, timeout: 30_000 },
    );

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      [
        "worktree",
        "add",
        "-b",
        "feat/TEST-1",
        "/mock-home/.worktrees/myproject/session-1",
        "refs/heads/main",
      ],
      { cwd: "/repo/path", windowsHide: true, timeout: 30_000 },
    );
  });

  it("throws when neither origin nor the local default branch can be resolved", async () => {
    const ws = create();

    mockGitError("fatal: not a git repository"); // git remote get-url origin fails
    mockGitError("fatal: invalid reference"); // git rev-parse --verify --quiet refs/heads/main

    await expect(ws.create(makeCreateConfig())).rejects.toThrow(
      'Unable to resolve base ref for default branch "main"',
    );
  });

  it("reuses an existing branch when it already matches the resolved base", async () => {
    const ws = create();

    mockOriginRemote();
    mockGitSuccess(""); // git rev-parse --verify --quiet origin/main
    mockGitError("already exists"); // worktree add -b fails
    mockGitSuccess("base-sha"); // git rev-parse origin/main
    mockGitSuccess(""); // git rev-parse --verify --quiet refs/heads/feat/TEST-1
    mockGitSuccess("base-sha"); // git rev-parse refs/heads/feat/TEST-1
    mockGitSuccess(""); // worktree add existing branch

    const info = await ws.create(makeCreateConfig());

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      ["worktree", "add", "/mock-home/.worktrees/myproject/session-1", "feat/TEST-1"],
      { cwd: "/repo/path", windowsHide: true, timeout: 30_000 },
    );

    expect(info.branch).toBe("feat/TEST-1");
  });

  it("resets an existing stale branch against the resolved base", async () => {
    const ws = create();

    mockOriginRemote();
    mockGitSuccess(""); // git rev-parse --verify --quiet origin/main
    mockGitError("already exists"); // worktree add -b fails
    mockGitSuccess("base-sha"); // git rev-parse origin/main
    mockGitSuccess(""); // git rev-parse --verify --quiet refs/heads/feat/TEST-1
    mockGitSuccess("old-sha"); // git rev-parse refs/heads/feat/TEST-1
    mockGitSuccess(""); // worktree add -B existing branch

    const info = await ws.create(makeCreateConfig());

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      [
        "worktree",
        "add",
        "-B",
        "feat/TEST-1",
        "/mock-home/.worktrees/myproject/session-1",
        "origin/main",
      ],
      { cwd: "/repo/path", windowsHide: true, timeout: 30_000 },
    );

    expect(info.branch).toBe("feat/TEST-1");
  });

  it("handles existing branch with local default branch when origin is missing", async () => {
    const ws = create();

    mockGitError("fatal: not a git repository"); // git remote get-url origin fails
    mockGitSuccess(""); // git rev-parse --verify --quiet refs/heads/main
    mockGitError("already exists"); // worktree add -b fails
    mockGitSuccess("base-sha"); // git rev-parse refs/heads/main
    mockGitSuccess(""); // git rev-parse --verify --quiet refs/heads/feat/TEST-1
    mockGitSuccess("base-sha"); // git rev-parse refs/heads/feat/TEST-1
    mockGitSuccess(""); // worktree add existing branch

    const info = await ws.create(makeCreateConfig());

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      ["worktree", "add", "/mock-home/.worktrees/myproject/session-1", "feat/TEST-1"],
      { cwd: "/repo/path", windowsHide: true, timeout: 30_000 },
    );

    expect(info.branch).toBe("feat/TEST-1");
  });

  it("cleans up worktree on retry failure", async () => {
    const ws = create();

    mockOriginRemote();
    mockGitSuccess(""); // git rev-parse --verify --quiet origin/main
    mockGitError("already exists"); // worktree add -b fails
    mockGitSuccess("base-sha"); // git rev-parse origin/main
    mockGitSuccess(""); // git rev-parse --verify --quiet refs/heads/feat/TEST-1
    mockGitSuccess("old-sha"); // git rev-parse refs/heads/feat/TEST-1
    mockGitError("worktree add failed: branch checked out"); // worktree add -B fails
    mockGitSuccess(""); // worktree remove (cleanup)

    await expect(ws.create(makeCreateConfig())).rejects.toThrow(
      'Failed to create worktree for branch "feat/TEST-1": worktree add failed: branch checked out',
    );

    // Verify cleanup was attempted
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "--force", "/mock-home/.worktrees/myproject/session-1"],
      { cwd: "/repo/path", windowsHide: true, timeout: 30_000 },
    );
  });

  it("still throws the retry failure even if cleanup fails", async () => {
    const ws = create();

    mockOriginRemote();
    mockGitSuccess(""); // git rev-parse --verify --quiet origin/main
    mockGitError("already exists"); // worktree add -b fails
    mockGitSuccess("base-sha"); // git rev-parse origin/main
    mockGitSuccess(""); // git rev-parse --verify --quiet refs/heads/feat/TEST-1
    mockGitSuccess("old-sha"); // git rev-parse refs/heads/feat/TEST-1
    mockGitError("worktree add failed"); // worktree add -B fails
    mockGitError("worktree remove failed"); // cleanup also fails

    await expect(ws.create(makeCreateConfig())).rejects.toThrow(
      'Failed to create worktree for branch "feat/TEST-1": worktree add failed',
    );
  });

  it("throws for non-already-exists worktree add errors", async () => {
    const ws = create();

    mockOriginRemote();
    mockGitSuccess(""); // git rev-parse --verify --quiet origin/main
    mockGitError("fatal: invalid reference"); // worktree add fails with other error

    await expect(ws.create(makeCreateConfig())).rejects.toThrow(
      'Failed to create worktree for branch "feat/TEST-1": fatal: invalid reference',
    );
  });

  it("rejects invalid projectId", async () => {
    const ws = create();

    await expect(ws.create(makeCreateConfig({ projectId: "bad/project" }))).rejects.toThrow(
      'Invalid projectId "bad/project"',
    );
  });

  it("rejects projectId with dots", async () => {
    const ws = create();

    await expect(ws.create(makeCreateConfig({ projectId: "my.project" }))).rejects.toThrow(
      'Invalid projectId "my.project"',
    );
  });

  it("rejects invalid sessionId", async () => {
    const ws = create();

    await expect(ws.create(makeCreateConfig({ sessionId: "../escape" }))).rejects.toThrow(
      'Invalid sessionId "../escape"',
    );
  });

  it("rejects sessionId with spaces", async () => {
    const ws = create();

    await expect(ws.create(makeCreateConfig({ sessionId: "bad session" }))).rejects.toThrow(
      'Invalid sessionId "bad session"',
    );
  });

  it("returns correct WorkspaceInfo", async () => {
    const ws = create();

    mockOriginRemote();
    mockGitSuccess(""); // git rev-parse --verify --quiet origin/main
    mockGitSuccess(""); // worktree add

    const info = await ws.create(makeCreateConfig());

    expect(info).toEqual({
      path: "/mock-home/.worktrees/myproject/session-1",
      branch: "feat/TEST-1",
      sessionId: "session-1",
      projectId: "myproject",
    });
  });

  it("expands tilde in project path", async () => {
    const ws = create();

    mockOriginRemote();
    mockGitSuccess(""); // git rev-parse --verify --quiet origin/main
    mockGitSuccess(""); // worktree add

    await ws.create(
      makeCreateConfig({
        project: makeProject({ path: "~/my-repo" }),
      }),
    );

    // fetch should use expanded path
    expect(mockExecFileAsync).toHaveBeenCalledWith("git", ["fetch", "origin", "--quiet"], {
      cwd: "/mock-home/my-repo",
      windowsHide: true, timeout: 30_000,
    });
  });

  it("uses the local default branch when origin remote is missing", async () => {
    const ws = create();

    mockGitError("fatal: not a git repository"); // git remote get-url origin fails
    mockGitSuccess(""); // git rev-parse --verify --quiet refs/heads/main
    mockGitSuccess(""); // worktree add

    await ws.create(makeCreateConfig());

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      [
        "worktree",
        "add",
        "-b",
        "feat/TEST-1",
        "/mock-home/.worktrees/myproject/session-1",
        "refs/heads/main",
      ],
      { cwd: "/repo/path", windowsHide: true, timeout: 30_000 },
    );
  });
});

describe("workspace.restore()", () => {
  it("prefers origin branch refs when origin exists", async () => {
    const ws = create();

    mockGitSuccess(""); // git worktree prune
    mockOriginRemote();
    mockGitError("fatal: invalid reference"); // git worktree add workspacePath cfg.branch fails
    mockGitError("fatal: bad ref"); // refExists(refs/heads/feat/TEST-1) → false (branch missing)
    // createBranchFromBase → cleanupStaleWorkspacePath
    mockGitSuccess(""); // worktree remove --force <path> (best-effort)
    mockExistsSync.mockReturnValueOnce(false); // no leftover dir, skip cleanup
    mockGitSuccess(""); // git rev-parse --verify --quiet origin/feat/TEST-1
    mockGitSuccess(""); // git worktree add -b cfg.branch workspacePath origin/feat/TEST-1

    const info = await ws.restore!(makeCreateConfig(), "/mock-home/.worktrees/myproject/session-1");

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      [
        "worktree",
        "add",
        "-b",
        "feat/TEST-1",
        "/mock-home/.worktrees/myproject/session-1",
        "origin/feat/TEST-1",
      ],
      { cwd: "/repo/path", windowsHide: true, timeout: 30_000 },
    );

    expect(info.branch).toBe("feat/TEST-1");
  });

  it("uses the local default branch when origin remote is missing", async () => {
    const ws = create();

    mockGitSuccess(""); // git worktree prune
    mockGitError("fatal: not a git repository"); // git remote get-url origin fails
    mockGitError("fatal: invalid reference"); // git worktree add workspacePath cfg.branch fails
    mockGitError("fatal: bad ref"); // refExists(refs/heads/feat/TEST-1) → false (branch missing)
    // createBranchFromBase → cleanupStaleWorkspacePath
    mockGitSuccess(""); // worktree remove --force <path> (best-effort)
    mockExistsSync.mockReturnValueOnce(false); // no leftover dir, skip cleanup
    mockGitSuccess(""); // git rev-parse --verify --quiet refs/heads/main
    mockGitSuccess(""); // git worktree add -b cfg.branch workspacePath refs/heads/main

    const info = await ws.restore!(makeCreateConfig(), "/mock-home/.worktrees/myproject/session-1");

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      [
        "worktree",
        "add",
        "-b",
        "feat/TEST-1",
        "/mock-home/.worktrees/myproject/session-1",
        "refs/heads/main",
      ],
      { cwd: "/repo/path", windowsHide: true, timeout: 30_000 },
    );

    expect(info).toEqual({
      path: "/mock-home/.worktrees/myproject/session-1",
      branch: "feat/TEST-1",
      sessionId: "session-1",
      projectId: "myproject",
    });
  });

  // --- Regression coverage for #1741 ---------------------------------------
  // When the local session branch already exists (destroy() preserves it on
  // purpose), restore() must re-attach it instead of falling through to the
  // -b path that would either fail ("branch already exists") or discard
  // commits. See https://github.com/ComposioHQ/agent-orchestrator/issues/1741.
  //
  // The recovery sequence (in reattachExistingBranch):
  //   1. `git worktree remove --force <path>` (best-effort: clears registry)
  //   2. existsSync(<path>) — bail if dir already gone
  //   3. `git worktree list --porcelain` (isRegisteredWorktree)
  //   4. rmSync(<path>) if not still registered (else throw — data safety)
  //   5. `git worktree add <path> <branch>` retry (no -b/-B)
  //
  // The entry-point prune in restore() is sufficient — no second prune in
  // the recovery path.

  it("re-attaches existing local branch when stale registry conflicts", async () => {
    // Path was registered as a worktree but the dir was already cleaned up.
    // worktree remove --force succeeds; the stale-dir cleanup short-circuits
    // because existsSync returns false; retry succeeds.
    const ws = create();

    mockGitSuccess(""); // git worktree prune (entry-point)
    mockOriginRemote();
    mockGitError("fatal: 'feat/TEST-1' is already checked out"); // first worktree add fails
    mockGitSuccess(""); // refExists(refs/heads/feat/TEST-1) → true
    mockGitSuccess(""); // worktree remove --force <path>
    mockExistsSync.mockReturnValueOnce(false); // no leftover dir, skip cleanup
    mockGitSuccess(""); // RETRY: worktree add <path> <branch> succeeds

    const info = await ws.restore!(makeCreateConfig(), "/mock-home/.worktrees/myproject/session-1");

    // The recovery call must re-attach the existing branch — no -b, no -B.
    expect(mockExecFileAsync).toHaveBeenLastCalledWith(
      "git",
      ["worktree", "add", "/mock-home/.worktrees/myproject/session-1", "feat/TEST-1"],
      { cwd: "/repo/path", windowsHide: true, timeout: 30_000 },
    );

    // No -b or -B should ever appear when the branch already exists locally.
    const calls = mockExecFileAsync.mock.calls;
    for (const [, args] of calls) {
      if (Array.isArray(args)) {
        expect(args).not.toContain("-b");
        expect(args).not.toContain("-B");
      }
    }

    expect(info).toEqual({
      path: "/mock-home/.worktrees/myproject/session-1",
      branch: "feat/TEST-1",
      sessionId: "session-1",
      projectId: "myproject",
    });
  });

  it("rmSyncs a stale workspace directory before retrying worktree add", async () => {
    // Direct repro of the user's #1741 follow-on failure: the dir physically
    // exists on disk (workspace.exists() returned false because it's not a
    // git working tree, just leftover files). worktree add fails with
    // "<path> already exists" — recovery must rmSync the stale dir, not loop.
    const ws = create();

    mockGitSuccess(""); // git worktree prune (entry-point)
    mockOriginRemote();
    mockGitError(
      "fatal: '/mock-home/.worktrees/myproject/session-1' already exists",
    ); // first worktree add fails because dir exists
    mockGitSuccess(""); // refExists → true
    mockGitError("fatal: not a working tree"); // worktree remove --force fails (path not registered)
    mockExistsSync.mockReturnValueOnce(true); // dir exists
    mockGitSuccess("worktree /some/other\nbranch refs/heads/main"); // worktree list — no entry for our path
    // rmSync called (mocked) — no second prune
    mockGitSuccess(""); // RETRY: worktree add succeeds

    const info = await ws.restore!(makeCreateConfig(), "/mock-home/.worktrees/myproject/session-1");

    // The stale dir must have been removed.
    expect(mockRmSync).toHaveBeenCalledWith("/mock-home/.worktrees/myproject/session-1", {
      recursive: true,
      force: true,
    });

    // Retry must be the no-flag form.
    expect(mockExecFileAsync).toHaveBeenLastCalledWith(
      "git",
      ["worktree", "add", "/mock-home/.worktrees/myproject/session-1", "feat/TEST-1"],
      { cwd: "/repo/path", windowsHide: true, timeout: 30_000 },
    );

    expect(info.branch).toBe("feat/TEST-1");
  });

  it("refuses to rmSync a still-registered worktree dir (data safety)", async () => {
    // If after `worktree remove --force` the path is STILL registered,
    // something is very wrong. reattachExistingBranch throws rather than
    // rmSync a registered worktree (which could destroy the user's work).
    // The error must propagate, not be swallowed.
    const ws = create();

    mockGitSuccess(""); // git worktree prune (entry-point)
    mockOriginRemote();
    mockGitError("fatal: 'feat/TEST-1' is already checked out"); // first worktree add fails
    mockGitSuccess(""); // refExists → true
    mockGitError("fatal: cannot remove"); // worktree remove --force fails
    mockExistsSync.mockReturnValueOnce(true); // dir exists
    // Path is still registered — isRegisteredWorktree returns our path
    mockGitSuccess(
      "worktree /mock-home/.worktrees/myproject/session-1\nbranch refs/heads/feat/TEST-1",
    );

    await expect(
      ws.restore!(makeCreateConfig(), "/mock-home/.worktrees/myproject/session-1"),
    ).rejects.toThrow(/already exists and is still registered/);

    // rmSync MUST NOT have been called — we never delete a registered worktree.
    expect(mockRmSync).not.toHaveBeenCalled();
  });

  it("propagates retry error when worktree add fails after cleanup", async () => {
    const ws = create();

    mockGitSuccess(""); // prune (entry-point)
    mockOriginRemote();
    mockGitError("fatal: first failure"); // first worktree add fails
    mockGitSuccess(""); // refExists → true
    mockGitSuccess(""); // worktree remove --force
    mockExistsSync.mockReturnValueOnce(false); // no leftover dir, skip cleanup
    mockGitError("fatal: persistent failure"); // RETRY also fails

    await expect(
      ws.restore!(makeCreateConfig(), "/mock-home/.worktrees/myproject/session-1"),
    ).rejects.toThrow(/persistent failure/);

    // Crucially, the failure surface is the underlying git error — NOT a
    // misleading "branch already exists" from a -b fallback.
    const calls = mockExecFileAsync.mock.calls;
    for (const [, args] of calls) {
      if (Array.isArray(args)) {
        expect(args).not.toContain("-b");
        expect(args).not.toContain("-B");
      }
    }
  });

  it("never force-resets an existing branch (preserves session commits)", async () => {
    // Defense-in-depth: confirm restore() never uses -B even in the
    // recovery path. -B would silently discard the user's commits,
    // which is the opposite of what restore must do.
    const ws = create();

    mockGitSuccess(""); // prune (entry-point)
    mockOriginRemote();
    mockGitError("fatal: registry conflict"); // first worktree add fails
    mockGitSuccess(""); // refExists → true
    mockGitSuccess(""); // worktree remove --force
    mockExistsSync.mockReturnValueOnce(false); // no leftover dir, skip cleanup
    mockGitSuccess(""); // RETRY succeeds

    await ws.restore!(makeCreateConfig(), "/mock-home/.worktrees/myproject/session-1");

    const calls = mockExecFileAsync.mock.calls;
    const dashBigB = calls.filter(([, args]) => Array.isArray(args) && args.includes("-B"));
    expect(dashBigB).toHaveLength(0);
  });

  it("checks branch existence with rev-parse --verify --quiet refs/heads/<branch>", async () => {
    // Lock in the exact ref form used. If someone later refactors refExists or
    // forgets the refs/heads/ prefix, this regression test catches it.
    const ws = create();

    mockGitSuccess(""); // prune (entry-point)
    mockOriginRemote();
    mockGitError("fatal: first failure"); // first worktree add fails
    mockGitSuccess(""); // refExists → true
    mockGitSuccess(""); // worktree remove --force
    mockExistsSync.mockReturnValueOnce(false); // no leftover dir, skip cleanup
    mockGitSuccess(""); // RETRY succeeds

    await ws.restore!(makeCreateConfig(), "/mock-home/.worktrees/myproject/session-1");

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "--verify", "--quiet", "refs/heads/feat/TEST-1"],
      { cwd: "/repo/path", windowsHide: true, timeout: 30_000 },
    );
  });

  it("matches registered worktree even when workspacePath has trailing slash", async () => {
    // Path normalization safety: if `workspacePath` is passed in a non-canonical
    // form (trailing slash, ".." segments) and git reports a canonical path,
    // strict string equality false-negatives. That would mistakenly rmSync a
    // still-registered worktree → DATA LOSS. Both sides must be resolve()d.
    const ws = create();

    mockGitSuccess(""); // entry-point prune
    mockOriginRemote();
    mockGitError("fatal: 'feat/TEST-1' is already checked out"); // first worktree add fails
    mockGitSuccess(""); // refExists → true
    // reattachExistingBranch → cleanupStaleWorkspacePath
    mockGitError("fatal: cannot remove"); // worktree remove --force fails
    mockExistsSync.mockReturnValueOnce(true); // dir exists
    // git reports canonical path (no trailing slash); we call restore with trailing slash
    mockGitSuccess(
      "worktree /mock-home/.worktrees/myproject/session-1\nbranch refs/heads/feat/TEST-1",
    );

    await expect(
      ws.restore!(makeCreateConfig(), "/mock-home/.worktrees/myproject/session-1/"),
    ).rejects.toThrow(/already exists and is still registered/);

    // CRITICAL: rmSync MUST NOT have been called — the resolve() normalization
    // correctly identified the path as still-registered despite the trailing slash.
    expect(mockRmSync).not.toHaveBeenCalled();
  });

  it("createBranchFromBase also clears stale workspace dir before worktree add -b", async () => {
    // Mirror of the re-attach path: when the local branch is MISSING and the
    // workspacePath has stale state, createBranchFromBase must also do the
    // cleanup. Otherwise `git worktree add -b ...` fails with the same
    // "<path> already exists" error the re-attach path was fixed for.
    const ws = create();

    mockGitSuccess(""); // entry-point prune
    mockOriginRemote();
    mockGitError(
      "fatal: '/mock-home/.worktrees/myproject/session-1' already exists",
    ); // first worktree add fails
    mockGitError("fatal: bad ref"); // refExists → false (branch missing)
    // createBranchFromBase → cleanupStaleWorkspacePath
    mockGitError("fatal: not registered"); // worktree remove --force fails
    mockExistsSync.mockReturnValueOnce(true); // dir exists as junk
    mockGitSuccess("worktree /some/other\nbranch refs/heads/main"); // not registered
    // rmSync called (mocked)
    mockGitSuccess(""); // resolveBaseRef: rev-parse origin/feat/TEST-1
    mockGitSuccess(""); // worktree add -b ... origin/feat/TEST-1 succeeds

    const info = await ws.restore!(makeCreateConfig(), "/mock-home/.worktrees/myproject/session-1");

    // Stale dir must have been removed before -b add.
    expect(mockRmSync).toHaveBeenCalledWith("/mock-home/.worktrees/myproject/session-1", {
      recursive: true,
      force: true,
    });

    expect(info.branch).toBe("feat/TEST-1");
    expect(mockExecFileAsync).toHaveBeenLastCalledWith(
      "git",
      [
        "worktree",
        "add",
        "-b",
        "feat/TEST-1",
        "/mock-home/.worktrees/myproject/session-1",
        "origin/feat/TEST-1",
      ],
      { cwd: "/repo/path", windowsHide: true, timeout: 30_000 },
    );
  });

  it("happy path: restore re-attaches branch when first worktree add already succeeds", async () => {
    // No catch path — the first attempt works. Confirms we don't accidentally
    // run the cleanup/retry sequence in the common case.
    const ws = create();

    mockGitSuccess(""); // prune (entry-point)
    mockOriginRemote();
    mockGitSuccess(""); // worktree add <path> <branch> succeeds first try

    const info = await ws.restore!(makeCreateConfig(), "/mock-home/.worktrees/myproject/session-1");

    expect(info.branch).toBe("feat/TEST-1");
    // Total calls: prune + remote get-url + fetch + worktree add = 4
    expect(mockExecFileAsync).toHaveBeenCalledTimes(4);
  });
});

describe("workspace.destroy()", () => {
  it("removes worktree via git commands", async () => {
    const ws = create();

    // rev-parse returns the .git dir
    mockGitSuccess("/repo/path/.git");
    // worktree remove succeeds
    mockGitSuccess("");

    await ws.destroy("/mock-home/.worktrees/myproject/session-1");

    // First call: rev-parse
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: "/mock-home/.worktrees/myproject/session-1", windowsHide: true, timeout: 30_000 },
    );

    // Second call: worktree remove
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "--force", "/mock-home/.worktrees/myproject/session-1"],
      { cwd: "/repo/path", windowsHide: true, timeout: 30_000 },
    );
  });

  it("falls back to rmSync when git commands fail", async () => {
    const ws = create();

    mockGitError("not a git repository"); // rev-parse fails
    mockExistsSync.mockReturnValueOnce(true);

    await ws.destroy("/mock-home/.worktrees/myproject/session-1");

    expect(mockRmSync).toHaveBeenCalledWith("/mock-home/.worktrees/myproject/session-1", {
      recursive: true,
      force: true,
    });
  });

  it("does nothing if git fails and directory does not exist", async () => {
    const ws = create();

    mockGitError("not a git repository");
    mockExistsSync.mockReturnValueOnce(false);

    await ws.destroy("/nonexistent/path");

    expect(mockRmSync).not.toHaveBeenCalled();
  });

  it("retries rmSync on Windows when first attempts fail (file-handle drain)", async () => {
    mockIsWindows.mockReturnValue(true);
    const ws = create();

    mockGitError("not a git repository"); // force fallback
    // existsSync sequence: top guard (true), then between-retries checks
    mockExistsSync.mockReturnValueOnce(true); // destroy() top guard
    mockExistsSync.mockReturnValueOnce(true); // after attempt #1 — still there
    mockExistsSync.mockReturnValueOnce(true); // after attempt #2 — still there
    mockExistsSync.mockReturnValueOnce(false); // after attempt #3 — gone

    let calls = 0;
    mockRmSync.mockImplementation(() => {
      calls++;
      if (calls < 3) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
    });

    await ws.destroy("/mock-home/.worktrees/myproject/session-1");

    expect(mockRmSync.mock.calls.length).toBeGreaterThanOrEqual(3);
    mockIsWindows.mockReturnValue(false);
    mockRmSync.mockReset();
  });

  it("throws on Windows after exhausting retries (handles never released)", async () => {
    mockIsWindows.mockReturnValue(true);
    const ws = create();

    mockGitError("not a git repository");
    mockExistsSync.mockReturnValue(true); // always exists — never drains
    mockRmSync.mockImplementation(() => {
      throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
    });

    await expect(ws.destroy("/mock-home/.worktrees/myproject/session-1")).rejects.toThrow(
      /Windows file-handle drain/,
    );
    expect(mockRmSync.mock.calls.length).toBe(6);
    mockIsWindows.mockReturnValue(false);
    mockExistsSync.mockReset();
    mockRmSync.mockReset();
  });
});

describe("workspace.list()", () => {
  it("returns empty array when project directory does not exist", async () => {
    const ws = create();

    mockExistsSync.mockReturnValueOnce(false);

    const result = await ws.list("myproject");

    expect(result).toEqual([]);
  });

  it("returns empty array when project directory has no subdirectories", async () => {
    const ws = create();

    mockExistsSync.mockReturnValueOnce(true);
    mockReaddirSync.mockReturnValueOnce([]);

    const result = await ws.list("myproject");

    expect(result).toEqual([]);
  });

  it("parses worktree list porcelain output", async () => {
    const ws = create();

    mockExistsSync.mockReturnValueOnce(true);
    mockReaddirSync.mockReturnValueOnce([
      { name: "session-1", isDirectory: () => true },
      { name: "session-2", isDirectory: () => true },
    ]);

    const porcelainOutput = [
      "worktree /mock-home/.worktrees/myproject/session-1",
      "HEAD abc1234",
      "branch refs/heads/feat/TEST-1",
      "",
      "worktree /mock-home/.worktrees/myproject/session-2",
      "HEAD def5678",
      "branch refs/heads/feat/TEST-2",
      "",
      "worktree /repo/path",
      "HEAD 0000000",
      "branch refs/heads/main",
    ].join("\n");

    mockGitSuccess(porcelainOutput);

    const result = await ws.list("myproject");

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      path: "/mock-home/.worktrees/myproject/session-1",
      branch: "feat/TEST-1",
      sessionId: "session-1",
      projectId: "myproject",
    });
    expect(result[1]).toEqual({
      path: "/mock-home/.worktrees/myproject/session-2",
      branch: "feat/TEST-2",
      sessionId: "session-2",
      projectId: "myproject",
    });
  });

  it("handles detached HEAD worktrees", async () => {
    const ws = create();

    mockExistsSync.mockReturnValueOnce(true);
    mockReaddirSync.mockReturnValueOnce([{ name: "session-1", isDirectory: () => true }]);

    const porcelainOutput = [
      "worktree /mock-home/.worktrees/myproject/session-1",
      "HEAD abc1234",
      "detached",
    ].join("\n");

    mockGitSuccess(porcelainOutput);

    const result = await ws.list("myproject");

    expect(result).toHaveLength(1);
    expect(result[0].branch).toBe("detached");
  });

  it("excludes worktrees outside the project directory", async () => {
    const ws = create();

    mockExistsSync.mockReturnValueOnce(true);
    mockReaddirSync.mockReturnValueOnce([{ name: "session-1", isDirectory: () => true }]);

    const porcelainOutput = [
      "worktree /other/path/session-1",
      "HEAD abc1234",
      "branch refs/heads/feat/other",
      "",
      "worktree /mock-home/.worktrees/myproject/session-1",
      "HEAD def5678",
      "branch refs/heads/feat/TEST-1",
    ].join("\n");

    mockGitSuccess(porcelainOutput);

    const result = await ws.list("myproject");

    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe("session-1");
  });

  it("returns empty when all git worktree list calls fail", async () => {
    const ws = create();

    mockExistsSync.mockReturnValueOnce(true);
    mockReaddirSync.mockReturnValueOnce([{ name: "session-1", isDirectory: () => true }]);

    mockGitError("fatal: not a git repository");

    const result = await ws.list("myproject");

    expect(result).toEqual([]);
  });

  it("tries next directory when first worktree list fails", async () => {
    const ws = create();

    mockExistsSync.mockReturnValueOnce(true);
    mockReaddirSync.mockReturnValueOnce([
      { name: "session-1", isDirectory: () => true },
      { name: "session-2", isDirectory: () => true },
    ]);

    // First dir fails
    mockGitError("fatal: not a git repository");
    // Second dir succeeds
    const porcelainOutput = [
      "worktree /mock-home/.worktrees/myproject/session-2",
      "HEAD abc1234",
      "branch refs/heads/feat/TEST-2",
    ].join("\n");
    mockGitSuccess(porcelainOutput);

    const result = await ws.list("myproject");

    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe("session-2");
  });

  it("rejects invalid projectId", async () => {
    const ws = create();

    await expect(ws.list("bad/id")).rejects.toThrow('Invalid projectId "bad/id"');
  });

  it("filters out non-directory entries", async () => {
    const ws = create();

    mockExistsSync.mockReturnValueOnce(true);
    mockReaddirSync.mockReturnValueOnce([
      { name: "session-1", isDirectory: () => true },
      { name: ".DS_Store", isDirectory: () => false },
      { name: "readme.txt", isDirectory: () => false },
    ]);

    const porcelainOutput = [
      "worktree /mock-home/.worktrees/myproject/session-1",
      "HEAD abc1234",
      "branch refs/heads/feat/TEST-1",
    ].join("\n");

    mockGitSuccess(porcelainOutput);

    const result = await ws.list("myproject");

    expect(result).toHaveLength(1);
  });
});

describe("workspace.postCreate()", () => {
  const workspaceInfo: WorkspaceInfo = {
    path: "/mock-home/.worktrees/myproject/session-1",
    branch: "feat/TEST-1",
    sessionId: "session-1",
    projectId: "myproject",
  };

  it("creates symlinks for configured paths", async () => {
    const ws = create();
    const project = makeProject({ symlinks: ["node_modules", ".env"] });

    // First symlink: node_modules exists, target lstat throws (doesn't exist)
    mockExistsSync.mockReturnValueOnce(true); // sourcePath exists
    mockLstatSync.mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });

    // Second symlink: .env exists, target lstat throws (doesn't exist)
    mockExistsSync.mockReturnValueOnce(true); // sourcePath exists
    mockLstatSync.mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });

    await ws.postCreate!(workspaceInfo, project);

    expect(mockSymlinkSync).toHaveBeenCalledTimes(2);
    expect(mockSymlinkSync).toHaveBeenCalledWith(
      "/repo/path/node_modules",
      "/mock-home/.worktrees/myproject/session-1/node_modules",
    );
    expect(mockSymlinkSync).toHaveBeenCalledWith(
      "/repo/path/.env",
      "/mock-home/.worktrees/myproject/session-1/.env",
    );
  });

  it("removes existing target before symlinking", async () => {
    const ws = create();
    const project = makeProject({ symlinks: ["node_modules"] });

    mockExistsSync.mockReturnValueOnce(true); // sourcePath exists
    mockLstatSync.mockReturnValueOnce({
      isSymbolicLink: () => true,
      isFile: () => false,
      isDirectory: () => false,
    });

    await ws.postCreate!(workspaceInfo, project);

    expect(mockRmSync).toHaveBeenCalledWith(
      "/mock-home/.worktrees/myproject/session-1/node_modules",
      { recursive: true, force: true },
    );
    expect(mockSymlinkSync).toHaveBeenCalledTimes(1);
  });

  it("skips symlinks when source does not exist", async () => {
    const ws = create();
    const project = makeProject({ symlinks: ["nonexistent"] });

    mockExistsSync.mockReturnValueOnce(false); // sourcePath does not exist

    await ws.postCreate!(workspaceInfo, project);

    expect(mockSymlinkSync).not.toHaveBeenCalled();
  });

  it("rejects absolute symlink paths", async () => {
    const ws = create();
    const project = makeProject({ symlinks: ["/absolute/path"] });

    await expect(ws.postCreate!(workspaceInfo, project)).rejects.toThrow(
      'Invalid symlink path "/absolute/path": must be a relative path without ".." segments',
    );
  });

  it("rejects .. directory traversal in symlink paths", async () => {
    const ws = create();
    const project = makeProject({ symlinks: ["../escape"] });

    await expect(ws.postCreate!(workspaceInfo, project)).rejects.toThrow(
      'Invalid symlink path "../escape": must be a relative path without ".." segments',
    );
  });

  it("rejects .. embedded in symlink paths", async () => {
    const ws = create();
    const project = makeProject({ symlinks: ["foo/../../../etc/passwd"] });

    await expect(ws.postCreate!(workspaceInfo, project)).rejects.toThrow(
      'must be a relative path without ".." segments',
    );
  });

  it("rejects Windows drive-letter absolute symlink paths (e.g. C:\\path)", async () => {
    const ws = create();
    const project = makeProject({ symlinks: ["C:\\Windows\\System32"] });

    await expect(ws.postCreate!(workspaceInfo, project)).rejects.toThrow(
      'must be a relative path without ".." segments',
    );
  });

  it("rejects Windows UNC absolute symlink paths (e.g. \\\\server\\share)", async () => {
    const ws = create();
    const project = makeProject({ symlinks: ["\\\\server\\share\\file"] });

    await expect(ws.postCreate!(workspaceInfo, project)).rejects.toThrow(
      'must be a relative path without ".." segments',
    );
  });

  it("creates parent directories for nested symlink targets", async () => {
    const ws = create();
    const project = makeProject({ symlinks: ["config/settings"] });

    mockExistsSync.mockReturnValueOnce(true); // sourcePath exists
    mockLstatSync.mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });

    await ws.postCreate!(workspaceInfo, project);

    expect(mockMkdirSync).toHaveBeenCalledWith("/mock-home/.worktrees/myproject/session-1/config", {
      recursive: true,
    });
  });

  it("runs postCreate commands using getShell()", async () => {
    const ws = create();
    const project = makeProject({
      postCreate: ["pnpm install", "pnpm build"],
    });

    mockGetShell.mockReturnValue({ cmd: "sh", args: (c: string) => ["-c", c] });

    // Two shell calls
    mockExecFileAsync.mockResolvedValueOnce({ stdout: "", stderr: "" });
    mockExecFileAsync.mockResolvedValueOnce({ stdout: "", stderr: "" });

    await ws.postCreate!(workspaceInfo, project);

    expect(mockGetShell).toHaveBeenCalled();
    expect(mockExecFileAsync).toHaveBeenCalledWith("sh", ["-c", "pnpm install"], {
      cwd: "/mock-home/.worktrees/myproject/session-1",
      windowsHide: true,
    });
    expect(mockExecFileAsync).toHaveBeenCalledWith("sh", ["-c", "pnpm build"], {
      cwd: "/mock-home/.worktrees/myproject/session-1",
      windowsHide: true,
    });
  });

  it("uses Windows shell (pwsh) when getShell returns pwsh", async () => {
    const ws = create();
    const project = makeProject({ postCreate: ["npm install"] });

    mockGetShell.mockReturnValueOnce({
      cmd: "pwsh",
      args: (c: string) => ["-NoLogo", "-NonInteractive", "-Command", c],
    });
    mockExecFileAsync.mockResolvedValueOnce({ stdout: "", stderr: "" });

    await ws.postCreate!(workspaceInfo, project);

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      "pwsh",
      ["-NoLogo", "-NonInteractive", "-Command", "npm install"],
      { cwd: "/mock-home/.worktrees/myproject/session-1", windowsHide: true },
    );
  });

  it("falls back to junction for directories on Windows (B19)", async () => {
    const ws = create();
    const project = makeProject({ symlinks: ["node_modules"] });

    mockIsWindows.mockReturnValue(true);
    mockExistsSync.mockReturnValueOnce(true);
    mockLstatSync.mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });

    const symlinkError = Object.assign(new Error("symlink requires elevation"), { code: "EPERM" });
    mockSymlinkSync
      .mockImplementationOnce(() => {
        throw symlinkError;
      })
      .mockImplementationOnce(() => undefined); // junction succeeds
    mockStatSync.mockReturnValueOnce({ isDirectory: () => true });

    await ws.postCreate!(workspaceInfo, project);

    expect(mockSymlinkSync).toHaveBeenLastCalledWith(
      expect.stringContaining("node_modules"),
      expect.stringContaining("node_modules"),
      "junction",
    );
    expect(mockLinkSync).not.toHaveBeenCalled();
    expect(mockCpSync).not.toHaveBeenCalled();
  });

  it("falls back to hardlink for files on Windows (B19)", async () => {
    const ws = create();
    const project = makeProject({ symlinks: [".env"] });

    mockIsWindows.mockReturnValue(true);
    mockExistsSync.mockReturnValueOnce(true);
    mockLstatSync.mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });

    const symlinkError = Object.assign(new Error("symlink requires elevation"), { code: "EPERM" });
    mockSymlinkSync.mockImplementationOnce(() => {
      throw symlinkError;
    });
    mockStatSync.mockReturnValueOnce({ isDirectory: () => false });
    mockLinkSync.mockImplementationOnce(() => undefined);

    await ws.postCreate!(workspaceInfo, project);

    expect(mockLinkSync).toHaveBeenCalledWith(
      expect.stringContaining(".env"),
      expect.stringContaining(".env"),
    );
    expect(mockCpSync).not.toHaveBeenCalled();
  });

  it("falls back to cpSync when junction also fails on Windows (B19)", async () => {
    const ws = create();
    const project = makeProject({ symlinks: ["node_modules"] });

    mockIsWindows.mockReturnValue(true);
    mockExistsSync.mockReturnValueOnce(true);
    mockLstatSync.mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });

    const symlinkError = Object.assign(new Error("symlink requires elevation"), { code: "EPERM" });
    mockSymlinkSync
      .mockImplementationOnce(() => {
        throw symlinkError;
      })
      .mockImplementationOnce(() => {
        throw new Error("junction failed");
      });
    mockStatSync.mockReturnValueOnce({ isDirectory: () => true });

    await ws.postCreate!(workspaceInfo, project);

    expect(mockCpSync).toHaveBeenCalledWith(
      expect.stringContaining("node_modules"),
      expect.stringContaining("node_modules"),
      { recursive: true },
    );
  });

  it("re-throws symlink errors on non-Windows (B19)", async () => {
    const ws = create();
    const project = makeProject({ symlinks: ["node_modules"] });

    mockIsWindows.mockReturnValue(false);
    mockExistsSync.mockReturnValueOnce(true);
    mockLstatSync.mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });

    const symlinkError = new Error("permission denied");
    mockSymlinkSync.mockImplementationOnce(() => {
      throw symlinkError;
    });

    await expect(ws.postCreate!(workspaceInfo, project)).rejects.toThrow("permission denied");
    expect(mockCpSync).not.toHaveBeenCalled();
  });

  it("does nothing when no symlinks or postCreate configured", async () => {
    const ws = create();
    const project = makeProject();

    await ws.postCreate!(workspaceInfo, project);

    expect(mockSymlinkSync).not.toHaveBeenCalled();
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it("handles both symlinks and postCreate commands together", async () => {
    const ws = create();
    const project = makeProject({
      symlinks: ["node_modules"],
      postCreate: ["pnpm install"],
    });

    // Symlink: source exists, target doesn't
    mockExistsSync.mockReturnValueOnce(true);
    mockLstatSync.mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });

    // postCreate command
    mockExecFileAsync.mockResolvedValueOnce({ stdout: "", stderr: "" });

    await ws.postCreate!(workspaceInfo, project);

    expect(mockSymlinkSync).toHaveBeenCalledTimes(1);
    expect(mockExecFileAsync).toHaveBeenCalledWith("sh", ["-c", "pnpm install"], {
      cwd: "/mock-home/.worktrees/myproject/session-1",
      windowsHide: true,
    }); // getShell() returns { cmd: "sh", args: ["-c", cmd] } in tests
  });

  it("expands tilde in project path for symlink sources", async () => {
    const ws = create();
    const project = makeProject({ path: "~/my-repo", symlinks: ["data"] });

    mockExistsSync.mockReturnValueOnce(true);
    mockLstatSync.mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });

    await ws.postCreate!(workspaceInfo, project);

    expect(mockSymlinkSync).toHaveBeenCalledWith(
      "/mock-home/my-repo/data",
      "/mock-home/.worktrees/myproject/session-1/data",
    );
  });
});
