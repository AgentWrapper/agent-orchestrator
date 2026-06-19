/**
 * Smoke tests for `ao spawn --attach-session <id>`.
 *
 * Status: SKIPPED — Step 0 TDD. Unblock in PR 1 (attach-session spawn flag).
 *
 * These tests ARE THE SPEC. The assertions define exactly what PR 1 must satisfy.
 * When all tests pass without the .skip, the feature is correctly implemented.
 *
 * Feature:
 *   `ao spawn --attach-session <id>` adopts an existing AO session's worktree
 *   instead of creating a new one. It seeds the new session with the old session's
 *   agent resume keys so the agent can continue the conversation.
 *
 * Contract:
 *   - The new session's metadata.worktree == source session's metadata.worktree
 *   - The new session's metadata.adoptedWorkspace == 'true'
 *   - All resume keys from the source session (claudeSessionUuid, codexThreadId, …)
 *     are copied to the new session so the agent can restore prior context
 *   - Killing the new session must NOT delete the worktree directory (adoptedWorkspace)
 *   - --attach-session and --claim-pr are mutually exclusive (validation error)
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getProjectSessionsDir,
  readMetadataRaw,
  writeMetadata,
  type SessionMetadata,
} from "@aoagents/ao-core";

// ─── Stubs for APIs to be created / extended in PR 1 ─────────────────────────
//
// SessionSpawnConfig will gain an `attachSessionId?: string` field in PR 1.
// SpawnAttachConfig below is a local stand-in until that field is added.
// Delete this interface and replace with the updated SessionSpawnConfig import.
interface SpawnAttachConfig {
  projectId: string;
  /** ID of the existing AO session whose worktree to adopt. */
  attachSessionId: string;
  /** Mutually exclusive with attachSessionId — using both must be a validation error. */
  claimPr?: number;
}

// spawnWithAttach represents the session-manager.spawn() path after PR 1.
// When implemented, it should:
//   1. Validate that attachSessionId and claimPr are not both set (throw if so)
//   2. Read source session metadata to obtain worktreePath and resume keys
//   3. Allocate a new session ID under the project's session prefix
//   4. Write metadata: { worktree: <src.worktree>, adoptedWorkspace: 'true',
//        branch: <src.branch>, claudeSessionUuid: <src.claudeSessionUuid>, … }
//   5. Return the new session object (without starting the agent process — that is
//        the job of the lifecycle manager, which is not started in these tests)
//
// Delete this stub and replace with:
//   import { createSessionManager } from "@aoagents/ao-core";
//   const sessionManager = createSessionManager({ config, registry });
//   const session = await sessionManager.spawn({ projectId, attachSessionId });
async function spawnWithAttach(
  _config: SpawnAttachConfig,
  _opts: { sessionsDir: string },
): Promise<{ sessionId: string }> {
  throw new Error("not yet implemented — unblock in PR 1");
}

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trimEnd();
}

describe.skip("spawn --attach-session [TODO: unblock in PR 1]", () => {
  const projectId = "attach-session-test";
  let tmpDir: string;
  let mainRepoDir: string;
  let worktreeDir: string;
  let sessionsDir: string;
  let originalHome: string | undefined;

  // Source session that will be "attached to" in all tests
  const sourceSessionId = "ao-1";
  const sourceWorktreePath = ""; // set in beforeAll after tmpDir is known

  beforeAll(async () => {
    const raw = await mkdtemp(join(tmpdir(), "ao-attach-session-"));
    tmpDir = raw;
    mainRepoDir = join(tmpDir, "main-repo");
    worktreeDir = join(tmpDir, "worktrees", "session-wt");

    mkdirSync(mainRepoDir, { recursive: true });
    mkdirSync(join(tmpDir, "worktrees"), { recursive: true });

    // Set up a real git repo and worktree so that worktree-path assertions are
    // verifiable against real filesystem state
    await git(mainRepoDir, "init", "-b", "main");
    await git(mainRepoDir, "config", "user.email", "test@test.com");
    await git(mainRepoDir, "config", "user.name", "Test");
    await writeFile(join(mainRepoDir, "README.md"), "# Test\n");
    await git(mainRepoDir, "add", ".");
    await git(mainRepoDir, "commit", "-m", "initial commit");
    await git(mainRepoDir, "worktree", "add", worktreeDir, "-b", "session/ao-1");

    // Redirect HOME so session storage goes to tmpDir, not real ~/.agent-orchestrator
    originalHome = process.env["HOME"];
    process.env["HOME"] = tmpDir;

    sessionsDir = getProjectSessionsDir(projectId);
    mkdirSync(sessionsDir, { recursive: true });

    // Write metadata for the source session (as if ao had already spawned it)
    const sourceMetadata: SessionMetadata = {
      worktree: worktreeDir,
      branch: "session/ao-1",
      status: "idle",
      project: projectId,
      claudeSessionUuid: "claude-uuid-abc123",
      codexThreadId: undefined,
      createdAt: new Date().toISOString(),
    };
    writeMetadata(sessionsDir, sourceSessionId, sourceMetadata);
  }, 30_000);

  afterAll(async () => {
    if (originalHome !== undefined) process.env["HOME"] = originalHome;
    else delete process.env["HOME"];
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }, 30_000);

  // ─── Basic attach: new session adopts source session's worktree ─────────────

  it("creates a new session that adopts the source session's worktree directory", async () => {
    const result = await spawnWithAttach(
      { projectId, attachSessionId: sourceSessionId },
      { sessionsDir },
    );

    expect(result.sessionId).toBeTruthy();
    expect(result.sessionId).not.toBe(sourceSessionId); // must be a fresh ID

    const raw = readMetadataRaw(sessionsDir, result.sessionId);
    expect(raw).not.toBeNull();
    // Worktree path is inherited from the source session
    expect(raw!["worktree"]).toBe(worktreeDir);
    // adoptedWorkspace flag: AO will NOT delete this directory on kill
    expect(raw!["adoptedWorkspace"]).toBe("true");
    // Branch is copied from the source session
    expect(raw!["branch"]).toBe("session/ao-1");
  });

  // ─── Resume key seeding: agent keys propagate from source to new session ────

  it("seeds the new session with the source session's claudeSessionUuid so the agent can resume", async () => {
    const result = await spawnWithAttach(
      { projectId, attachSessionId: sourceSessionId },
      { sessionsDir },
    );

    const raw = readMetadataRaw(sessionsDir, result.sessionId);
    expect(raw).not.toBeNull();
    // claudeSessionUuid present in source → must be copied to new session
    expect(raw!["claudeSessionUuid"]).toBe("claude-uuid-abc123");
  });

  it("omits resume keys that are absent in the source session (no phantom keys written)", async () => {
    const result = await spawnWithAttach(
      { projectId, attachSessionId: sourceSessionId },
      { sessionsDir },
    );

    const raw = readMetadataRaw(sessionsDir, result.sessionId);
    // codexThreadId was undefined in source — new session must not invent a value
    expect(raw!["codexThreadId"]).toBeUndefined();
  });

  // ─── Kill safety: adopted worktree survives session termination ─────────────

  it("killing the adopted session does not delete the worktree directory", async () => {
    const result = await spawnWithAttach(
      { projectId, attachSessionId: sourceSessionId },
      { sessionsDir },
    );

    // Simulate kill: the session manager's kill() path checks adoptedWorkspace
    // and skips workspace.destroy() when it is 'true'. We verify the directory
    // still exists after the kill hook would have run.
    //
    // TODO: replace the comment below with the actual kill call once PR 1 lands:
    //   await sessionManager.kill(result.sessionId, "manually_killed");
    //
    // For now, assert the precondition that makes kill-safety work:
    const raw = readMetadataRaw(sessionsDir, result.sessionId);
    expect(raw!["adoptedWorkspace"]).toBe("true");
    expect(existsSync(worktreeDir)).toBe(true); // worktree must still exist
  });

  // ─── Mutual exclusion: --attach-session + --claim-pr must be rejected ───────
  // Attaching to an existing worktree and claiming a PR imply conflicting
  // workspace setups: attach-session adopts an existing dir, claim-pr checks out
  // a new one. Allowing both would silently overwrite the adopted worktree.

  it("spawn with both attachSessionId and claimPr throws a validation error", async () => {
    await expect(
      spawnWithAttach(
        { projectId, attachSessionId: sourceSessionId, claimPr: 42 },
        { sessionsDir },
      ),
    ).rejects.toThrow(/attach-session.*claim-pr|mutually exclusive/i);
  });
});
