import { execFile } from "node:child_process";
import { mkdtemp, rm, realpath, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import worktreePlugin from "@aoagents/ao-plugin-workspace-worktree";
import type { ProjectConfig, WorkspaceInfo } from "@aoagents/ao-core";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trimEnd();
}

async function createCommit(cwd: string, fileName: string, content: string): Promise<string> {
  await writeFile(join(cwd, fileName), content);
  await git(cwd, "add", fileName);
  await git(cwd, "commit", "-m", `update ${fileName}`);
  return git(cwd, "rev-parse", "HEAD");
}

async function createRepoClone(): Promise<{
  bareDir: string;
  cloneParent: string;
  repoDir: string;
}> {
  const rawBare = await mkdtemp(join(tmpdir(), "ao-inttest-wt-origin-"));
  const bareDir = await realpath(rawBare);
  await git(bareDir, "init", "--bare");

  const rawParent = await mkdtemp(join(tmpdir(), "ao-inttest-wt-clone-parent-"));
  const cloneParent = await realpath(rawParent);
  const repoDir = join(cloneParent, "repo");
  await execFileAsync("git", ["clone", bareDir, repoDir]);
  await git(repoDir, "config", "user.email", "test@test.com");
  await git(repoDir, "config", "user.name", "Test");

  return { bareDir, cloneParent, repoDir };
}

describe("workspace-worktree (integration)", () => {
  let repoDir: string;
  let worktreeBaseDir: string;
  let workspace: ReturnType<typeof worktreePlugin.create>;
  let project: ProjectConfig;
  let createdInfo: WorkspaceInfo;

  beforeAll(async () => {
    // Create a temp repo with initial commit
    const rawRepo = await mkdtemp(join(tmpdir(), "ao-inttest-wt-repo-"));
    repoDir = await realpath(rawRepo);

    await git(repoDir, "init", "-b", "main");
    await git(repoDir, "config", "user.email", "test@test.com");
    await git(repoDir, "config", "user.name", "Test");
    await execFileAsync("sh", ["-c", "echo hello > README.md"], { cwd: repoDir });
    await git(repoDir, "add", ".");
    await git(repoDir, "commit", "-m", "initial commit");

    // Add "origin" pointing at itself so the plugin's fetch succeeds
    await git(repoDir, "remote", "add", "origin", repoDir);
    await git(repoDir, "fetch", "origin");

    // Create worktree base dir
    const rawBase = await mkdtemp(join(tmpdir(), "ao-inttest-wt-base-"));
    worktreeBaseDir = await realpath(rawBase);

    workspace = worktreePlugin.create({ worktreeDir: worktreeBaseDir });

    project = {
      name: "inttest",
      repo: "test/inttest",
      path: repoDir,
      defaultBranch: "main",
      sessionPrefix: "test",
    };
  }, 30_000);

  afterAll(async () => {
    // Clean up worktrees first (must be done before removing repo)
    try {
      await git(repoDir, "worktree", "prune");
    } catch {
      /* best-effort cleanup */
    }
    if (repoDir) await rm(repoDir, { recursive: true, force: true }).catch(() => {});
    if (worktreeBaseDir)
      await rm(worktreeBaseDir, { recursive: true, force: true }).catch(() => {});
  }, 30_000);

  it("creates a worktree workspace", async () => {
    createdInfo = await workspace.create({
      projectId: "inttest",
      sessionId: "session-1",
      project,
      branch: "feat/test-branch",
    });

    expect(createdInfo.path).toContain("session-1");
    expect(createdInfo.branch).toBe("feat/test-branch");
    expect(createdInfo.sessionId).toBe("session-1");
    expect(createdInfo.projectId).toBe("inttest");
    expect(existsSync(createdInfo.path)).toBe(true);
  });

  it("worktree is on the correct branch", async () => {
    const branch = await git(createdInfo.path, "branch", "--show-current");
    expect(branch).toBe("feat/test-branch");
  });

  it("worktree has the files from main", async () => {
    expect(existsSync(join(createdInfo.path, "README.md"))).toBe(true);
  });

  it("lists the worktree", async () => {
    const list = await workspace.list("inttest");
    expect(list.length).toBeGreaterThanOrEqual(1);
    const found = list.find((w: { sessionId: string }) => w.sessionId === "session-1");
    expect(found).toBeDefined();
    expect(found!.branch).toBe("feat/test-branch");
  });

  it("rejects invalid projectId", async () => {
    await expect(
      workspace.create({
        projectId: "../escape",
        sessionId: "ok",
        project,
        branch: "feat/x",
      }),
    ).rejects.toThrow("Invalid projectId");
  });

  it("rejects invalid sessionId", async () => {
    await expect(
      workspace.create({
        projectId: "inttest",
        sessionId: "bad/id",
        project,
        branch: "feat/x",
      }),
    ).rejects.toThrow("Invalid sessionId");
  });

  it("destroys the worktree", async () => {
    const pathToDestroy = createdInfo.path;
    await workspace.destroy(pathToDestroy);
    expect(existsSync(pathToDestroy)).toBe(false);
  });

  it("list returns empty after destroy", async () => {
    const list = await workspace.list("inttest");
    const found = list.find((w: { sessionId: string }) => w.sessionId === "session-1");
    expect(found).toBeUndefined();
  });

  it("resets a stale session branch when defaultBranch changes", async () => {
    const { bareDir, cloneParent, repoDir: isolatedRepoDir } = await createRepoClone();
    const rawBase = await mkdtemp(join(tmpdir(), "ao-inttest-wt-stale-default-"));
    const isolatedWorktreeBaseDir = await realpath(rawBase);

    try {
      await git(isolatedRepoDir, "switch", "-c", "develop");
      const developSha = await createCommit(isolatedRepoDir, "base.txt", "develop\n");
      await git(isolatedRepoDir, "push", "-u", "origin", "develop");

      await git(isolatedRepoDir, "switch", "-c", "reset");
      const resetSha = await createCommit(isolatedRepoDir, "reset.txt", "reset\n");
      await git(isolatedRepoDir, "push", "-u", "origin", "reset");

      const isolatedWorkspace = worktreePlugin.create({ worktreeDir: isolatedWorktreeBaseDir });
      const developProject: ProjectConfig = {
        name: "stale-default",
        repo: "test/stale-default",
        path: isolatedRepoDir,
        defaultBranch: "develop",
        sessionPrefix: "meg",
      };

      const firstInfo = await isolatedWorkspace.create({
        projectId: "stale-default",
        sessionId: "meg-1",
        project: developProject,
        branch: "session/meg-1",
      });
      expect(await git(firstInfo.path, "rev-parse", "HEAD")).toBe(developSha);
      await isolatedWorkspace.destroy(firstInfo.path);

      const resetProject = { ...developProject, defaultBranch: "reset" };
      const secondInfo = await isolatedWorkspace.create({
        projectId: "stale-default",
        sessionId: "meg-1",
        project: resetProject,
        branch: "session/meg-1",
      });

      expect(await git(secondInfo.path, "rev-parse", "HEAD")).toBe(resetSha);
      expect(await git(isolatedRepoDir, "rev-parse", "refs/heads/session/meg-1")).toBe(resetSha);
    } finally {
      await rm(isolatedWorktreeBaseDir, { recursive: true, force: true }).catch(() => {});
      await rm(cloneParent, { recursive: true, force: true }).catch(() => {});
      await rm(bareDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 30_000);

  it("resets a stale session branch when origin default branch advances", async () => {
    const { bareDir, cloneParent, repoDir: isolatedRepoDir } = await createRepoClone();
    const rawBase = await mkdtemp(join(tmpdir(), "ao-inttest-wt-stale-origin-"));
    const isolatedWorktreeBaseDir = await realpath(rawBase);
    const rawExternalParent = await mkdtemp(join(tmpdir(), "ao-inttest-wt-external-parent-"));
    const externalParent = await realpath(rawExternalParent);
    const externalRepoDir = join(externalParent, "repo");

    try {
      await git(isolatedRepoDir, "switch", "-c", "main");
      const oldMainSha = await createCommit(isolatedRepoDir, "base.txt", "main one\n");
      await git(isolatedRepoDir, "push", "-u", "origin", "main");

      const isolatedWorkspace = worktreePlugin.create({ worktreeDir: isolatedWorktreeBaseDir });
      const mainProject: ProjectConfig = {
        name: "stale-origin",
        repo: "test/stale-origin",
        path: isolatedRepoDir,
        defaultBranch: "main",
        sessionPrefix: "meg",
      };

      const firstInfo = await isolatedWorkspace.create({
        projectId: "stale-origin",
        sessionId: "meg-1",
        project: mainProject,
        branch: "session/meg-1",
      });
      expect(await git(firstInfo.path, "rev-parse", "HEAD")).toBe(oldMainSha);
      await isolatedWorkspace.destroy(firstInfo.path);

      await execFileAsync("git", ["clone", bareDir, externalRepoDir]);
      await git(externalRepoDir, "config", "user.email", "test@test.com");
      await git(externalRepoDir, "config", "user.name", "Test");
      await git(externalRepoDir, "switch", "main");
      const newMainSha = await createCommit(externalRepoDir, "base.txt", "main two\n");
      await git(externalRepoDir, "push", "origin", "main");

      const secondInfo = await isolatedWorkspace.create({
        projectId: "stale-origin",
        sessionId: "meg-1",
        project: mainProject,
        branch: "session/meg-1",
      });

      expect(await git(secondInfo.path, "rev-parse", "HEAD")).toBe(newMainSha);
      expect(await git(isolatedRepoDir, "rev-parse", "refs/heads/session/meg-1")).toBe(newMainSha);
    } finally {
      await rm(isolatedWorktreeBaseDir, { recursive: true, force: true }).catch(() => {});
      await rm(externalParent, { recursive: true, force: true }).catch(() => {});
      await rm(cloneParent, { recursive: true, force: true }).catch(() => {});
      await rm(bareDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 30_000);
});
