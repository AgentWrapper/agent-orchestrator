import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import {
  existsSync,
  lstatSync,
  statSync,
  symlinkSync,
  linkSync,
  rmSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { join, resolve, basename, dirname, sep } from "node:path";
import { homedir } from "node:os";
import {
  getShell,
  isWindows,
  type PluginModule,
  type Workspace,
  type WorkspaceCreateConfig,
  type WorkspaceInfo,
  type ProjectConfig,
} from "@aoagents/ao-core";

/** Timeout for git commands (30 seconds) */
const GIT_TIMEOUT = 30_000;

const execFileAsync = promisify(execFile);

export const manifest = {
  name: "worktree",
  slot: "workspace" as const,
  description: "Workspace plugin: git worktrees",
  version: "0.1.0",
};

/** Run a git command in a given directory */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    windowsHide: true,
    timeout: GIT_TIMEOUT,
  });
  return stdout.trimEnd();
}

/**
 * Normalize a path for cross-platform comparison. `git worktree list --porcelain`
 * emits forward-slash paths on Windows even when callers constructed the
 * directory with backslashes via `path.join`. Lowercase the drive letter so
 * `C:` and `c:` match.
 */
function toComparablePath(p: string): string {
  const slash = p.replace(/\\/g, "/");
  return slash.replace(/^([a-zA-Z]):/, (_, d: string) => d.toLowerCase() + ":");
}

/**
 * Remove a directory, retrying on Windows when file handles haven't drained yet.
 *
 * On Windows, killing a pty-host with node-pty leaves a small window where
 * child processes (conpty_console_list_agent.exe, the agent's spawned shell,
 * .git/index.lock) still hold handles inside the worktree. rmSync(force: true)
 * deletes individual files but the directory rmdir blocks with EBUSY/ENOTEMPTY/EPERM
 * until the kernel drains those handles — typically 100 ms–2 min. Without retry,
 * AO leaves an empty orphan directory that confuses the next git worktree
 * operation and shows up as residue under the project's worktrees directory.
 */
async function removeDirWithRetry(target: string): Promise<void> {
  if (!isWindows()) {
    rmSync(target, { recursive: true, force: true });
    return;
  }
  const backoffsMs = [0, 100, 250, 500, 1000, 2000];
  let lastErr: unknown;
  for (const delay of backoffsMs) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    try {
      rmSync(target, { recursive: true, force: true });
      if (!existsSync(target)) return;
    } catch (err) {
      lastErr = err;
    }
  }
  if (existsSync(target)) {
    throw new Error(
      `Failed to remove "${target}" after ${backoffsMs.length} attempts (Windows file-handle drain). ` +
        `Last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    );
  }
}

async function hasOriginRemote(cwd: string): Promise<boolean> {
  try {
    await git(cwd, "remote", "get-url", "origin");
    return true;
  } catch {
    return false;
  }
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await git(cwd, "rev-parse", "--verify", "--quiet", ref);
    return true;
  } catch {
    return false;
  }
}

async function resolveBaseRef(
  repoPath: string,
  defaultBranch: string,
  options?: { branch?: string; hasOrigin?: boolean },
): Promise<string> {
  const hasOrigin = options?.hasOrigin ?? (await hasOriginRemote(repoPath));

  if (hasOrigin) {
    if (options?.branch) {
      const remoteBranch = `origin/${options.branch}`;
      if (await refExists(repoPath, remoteBranch)) return remoteBranch;
    }

    const remoteDefaultBranch = `origin/${defaultBranch}`;
    if (await refExists(repoPath, remoteDefaultBranch)) return remoteDefaultBranch;
  }

  const localDefaultBranch = `refs/heads/${defaultBranch}`;
  if (await refExists(repoPath, localDefaultBranch)) return localDefaultBranch;

  throw new Error(`Unable to resolve base ref for default branch "${defaultBranch}"`);
}

async function isRegisteredWorktree(repoPath: string, worktreePath: string): Promise<boolean> {
  try {
    const output = await git(repoPath, "worktree", "list", "--porcelain");
    // Normalize both sides so non-canonical inputs don't false-negative
    // and let a subsequent rmSync delete a still-registered worktree
    // (data loss). resolve() collapses trailing-slash / ".." segments;
    // toComparablePath handles Windows backslashes and drive case.
    const target = toComparablePath(resolve(worktreePath));
    return output
      .split("\n")
      .some(
        (line) =>
          line.startsWith("worktree ") &&
          toComparablePath(resolve(line.slice("worktree ".length))) === target,
      );
  } catch {
    return false;
  }
}

async function clearStaleWorktreePath(repoPath: string, worktreePath: string): Promise<void> {
  if (!existsSync(worktreePath)) return;

  try {
    await git(repoPath, "worktree", "prune");
  } catch {
    // Best-effort prune before checking whether the path is still registered.
  }

  if (await isRegisteredWorktree(repoPath, worktreePath)) {
    throw new Error(
      `Worktree path "${worktreePath}" already exists and is still registered with git`,
    );
  }

  rmSync(worktreePath, { recursive: true, force: true });
}

/**
 * Restore recovery: clear any stale worktree registration and/or stale
 * directory at `workspacePath` so a subsequent `git worktree add` can
 * succeed. Both restore branches (re-attach existing branch, create from
 * base) need this — without it, an `<path> already exists` failure repeats.
 *
 * Refuses to rmSync the path if it's still a registered worktree, which
 * would silently destroy the user's work. The entry-point `worktree prune`
 * in restore() already ran, so we don't prune again here.
 */
async function cleanupStaleWorkspacePath(
  repoPath: string,
  workspacePath: string,
): Promise<void> {
  // Force-remove any registered worktree at this path. Best-effort — the
  // path may not be registered, in which case git errors and we fall
  // through to the dir cleanup.
  try {
    await git(repoPath, "worktree", "remove", "--force", workspacePath);
  } catch {
    // Best-effort
  }

  if (existsSync(workspacePath)) {
    if (await isRegisteredWorktree(repoPath, workspacePath)) {
      throw new Error(
        `Worktree path "${workspacePath}" already exists and is still registered with git`,
      );
    }
    // Use removeDirWithRetry for Windows file-handle drain races (matches
    // destroy()'s fallback). On Unix this is just rmSync.
    await removeDirWithRetry(workspacePath);
  }
}

/**
 * Restore recovery: re-attach an existing local branch to a worktree at
 * `workspacePath`. Used when the branch is already present (destroy()
 * preserves it) but the first `git worktree add <path> <branch>` failed
 * — typically because `workspacePath` has a stale registry entry, a
 * stale directory, or both.
 *
 * Never uses -b/-B: -b would fail with "branch already exists", and -B
 * would force-reset the branch to a base ref and silently discard the
 * session's commits, which is the opposite of restore's intent.
 */
async function reattachExistingBranch(
  repoPath: string,
  workspacePath: string,
  branch: string,
): Promise<void> {
  await cleanupStaleWorkspacePath(repoPath, workspacePath);
  await git(repoPath, "worktree", "add", workspacePath, branch);
}

/**
 * Restore recovery: create a fresh branch at `workspacePath` from the
 * appropriate base ref. Used when the local branch is missing — typically
 * because only `origin/<branch>` exists and we need to materialize the
 * local ref. Tries the remote ref first, then falls back to the local
 * default branch.
 *
 * Runs the same stale-path cleanup as reattachExistingBranch so this path
 * also recovers when `workspacePath` has a stale registry entry / dir.
 */
async function createBranchFromBase(
  repoPath: string,
  workspacePath: string,
  branch: string,
  defaultBranch: string,
  hasOrigin: boolean,
): Promise<void> {
  await cleanupStaleWorkspacePath(repoPath, workspacePath);

  const baseRef = await resolveBaseRef(repoPath, defaultBranch, { branch, hasOrigin });

  if (!baseRef.startsWith("origin/")) {
    // No remote available — create from the local default branch
    await git(repoPath, "worktree", "add", "-b", branch, workspacePath, baseRef);
    return;
  }

  // Branch might not exist locally — try the remote ref first, then fall
  // back to the local default branch if the remote ref is unavailable.
  try {
    await git(repoPath, "worktree", "add", "-b", branch, workspacePath, baseRef);
  } catch {
    await git(
      repoPath,
      "worktree",
      "add",
      "-b",
      branch,
      workspacePath,
      `refs/heads/${defaultBranch}`,
    );
  }
}

interface WorktreeEntry {
  path: string;
  branch: string | null;
}

function parseWorktreeList(output: string): WorktreeEntry[] {
  const normalized = output.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  return normalized
    .split("\n\n")
    .map((block) => {
      let path = "";
      let branch: string | null = null;
      for (const line of block.split("\n")) {
        if (line.startsWith("worktree ")) {
          path = resolve(line.slice("worktree ".length));
        } else if (line.startsWith("branch ")) {
          branch = line.slice("branch ".length).replace("refs/heads/", "");
        }
      }
      return { path, branch };
    })
    .filter((entry) => entry.path.length > 0);
}

/** Only allow safe characters in path segments to prevent directory traversal */
const SAFE_PATH_SEGMENT = /^[a-zA-Z0-9_-]+$/;

function assertSafePathSegment(value: string, label: string): void {
  if (!SAFE_PATH_SEGMENT.test(value)) {
    throw new Error(`Invalid ${label} "${value}": must match ${SAFE_PATH_SEGMENT}`);
  }
}

/** Expand ~ to home directory */
function expandPath(p: string): string {
  if (p.startsWith("~/")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

export function create(config?: Record<string, unknown>): Workspace {
  const worktreeBaseDir = config?.worktreeDir
    ? expandPath(config.worktreeDir as string)
    : join(homedir(), ".worktrees");

  return {
    name: "worktree",

    async create(cfg: WorkspaceCreateConfig): Promise<WorkspaceInfo> {
      assertSafePathSegment(cfg.projectId, "projectId");
      assertSafePathSegment(cfg.sessionId, "sessionId");

      const repoPath = expandPath(cfg.project.path);
      const effectiveBaseDir = cfg.worktreeDir ?? worktreeBaseDir;
      const projectWorktreeDir = cfg.worktreeDir
        ? effectiveBaseDir
        : join(effectiveBaseDir, cfg.projectId);
      const worktreePath = join(projectWorktreeDir, cfg.sessionId);

      mkdirSync(projectWorktreeDir, { recursive: true });
      await clearStaleWorktreePath(repoPath, worktreePath);

      const hasOrigin = await hasOriginRemote(repoPath);

      // Fetch latest from remote when origin exists
      if (hasOrigin) {
        try {
          await git(repoPath, "fetch", "origin", "--quiet");
        } catch {
          // Fetch may fail if offline — continue anyway
        }
      }

      const baseRef = await resolveBaseRef(repoPath, cfg.project.defaultBranch, { hasOrigin });

      // Create worktree with a new branch
      try {
        await git(repoPath, "worktree", "add", "-b", cfg.branch, worktreePath, baseRef);
      } catch (err: unknown) {
        // Only retry if the error is "branch already exists"
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("already exists")) {
          throw new Error(`Failed to create worktree for branch "${cfg.branch}": ${msg}`, {
            cause: err,
          });
        }

        // Branch already exists. It may be a stale session branch left behind
        // from an earlier spawn, so compare it with the freshly-resolved base
        // before reusing it.
        const baseSha = await git(repoPath, "rev-parse", baseRef);
        const branchRef = `refs/heads/${cfg.branch}`;
        const existingBranchSha = (await refExists(repoPath, branchRef))
          ? await git(repoPath, "rev-parse", branchRef)
          : undefined;

        try {
          if (existingBranchSha === baseSha) {
            await git(repoPath, "worktree", "add", worktreePath, cfg.branch);
          } else {
            await git(repoPath, "worktree", "add", "-B", cfg.branch, worktreePath, baseRef);
          }
        } catch (retryErr: unknown) {
          // Retry failed — remove any orphaned worktree before rethrowing
          try {
            await git(repoPath, "worktree", "remove", "--force", worktreePath);
          } catch {
            // Best-effort cleanup
          }
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          throw new Error(`Failed to create worktree for branch "${cfg.branch}": ${retryMsg}`, {
            cause: retryErr,
          });
        }
      }

      return {
        path: worktreePath,
        branch: cfg.branch,
        sessionId: cfg.sessionId,
        projectId: cfg.projectId,
      };
    },

    async findManagedWorkspace(cfg: WorkspaceCreateConfig): Promise<WorkspaceInfo | null> {
      assertSafePathSegment(cfg.projectId, "projectId");
      assertSafePathSegment(cfg.sessionId, "sessionId");

      const repoPath = expandPath(cfg.project.path);
      const effectiveBaseDir = cfg.worktreeDir ?? worktreeBaseDir;
      const projectWorktreeDir = cfg.worktreeDir
        ? effectiveBaseDir
        : join(effectiveBaseDir, cfg.projectId);
      const currentManagedPath = resolve(join(projectWorktreeDir, cfg.sessionId));
      const legacyManagedPath = resolve(join(worktreeBaseDir, cfg.projectId, cfg.sessionId));
      const allowedPaths = new Set([currentManagedPath, legacyManagedPath]);

      const worktrees = parseWorktreeList(await git(repoPath, "worktree", "list", "--porcelain"));
      const matches = worktrees.filter(
        (entry) => entry.branch === cfg.branch && existsSync(entry.path),
      );

      if (matches.length === 0) return null;
      if (matches.length > 1) {
        throw new Error(
          `Found multiple worktrees for orchestrator branch "${cfg.branch}". Reuse one workspace or remove the extras before starting the orchestrator.`,
        );
      }

      const match = matches[0]!;
      if (!allowedPaths.has(match.path)) {
        throw new Error(
          `Found existing worktree for orchestrator branch "${cfg.branch}" at "${match.path}", but it is outside AO-managed worktree directories. Reuse it manually or remove it and try again.`,
        );
      }

      return {
        path: match.path,
        branch: cfg.branch,
        sessionId: cfg.sessionId,
        projectId: cfg.projectId,
      };
    },

    async destroy(workspacePath: string): Promise<void> {
      try {
        const gitCommonDir = await git(
          workspacePath,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        );
        // git-common-dir returns something like /path/to/repo/.git
        const repoPath = resolve(gitCommonDir, "..");
        await git(repoPath, "worktree", "remove", "--force", workspacePath);

        // NOTE: We intentionally do NOT delete the branch here. The worktree
        // removal is sufficient. Auto-deleting branches risks removing
        // pre-existing local branches unrelated to this workspace (any branch
        // containing "/" would have been deleted). Stale branches can be
        // cleaned up separately via `git branch --merged` or similar.
      } catch {
        // If git commands fail, try to clean up the directory.
        // On Windows, retry with backoff for the file-handle drain race
        // (just-killed pty-host children still hold handles inside the worktree).
        if (existsSync(workspacePath)) {
          await removeDirWithRetry(workspacePath);
        }
      }
    },

    async list(projectId: string): Promise<WorkspaceInfo[]> {
      assertSafePathSegment(projectId, "projectId");
      const projectWorktreeDir = join(worktreeBaseDir, projectId);
      if (!existsSync(projectWorktreeDir)) return [];

      const entries = readdirSync(projectWorktreeDir, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => join(projectWorktreeDir, e.name));

      if (dirs.length === 0) return [];

      // Use first valid worktree to get the list
      let worktreeListOutput = "";
      for (const dir of dirs) {
        try {
          worktreeListOutput = await git(dir, "worktree", "list", "--porcelain");
          break;
        } catch {
          continue;
        }
      }

      if (!worktreeListOutput) return [];

      // Parse porcelain output — only include worktrees within our project directory
      const infos: WorkspaceInfo[] = [];
      const blocks = worktreeListOutput.split("\n\n");
      const projectDirCmp = toComparablePath(projectWorktreeDir);

      for (const block of blocks) {
        const lines = block.trim().split("\n");
        let path = "";
        let branch = "";

        for (const line of lines) {
          if (line.startsWith("worktree ")) {
            path = line.slice("worktree ".length);
          } else if (line.startsWith("branch ")) {
            // branch refs/heads/feat/INT-1234 → feat/INT-1234
            branch = line.slice("branch ".length).replace("refs/heads/", "");
          }
        }

        const pathCmp = path ? toComparablePath(path) : "";
        if (path && (pathCmp === projectDirCmp || pathCmp.startsWith(projectDirCmp + "/"))) {
          const sessionId = basename(path);
          infos.push({
            path,
            branch: branch || "detached",
            sessionId,
            projectId,
          });
        }
      }

      return infos;
    },

    async exists(workspacePath: string): Promise<boolean> {
      if (!existsSync(workspacePath)) return false;
      try {
        await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
          cwd: workspacePath,
          timeout: GIT_TIMEOUT,
          windowsHide: true,
        });
        return true;
      } catch {
        return false;
      }
    },

    async restore(cfg: WorkspaceCreateConfig, workspacePath: string): Promise<WorkspaceInfo> {
      const repoPath = expandPath(cfg.project.path);

      // Prune stale worktree entries
      try {
        await git(repoPath, "worktree", "prune");
      } catch {
        // Best effort
      }

      // Fetch latest
      const hasOrigin = await hasOriginRemote(repoPath);
      if (hasOrigin) {
        try {
          await git(repoPath, "fetch", "origin", "--quiet");
        } catch {
          // May fail if offline
        }
      }

      // Try to create worktree on the existing branch.
      try {
        await git(repoPath, "worktree", "add", workspacePath, cfg.branch);
      } catch {
        if (await refExists(repoPath, `refs/heads/${cfg.branch}`)) {
          await reattachExistingBranch(repoPath, workspacePath, cfg.branch);
        } else {
          await createBranchFromBase(
            repoPath,
            workspacePath,
            cfg.branch,
            cfg.project.defaultBranch,
            hasOrigin,
          );
        }
      }

      return {
        path: workspacePath,
        branch: cfg.branch,
        sessionId: cfg.sessionId,
        projectId: cfg.projectId,
      };
    },

    async postCreate(info: WorkspaceInfo, project: ProjectConfig): Promise<void> {
      const repoPath = expandPath(project.path);

      // Symlink shared resources
      if (project.symlinks) {
        for (const symlinkPath of project.symlinks) {
          // Guard against absolute paths (Unix: leading "/", Windows: drive letter "C:\"
          // or UNC "\\server\share") and directory traversal
          if (
            symlinkPath.startsWith("/") ||
            symlinkPath.includes("..") ||
            /^[a-zA-Z]:[\\/]/.test(symlinkPath) ||
            symlinkPath.startsWith("\\\\")
          ) {
            throw new Error(
              `Invalid symlink path "${symlinkPath}": must be a relative path without ".." segments`,
            );
          }

          const sourcePath = join(repoPath, symlinkPath);
          const targetPath = resolve(info.path, symlinkPath);
          const normalizedBase = resolve(info.path);

          // Verify resolved target is still within the workspace
          if (!targetPath.startsWith(normalizedBase + sep) && targetPath !== normalizedBase) {
            throw new Error(
              `Symlink target "${symlinkPath}" resolves outside workspace: ${targetPath}`,
            );
          }

          if (!existsSync(sourcePath)) continue;

          // Remove existing target if it exists
          try {
            const stat = lstatSync(targetPath);
            if (stat.isSymbolicLink() || stat.isFile() || stat.isDirectory()) {
              rmSync(targetPath, { recursive: true, force: true });
            }
          } catch {
            // Target doesn't exist — that's fine
          }

          // Ensure parent directory exists for nested symlink targets
          mkdirSync(dirname(targetPath), { recursive: true });
          try {
            symlinkSync(sourcePath, targetPath);
          } catch (err) {
            if (isWindows()) {
              // Symlinks need admin/Developer Mode on Windows. Try unprivileged
              // alternatives first — junctions for dirs, hardlinks for files —
              // before falling back to a recursive copy (slow + bloats every
              // worktree, especially for node_modules).
              const isDir = (() => {
                try {
                  return statSync(sourcePath).isDirectory();
                } catch {
                  return false;
                }
              })();
              try {
                if (isDir) {
                  symlinkSync(sourcePath, targetPath, "junction");
                } else {
                  linkSync(sourcePath, targetPath);
                }
              } catch {
                fs.cpSync(sourcePath, targetPath, { recursive: true });
              }
            } else {
              throw err;
            }
          }
        }
      }

      // Run postCreate hooks
      // NOTE: commands run with full shell privileges — they come from trusted YAML config
      if (project.postCreate) {
        const shell = getShell();
        for (const command of project.postCreate) {
          await execFileAsync(shell.cmd, shell.args(command), {
            cwd: info.path,
            windowsHide: true,
          });
        }
      }
    },
  };
}

export default { manifest, create } satisfies PluginModule<Workspace>;
