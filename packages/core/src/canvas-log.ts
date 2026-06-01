import { execFile } from "node:child_process";
import { readdir, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { CanvasArtifactSchema } from "./canvas-schema.js";
import { isWindows } from "./platform.js";
import type {
  CanvasArtifact,
  CanvasDiffFile,
  ProjectConfig,
  Session,
} from "./types.js";

// Git's "empty side" sentinel for `git diff --no-index`. Windows git rejects
// `/dev/null` and expects `NUL`; POSIX accepts the conventional path.
const NULL_DEVICE = isWindows() ? "NUL" : "/dev/null";

const execFileAsync = promisify(execFile);

export const CANVAS_MAX_FILE_BYTES = 256 * 1024;
export const CANVAS_MAX_PER_SESSION = 32;
const DIFF_MAX_FILES = 200;
const DIFF_MAX_LINES = 5000;
const UNTRACKED_FILE_LIMIT = 50;
const UNTRACKED_BYTE_BUDGET = 4 * 1024 * 1024;

export function getCanvasDir(workspacePath: string): string {
  return join(workspacePath, ".ao", "canvases");
}

export async function readCanvases(workspacePath: string): Promise<CanvasArtifact[]> {
  const dir = getCanvasDir(workspacePath);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  // Two-pass to bound I/O when a buggy agent emits 1000s of canvas files.
  // Pass 1 (cheap, all entries): lstat to filter non-regular + oversized,
  // collect {name, mtimeMs} for the survivors. lstat is cheap; readFile +
  // JSON.parse + Zod validate is the expensive part we want to bound.
  // Pass 2 (capped): sort by mtime desc, read + validate the newest, break
  // once CANVAS_MAX_PER_SESSION valid canvases are collected. Hard ceiling
  // CANVAS_MAX_PER_SESSION * 4 file reads so the loop can't be starved by a
  // pile of invalid newer files into reading everything anyway.
  type Candidate = { name: string; mtimeMs: number };
  const candidates: Candidate[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const filePath = join(dir, entry);
    try {
      const st = await lstat(filePath);
      // Reject anything that isn't a regular file. lstat (not stat) avoids
      // following symlinks so a symlink to /dev/zero or a FIFO can't slip past
      // the size check and hang the reader.
      if (!st.isFile()) {
        console.warn(`canvas: dropping ${entry} (not a regular file)`);
        continue;
      }
      if (st.size > CANVAS_MAX_FILE_BYTES) {
        console.warn(`canvas: dropping ${entry} (${st.size} bytes exceeds ${CANVAS_MAX_FILE_BYTES})`);
        continue;
      }
      candidates.push({ name: entry, mtimeMs: st.mtimeMs });
    } catch {
      // file vanished between readdir and lstat, or unreadable — skip silently
    }
  }

  // Newest-first so the read-loop can early-break at CANVAS_MAX_PER_SESSION
  // and still keep the newest files (the design intent of the cap).
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const readBudget = CANVAS_MAX_PER_SESSION * 4;
  const canvases: CanvasArtifact[] = [];
  let reads = 0;
  for (const { name } of candidates) {
    if (canvases.length >= CANVAS_MAX_PER_SESSION) break;
    if (reads >= readBudget) {
      console.warn(`canvas: stopping at ${reads} reads (budget exhausted, ${candidates.length - reads} skipped)`);
      break;
    }
    reads++;
    const filePath = join(dir, name);

    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn(`canvas: dropping ${name} (invalid JSON)`);
      continue;
    }

    const result = CanvasArtifactSchema.safeParse(parsed);
    if (!result.success) {
      console.warn(`canvas: dropping ${name} (schema invalid: ${result.error.issues[0]?.message ?? "unknown"})`);
      continue;
    }
    // The "core-" id prefix is reserved for canvases synthesized by core
    // (e.g. core-git-diff). Dropping it here prevents an agent file canvas
    // from shadowing the trusted synthesized version in API responses.
    if (result.data.id.startsWith("core-")) {
      console.warn(`canvas: dropping ${name} (id "${result.data.id}" uses reserved "core-" prefix)`);
      continue;
    }
    canvases.push(result.data);
  }

  // Final sort by updatedAt (the canvas-supplied timestamp). mtime ordering
  // was used to bound I/O; updatedAt is what the UI cares about and may
  // differ if an agent rewrites a file without changing the canvas's
  // updatedAt field.
  canvases.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return canvases;
}

export async function synthesizeGitDiffCanvas(
  session: Session,
  project: ProjectConfig,
): Promise<CanvasArtifact | null> {
  if (!session.workspacePath) return null;

  const baseBranch = project.defaultBranch;

  // Find the merge-base so the diff doesn't misattribute upstream changes.
  // `git diff <base>` against working tree would show commits added to main
  // after the session branched as "deletions" by the agent.
  // Prefer origin/<base> since the workspace plugin fetches and branches from
  // there. Falling back to the local ref keeps offline / no-remote repos working.
  const baseCandidates = [`origin/${baseBranch}`, baseBranch];
  let mergeBase = "";
  for (const candidate of baseCandidates) {
    try {
      const result = await execFileAsync("git", ["merge-base", candidate, "HEAD"], {
        cwd: session.workspacePath,
        timeout: 5_000,
      });
      const sha = result.stdout.trim();
      if (sha) {
        mergeBase = sha;
        break;
      }
    } catch {
      // try next candidate
    }
  }
  if (!mergeBase) return null;

  let stdout: string;
  try {
    const result = await execFileAsync("git", ["diff", "--no-color", mergeBase], {
      cwd: session.workspacePath,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 5_000,
    });
    stdout = result.stdout;
  } catch (err) {
    // On `maxBuffer` overflow, execFile still hands back the partial stdout it
    // captured — keep it so parseUnifiedDiff's file/line caps can produce a
    // truncated canvas instead of the user seeing the diff disappear entirely.
    const e = err as { stdout?: string };
    if (typeof e.stdout === "string" && e.stdout.length > 0) {
      stdout = e.stdout;
    } else {
      return null;
    }
  }

  // Append untracked files. `git diff` skips them, but they're a common case
  // (agent creates a file without `git add`). For each untracked file, run
  // `git diff --no-index /dev/null <file>` to synthesize a unified-add diff.
  // Cap to UNTRACKED_FILE_LIMIT files and a total size budget so a workspace
  // with thousands of generated/build artifacts can't make every poll slow.
  try {
    const { stdout: untrackedRaw } = await execFileAsync(
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { cwd: session.workspacePath, maxBuffer: 1 * 1024 * 1024, timeout: 5_000 },
    );
    const untracked = untrackedRaw
      .split("\0")
      .filter(Boolean)
      // Skip AO's own workspace files. If the host repo doesn't ignore .ao/
      // (likely, since it's not part of the project), agent-emitted canvases
      // and AGENTS.md would otherwise appear as added files in the diff and
      // consume the untracked-file budget.
      .filter((p) => !p.startsWith(".ao/") && p !== ".ao")
      .slice(0, UNTRACKED_FILE_LIMIT);
    for (const path of untracked) {
      if (stdout.length >= UNTRACKED_BYTE_BUDGET) break;
      // Skip FIFOs, sockets, devices — `git diff --no-index` would block on
      // them until our 5s timeout fires, stacking polls.
      try {
        const st = await lstat(join(session.workspacePath, path));
        if (!st.isFile()) continue;
      } catch {
        continue;
      }
      try {
        const { stdout: addDiff } = await execFileAsync(
          "git",
          ["diff", "--no-color", "--no-index", "--", NULL_DEVICE, path],
          { cwd: session.workspacePath, maxBuffer: 1 * 1024 * 1024, timeout: 5_000 },
        );
        stdout += addDiff;
      } catch (err) {
        // `git diff --no-index` exits 1 when files differ — that's the success
        // case, and execFile rejects on non-zero. Capture stdout from the error.
        const e = err as { stdout?: string };
        if (typeof e.stdout === "string") stdout += e.stdout;
      }
    }
  } catch {
    // ls-files failed (not a repo, etc.) — fall through with whatever diff we have.
  }

  if (!stdout.trim()) return null;

  const { files, truncated } = parseUnifiedDiff(stdout);
  if (files.length === 0) return null;

  const now = new Date().toISOString();
  const fileCount = files.length;
  const titleSuffix = truncated ? " (truncated)" : "";
  return {
    version: 1,
    id: "core-git-diff",
    type: "diff",
    title: `Diff vs ${baseBranch} (${fileCount} file${fileCount === 1 ? "" : "s"})${titleSuffix}`,
    createdAt: now,
    updatedAt: now,
    source: "core",
    payload: { files },
  };
}

export function parseUnifiedDiff(diff: string): { files: CanvasDiffFile[]; truncated: boolean } {
  const lines = diff.split("\n");
  const files: CanvasDiffFile[] = [];
  let current: CanvasDiffFile | null = null;
  let currentHunk: CanvasDiffFile["hunks"][number] | null = null;
  let totalLines = 0;
  let truncated = false;

  const finalizeFile = () => {
    if (current) {
      if (currentHunk) current.hunks.push(currentHunk);
      files.push(current);
    }
    current = null;
    currentHunk = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;

    if (line.startsWith("diff --git ")) {
      finalizeFile();
      if (files.length >= DIFF_MAX_FILES) {
        truncated = true;
        break;
      }
      // Parse "diff --git a/<oldPath> b/<newPath>" without a regex. The naive
      // regex `/^diff --git a\/(.+) b\/(.+)$/` is polynomial-backtracking on
      // pathological inputs like "a/a b/a b/a b/a..." (CodeQL js/redos).
      // lastIndexOf is O(n) and works for the common case where paths don't
      // contain " b/"; for paths that do, git quotes them anyway.
      const prefix = "diff --git a/";
      let path = "";
      let oldPath: string | undefined;
      if (line.startsWith(prefix)) {
        const rest = line.slice(prefix.length);
        const sep = rest.lastIndexOf(" b/");
        if (sep >= 0) {
          oldPath = rest.slice(0, sep);
          path = rest.slice(sep + 3);
        }
      }
      current = {
        path,
        oldPath: oldPath !== path ? oldPath : undefined,
        status: "modified",
        hunks: [],
      };
      continue;
    }

    if (!current) continue;

    if (line.startsWith("new file mode")) current.status = "added";
    else if (line.startsWith("deleted file mode")) current.status = "deleted";
    else if (line.startsWith("rename from") || line.startsWith("rename to")) current.status = "renamed";
    else if (line.startsWith("@@")) {
      if (currentHunk) current.hunks.push(currentHunk);
      currentHunk = { header: line, lines: [] };
    } else if (currentHunk) {
      // Bare-empty lines inside a hunk represent a blank context line that some
      // diff generators emit without the leading space prefix. Treat them as
      // empty context rather than dropping (which would misalign surrounding
      // lines in the rendered hunk).
      if (line === "") {
        currentHunk.lines.push({ kind: "context", text: "" });
        totalLines++;
        if (totalLines >= DIFF_MAX_LINES) {
          truncated = true;
          break;
        }
        continue;
      }
      const kind: "add" | "del" | "context" = line.startsWith("+")
        ? "add"
        : line.startsWith("-")
          ? "del"
          : "context";
      // Strip the unified-diff prefix character (`+`, `-`, or ` `) so the
      // renderer can show its own marker column without doubling the indent.
      const text = line.slice(1);
      currentHunk.lines.push({ kind, text });
      totalLines++;
      if (totalLines >= DIFF_MAX_LINES) {
        truncated = true;
        break;
      }
    }
  }
  finalizeFile();
  return { files, truncated };
}
