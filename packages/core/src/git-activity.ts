/**
 * Git-commit-based activity detection helpers for agent plugins.
 *
 * Agents without native JSONL introspection (Aider, Cursor, etc.) can use
 * recent git commits as a signal that the agent has been actively working.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Check whether the given workspace has any git commits within the last
 * `windowSeconds` seconds. Swallows errors (e.g. not a git repo, git missing)
 * and returns `false` so callers can use this as a best-effort liveness signal.
 *
 * @param workspacePath Absolute path to the workspace (must be a git repo).
 * @param windowSeconds How far back to look for commits. Defaults to 60s.
 */
export async function hasRecentCommits(
  workspacePath: string,
  windowSeconds = 60,
): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["log", `--since=${windowSeconds} seconds ago`, "--format=%H"],
      { cwd: workspacePath, timeout: 5_000 },
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}
