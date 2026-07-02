import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

/**
 * Relative paths AO injects into every session worktree (Claude Code
 * discipline hooks, metadata/activity updater scripts, `.ao/` session state).
 * These are noise in a worker's diff/PR, not real work. Kept in sync by hand
 * with Maestro's `GitDiffClient.aoInjectedPaths`
 * (app/Sources/Maestro/Data/GitDiffClient.swift).
 */
export const AO_INJECTED_WORKTREE_EXCLUDES = [
  ".ao",
  ".claude/settings.json",
  ".claude/metadata-updater.sh",
  ".claude/metadata-updater.cjs",
  ".claude/activity-updater.sh",
  ".claude/activity-updater.cjs",
  ".claude/orchestrator-no-inline-code.cjs",
  ".claude/orchestrator-no-source-shell.cjs",
  ".claude/pre-spawn-rlm.cjs",
] as const;

const EXCLUDE_HEADER = "# AO injected (do not commit)";

/**
 * Appends AO's injected paths to `<worktree>/.git/info/exclude` so `git add
 * -A` / `git commit -am` don't sweep them into a worker's commits. This only
 * hides untracked paths — it can't un-track a file a repo already committed
 * (see Maestro's pathspec-based diff-view filter for that case) — but for the
 * common case of a fresh worktree it's what actually keeps PRs clean.
 * Idempotent: only appends entries missing from the file.
 */
export async function writeWorktreeGitExclude(worktreePath: string): Promise<void> {
  const gitDir = join(worktreePath, ".git");
  const excludePath = existsSync(gitDir) && !(await isDirectory(gitDir))
    ? await resolveLinkedGitDir(gitDir)
    : join(gitDir, "info", "exclude");

  let existing = "";
  try {
    existing = await readFile(excludePath, "utf-8");
  } catch {
    // File may not exist yet; start fresh
  }

  const existingLines = new Set(existing.split("\n").map((line) => line.trim()));
  const missing = AO_INJECTED_WORKTREE_EXCLUDES.filter((path) => !existingLines.has(path));
  if (missing.length === 0) return;

  await mkdir(dirname(excludePath), { recursive: true });
  const needsHeader = !existing.includes(EXCLUDE_HEADER);
  const suffix = [
    existing.length > 0 && !existing.endsWith("\n") ? "\n" : "",
    needsHeader ? `${EXCLUDE_HEADER}\n` : "",
    missing.map((path) => `${path}\n`).join(""),
  ].join("");

  await writeFile(excludePath, existing + suffix, "utf-8");
}

async function isDirectory(path: string): Promise<boolean> {
  const { stat } = await import("node:fs/promises");
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Linked worktrees have a `.git` *file* pointing at `gitdir: <path>`. */
async function resolveLinkedGitDir(gitFilePath: string): Promise<string> {
  const content = await readFile(gitFilePath, "utf-8");
  const match = content.match(/^gitdir:\s*(.+)$/m);
  const gitDir = match ? match[1].trim() : gitFilePath;
  return join(gitDir, "info", "exclude");
}
