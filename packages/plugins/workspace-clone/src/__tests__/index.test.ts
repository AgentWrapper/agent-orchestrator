import { describe, it, expect, vi, beforeEach } from "vitest";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import type { ProjectConfig } from "@aoagents/ao-core";

// Mock node:child_process with custom promisify support
vi.mock("node:child_process", () => {
  const mockExecFile = vi.fn();
  (mockExecFile as any)[Symbol.for("nodejs.util.promisify.custom")] = vi.fn();
  return { execFile: mockExecFile };
});

// Mock node:fs
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  rmSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(),
}));

// Mock node:os
vi.mock("node:os", () => ({
  homedir: () => "/mock-home",
}));

// Get reference to the promisify-custom mock — this is what the plugin actually calls
const mockExecFileAsync = (childProcess.execFile as any)[
  Symbol.for("nodejs.util.promisify.custom")
] as ReturnType<typeof vi.fn>;

/** Queue a successful git command with the given stdout. */
function mockGitSuccess(stdout: string) {
  mockExecFileAsync.mockResolvedValueOnce({ stdout: stdout + "\n", stderr: "" });
}

/** Queue a failed git command. */
function mockGitError(message: string) {
  mockExecFileAsync.mockRejectedValueOnce(new Error(message));
}

/** Create a ProjectConfig for testing. */
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

// Import after mocks are set up
import clonePlugin, { manifest, create } from "../index.js";

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------
describe("manifest", () => {
  it("has name 'clone' and slot 'workspace'", () => {
    expect(manifest.name).toBe("clone");
    expect(manifest.slot).toBe("workspace");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.description).toBe("Workspace plugin: git clone isolation");
  });

  it("default export includes manifest and create", () => {
    expect(clonePlugin.manifest).toBe(manifest);
    expect(clonePlugin.create).toBe(create);
  });
});

// ---------------------------------------------------------------------------
// create() factory
// ---------------------------------------------------------------------------
describe("create()", () => {
  it("returns a Workspace with name 'clone'", () => {
    const workspace = create();
    expect(workspace.name).toBe("clone");
  });

  it("uses ~/.ao-clones as default base dir", async () => {
    const workspace = create();

    // Setup: remote URL lookup
    mockGitSuccess("https://github.com/test/repo.git");
    // existsSync: workspace path does not exist yet
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    // git clone
    mockGitSuccess("");
    // git checkout -b
    mockGitSuccess("");

    const info = await workspace.create({
      projectId: "myproject",
      sessionId: "session-1",
      branch: "feat/test",
      project: makeProject(),
    });

    expect(info.path).toBe("/mock-home/.ao-clones/myproject/session-1");
  });

  it("uses custom cloneDir when configured", async () => {
    const workspace = create({ cloneDir: "~/custom-clones" });

    mockGitSuccess("https://github.com/test/repo.git");
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    mockGitSuccess("");
    mockGitSuccess("");

    const info = await workspace.create({
      projectId: "myproject",
      sessionId: "session-2",
      branch: "feat/custom",
      project: makeProject(),
    });

    expect(info.path).toBe("/mock-home/custom-clones/myproject/session-2");
  });
});

// ---------------------------------------------------------------------------
// workspace.create()
// ---------------------------------------------------------------------------
describe("workspace.create()", () => {
  it("gets remote URL via git remote get-url origin", async () => {
    const workspace = create();

    // 1: git remote get-url origin
    mockGitSuccess("https://github.com/test/repo.git");
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    // 2: git clone
    mockGitSuccess("");
    // 3: git checkout -b
    mockGitSuccess("");

    await workspace.create({
      projectId: "proj",
      sessionId: "sess",
      branch: "feat/branch",
      project: makeProject(),
    });

    // First call should be git remote get-url origin
    expect(mockExecFileAsync).toHaveBeenNthCalledWith(1, "git", ["remote", "get-url", "origin"], {
      cwd: "/repo/path",
    });
  });

  it("falls back to local path when remote URL lookup fails", async () => {
    const workspace = create();

    // 1: git remote get-url origin FAILS
    mockGitError("fatal: not a git repository");
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    // 2: git clone (uses local path as remoteUrl)
    mockGitSuccess("");
    // 3: git checkout -b
    mockGitSuccess("");

    await workspace.create({
      projectId: "proj",
      sessionId: "sess",
      branch: "feat/branch",
      project: makeProject(),
    });

    // Clone should use local path as the remote URL
    const cloneCall = mockExecFileAsync.mock.calls[1];
    expect(cloneCall[0]).toBe("git");
    const cloneArgs = cloneCall[1] as string[];
    // The remote URL argument (after --reference repoPath --branch defaultBranch) is the 6th arg
    expect(cloneArgs[5]).toBe("/repo/path");
  });

  it("calls git clone with --reference flag", async () => {
    const workspace = create();

    mockGitSuccess("https://github.com/test/repo.git");
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    mockGitSuccess("");
    mockGitSuccess("");

    await workspace.create({
      projectId: "proj",
      sessionId: "sess",
      branch: "feat/branch",
      project: makeProject({ defaultBranch: "develop" }),
    });

    // The clone call (second call overall)
    expect(mockExecFileAsync).toHaveBeenNthCalledWith(2, "git", [
      "clone",
      "--reference",
      "/repo/path",
      "--branch",
      "develop",
      "https://github.com/test/repo.git",
      "/mock-home/.ao-clones/proj/sess",
    ]);
  });

  it("creates feature branch via checkout -b", async () => {
    const workspace = create();

    mockGitSuccess("https://github.com/test/repo.git");
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    mockGitSuccess("");
    // git checkout -b feat/new-branch
    mockGitSuccess("");

    await workspace.create({
      projectId: "proj",
      sessionId: "sess",
      branch: "feat/new-branch",
      project: makeProject(),
    });

    // Third call: checkout -b
    expect(mockExecFileAsync).toHaveBeenNthCalledWith(
      3,
      "git",
      ["checkout", "-b", "feat/new-branch"],
      { cwd: "/mock-home/.ao-clones/proj/sess" },
    );
  });

  it("falls back to plain checkout when branch already exists", async () => {
    const workspace = create();

    mockGitSuccess("https://github.com/test/repo.git");
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    mockGitSuccess("");
    // git checkout -b fails (branch exists)
    mockGitError("fatal: A branch named 'feat/existing' already exists");
    // git checkout (plain) succeeds
    mockGitSuccess("");

    const info = await workspace.create({
      projectId: "proj",
      sessionId: "sess",
      branch: "feat/existing",
      project: makeProject(),
    });

    // Fourth call: plain checkout
    expect(mockExecFileAsync).toHaveBeenNthCalledWith(4, "git", ["checkout", "feat/existing"], {
      cwd: "/mock-home/.ao-clones/proj/sess",
    });

    expect(info.branch).toBe("feat/existing");
  });

  it("cleans up partial clone on clone failure", async () => {
    const workspace = create();

    mockGitSuccess("https://github.com/test/repo.git");
    // existsSync: first call for "already exists" check => false
    // second call inside catch for cleanup check => true
    (fs.existsSync as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    // git clone fails
    mockGitError("fatal: could not read from remote repository");

    await expect(
      workspace.create({
        projectId: "proj",
        sessionId: "sess",
        branch: "feat/branch",
        project: makeProject(),
      }),
    ).rejects.toThrow('Failed to clone repo for session "sess"');

    // rmSync should be called to clean up
    expect(fs.rmSync).toHaveBeenCalledWith("/mock-home/.ao-clones/proj/sess", {
      recursive: true,
      force: true,
    });
  });

  it("cleans up clone on checkout failure and throws", async () => {
    const workspace = create();

    mockGitSuccess("https://github.com/test/repo.git");
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    // git clone succeeds
    mockGitSuccess("");
    // git checkout -b fails
    mockGitError("error: pathspec did not match");
    // git checkout (fallback) also fails
    mockGitError("error: pathspec 'bad-branch' did not match");

    await expect(
      workspace.create({
        projectId: "proj",
        sessionId: "sess",
        branch: "bad-branch",
        project: makeProject(),
      }),
    ).rejects.toThrow('Failed to checkout branch "bad-branch" in clone');

    // rmSync should be called to clean up the orphaned clone
    expect(fs.rmSync).toHaveBeenCalledWith("/mock-home/.ao-clones/proj/sess", {
      recursive: true,
      force: true,
    });
  });

  it("throws if workspace path already exists", async () => {
    const workspace = create();

    mockGitSuccess("https://github.com/test/repo.git");
    // existsSync returns true — path already exists
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);

    await expect(
      workspace.create({
        projectId: "proj",
        sessionId: "sess",
        branch: "feat/branch",
        project: makeProject(),
      }),
    ).rejects.toThrow(
      'Workspace path "/mock-home/.ao-clones/proj/sess" already exists for session "sess"',
    );
  });

  it("rejects invalid projectId with special characters", async () => {
    const workspace = create();

    await expect(
      workspace.create({
        projectId: "bad/project",
        sessionId: "sess",
        branch: "feat/branch",
        project: makeProject(),
      }),
    ).rejects.toThrow('Invalid projectId "bad/project"');
  });

  it("rejects projectId with dots", async () => {
    const workspace = create();

    await expect(
      workspace.create({
        projectId: "bad.project",
        sessionId: "sess",
        branch: "feat/branch",
        project: makeProject(),
      }),
    ).rejects.toThrow('Invalid projectId "bad.project"');
  });

  it("rejects invalid sessionId with special characters", async () => {
    const workspace = create();

    await expect(
      workspace.create({
        projectId: "proj",
        sessionId: "bad session!",
        branch: "feat/branch",
        project: makeProject(),
      }),
    ).rejects.toThrow('Invalid sessionId "bad session!"');
  });

  it("rejects sessionId with path traversal", async () => {
    const workspace = create();

    await expect(
      workspace.create({
        projectId: "proj",
        sessionId: "../escape",
        branch: "feat/branch",
        project: makeProject(),
      }),
    ).rejects.toThrow('Invalid sessionId "../escape"');
  });

  it("returns correct WorkspaceInfo", async () => {
    const workspace = create();

    mockGitSuccess("https://github.com/test/repo.git");
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    mockGitSuccess("");
    mockGitSuccess("");

    const info = await workspace.create({
      projectId: "my-project",
      sessionId: "session-42",
      branch: "feat/awesome",
      project: makeProject(),
    });

    expect(info).toEqual({
      path: "/mock-home/.ao-clones/my-project/session-42",
      branch: "feat/awesome",
      sessionId: "session-42",
      projectId: "my-project",
    });
  });

  it("creates project clone directory with recursive option", async () => {
    const workspace = create();

    mockGitSuccess("https://github.com/test/repo.git");
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    mockGitSuccess("");
    mockGitSuccess("");

    await workspace.create({
      projectId: "proj",
      sessionId: "sess",
      branch: "feat/branch",
      project: makeProject(),
    });

    expect(fs.mkdirSync).toHaveBeenCalledWith("/mock-home/.ao-clones/proj", { recursive: true });
  });

  it("expands ~ in project path", async () => {
    const workspace = create();

    mockGitSuccess("https://github.com/test/repo.git");
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    mockGitSuccess("");
    mockGitSuccess("");

    await workspace.create({
      projectId: "proj",
      sessionId: "sess",
      branch: "feat/branch",
      project: makeProject({ path: "~/my-repos/project" }),
    });

    // git remote get-url should use expanded path
    expect(mockExecFileAsync).toHaveBeenNthCalledWith(1, "git", ["remote", "get-url", "origin"], {
      cwd: "/mock-home/my-repos/project",
    });
  });
});

// ---------------------------------------------------------------------------
// workspace.destroy()
// ---------------------------------------------------------------------------
describe("workspace.destroy()", () => {
  it("removes directory with rmSync when it exists", async () => {
    const workspace = create();
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);

    await workspace.destroy("/mock-home/.ao-clones/proj/sess");

    expect(fs.rmSync).toHaveBeenCalledWith("/mock-home/.ao-clones/proj/sess", {
      recursive: true,
      force: true,
    });
  });

  it("does not throw when directory does not exist", async () => {
    const workspace = create();
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

    await expect(
      workspace.destroy("/mock-home/.ao-clones/proj/nonexistent"),
    ).resolves.toBeUndefined();

    expect(fs.rmSync).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// workspace.list()
// ---------------------------------------------------------------------------
describe("workspace.list()", () => {
  it("returns empty array when project directory does not exist", async () => {
    const workspace = create();
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const result = await workspace.list("myproject");

    expect(result).toEqual([]);
  });

  it("returns workspace entries with branch info", async () => {
    const workspace = create();
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);

    (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([
      { name: "session-1", isDirectory: () => true },
      { name: "session-2", isDirectory: () => true },
    ]);

    // git branch --show-current for each directory
    mockGitSuccess("feat/feature-a");
    mockGitSuccess("feat/feature-b");

    const result = await workspace.list("myproject");

    expect(result).toEqual([
      {
        path: "/mock-home/.ao-clones/myproject/session-1",
        branch: "feat/feature-a",
        sessionId: "session-1",
        projectId: "myproject",
      },
      {
        path: "/mock-home/.ao-clones/myproject/session-2",
        branch: "feat/feature-b",
        sessionId: "session-2",
        projectId: "myproject",
      },
    ]);

    // Verify git branch --show-current was called for each entry
    expect(mockExecFileAsync).toHaveBeenNthCalledWith(1, "git", ["branch", "--show-current"], {
      cwd: "/mock-home/.ao-clones/myproject/session-1",
    });
    expect(mockExecFileAsync).toHaveBeenNthCalledWith(2, "git", ["branch", "--show-current"], {
      cwd: "/mock-home/.ao-clones/myproject/session-2",
    });
  });

  it("skips non-directory entries", async () => {
    const workspace = create();
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);

    (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([
      { name: "session-1", isDirectory: () => true },
      { name: "some-file.txt", isDirectory: () => false },
      { name: ".DS_Store", isDirectory: () => false },
    ]);

    // Only one git call for the single directory
    mockGitSuccess("main");

    const result = await workspace.list("myproject");

    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe("session-1");
    expect(mockExecFileAsync).toHaveBeenCalledTimes(1);
  });

  it("skips invalid git repos with console warning", async () => {
    const workspace = create();
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([
      { name: "valid-session", isDirectory: () => true },
      { name: "corrupt-session", isDirectory: () => true },
    ]);

    // First directory succeeds
    mockGitSuccess("feat/working");
    // Second directory fails (not a valid git repo)
    mockGitError("fatal: not a git repository");

    const result = await workspace.list("myproject");

    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe("valid-session");

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[workspace-clone] Skipping "corrupt-session"'),
    );

    warnSpy.mockRestore();
  });

  it("rejects invalid projectId with special characters", async () => {
    const workspace = create();

    await expect(workspace.list("bad/project")).rejects.toThrow('Invalid projectId "bad/project"');
  });

  it("rejects projectId with spaces", async () => {
    const workspace = create();

    await expect(workspace.list("bad project")).rejects.toThrow('Invalid projectId "bad project"');
  });
});

// ---------------------------------------------------------------------------
// workspace.postCreate()
// ---------------------------------------------------------------------------
describe("workspace.postCreate()", () => {
  it("runs each postCreate command via sh -c", async () => {
    const workspace = create();

    const info = {
      path: "/mock-home/.ao-clones/proj/sess",
      branch: "feat/branch",
      sessionId: "sess",
      projectId: "proj",
    };

    const project = makeProject({
      postCreate: ["pnpm install", "pnpm build"],
    });

    // Two commands
    mockGitSuccess("");
    mockGitSuccess("");

    await workspace.postCreate!(info, project);

    expect(mockExecFileAsync).toHaveBeenCalledTimes(2);

    expect(mockExecFileAsync).toHaveBeenNthCalledWith(1, "sh", ["-c", "pnpm install"], {
      cwd: "/mock-home/.ao-clones/proj/sess",
    });

    expect(mockExecFileAsync).toHaveBeenNthCalledWith(2, "sh", ["-c", "pnpm build"], {
      cwd: "/mock-home/.ao-clones/proj/sess",
    });
  });

  it("does nothing when postCreate is undefined", async () => {
    const workspace = create();

    const info = {
      path: "/mock-home/.ao-clones/proj/sess",
      branch: "feat/branch",
      sessionId: "sess",
      projectId: "proj",
    };

    const project = makeProject(); // no postCreate

    await workspace.postCreate!(info, project);

    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it("does nothing when postCreate is empty array", async () => {
    const workspace = create();

    const info = {
      path: "/mock-home/.ao-clones/proj/sess",
      branch: "feat/branch",
      sessionId: "sess",
      projectId: "proj",
    };

    const project = makeProject({ postCreate: [] });

    await workspace.postCreate!(info, project);

    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });
});
