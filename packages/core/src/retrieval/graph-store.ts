/**
 * On-disk graphify graph store for a project.
 *
 * IMPORTANT (verified against graphifyy 0.5.0, not assumed): `graphify
 * update <path>` always writes `graphify-out/` *inside* `<path>` itself —
 * the process CWD has no effect on the output location. There is no `--out`
 * flag on `update`. So the only way to keep graph output out of the repo is
 * to run `update` against a *mirror* of the repo, not the repo itself.
 *
 * We mirror the project's tracked files (`git archive HEAD | tar -x`) into
 * the project's retrieval dir and run `graphify update` on that mirror.
 * `graph.json`'s `source_file` values end up relative to the mirror root,
 * which — since the mirror *is* the repo root — are already repo-relative
 * paths. The real repo directory is never written to.
 *
 * Rebuilds are incremental in intent: we only re-mirror + re-run `update`
 * when the project's HEAD sha has moved since the last stamped build.
 */

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getProjectRetrievalDir } from "../paths.js";

const execFileAsync = promisify(execFile);

export function resolveGraphifyBin(): string {
  return process.env["MAESTRO_GRAPHIFY_BIN"] || "graphify";
}

function getMirrorDir(projectId: string): string {
  return join(getProjectRetrievalDir(projectId), "src-mirror");
}

export function getGraphOutDir(projectId: string): string {
  return join(getMirrorDir(projectId), "graphify-out");
}

export function getGraphJsonPath(projectId: string): string {
  return join(getGraphOutDir(projectId), "graph.json");
}

function getStampPath(projectId: string): string {
  return join(getProjectRetrievalDir(projectId), "build-stamp.json");
}

interface BuildStamp {
  commitSha: string;
  builtAtMs: number;
}

function readStamp(projectId: string): BuildStamp | null {
  try {
    const raw = readFileSync(getStampPath(projectId), "utf-8");
    const parsed = JSON.parse(raw) as Partial<BuildStamp>;
    return typeof parsed.commitSha === "string" ? (parsed as BuildStamp) : null;
  } catch {
    return null;
  }
}

function writeStamp(projectId: string, commitSha: string, nowMs: number): void {
  writeFileSync(
    getStampPath(projectId),
    JSON.stringify({ commitSha, builtAtMs: nowMs } satisfies BuildStamp),
    "utf-8",
  );
}

/** Injectable for tests. Runs `git rev-parse HEAD` in projectRoot. */
export type GitHeadResolver = (projectRoot: string) => Promise<string | null>;

export const defaultGitHeadResolver: GitHeadResolver = async (projectRoot) => {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: projectRoot,
      timeout: 5000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
};

/** Mirrors the project's tracked files (git archive HEAD) into mirrorDir. */
async function mirrorProjectSource(
  projectRoot: string,
  mirrorDir: string,
  timeoutMs: number,
): Promise<void> {
  rmSync(mirrorDir, { recursive: true, force: true });
  mkdirSync(mirrorDir, { recursive: true });

  const { stdout } = await execFileAsync("git", ["archive", "HEAD"], {
    cwd: projectRoot,
    timeout: timeoutMs,
    maxBuffer: 256 * 1024 * 1024,
    encoding: "buffer",
  });

  await new Promise<void>((resolveTar, reject) => {
    const tar = spawn("tar", ["-x", "-C", mirrorDir]);
    tar.on("error", reject);
    tar.on("close", (code) => {
      if (code === 0) resolveTar();
      else reject(new Error(`tar exited with code ${code}`));
    });
    tar.stdin.end(stdout);
  });
}

/** Injectable for tests. Mirrors projectRoot and runs `graphify update` on the mirror. */
export type GraphifyUpdateRunner = (
  bin: string,
  projectRoot: string,
  mirrorDir: string,
  timeoutMs: number,
) => Promise<void>;

export const defaultGraphifyUpdateRunner: GraphifyUpdateRunner = async (
  bin,
  projectRoot,
  mirrorDir,
  timeoutMs,
) => {
  await mirrorProjectSource(projectRoot, mirrorDir, timeoutMs);
  await execFileAsync(bin, ["update", mirrorDir], {
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
};

/**
 * Ensures graph.json is present and reasonably fresh for the project's
 * current HEAD. Builds on first use, re-mirrors + re-extracts when HEAD
 * moved. FAIL-OPEN: never throws — returns false when the graph is
 * unavailable (no git repo, graphify missing, mirror/update failed, ...).
 */
export async function ensureGraphBuilt(params: {
  projectId: string;
  projectRoot: string;
  timeoutMs?: number;
  bin?: string;
  gitHeadResolver?: GitHeadResolver;
  updateRunner?: GraphifyUpdateRunner;
}): Promise<boolean> {
  const timeoutMs = params.timeoutMs ?? 60_000;
  const bin = params.bin ?? resolveGraphifyBin();
  const gitHeadResolver = params.gitHeadResolver ?? defaultGitHeadResolver;
  const updateRunner = params.updateRunner ?? defaultGraphifyUpdateRunner;

  try {
    const retrievalDir = getProjectRetrievalDir(params.projectId);
    mkdirSync(retrievalDir, { recursive: true });

    const graphJsonPath = getGraphJsonPath(params.projectId);
    const currentSha = await gitHeadResolver(params.projectRoot);
    const stamp = readStamp(params.projectId);

    const upToDate =
      existsSync(graphJsonPath) && currentSha !== null && stamp?.commitSha === currentSha;
    if (upToDate) {
      return true;
    }

    await updateRunner(bin, params.projectRoot, getMirrorDir(params.projectId), timeoutMs);

    if (!existsSync(graphJsonPath)) {
      return false;
    }
    if (currentSha) {
      writeStamp(params.projectId, currentSha, Date.now());
    }
    return true;
  } catch {
    return false;
  }
}
