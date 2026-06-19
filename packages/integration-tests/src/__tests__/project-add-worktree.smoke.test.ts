/**
 * Smoke tests for worktree canonicalization on `ao project add`.
 *
 * Status: SKIPPED — Step 0 TDD. Unblock in PR 2 (worktree adoption).
 *
 * These tests ARE THE SPEC. The assertions define exactly what PR 2 must satisfy.
 * When all tests pass without the .skip, the feature is correctly implemented.
 *
 * Feature:
 *   When `ao project add <path>` is given a git worktree path (not the main repo),
 *   AO should detect this and:
 *     1. Register the PARENT (main) repo as the project in the global config
 *     2. Create a session metadata file that adopts the worktree directory
 *     3. Set adoptedWorkspace='true' in the session metadata so AO knows it does
 *        not own the directory lifecycle (it will not delete it on kill)
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getProjectSessionsDir,
  listMetadata,
  readMetadataRaw,
  registerProjectInGlobalConfig,
} from "@aoagents/ao-core";

// ─── Stubs for APIs to be created in PR 2 ────────────────────────────────────
//
// registerProjectWithWorktreeDetection(worktreePath, opts) will be exported from
// @aoagents/ao-core once PR 2 lands. It must:
//   1. Detect the supplied path is a git worktree via
//        `git -C <path> rev-parse --git-common-dir`  (not equal to .git → it's a worktree)
//   2. Resolve the main (parent) repo path via
//        `git -C <path> worktree list --porcelain` (first entry is the main worktree)
//   3. Register the parent repo via registerProjectInGlobalConfig (idempotent)
//   4. Allocate the next available session ID under the project's session prefix
//   5. Write a session metadata file:
//        { worktree: <wtPath>, branch: <wt-branch>, status: 'spawning', adoptedWorkspace: 'true' }
//   6. Return { projectId: <parentProjectId>, sessionId: <new-session-id> }
//
// Delete this stub and replace with:
//   import { registerProjectWithWorktreeDetection } from "@aoagents/ao-core";
function registerProjectWithWorktreeDetection(
  _worktreePath: string,
  _opts: { globalConfigPath?: string } = {},
): { projectId: string; sessionId: string } {
  throw new Error("not yet implemented — unblock in PR 2");
}

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trimEnd();
}

describe.skip("worktree canonicalization [TODO: unblock in PR 2]", () => {
  let tmpDir: string;
  let mainRepoDir: string;
  let worktreeDir: string;
  let globalConfigPath: string;
  let originalHome: string | undefined;

  beforeAll(async () => {
    const raw = await mkdtemp(join(tmpdir(), "ao-wt-canonicalize-"));
    tmpDir = raw;
    mainRepoDir = join(tmpDir, "main-repo");
    worktreeDir = join(tmpDir, "worktrees", "feat-x");

    mkdirSync(mainRepoDir, { recursive: true });
    mkdirSync(join(tmpDir, "worktrees"), { recursive: true });

    // Set up a real git repo so worktree detection can query `git worktree list`
    await git(mainRepoDir, "init", "-b", "main");
    await git(mainRepoDir, "config", "user.email", "test@test.com");
    await git(mainRepoDir, "config", "user.name", "Test");
    await writeFile(join(mainRepoDir, "README.md"), "# Test Repo\n");
    await git(mainRepoDir, "add", ".");
    await git(mainRepoDir, "commit", "-m", "initial commit");

    // Create a real git worktree on branch feat/x
    await git(mainRepoDir, "worktree", "add", worktreeDir, "-b", "feat/x");

    // Redirect HOME so getAoBaseDir / getProjectSessionsDir resolve under tmpDir,
    // preventing test writes from polluting the real ~/.agent-orchestrator
    originalHome = process.env["HOME"];
    process.env["HOME"] = tmpDir;

    // Redirect global config to a temp file so we can inspect and clean it up
    globalConfigPath = join(tmpDir, "ao-global-config.yaml");
    process.env["AO_GLOBAL_CONFIG"] = globalConfigPath;
  }, 30_000);

  afterAll(async () => {
    if (originalHome !== undefined) process.env["HOME"] = originalHome;
    else delete process.env["HOME"];
    delete process.env["AO_GLOBAL_CONFIG"];
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }, 30_000);

  // ─── CLI path ───────────────────────────────────────────────────────────────
  // registerProjectWithWorktreeDetection is the core function that `ao project add`
  // will call when it detects the supplied path is a git worktree.

  it("registers the parent repo — not the worktree — as the project in the global config", () => {
    const result = registerProjectWithWorktreeDetection(worktreeDir, { globalConfigPath });

    expect(result.projectId).toBeTruthy();

    // The global config must record the PARENT repo path, not the worktree path
    const globalConfig = readFileSync(globalConfigPath, "utf-8");
    expect(globalConfig).toContain(mainRepoDir);
    expect(globalConfig).not.toContain(worktreeDir);
  });

  it("creates session metadata with worktree path, correct branch, and adoptedWorkspace='true'", () => {
    const result = registerProjectWithWorktreeDetection(worktreeDir, { globalConfigPath });

    const sessionsDir = getProjectSessionsDir(result.projectId);
    const raw = readMetadataRaw(sessionsDir, result.sessionId);

    expect(raw).not.toBeNull();
    // The session's worktree field points to the adopted directory, not the parent repo
    expect(raw!["worktree"]).toBe(worktreeDir);
    // Branch is the actual git branch of the worktree (feat/x), not main
    expect(raw!["branch"]).toBe("feat/x");
    // adoptedWorkspace='true' means AO will NOT delete this directory on session kill
    expect(raw!["adoptedWorkspace"]).toBe("true");
  });

  // ─── Web API path ────────────────────────────────────────────────────────────
  // POST /api/projects must apply the same worktree canonicalization as the CLI.
  //
  // TODO: to unblock this test:
  //   1. Add @aoagents/ao-web to integration-tests dependencies in package.json
  //   2. Replace the postHandler stub below with:
  //        import type { NextRequest } from "next/server";
  //        const { POST } = await import("@aoagents/ao-web/src/app/api/projects/route.js");
  //        const response = await POST(req as NextRequest);

  it("POST /api/projects with a worktree path returns 201 with projectId + sessionId and writes matching disk state", async () => {
    // Stub representing the to-be-updated POST handler behavior.
    // The real handler will detect the worktree, canonicalize, and return sessionId.
    const postHandler = async (
      _req: Request,
    ): Promise<{ status: number; body: { ok: boolean; projectId: string; sessionId: string } }> => {
      throw new Error("not yet implemented — unblock in PR 2");
    };

    const response = await postHandler(
      new Request("http://localhost/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: worktreeDir }),
      }),
    );

    expect(response.status).toBe(201);
    expect(response.body.ok).toBe(true);
    expect(response.body.projectId).toBeTruthy();
    expect(response.body.sessionId).toBeTruthy();

    // Disk state must match the CLI path: same metadata written by both entry points
    const sessionsDir = getProjectSessionsDir(response.body.projectId);
    const raw = readMetadataRaw(sessionsDir, response.body.sessionId);
    expect(raw!["worktree"]).toBe(worktreeDir);
    expect(raw!["adoptedWorkspace"]).toBe("true");
  });

  // ─── Regression: plain project add must NOT create a session ─────────────────
  // Adding a main repo (not a worktree) must register the project but must not
  // create any session metadata files — behaviour unchanged from today.

  it("ao project add <main-repo> registers as project without creating any sessions", () => {
    const projectId = registerProjectInGlobalConfig(
      "main-repo-regression",
      "main-repo-regression",
      mainRepoDir,
      { defaultBranch: "main" },
      globalConfigPath,
    );

    const sessionsDir = getProjectSessionsDir(projectId);
    const sessions = existsSync(sessionsDir) ? listMetadata(sessionsDir) : [];
    // A plain project registration creates zero sessions
    expect(sessions).toHaveLength(0);
  });

  // ─── Idempotency: same worktree twice → one project, two sessions ─────────────
  // Calling the registration twice for the same worktree must not duplicate the
  // project entry but must create a fresh adopted session each time.

  it("adding the same worktree twice creates one project entry and accumulates sessions", () => {
    const result1 = registerProjectWithWorktreeDetection(worktreeDir, { globalConfigPath });
    const result2 = registerProjectWithWorktreeDetection(worktreeDir, { globalConfigPath });

    // Both calls resolve to the same parent project
    expect(result2.projectId).toBe(result1.projectId);
    // Each call allocates a new, distinct session ID
    expect(result2.sessionId).not.toBe(result1.sessionId);

    // Both session metadata files are present on disk
    const sessionsDir = getProjectSessionsDir(result1.projectId);
    const sessions = listMetadata(sessionsDir);
    expect(sessions).toContain(result1.sessionId);
    expect(sessions).toContain(result2.sessionId);
  });
});
