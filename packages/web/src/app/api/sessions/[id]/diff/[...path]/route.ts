import { type NextRequest } from "next/server";
import { jsonWithCorrelation, getCorrelationId } from "@/lib/observability";
import { readFileSync, statSync } from "../../_fs";
import { resolveWorkspace, resolveWorkspaceFile, resolveBaseRef } from "../../_workspace";
import { spawnSync } from "../../_child-process";
import { createHash } from "../../_crypto";

const MAX_DIFF_BYTES = 512 * 1024;
const MAX_UNTRACKED_READ = 1_048_576;

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".webp",
  ".svg",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".7z",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".mp3",
  ".mp4",
  ".avi",
  ".mov",
]);

type GitStatus = "M" | "A" | "D" | "?" | "R";

function getPathGitStatus(worktreePath: string, filePath: string): GitStatus | undefined {
  // -z produces NUL-separated records without C-quoting. For renames/copies,
  // git emits two NUL-terminated tokens (new path, then old path) after the
  // "XY " prefix; we only need the status bits, not the paths.
  const result = spawnSync("git", ["status", "-z", "--porcelain=v1", "--", filePath], {
    cwd: worktreePath,
    encoding: "utf-8",
    timeout: 5000,
  });
  if (result.error || result.status === 128) return undefined;
  const out = result.stdout ?? "";
  if (!out) return undefined;
  const firstRecord = out.split("\0")[0] ?? "";
  if (firstRecord.length < 3) return undefined;
  const x = firstRecord[0];
  const y = firstRecord[1];
  if (x === "?") return "?";
  const status = x !== " " ? x : y;
  return status as GitStatus;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; path: string[] }> }
) {
  const correlationId = getCorrelationId(request);
  try {
    const { id, path: pathSegments } = await params;
    const filePath = pathSegments.join("/");

    if (!filePath) {
      return jsonWithCorrelation({ error: "Invalid path" }, { status: 400 }, correlationId);
    }

    const workspace = await resolveWorkspace(id);
    if (!workspace.ok) {
      const msg = workspace.reason === "not_found" ? "Session not found" : "Session has no workspace";
      return jsonWithCorrelation({ error: msg }, { status: 404 }, correlationId);
    }

    const resolved = resolveWorkspaceFile(workspace.realRoot, filePath);
    if (!resolved) {
      return jsonWithCorrelation({ error: "Forbidden" }, { status: 403 }, correlationId);
    }

    const ext = filePath.includes(".") ? filePath.slice(filePath.lastIndexOf(".")).toLowerCase() : "";

    if (BINARY_EXTENSIONS.has(ext)) {
      return jsonWithCorrelation(
        {
          error: "binary",
          message: "Binary file diff is not supported",
          path: filePath,
        },
        { status: 422 },
        correlationId
      );
    }

    const scopeParam = new URL(request.url).searchParams.get("scope");
    const scope = scopeParam === "branch" ? "branch" : "local";

    // Resolve merge-base for branch scope (fail soft → fall back to local).
    let mergeBase: string | null = null;
    if (scope === "branch") {
      const baseResult = resolveBaseRef(workspace.realRoot);
      if (baseResult) mergeBase = baseResult.mergeBase;
    }

    const statusFromGit = getPathGitStatus(workspace.realRoot, filePath);
    const isUntracked = statusFromGit === "?";

    if (isUntracked) {
      if (!resolved.exists) {
        return jsonWithCorrelation(
          { error: "not_found", message: "File not found", path: filePath },
          { status: 404 },
          correlationId
        );
      }
      let stat;
      try {
        stat = statSync(resolved.fullPath);
      } catch {
        return jsonWithCorrelation(
          { error: "not_found", message: "File not found", path: filePath },
          { status: 404 },
          correlationId
        );
      }
      if (!stat.isFile()) {
        return jsonWithCorrelation({ error: "Invalid path" }, { status: 400 }, correlationId);
      }
      if (stat.size > MAX_UNTRACKED_READ) {
        return jsonWithCorrelation(
          {
            error: "too_large",
            message: `File is too large to diff (${(stat.size / 1024 / 1024).toFixed(1)}MB)`,
            path: filePath,
          },
          { status: 422 },
          correlationId
        );
      }
      const content = readFileSync(resolved.fullPath, "utf-8");
      // Content-hash ETag: avoids same-size rewrite collisions.
      const etag = `"u-${createHash("sha256").update(content).digest("hex").slice(0, 16)}"`;
      if (request.headers.get("if-none-match") === etag) {
        return new Response(null, { status: 304, headers: { ETag: etag } });
      }
      return jsonWithCorrelation(
        {
          path: filePath,
          status: "?" as const,
          diff: null,
          content,
        },
        { status: 200, headers: { ETag: etag } },
        correlationId
      );
    }

    // Branch scope: diff from merge-base to working tree (covers committed + uncommitted).
    // Local scope (or fallback when merge-base resolution fails): diff HEAD to working tree.
    const diffRef = scope === "branch" && mergeBase ? mergeBase : "HEAD";
    const diffResult = spawnSync("git", ["diff", diffRef, "--", filePath], {
      cwd: workspace.realRoot,
      encoding: "utf-8",
      timeout: 5000,
      maxBuffer: 600 * 1024,
    });

    if (diffResult.error) {
      const errMsg = diffResult.error.message ?? "";
      if (errMsg.includes("maxBuffer") || errMsg.includes("ENOBUFS")) {
        return jsonWithCorrelation(
          { error: "diff_too_large", message: "Diff too large to display", path: filePath },
          { status: 422 },
          correlationId
        );
      }
      return jsonWithCorrelation(
        { error: "git_failed", message: diffResult.error.message, path: filePath },
        { status: 500 },
        correlationId
      );
    }

    if (diffResult.status !== 0 && diffResult.status !== 1) {
      return jsonWithCorrelation(
        {
          error: "git_error",
          message: (diffResult.stderr || "").trim() || "git diff failed",
          path: filePath,
        },
        { status: 500 },
        correlationId
      );
    }

    const diffText = diffResult.stdout ?? "";
    if (diffText.includes("Binary files ") && diffText.includes(" differ")) {
      return jsonWithCorrelation(
        { error: "binary", message: "Binary file diff is not supported", path: filePath },
        { status: 422 },
        correlationId
      );
    }
    if (diffText.length > MAX_DIFF_BYTES) {
      return jsonWithCorrelation(
        { error: "diff_too_large", message: "Diff too large to display", path: filePath },
        { status: 422 },
        correlationId
      );
    }

    const effectiveStatus: GitStatus = statusFromGit ?? "M";
    const diffPayload = diffText.length > 0 ? diffText : null;
    const etag = `"d-${createHash("sha256").update(diffText).digest("hex").slice(0, 16)}"`;
    if (request.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag } });
    }

    return jsonWithCorrelation(
      {
        path: filePath,
        status: effectiveStatus,
        diff: diffPayload,
        content: null,
      },
      { status: 200, headers: { ETag: etag } },
      correlationId
    );
  } catch (error) {
    console.error("Error fetching diff:", error);
    return jsonWithCorrelation(
      { error: "Failed to fetch diff" },
      { status: 500 },
      correlationId
    );
  }
}
