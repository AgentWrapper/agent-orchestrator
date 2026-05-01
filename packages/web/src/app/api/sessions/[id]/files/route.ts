import { type NextRequest } from "next/server";
import { jsonWithCorrelation, getCorrelationId } from "@/lib/observability";
import { readdirSync } from "../_fs";
import { resolveWorkspace, resolveBaseRef } from "../_workspace";
import { createHash } from "../_crypto";
import { join, relative } from "node:path";
import { execSync, spawnSync } from "../_child-process";

type DiffScope = "local" | "branch";

export interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileNode[];
}

type GitStatus = "M" | "A" | "D" | "?" | "R";

// Skip directories that are never part of an engineer's working set. Keeps
// buildTree from walking into generated output, .git internals, and lockfile
// stores, which can be tens of thousands of files deep.
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  ".turbo",
  ".cache",
  ".pnpm-store",
]);

const MAX_DEPTH = 8;
const MAX_NODES = 5000;

/**
 * Parse `git status -z --porcelain=v1` output.
 *
 * With `-z`:
 * - Records are NUL-separated and NOT C-quoted.
 * - Normal entries: "XY PATH".
 * - Renames/copies ("R"/"C"): "XY NEW_PATH", followed by a separate NUL-terminated
 *   record containing OLD_PATH. The status maps to NEW_PATH.
 */
function getGitStatus(worktreePath: string): Record<string, GitStatus> {
  const result: Record<string, GitStatus> = {};
  try {
    const output = execSync("git status -z --porcelain=v1 -uall", {
      cwd: worktreePath,
      encoding: "utf-8",
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const records = output.split("\0");
    let i = 0;
    while (i < records.length) {
      const rec = records[i];
      if (!rec || rec.length < 3) {
        i += 1;
        continue;
      }
      const x = rec[0];
      const y = rec[1];
      const path = rec.slice(3);
      const status: GitStatus = (x === "?" ? "?" : x !== " " ? x : y) as GitStatus;
      result[path] = status;
      // Renames and copies are emitted as two NUL-terminated tokens. Skip the
      // follow-up old-path record so we don't treat it as a new entry.
      if (x === "R" || x === "C") {
        i += 2;
      } else {
        i += 1;
      }
    }
  } catch {
    // git not available or not a repo — return empty
  }
  return result;
}

/**
 * Parse `git diff -z --name-status <mergeBase>` output.
 *
 * Format (NUL-separated): "STATUS\0PATH\0" (or "STATUS\0OLD\0NEW\0" for renames).
 */
function getBranchGitStatus(worktreePath: string, mergeBase: string): Record<string, GitStatus> {
  const result: Record<string, GitStatus> = {};
  try {
    const r = spawnSync("git", ["diff", "-z", "--name-status", mergeBase], {
      cwd: worktreePath,
      encoding: "utf-8",
      timeout: 10000,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (r.error || (r.status !== 0 && r.status !== 1)) return result;
    const tokens = (r.stdout ?? "").split("\0").filter(Boolean);
    let i = 0;
    while (i < tokens.length) {
      const statusToken = tokens[i] ?? "";
      const statusChar = statusToken[0];
      if (!statusChar) { i += 1; continue; }
      if (statusChar === "R" || statusChar === "C") {
        // R/C: STATUS OLD NEW
        const newPath = tokens[i + 2];
        if (newPath) result[newPath] = "R";
        i += 3;
      } else {
        const path = tokens[i + 1];
        if (path) result[path] = statusChar as GitStatus;
        i += 2;
      }
    }
  } catch {
    // fail soft
  }
  return result;
}

/**
 * Merge branch-tracked changes with untracked files from `git status`.
 * Untracked (??)-only entries are added; existing entries are not overwritten.
 */
function mergeBranchWithUntracked(
  branchStatus: Record<string, GitStatus>,
  localStatus: Record<string, GitStatus>
): Record<string, GitStatus> {
  const merged: Record<string, GitStatus> = { ...branchStatus };
  for (const [path, status] of Object.entries(localStatus)) {
    if (status === "?" && !(path in merged)) {
      merged[path] = "?";
    }
  }
  return merged;
}

interface BuildContext {
  rootPath: string;
  count: number;
  truncated: boolean;
}

function buildTree(dirPath: string, depth: number, ctx: BuildContext): FileNode[] {
  const nodes: FileNode[] = [];
  if (depth > MAX_DEPTH || ctx.count >= MAX_NODES) {
    ctx.truncated = true;
    return nodes;
  }

  let entries;
  try {
    entries = readdirSync(dirPath, { withFileTypes: true });
  } catch {
    // Unreadable directory (perms, race) — skip quietly so one bad dir doesn't
    // 500 the whole tree.
    return nodes;
  }

  entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of entries) {
    if (ctx.count >= MAX_NODES) {
      ctx.truncated = true;
      break;
    }
    if (SKIP_DIRS.has(entry.name)) continue;

    const fullPath = join(dirPath, entry.name);
    const relPath = relative(ctx.rootPath, fullPath);

    if (entry.isDirectory()) {
      ctx.count += 1;
      nodes.push({
        name: entry.name,
        path: relPath,
        type: "directory",
        children: buildTree(fullPath, depth + 1, ctx),
      });
    } else if (entry.isFile()) {
      ctx.count += 1;
      nodes.push({
        name: entry.name,
        path: relPath,
        type: "file",
      });
    }
  }
  return nodes;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const correlationId = getCorrelationId(request);
  try {
    const { id } = await params;
    const scopeParam = new URL(request.url).searchParams.get("scope");
    const scope: DiffScope = scopeParam === "branch" ? "branch" : "local";

    const workspace = await resolveWorkspace(id);
    if (!workspace.ok) {
      const msg = workspace.reason === "not_found" ? "Session not found" : "Session has no workspace";
      return jsonWithCorrelation({ error: msg }, { status: 404 }, correlationId);
    }

    const ctx: BuildContext = { rootPath: workspace.realRoot, count: 0, truncated: false };
    const tree = buildTree(workspace.realRoot, 0, ctx);
    const localStatus = getGitStatus(workspace.realRoot);

    let gitStatus: Record<string, GitStatus>;
    let baseRef: string | null = null;

    if (scope === "branch") {
      const baseResult = resolveBaseRef(workspace.realRoot);
      if (baseResult) {
        baseRef = baseResult.baseRef;
        const branchStatus = getBranchGitStatus(workspace.realRoot, baseResult.mergeBase);
        gitStatus = mergeBranchWithUntracked(branchStatus, localStatus);
      } else {
        // Fail soft: fall back to local scope
        gitStatus = localStatus;
      }
    } else {
      gitStatus = localStatus;
    }

    // ETag includes scope + baseRef so local/branch caches don't collide.
    const hash = createHash("sha256")
      .update(JSON.stringify(tree))
      .update("\0")
      .update(JSON.stringify(gitStatus))
      .update("\0")
      .update(scope)
      .update("\0")
      .update(baseRef ?? "")
      .digest("hex")
      .slice(0, 16);
    const etag = `"t-${hash}"`;

    if (request.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag } });
    }

    return jsonWithCorrelation(
      { tree, gitStatus, truncated: ctx.truncated, scope, baseRef },
      { status: 200, headers: { ETag: etag } },
      correlationId
    );
  } catch (error) {
    console.error("Error fetching file tree:", error);
    return jsonWithCorrelation(
      { error: "Failed to fetch file tree" },
      { status: 500 },
      correlationId
    );
  }
}
