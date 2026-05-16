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

  // Regression for https://github.com/ComposioHQ/agent-orchestrator/issues/1741.
  // After a clean destroy(), the local session branch is intentionally kept so
  // the user's commits aren't lost. restore() must re-attach that branch
  // without recreating it (-b) or force-resetting it (-B), so the session's
  // HEAD survives.
  it("restore re-attaches existing session branch and preserves its commits", async () => {
    const { bareDir, cloneParent, repoDir: isolatedRepoDir } = await createRepoClone();
    const rawBase = await mkdtemp(join(tmpdir(), "ao-inttest-wt-restore-preserve-"));
    const isolatedWorktreeBaseDir = await realpath(rawBase);

    try {
      await git(isolatedRepoDir, "switch", "-c", "main");
      const mainSha = await createCommit(isolatedRepoDir, "base.txt", "main\n");
      await git(isolatedRepoDir, "push", "-u", "origin", "main");

      const isolatedWorkspace = worktreePlugin.create({ worktreeDir: isolatedWorktreeBaseDir });
      const proj: ProjectConfig = {
        name: "restore-preserve",
        repo: "test/restore-preserve",
        path: isolatedRepoDir,
        defaultBranch: "main",
        sessionPrefix: "ao",
      };

      const created = await isolatedWorkspace.create({
        projectId: "restore-preserve",
        sessionId: "ao-1",
        project: proj,
        branch: "session/ao-1",
      });

      // Simulate session work with a commit on the session branch.
      await git(created.path, "config", "user.email", "test@test.com");
      await git(created.path, "config", "user.name", "Test");
      const sessionSha = await createCommit(created.path, "session.txt", "session work\n");
      expect(sessionSha).not.toBe(mainSha);

      // Tear down the worktree the way AO does — branch is preserved.
      await isolatedWorkspace.destroy(created.path);
      expect(existsSync(created.path)).toBe(false);
      expect(await git(isolatedRepoDir, "rev-parse", "refs/heads/session/ao-1")).toBe(sessionSha);

      // Restore — must re-attach session/ao-1 with its existing HEAD intact.
      const restored = await isolatedWorkspace.restore!(
        {
          projectId: "restore-preserve",
          sessionId: "ao-1",
          project: proj,
          branch: "session/ao-1",
        },
        created.path,
      );

      expect(restored.branch).toBe("session/ao-1");
      expect(await git(restored.path, "rev-parse", "HEAD")).toBe(sessionSha);
      expect(await git(isolatedRepoDir, "rev-parse", "refs/heads/session/ao-1")).toBe(sessionSha);
    } finally {
      await rm(isolatedWorktreeBaseDir, { recursive: true, force: true }).catch(() => {});
      await rm(cloneParent, { recursive: true, force: true }).catch(() => {});
      await rm(bareDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 30_000);

  // Same regression — direct repro of the failure surface in #1741. We force
  // the first `git worktree add <path> <branch>` to fail by leaving a stale
  // registered worktree at the same path, then verify restore recovers
  // without using -b (which would fail with "branch already exists") or -B
  // (which would discard the session's commits).
  it("restore recovers when a stale worktree registration conflicts with the path", async () => {
    const { bareDir, cloneParent, repoDir: isolatedRepoDir } = await createRepoClone();
    const rawBase = await mkdtemp(join(tmpdir(), "ao-inttest-wt-restore-stale-"));
    const isolatedWorktreeBaseDir = await realpath(rawBase);

    try {
      await git(isolatedRepoDir, "switch", "-c", "main");
      const mainSha = await createCommit(isolatedRepoDir, "base.txt", "main\n");
      await git(isolatedRepoDir, "push", "-u", "origin", "main");

      const isolatedWorkspace = worktreePlugin.create({ worktreeDir: isolatedWorktreeBaseDir });
      const proj: ProjectConfig = {
        name: "restore-stale",
        repo: "test/restore-stale",
        path: isolatedRepoDir,
        defaultBranch: "main",
        sessionPrefix: "ao",
      };

      const created = await isolatedWorkspace.create({
        projectId: "restore-stale",
        sessionId: "ao-1",
        project: proj,
        branch: "session/ao-1",
      });

      await git(created.path, "config", "user.email", "test@test.com");
      await git(created.path, "config", "user.name", "Test");
      const sessionSha = await createCommit(created.path, "session.txt", "session work\n");
      expect(sessionSha).not.toBe(mainSha);

      // Simulate a dirty teardown: rmSync the dir but leave the worktree
      // entry registered (this is the failure mode from #1562 that triggers
      // the buggy fallback path in #1741).
      await rm(created.path, { recursive: true, force: true });
      // Worktree registration is still present — branch is still considered
      // checked out at that (now-missing) path. Restore must handle this.

      const restored = await isolatedWorkspace.restore!(
        {
          projectId: "restore-stale",
          sessionId: "ao-1",
          project: proj,
          branch: "session/ao-1",
        },
        created.path,
      );

      expect(restored.branch).toBe("session/ao-1");
      // Most importantly, the session commit must survive — anything that
      // touched -B would have reset the branch back to mainSha.
      expect(await git(restored.path, "rev-parse", "HEAD")).toBe(sessionSha);
      expect(await git(isolatedRepoDir, "rev-parse", "refs/heads/session/ao-1")).toBe(sessionSha);
    } finally {
      await rm(isolatedWorktreeBaseDir, { recursive: true, force: true }).catch(() => {});
      await rm(cloneParent, { recursive: true, force: true }).catch(() => {});
      await rm(bareDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 30_000);

  // Direct repro of the user-reported failure on PR #1742: the workspace dir
  // physically exists on disk but is no longer a valid git working tree
  // (workspace.exists() returned false because rev-parse failed). The first
  // `git worktree add <path> <branch>` fails with `'<path>' already exists`,
  // so restore must rmSync the stale dir before retrying. Without this, my
  // first fix attempt cleaned the registry but left the dir, so the retry
  // failed identically.
  it("restore recovers when a stale (non-worktree) directory exists at the path", async () => {
    const { bareDir, cloneParent, repoDir: isolatedRepoDir } = await createRepoClone();
    const rawBase = await mkdtemp(join(tmpdir(), "ao-inttest-wt-restore-junkdir-"));
    const isolatedWorktreeBaseDir = await realpath(rawBase);

    try {
      await git(isolatedRepoDir, "switch", "-c", "main");
      const mainSha = await createCommit(isolatedRepoDir, "base.txt", "main\n");
      await git(isolatedRepoDir, "push", "-u", "origin", "main");

      const isolatedWorkspace = worktreePlugin.create({ worktreeDir: isolatedWorktreeBaseDir });
      const proj: ProjectConfig = {
        name: "restore-junkdir",
        repo: "test/restore-junkdir",
        path: isolatedRepoDir,
        defaultBranch: "main",
        sessionPrefix: "ao",
      };

      const created = await isolatedWorkspace.create({
        projectId: "restore-junkdir",
        sessionId: "ao-1",
        project: proj,
        branch: "session/ao-1",
      });

      await git(created.path, "config", "user.email", "test@test.com");
      await git(created.path, "config", "user.name", "Test");
      const sessionSha = await createCommit(created.path, "session.txt", "session work\n");
      expect(sessionSha).not.toBe(mainSha);

      // Clean teardown — registry and dir both gone, branch preserved.
      await isolatedWorkspace.destroy(created.path);
      expect(existsSync(created.path)).toBe(false);

      // Now simulate a partially-restored or hand-mucked state: the dir
      // exists at workspacePath but is just leftover files, not a working
      // tree. workspace.exists() will return false (rev-parse fails), so
      // restore is invoked, and its first `worktree add` will fail with
      // `'<path>' already exists`.
      await execFileAsync("mkdir", ["-p", created.path]);
      await writeFile(join(created.path, "stale.txt"), "junk\n");
      expect(existsSync(created.path)).toBe(true);

      const restored = await isolatedWorkspace.restore!(
        {
          projectId: "restore-junkdir",
          sessionId: "ao-1",
          project: proj,
          branch: "session/ao-1",
        },
        created.path,
      );

      expect(restored.branch).toBe("session/ao-1");
      // Junk file must be gone (restore rmSync'd the stale dir before retry).
      expect(existsSync(join(created.path, "stale.txt"))).toBe(false);
      // Session commit must survive — anything using -B would have lost it.
      expect(await git(restored.path, "rev-parse", "HEAD")).toBe(sessionSha);
      expect(await git(isolatedRepoDir, "rev-parse", "refs/heads/session/ao-1")).toBe(sessionSha);
    } finally {
      await rm(isolatedWorktreeBaseDir, { recursive: true, force: true }).catch(() => {});
      await rm(cloneParent, { recursive: true, force: true }).catch(() => {});
      await rm(bareDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 30_000);

  // Coverage for the createBranchFromBase recovery path (Copilot review on
  // PR #1742): when the LOCAL branch is missing (only origin/<branch>
  // exists) AND `workspacePath` has stale state, the -b fallback must also
  // run the cleanup. Without it, `git worktree add -b ...` fails with
  // `'<path>' already exists` exactly like the re-attach path used to.
  it("restore recovers when local branch is missing and stale dir exists at the path", async () => {
    const { bareDir, cloneParent, repoDir: isolatedRepoDir } = await createRepoClone();
    const rawBase = await mkdtemp(join(tmpdir(), "ao-inttest-wt-restore-missing-branch-"));
    const isolatedWorktreeBaseDir = await realpath(rawBase);

    try {
      await git(isolatedRepoDir, "switch", "-c", "main");
      await createCommit(isolatedRepoDir, "base.txt", "main\n");
      await git(isolatedRepoDir, "push", "-u", "origin", "main");

      // Manually push a session branch to origin without keeping it locally,
      // simulating a session whose local branch was pruned but origin still
      // has it (e.g. fetched after a remote-only force-update).
      await git(isolatedRepoDir, "switch", "-c", "session/ao-1");
      const sessionSha = await createCommit(isolatedRepoDir, "session.txt", "session work\n");
      await git(isolatedRepoDir, "push", "-u", "origin", "session/ao-1");
      // Switch off session/ao-1 then delete the local branch — only origin has it now.
      await git(isolatedRepoDir, "switch", "main");
      await git(isolatedRepoDir, "branch", "-D", "session/ao-1");

      const isolatedWorkspace = worktreePlugin.create({ worktreeDir: isolatedWorktreeBaseDir });
      const proj: ProjectConfig = {
        name: "restore-missing-branch",
        repo: "test/restore-missing-branch",
        path: isolatedRepoDir,
        defaultBranch: "main",
        sessionPrefix: "ao",
      };
      const workspacePath = join(isolatedWorktreeBaseDir, "restore-missing-branch", "ao-1");

      // Plant a stale junk directory at workspacePath. workspace.exists()
      // will return false (not a working tree) and restore is invoked.
      // The first `worktree add` will fail with `'<path>' already exists`,
      // refExists for refs/heads/session/ao-1 returns false (we deleted it),
      // so createBranchFromBase runs and must clean the stale dir first.
      await execFileAsync("mkdir", ["-p", workspacePath]);
      await writeFile(join(workspacePath, "stale.txt"), "junk\n");
      expect(existsSync(workspacePath)).toBe(true);

      const restored = await isolatedWorkspace.restore!(
        {
          projectId: "restore-missing-branch",
          sessionId: "ao-1",
          project: proj,
          branch: "session/ao-1",
        },
        workspacePath,
      );

      expect(restored.branch).toBe("session/ao-1");
      // Junk file gone — cleanup ran before -b add.
      expect(existsSync(join(workspacePath, "stale.txt"))).toBe(false);
      // Local branch was recreated from origin/session/ao-1, preserving the
      // session's commit (which only existed remotely before restore).
      expect(await git(restored.path, "rev-parse", "HEAD")).toBe(sessionSha);
      expect(await git(isolatedRepoDir, "rev-parse", "refs/heads/session/ao-1")).toBe(sessionSha);
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
