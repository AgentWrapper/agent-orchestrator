import { execFile } from "node:child_process";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import clonePlugin from "@aoagents/ao-plugin-workspace-clone";
import type { ProjectConfig, WorkspaceInfo } from "@aoagents/ao-core";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trimEnd();
}

describe("workspace-clone (integration)", () => {
  let repoDir: string;
  let cloneBaseDir: string;
  let workspace: ReturnType<typeof clonePlugin.create>;
  let project: ProjectConfig;
  let createdInfo: WorkspaceInfo;

  beforeAll(async () => {
    // Create a temp repo with initial commit
    const rawRepo = await mkdtemp(join(tmpdir(), "ao-inttest-clone-repo-"));
    repoDir = await realpath(rawRepo);

    await git(repoDir, "init", "-b", "main");
    await git(repoDir, "config", "user.email", "test@test.com");
    await git(repoDir, "config", "user.name", "Test");
    await execFileAsync("sh", ["-c", "echo hello > README.md"], { cwd: repoDir });
    await git(repoDir, "add", ".");
    await git(repoDir, "commit", "-m", "initial commit");

    // Clone plugin needs a remote URL — use the local path as origin
    await git(repoDir, "remote", "add", "origin", repoDir);

    // Create clone base dir
    const rawBase = await mkdtemp(join(tmpdir(), "ao-inttest-clone-base-"));
    cloneBaseDir = await realpath(rawBase);

    workspace = clonePlugin.create({ cloneDir: cloneBaseDir });

    project = {
      name: "inttest",
      repo: "test/inttest",
      path: repoDir,
      defaultBranch: "main",
      sessionPrefix: "test",
    };
  }, 30_000);

  afterAll(async () => {
    if (repoDir) await rm(repoDir, { recursive: true, force: true }).catch(() => {});
    if (cloneBaseDir) await rm(cloneBaseDir, { recursive: true, force: true }).catch(() => {});
  }, 30_000);

  it("creates a clone workspace", async () => {
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

  it("clone is on the correct branch", async () => {
    const branch = await git(createdInfo.path, "branch", "--show-current");
    expect(branch).toBe("feat/test-branch");
  });

  it("clone has the files from main", async () => {
    expect(existsSync(join(createdInfo.path, "README.md"))).toBe(true);
  });

  it("rejects duplicate workspace", async () => {
    await expect(
      workspace.create({
        projectId: "inttest",
        sessionId: "session-1",
        project,
        branch: "feat/other",
      }),
    ).rejects.toThrow("already exists");
  });

  it("lists the clone", async () => {
    const list = await workspace.list("inttest");
    expect(list.length).toBeGreaterThanOrEqual(1);
    const found = list.find((w: { sessionId: string }) => w.sessionId === "session-1");
    expect(found).toBeDefined();
    expect(found!.branch).toBe("feat/test-branch");
  });

  it("rejects invalid projectId", async () => {
    await expect(
      workspace.create({
        projectId: "bad/id",
        sessionId: "ok",
        project,
        branch: "feat/x",
      }),
    ).rejects.toThrow("Invalid projectId");
  });

  it("destroys the clone", async () => {
    const pathToDestroy = createdInfo.path;
    await workspace.destroy(pathToDestroy);
    expect(existsSync(pathToDestroy)).toBe(false);
  });

  it("list returns empty after destroy", async () => {
    const list = await workspace.list("inttest");
    const found = list.find((w: { sessionId: string }) => w.sessionId === "session-1");
    expect(found).toBeUndefined();
  });
});
