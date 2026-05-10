/**
 * Regression tests for plugin-internal activity events (issue #1659).
 *
 * Covers the MUST emit: workspace.post_create_failed, plus the SHOULDs
 * workspace.branch_collision and workspace.destroy_fell_back.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — declared before any import that uses the mocked modules
// ---------------------------------------------------------------------------

const { recordActivityEventMock } = vi.hoisted(() => ({
  recordActivityEventMock: vi.fn(),
}));

vi.mock("@aoagents/ao-core", async () => {
  const actual = (await vi.importActual("@aoagents/ao-core")) as Record<string, unknown>;
  return {
    ...actual,
    recordActivityEvent: recordActivityEventMock,
  };
});

vi.mock("node:child_process", () => {
  const mockExecFile = vi.fn();
  (mockExecFile as unknown as Record<symbol, unknown>)[Symbol.for("nodejs.util.promisify.custom")] =
    vi.fn();
  return { execFile: mockExecFile };
});

vi.mock("node:fs", () => ({
  cpSync: vi.fn(),
  existsSync: vi.fn(() => false),
  linkSync: vi.fn(),
  lstatSync: vi.fn(),
  statSync: vi.fn(),
  symlinkSync: vi.fn(),
  rmSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(),
}));

vi.mock("node:os", () => ({ homedir: () => "/mock-home" }));

import * as childProcess from "node:child_process";
import { create } from "../index.js";
import type { ProjectConfig, WorkspaceCreateConfig, WorkspaceInfo } from "@aoagents/ao-core/types";

const mockExecFileAsync = (childProcess.execFile as unknown as Record<symbol, unknown>)[
  Symbol.for("nodejs.util.promisify.custom")
] as ReturnType<typeof vi.fn>;

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

function makeWorkspaceInfo(): WorkspaceInfo {
  return {
    path: "/mock-home/.worktrees/myproject/session-1",
    branch: "feat/TEST-1",
    sessionId: "session-1",
    projectId: "myproject",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("workspace.post_create_failed (MUST emit)", () => {
  it("emits when a postCreate command fails, then rethrows", async () => {
    const ws = create();
    const project = makeProject({ postCreate: ["pnpm install"] });

    mockExecFileAsync.mockRejectedValueOnce(new Error("Command failed: exit 127"));

    await expect(ws.postCreate!(makeWorkspaceInfo(), project)).rejects.toThrow(
      "Command failed: exit 127",
    );

    expect(recordActivityEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "workspace",
        kind: "workspace.post_create_failed",
        level: "error",
        sessionId: "session-1",
        projectId: "myproject",
        data: expect.objectContaining({
          plugin: "workspace-worktree",
          command: "pnpm install",
          errorMessage: expect.stringContaining("exit 127"),
        }),
      }),
    );
  });

  it("does NOT emit when postCreate command succeeds", async () => {
    const ws = create();
    const project = makeProject({ postCreate: ["echo hi"] });

    mockExecFileAsync.mockResolvedValueOnce({ stdout: "hi\n", stderr: "" });

    await ws.postCreate!(makeWorkspaceInfo(), project);

    expect(recordActivityEventMock).not.toHaveBeenCalled();
  });
});

describe("workspace.branch_collision (SHOULD emit)", () => {
  it("emits when worktree add -b fails because branch already exists", async () => {
    const ws = create();

    // git remote get-url origin
    mockExecFileAsync.mockResolvedValueOnce({ stdout: "origin\n", stderr: "" });
    // git fetch origin --quiet
    mockExecFileAsync.mockResolvedValueOnce({ stdout: "", stderr: "" });
    // resolveBaseRef -> rev-parse origin/main
    mockExecFileAsync.mockResolvedValueOnce({ stdout: "abc\n", stderr: "" });
    // git worktree add -b ... → already exists
    mockExecFileAsync.mockRejectedValueOnce(
      new Error("fatal: a branch named 'feat/TEST-1' already exists"),
    );
    // rev-parse baseRef for stale-branch comparison
    mockExecFileAsync.mockResolvedValueOnce({ stdout: "abc\n", stderr: "" });
    // refExists(branchRef) -> true
    mockExecFileAsync.mockResolvedValueOnce({ stdout: "refs/heads/feat/TEST-1\n", stderr: "" });
    // rev-parse existing branch -> same as base, so reuse it
    mockExecFileAsync.mockResolvedValueOnce({ stdout: "abc\n", stderr: "" });
    // git worktree add (without -b) — succeeds
    mockExecFileAsync.mockResolvedValueOnce({ stdout: "", stderr: "" });

    await ws.create(makeCreateConfig());

    expect(recordActivityEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "workspace",
        kind: "workspace.branch_collision",
        level: "warn",
        projectId: "myproject",
        sessionId: "session-1",
        data: expect.objectContaining({
          plugin: "workspace-worktree",
          branch: "feat/TEST-1",
          errorMessage: expect.stringContaining("already exists"),
        }),
      }),
    );
  });
});

describe("workspace.destroy_fell_back (SHOULD emit)", () => {
  it("emits when destroy() falls back to rmSync after git failure", async () => {
    const ws = create();

    // git rev-parse --git-common-dir → fails
    mockExecFileAsync.mockRejectedValueOnce(new Error("not a git repository"));

    await ws.destroy("/some/stale/path");

    expect(recordActivityEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "workspace",
        kind: "workspace.destroy_fell_back",
        level: "warn",
        data: expect.objectContaining({
          plugin: "workspace-worktree",
          workspacePath: "/some/stale/path",
          errorMessage: expect.stringContaining("not a git repository"),
        }),
      }),
    );
  });
});
