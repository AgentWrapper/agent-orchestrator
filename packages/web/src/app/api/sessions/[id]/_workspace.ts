import { getServices } from "@/lib/services";
import { realpathSync } from "./_fs";
import { resolve } from "node:path";
import { spawnSync } from "./_child-process";

/**
 * Resolves a session's workspace path to its canonical (realpath) form and
 * caches the result in a bounded TTL cache.
 *
 * The cache is shared across all file-content routes so they consistently see
 * the same canonicalized root and cannot be tricked by a stale or symlinked
 * workspace entry.
 */

const WORKSPACE_TTL_MS = 60_000;
const WORKSPACE_MAX_ENTRIES = 128;

const workspaceCache = new Map<string, { realRoot: string; expiresAt: number }>();

export type WorkspaceLookup =
  | { ok: true; realRoot: string }
  | { ok: false; reason: "not_found" | "no_workspace" };

export async function resolveWorkspace(sessionId: string): Promise<WorkspaceLookup> {
  const now = Date.now();
  const cached = workspaceCache.get(sessionId);
  if (cached && cached.expiresAt > now) {
    return { ok: true, realRoot: cached.realRoot };
  }

  const { sessionManager } = await getServices();
  const session = await sessionManager.get(sessionId);
  if (!session) return { ok: false, reason: "not_found" };

  const ws = session.workspacePath;
  if (!ws) return { ok: false, reason: "no_workspace" };

  let realRoot: string;
  try {
    realRoot = realpathSync(resolve(ws));
  } catch {
    // Directory is missing or not accessible — treat as no workspace.
    return { ok: false, reason: "no_workspace" };
  }

  // Sweep expired before adding to keep the map bounded.
  if (workspaceCache.size >= WORKSPACE_MAX_ENTRIES) {
    for (const [k, v] of workspaceCache) {
      if (v.expiresAt <= now) workspaceCache.delete(k);
    }
    // If still at cap, evict the oldest entry (Map iteration order is insertion order).
    if (workspaceCache.size >= WORKSPACE_MAX_ENTRIES) {
      const firstKey = workspaceCache.keys().next().value;
      if (firstKey !== undefined) workspaceCache.delete(firstKey);
    }
  }

  workspaceCache.set(sessionId, { realRoot, expiresAt: now + WORKSPACE_TTL_MS });
  return { ok: true, realRoot };
}

export interface BaseRefResult {
  baseRef: string;
  mergeBase: string;
}

/**
 * Resolve the base branch ref and compute the merge-base SHA for branch-scope diffs.
 *
 * Fallback chain:
 *   1. session.baseBranch (prefixed with origin/ if that remote-tracking ref exists)
 *   2. origin/HEAD (via git symbolic-ref)
 *   3. origin/main, origin/master
 *   4. main, master
 *
 * Returns null (fail soft) when no base can be resolved or merge-base fails.
 */
export function resolveBaseRef(realRoot: string, baseBranch?: string | null): BaseRefResult | null {
  function run(args: string[]): string | null {
    const r = spawnSync("git", args, { cwd: realRoot, encoding: "utf-8", timeout: 5000 });
    if (r.error || (r.status !== 0 && r.status !== 1)) return null;
    return (r.stdout ?? "").trim() || null;
  }

  function refExists(ref: string): boolean {
    const r = spawnSync("git", ["rev-parse", "--verify", ref], { cwd: realRoot, encoding: "utf-8", timeout: 3000 });
    return r.status === 0 && !r.error;
  }

  function computeMergeBase(ref: string): BaseRefResult | null {
    const mb = run(["merge-base", "HEAD", ref]);
    if (!mb) return null;
    return { baseRef: ref, mergeBase: mb };
  }

  // 1. session.baseBranch
  if (baseBranch) {
    const remote = `origin/${baseBranch}`;
    if (refExists(remote)) {
      return computeMergeBase(remote);
    }
    if (refExists(baseBranch)) {
      return computeMergeBase(baseBranch);
    }
  }

  // 2. origin/HEAD
  const originHead = run(["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (originHead) {
    const ref = originHead.replace("refs/remotes/", "");
    const result = computeMergeBase(ref);
    if (result) return result;
  }

  // 3. origin/main, origin/master
  for (const ref of ["origin/main", "origin/master"]) {
    if (refExists(ref)) {
      const result = computeMergeBase(ref);
      if (result) return result;
    }
  }

  // 4. main, master
  for (const ref of ["main", "master"]) {
    if (refExists(ref)) {
      const result = computeMergeBase(ref);
      if (result) return result;
    }
  }

  return null;
}

export interface SafeFileResolution {
  /** Canonicalized absolute path inside the workspace, safe for statSync/readFileSync. */
  fullPath: string;
  /** Whether the target file/directory currently exists. */
  exists: boolean;
}

/**
 * Resolve a relative path inside the workspace, defending against symlink
 * escapes. Returns `null` if the resolved path escapes the workspace root.
 *
 * If the path does not yet exist on disk (e.g. deleted/renamed), falls back to
 * the lexical resolution — callers must still guard their reads.
 */
export function resolveWorkspaceFile(realRoot: string, relPath: string): SafeFileResolution | null {
  const lexical = resolve(realRoot, relPath);
  const rootWithSep = realRoot.endsWith("/") ? realRoot : realRoot + "/";

  // Lexical escape: definitely reject.
  if (lexical !== realRoot && !lexical.startsWith(rootWithSep)) {
    return null;
  }

  try {
    const real = realpathSync(lexical);
    if (real !== realRoot && !real.startsWith(rootWithSep)) {
      return null;
    }
    return { fullPath: real, exists: true };
  } catch {
    // Path doesn't exist; return lexical path for not-found handling.
    return { fullPath: lexical, exists: false };
  }
}
