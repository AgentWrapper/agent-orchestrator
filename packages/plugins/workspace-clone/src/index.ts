import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, rmSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  PluginModule,
  Workspace,
  WorkspaceCreateConfig,
  WorkspaceInfo,
  ProjectConfig,
} from "@aoagents/ao-core";

const execFileAsync = promisify(execFile);

export const manifest = {
  name: "clone",
  slot: "workspace" as const,
  description: "Workspace plugin: git clone isolation",
  version: "0.1.0",
};

/** Run a git command in a given directory */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trimEnd();
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
  const cloneBaseDir = config?.cloneDir
    ? expandPath(config.cloneDir as string)
    : join(homedir(), ".ao-clones");

  return {
    name: "clone",

    async create(cfg: WorkspaceCreateConfig): Promise<WorkspaceInfo> {
      assertSafePathSegment(cfg.projectId, "projectId");
      assertSafePathSegment(cfg.sessionId, "sessionId");

      const repoPath = expandPath(cfg.project.path);
      const projectCloneDir = join(cloneBaseDir, cfg.projectId);
      const clonePath = join(projectCloneDir, cfg.sessionId);

      mkdirSync(projectCloneDir, { recursive: true });

      // Get the remote URL from the source repo
      let remoteUrl: string;
      try {
        remoteUrl = await git(repoPath, "remote", "get-url", "origin");
      } catch {
        // Fallback: use the local path as source
        remoteUrl = repoPath;
      }

      // Fail early if destination already exists — avoid deleting a pre-existing
      // workspace in the error handler below
      if (existsSync(clonePath)) {
        throw new Error(
          `Workspace path "${clonePath}" already exists for session "${cfg.sessionId}" — destroy it before re-creating`,
        );
      }

      // Clone using --reference for faster clone with shared objects
      try {
        await execFileAsync("git", [
          "clone",
          "--reference",
          repoPath,
          "--branch",
          cfg.project.defaultBranch,
          remoteUrl,
          clonePath,
        ]);
      } catch (cloneErr: unknown) {
        // Clone failed — clean up any partial directory left on disk
        if (existsSync(clonePath)) {
          rmSync(clonePath, { recursive: true, force: true });
        }
        const msg = cloneErr instanceof Error ? cloneErr.message : String(cloneErr);
        throw new Error(`Failed to clone repo for session "${cfg.sessionId}": ${msg}`, {
          cause: cloneErr,
        });
      }

      // Create and checkout the feature branch
      try {
        await git(clonePath, "checkout", "-b", cfg.branch);
      } catch {
        // Branch may exist on remote — try plain checkout
        try {
          await git(clonePath, "checkout", cfg.branch);
        } catch (checkoutErr: unknown) {
          // Both checkout attempts failed — clean up the orphaned clone
          rmSync(clonePath, { recursive: true, force: true });
          const msg = checkoutErr instanceof Error ? checkoutErr.message : String(checkoutErr);
          throw new Error(`Failed to checkout branch "${cfg.branch}" in clone: ${msg}`, {
            cause: checkoutErr,
          });
        }
      }

      return {
        path: clonePath,
        branch: cfg.branch,
        sessionId: cfg.sessionId,
        projectId: cfg.projectId,
      };
    },

    async destroy(workspacePath: string): Promise<void> {
      if (existsSync(workspacePath)) {
        rmSync(workspacePath, { recursive: true, force: true });
      }
    },

    async list(projectId: string): Promise<WorkspaceInfo[]> {
      assertSafePathSegment(projectId, "projectId");
      const projectCloneDir = join(cloneBaseDir, projectId);
      if (!existsSync(projectCloneDir)) return [];

      const entries = readdirSync(projectCloneDir, { withFileTypes: true });
      const infos: WorkspaceInfo[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const clonePath = join(projectCloneDir, entry.name);
        let branch: string;

        try {
          branch = await git(clonePath, "branch", "--show-current");
        } catch (err: unknown) {
          // Warn about corrupted clones instead of silently skipping
          const msg = err instanceof Error ? err.message : String(err);
          // eslint-disable-next-line no-console -- expected diagnostic for corrupted clones
          console.warn(`[workspace-clone] Skipping "${entry.name}": not a valid git repo (${msg})`);
          continue;
        }

        infos.push({
          path: clonePath,
          branch,
          sessionId: entry.name,
          projectId,
        });
      }

      return infos;
    },

    async exists(workspacePath: string): Promise<boolean> {
      if (!existsSync(workspacePath)) return false;
      try {
        await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
          cwd: workspacePath,
          timeout: 30_000,
        });
        return true;
      } catch {
        return false;
      }
    },

    async restore(cfg: WorkspaceCreateConfig, workspacePath: string): Promise<WorkspaceInfo> {
      const repoPath = expandPath(cfg.project.path);

      // Get remote URL
      let remoteUrl: string;
      try {
        remoteUrl = await git(repoPath, "remote", "get-url", "origin");
      } catch {
        remoteUrl = repoPath;
      }

      // Clone fresh — clean up partial directory on failure
      try {
        await execFileAsync("git", [
          "clone",
          "--reference",
          repoPath,
          "--branch",
          cfg.project.defaultBranch,
          remoteUrl,
          workspacePath,
        ]);
      } catch (cloneErr: unknown) {
        rmSync(workspacePath, { recursive: true, force: true });
        const msg = cloneErr instanceof Error ? cloneErr.message : String(cloneErr);
        throw new Error(`Clone failed during restore: ${msg}`, { cause: cloneErr });
      }

      // Try to checkout the branch
      try {
        await git(workspacePath, "checkout", cfg.branch);
      } catch {
        try {
          await git(workspacePath, "checkout", "-b", cfg.branch);
        } catch (checkoutErr: unknown) {
          rmSync(workspacePath, { recursive: true, force: true });
          const msg = checkoutErr instanceof Error ? checkoutErr.message : String(checkoutErr);
          throw new Error(`Failed to checkout branch "${cfg.branch}" during restore: ${msg}`, {
            cause: checkoutErr,
          });
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
