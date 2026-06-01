import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readCanvases,
  parseUnifiedDiff,
  getCanvasDir,
  CANVAS_MAX_FILE_BYTES,
  CANVAS_MAX_PER_SESSION,
} from "../canvas-log.js";
import { CanvasArtifactSchema } from "../canvas-schema.js";
import type { CanvasArtifact } from "../types.js";

let dir: string;
let canvasDir: string;

const validMarkdown: CanvasArtifact = {
  version: 1,
  id: "hello",
  type: "markdown",
  title: "Hello",
  createdAt: "2026-05-05T00:00:00Z",
  updatedAt: "2026-05-05T00:00:00Z",
  payload: { markdown: "hi" },
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "canvas-test-"));
  canvasDir = getCanvasDir(dir);
  await mkdir(canvasDir, { recursive: true });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("readCanvases", () => {
  it("returns empty array when canvas dir does not exist", async () => {
    const fresh = await mkdtemp(join(tmpdir(), "canvas-empty-"));
    expect(await readCanvases(fresh)).toEqual([]);
    await rm(fresh, { recursive: true, force: true });
  });

  it("reads valid canvases", async () => {
    await writeFile(join(canvasDir, "hello.json"), JSON.stringify(validMarkdown));
    const result = await readCanvases(dir);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("hello");
  });

  it("drops invalid JSON without throwing", async () => {
    await writeFile(join(canvasDir, "bad.json"), "{ not json");
    await writeFile(join(canvasDir, "good.json"), JSON.stringify(validMarkdown));
    const result = await readCanvases(dir);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("hello");
  });

  it("drops canvases with unknown type", async () => {
    const broken = { ...validMarkdown, type: "unknown" };
    await writeFile(join(canvasDir, "broken.json"), JSON.stringify(broken));
    expect(await readCanvases(dir)).toEqual([]);
  });

  it("drops canvases with missing required fields", async () => {
    const broken = { version: 1, type: "markdown", id: "x" };
    await writeFile(join(canvasDir, "broken.json"), JSON.stringify(broken));
    expect(await readCanvases(dir)).toEqual([]);
  });

  it("drops files larger than the per-file cap", async () => {
    const oversized = "x".repeat(CANVAS_MAX_FILE_BYTES + 100);
    await writeFile(join(canvasDir, "big.json"), oversized);
    expect(await readCanvases(dir)).toEqual([]);
  });

  it("caps to CANVAS_MAX_PER_SESSION, evicting oldest by updatedAt", async () => {
    for (let i = 0; i < CANVAS_MAX_PER_SESSION + 5; i++) {
      const c: CanvasArtifact = {
        ...validMarkdown,
        id: `c-${i}`,
        updatedAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
      };
      await writeFile(join(canvasDir, `c-${i}.json`), JSON.stringify(c));
    }
    const result = await readCanvases(dir);
    expect(result).toHaveLength(CANVAS_MAX_PER_SESSION);
    expect(result[0]?.id).toBe(`c-${CANVAS_MAX_PER_SESSION + 4}`);
  });

  it("bounds I/O when an agent emits hundreds of canvas files (greptile P1)", async () => {
    // Pre-fix: readCanvases lstat-ed, read, parsed, validated EVERY file before
    // capping. 200 files × 256 KB = 50+ MB of reads per 5s poll. Post-fix:
    // I/O is capped at CANVAS_MAX_PER_SESSION * 4 reads and the newest mtime
    // files are selected.
    const N = 200;
    for (let i = 0; i < N; i++) {
      const c: CanvasArtifact = {
        ...validMarkdown,
        id: `c-${String(i).padStart(3, "0")}`,
      };
      const filePath = join(canvasDir, `c-${String(i).padStart(3, "0")}.json`);
      await writeFile(filePath, JSON.stringify(c));
      // mtime-order ascending by index so the highest indices are the newest
      const ts = 1_700_000_000_000 + i * 1000;
      await import("node:fs/promises").then((fs) => fs.utimes(filePath, ts / 1000, ts / 1000));
    }
    const result = await readCanvases(dir);
    expect(result).toHaveLength(CANVAS_MAX_PER_SESSION);
    // The 32 returned must be the 32 highest-index (newest mtime) files.
    const ids = new Set(result.map((c) => c.id));
    for (let i = N - CANVAS_MAX_PER_SESSION; i < N; i++) {
      expect(ids.has(`c-${String(i).padStart(3, "0")}`)).toBe(true);
    }
  });

  it("drops file canvases that use the reserved core- prefix", async () => {
    const reserved: CanvasArtifact = { ...validMarkdown, id: "core-git-diff" };
    await writeFile(join(canvasDir, "evil.json"), JSON.stringify(reserved));
    expect(await readCanvases(dir)).toEqual([]);
  });

  it("ignores non-json files", async () => {
    await writeFile(join(canvasDir, "notes.txt"), "ignore me");
    await writeFile(join(canvasDir, "good.json"), JSON.stringify(validMarkdown));
    const result = await readCanvases(dir);
    expect(result).toHaveLength(1);
  });
});

describe("CanvasArtifactSchema", () => {
  it("accepts a valid table canvas", () => {
    const ok = CanvasArtifactSchema.safeParse({
      version: 1,
      id: "tests",
      type: "table",
      title: "Tests",
      createdAt: "2026-05-05T00:00:00Z",
      updatedAt: "2026-05-05T00:00:00Z",
      payload: {
        columns: [{ key: "name", label: "Name" }],
        rows: [{ name: "auth.test.ts" }],
      },
    });
    expect(ok.success).toBe(true);
  });

  it("rejects unknown payload fields (strict)", () => {
    const result = CanvasArtifactSchema.safeParse({
      ...validMarkdown,
      payload: { markdown: "hi", extra: "no" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects bad id format", () => {
    const result = CanvasArtifactSchema.safeParse({ ...validMarkdown, id: "BAD ID" });
    expect(result.success).toBe(false);
  });

  it("rejects diff canvases with too many hunk lines", () => {
    // 1001 lines exceeds DIFF_MAX_LINES_PER_HUNK (1000). This is the cap that
    // prevents agent-emitted diffs from rendering hundreds of thousands of DOM
    // rows on every 5s poll.
    const tooManyLines = Array.from({ length: 1001 }, (_, i) => ({
      kind: "context" as const,
      text: `line ${i}`,
    }));
    const result = CanvasArtifactSchema.safeParse({
      version: 1,
      id: "huge",
      type: "diff",
      title: "Too many lines",
      createdAt: "2026-05-06T00:00:00Z",
      updatedAt: "2026-05-06T00:00:00Z",
      payload: { files: [{ path: "a.ts", status: "modified", hunks: [{ header: "@@", lines: tooManyLines }] }] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects diff canvases with too many files", () => {
    const tooManyFiles = Array.from({ length: 201 }, (_, i) => ({
      path: `f${i}.ts`,
      status: "modified" as const,
      hunks: [],
    }));
    const result = CanvasArtifactSchema.safeParse({
      version: 1,
      id: "wide",
      type: "diff",
      title: "Too many files",
      createdAt: "2026-05-06T00:00:00Z",
      updatedAt: "2026-05-06T00:00:00Z",
      payload: { files: tooManyFiles },
    });
    expect(result.success).toBe(false);
  });
});

describe("parseUnifiedDiff", () => {
  it("returns no files for empty diff", () => {
    expect(parseUnifiedDiff("")).toEqual({ files: [], truncated: false });
  });

  it("parses a single-file modification with one hunk", () => {
    const diff = [
      "diff --git a/foo.ts b/foo.ts",
      "index abc..def 100644",
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1,3 +1,3 @@",
      " context",
      "-old",
      "+new",
      "",
    ].join("\n");
    const result = parseUnifiedDiff(diff);
    expect(result.truncated).toBe(false);
    expect(result.files).toHaveLength(1);
    const file = result.files[0]!;
    expect(file.path).toBe("foo.ts");
    expect(file.status).toBe("modified");
    expect(file.hunks[0]?.lines).toEqual([
      { kind: "context", text: "context" },
      { kind: "del", text: "old" },
      { kind: "add", text: "new" },
      { kind: "context", text: "" },
    ]);
  });

  it("preserves hunk lines whose content starts with +++ or ---", () => {
    const diff = [
      "diff --git a/notes.md b/notes.md",
      "--- a/notes.md",
      "+++ b/notes.md",
      "@@ -1,3 +1,3 @@",
      " heading",
      "---",
      "+++added text",
      "",
    ].join("\n");
    const result = parseUnifiedDiff(diff);
    expect(result.files).toHaveLength(1);
    const lines = result.files[0]!.hunks[0]!.lines;
    expect(lines).toEqual([
      { kind: "context", text: "heading" },
      { kind: "del", text: "--" },
      { kind: "add", text: "++added text" },
      { kind: "context", text: "" },
    ]);
  });

  it("ignores file-header lines emitted before the first hunk", () => {
    const diff = [
      "diff --git a/foo.ts b/foo.ts",
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
    ].join("\n");
    const result = parseUnifiedDiff(diff);
    const lines = result.files[0]!.hunks[0]!.lines;
    expect(lines).toEqual([
      { kind: "del", text: "old" },
      { kind: "add", text: "new" },
    ]);
  });

  it("detects added and deleted files", () => {
    const diff = [
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "@@ -0,0 +1,1 @@",
      "+hello",
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "@@ -1,1 +0,0 @@",
      "-bye",
    ].join("\n");
    const result = parseUnifiedDiff(diff);
    expect(result.files.map((f) => f.status)).toEqual(["added", "deleted"]);
  });
});
