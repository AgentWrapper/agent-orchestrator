import { type NextRequest } from "next/server";
import { jsonWithCorrelation, getCorrelationId } from "@/lib/observability";
import { readFileSync, statSync } from "../../_fs";
import { resolveWorkspace, resolveWorkspaceFile } from "../../_workspace";
import { createHash } from "../../_crypto";

const MAX_FILE_SIZE = 1_048_576; // 1MB

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

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; path: string[] }> }
) {
  const correlationId = getCorrelationId(request);
  try {
    const { id, path: pathSegments } = await params;
    const filePath = pathSegments.join("/");

    const workspace = await resolveWorkspace(id);
    if (!workspace.ok) {
      const status = workspace.reason === "not_found" ? 404 : 404;
      const msg = workspace.reason === "not_found" ? "Session not found" : "Session has no workspace";
      return jsonWithCorrelation({ error: msg }, { status }, correlationId);
    }

    const resolved = resolveWorkspaceFile(workspace.realRoot, filePath);
    if (!resolved) {
      return jsonWithCorrelation({ error: "Forbidden" }, { status: 403 }, correlationId);
    }

    const ext = filePath.includes(".") ? filePath.slice(filePath.lastIndexOf(".")).toLowerCase() : "";

    // Binary check before stat (cheaper)
    if (BINARY_EXTENSIONS.has(ext)) {
      let size = 0;
      if (resolved.exists) {
        try {
          size = statSync(resolved.fullPath).size;
        } catch {
          // ignore
        }
      }
      return jsonWithCorrelation(
        {
          error: "binary",
          message: "Binary file preview is not supported",
          path: filePath,
          size,
        },
        { status: 422 },
        correlationId
      );
    }

    if (!resolved.exists) {
      return jsonWithCorrelation(
        { error: "not_found", message: "File not found", path: filePath },
        { status: 404 },
        correlationId
      );
    }

    const stat = statSync(resolved.fullPath);

    // Size check first so we don't read huge files just to hash them.
    if (stat.size > MAX_FILE_SIZE) {
      const etag = `"s-${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`;
      return jsonWithCorrelation(
        {
          error: "too_large",
          message: `File is too large to preview (${(stat.size / 1024 / 1024).toFixed(1)}MB)`,
          path: filePath,
          size: stat.size,
        },
        { status: 422, headers: { ETag: etag } },
        correlationId
      );
    }

    const content = readFileSync(resolved.fullPath, "utf-8");

    // Content-hash ETag: safe against same-size rewrites + mtime collisions.
    const etag = `"h-${createHash("sha256").update(content).digest("hex").slice(0, 16)}"`;
    if (request.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag } });
    }

    return jsonWithCorrelation(
      { content, path: filePath, size: stat.size, mtime: stat.mtime.toISOString() },
      { status: 200, headers: { ETag: etag } },
      correlationId
    );
  } catch (error) {
    console.error("Error fetching file content:", error);
    return jsonWithCorrelation(
      { error: "Failed to fetch file content" },
      { status: 500 },
      correlationId
    );
  }
}
