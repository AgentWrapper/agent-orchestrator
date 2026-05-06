import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, lstatSync, symlinkSync, rmSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { homedir } from "node:os";
import type {
  PluginModule,
  Workspace,
  WorkspaceCreateConfig,
  WorkspaceInfo,
  ProjectConfig,
} from "@aoagents/ao-core/types";

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
  const { stdout } = await execFileAsync("git", args, { cwd, timeout: GIT_TIMEOUT });
  return stdout.trimEnd();
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
    return output
      .split("\n")
      .some((line) => line.startsWith("worktree ") && line.slice("worktree ".length) === worktreePath);
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
        // Branch already exists — create worktree and check it out
        await git(repoPath, "worktree", "add", worktreePath, baseRef);
        try {
          await git(worktreePath, "checkout", cfg.branch);
        } catch (checkoutErr: unknown) {
          // Checkout failed — remove the orphaned worktree before rethrowing
          try {
            await git(repoPath, "worktree", "remove", "--force", worktreePath);
          } catch {
            // Best-effort cleanup
          }
          const checkoutMsg =
            checkoutErr instanceof Error ? checkoutErr.message : String(checkoutErr);
          throw new Error(`Failed to checkout branch "${cfg.branch}" in worktree: ${checkoutMsg}`, {
            cause: checkoutErr,
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
        // If git commands fail, try to clean up the directory
        if (existsSync(workspacePath)) {
          rmSync(workspacePath, { recursive: true, force: true });
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

        if (path && (path === projectWorktreeDir || path.startsWith(projectWorktreeDir + "/"))) {
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

      // Try to create worktree on the existing branch
      try {
        await git(repoPath, "worktree", "add", workspacePath, cfg.branch);
      } catch {
        const baseRef = await resolveBaseRef(repoPath, cfg.project.defaultBranch, {
          branch: cfg.branch,
          hasOrigin,
        });

        if (!baseRef.startsWith("origin/")) {
          // No remote available — create from the local default branch
          await git(repoPath, "worktree", "add", "-b", cfg.branch, workspacePath, baseRef);
        } else {
          // Branch might not exist locally — try the remote ref first, then fall back
          // to the local default branch if the remote ref is unavailable.
          try {
            await git(repoPath, "worktree", "add", "-b", cfg.branch, workspacePath, baseRef);
          } catch {
            await git(
              repoPath,
              "worktree",
              "add",
              "-b",
              cfg.branch,
              workspacePath,
              `refs/heads/${cfg.project.defaultBranch}`,
            );
          }
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
          // Guard against absolute paths and directory traversal
          if (symlinkPath.startsWith("/") || symlinkPath.includes("..")) {
            throw new Error(
              `Invalid symlink path "${symlinkPath}": must be a relative path without ".." segments`,
            );
          }

          const sourcePath = join(repoPath, symlinkPath);
          const targetPath = resolve(info.path, symlinkPath);

          // Verify resolved target is still within the workspace
          if (!targetPath.startsWith(info.path + "/") && targetPath !== info.path) {
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
          symlinkSync(sourcePath, targetPath);
        }
      }

      // Run postCreate hooks
      // NOTE: commands run with full shell privileges — they come from trusted YAML config
      if (project.postCreate) {
        for (const command of project.postCreate) {
          await execFileAsync("sh", ["-c", command], { cwd: info.path });
        }
      }
    },
  };
}

export default { manifest, create } satisfies PluginModule<Workspace>;
