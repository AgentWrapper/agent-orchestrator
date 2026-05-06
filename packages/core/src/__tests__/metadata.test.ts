import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  readMetadata,
  readMetadataRaw,
  readCanonicalLifecycle,
  mutateMetadata,
  writeMetadata,
  updateMetadata,
  deleteMetadata,
  listMetadata,
} from "../metadata.js";

let dataDir: string;

beforeEach(() => {
  dataDir = join(tmpdir(), `ao-test-metadata-${randomUUID()}`);
  mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("writeMetadata + readMetadata", () => {
  it("writes and reads basic metadata", () => {
    writeMetadata(dataDir, "app-1", {
      worktree: "/tmp/worktree",
      branch: "feat/test",
      status: "working",
    });

    const meta = readMetadata(dataDir, "app-1");
    expect(meta).not.toBeNull();
    expect(meta!.worktree).toBe("/tmp/worktree");
    expect(meta!.branch).toBe("feat/test");
    expect(meta!.status).toBe("working");
  });

  it("writes and reads optional fields", () => {
    writeMetadata(dataDir, "app-2", {
      worktree: "/tmp/w",
      branch: "main",
      status: "pr_open",
      issue: "https://linear.app/team/issue/INT-100",
      pr: "https://github.com/org/repo/pull/42",
      prAutoDetect: false,
      summary: "Implementing feature X",
      project: "my-app",
      createdAt: "2025-01-01T00:00:00.000Z",
      runtimeHandle: { id: "tmux-1", runtimeName: "tmux", data: {} },
      lifecycle: {
        version: 2,
        session: { kind: "worker", state: "working", reason: "task_in_progress", startedAt: "2025-01-01T00:00:00.000Z", completedAt: null, terminatedAt: null, lastTransitionAt: "2025-01-01T00:00:00.000Z" },
        pr: { state: "none", reason: "not_created", number: null, url: null, lastObservedAt: null },
        runtime: { state: "alive", reason: "process_running", lastObservedAt: "2025-01-01T00:00:00.000Z", handle: { id: "tmux-1", runtimeName: "tmux", data: {} }, tmuxName: null },
      },
    });

    const meta = readMetadata(dataDir, "app-2");
    expect(meta).not.toBeNull();
    expect(meta!.issue).toBe("https://linear.app/team/issue/INT-100");
    expect(meta!.pr).toBe("https://github.com/org/repo/pull/42");
    expect(meta!.prAutoDetect).toBe(false);
    expect(meta!.summary).toBe("Implementing feature X");
    expect(meta!.project).toBe("my-app");
    expect(meta!.createdAt).toBe("2025-01-01T00:00:00.000Z");
    expect(meta!.runtimeHandle?.id).toBe("tmux-1");
    expect(meta!.lifecycle).toBeDefined();
    expect(meta!.lifecycle?.version).toBe(2);
  });

  it("returns null for nonexistent session", () => {
    const meta = readMetadata(dataDir, "nonexistent");
    expect(meta).toBeNull();
  });

  it("produces JSON format", () => {
    writeMetadata(dataDir, "app-3", {
      worktree: "/tmp/w",
      branch: "feat/INT-123",
      status: "working",
      issue: "https://linear.app/team/issue/INT-123",
    });

    const content = readFileSync(join(dataDir, "app-3.json"), "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.worktree).toBe("/tmp/w");
    expect(parsed.branch).toBe("feat/INT-123");
    expect(parsed.status).toBe("working");
    expect(parsed.issue).toBe("https://linear.app/team/issue/INT-123");
  });

  it("stores runtimeHandle as an object in JSON (not stringified)", () => {
    writeMetadata(dataDir, "app-json", {
      worktree: "/tmp/w",
      branch: "main",
      status: "working",
      runtimeHandle: { id: "tmux-1", runtimeName: "tmux", data: {} },
    });

    const content = readFileSync(join(dataDir, "app-json.json"), "utf-8");
    const parsed = JSON.parse(content);
    expect(typeof parsed.runtimeHandle).toBe("object");
    expect(parsed.runtimeHandle.id).toBe("tmux-1");
  });

  it("omits optional fields that are undefined", () => {
    writeMetadata(dataDir, "app-4", {
      worktree: "/tmp/w",
      branch: "main",
      status: "spawning",
    });

    const content = readFileSync(join(dataDir, "app-4.json"), "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.issue).toBeUndefined();
    expect(parsed.pr).toBeUndefined();
    expect(parsed.summary).toBeUndefined();
  });

  it("serializes pinnedSummary field when present", () => {
    writeMetadata(dataDir, "app-5", {
      worktree: "/tmp/w",
      branch: "feat/test",
      status: "working",
      pinnedSummary: "First quality summary",
    });

    const content = readFileSync(join(dataDir, "app-5.json"), "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.pinnedSummary).toBe("First quality summary");
  });

  it("serializes and reads back displayName", () => {
    writeMetadata(dataDir, "app-6", {
      worktree: "/tmp/w",
      branch: "feat/test",
      status: "working",
      displayName: "Refactor session manager",
    });

    const content = readFileSync(join(dataDir, "app-6.json"), "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.displayName).toBe("Refactor session manager");

    const meta = readMetadata(dataDir, "app-6");
    expect(meta?.displayName).toBe("Refactor session manager");
  });
});

describe("readMetadataRaw", () => {
  it("reads arbitrary JSON fields as strings", () => {
    writeFileSync(
      join(dataDir, "raw-1.json"),
      JSON.stringify({ worktree: "/tmp/w", branch: "main", custom_key: "custom_value" }),
      "utf-8",
    );

    const raw = readMetadataRaw(dataDir, "raw-1");
    expect(raw).not.toBeNull();
    expect(raw!["worktree"]).toBe("/tmp/w");
    expect(raw!["custom_key"]).toBe("custom_value");
  });

  it("returns null for nonexistent session", () => {
    expect(readMetadataRaw(dataDir, "nope")).toBeNull();
  });

  it("returns null for empty file (from reserveSessionId)", () => {
    writeFileSync(join(dataDir, "empty.json"), "", "utf-8");
    expect(readMetadataRaw(dataDir, "empty")).toBeNull();
  });

  it("flattens nested objects to JSON strings", () => {
    writeFileSync(
      join(dataDir, "raw-3.json"),
      JSON.stringify({ runtimeHandle: { id: "foo", data: { key: "val" } } }),
      "utf-8",
    );

    const raw = readMetadataRaw(dataDir, "raw-3");
    expect(raw!["runtimeHandle"]).toBe('{"id":"foo","data":{"key":"val"}}');
  });
});

describe("updateMetadata", () => {
  it("updates specific fields while preserving others", () => {
    writeMetadata(dataDir, "upd-1", {
      worktree: "/tmp/w",
      branch: "main",
      status: "spawning",
    });

    updateMetadata(dataDir, "upd-1", {
      status: "working",
      pr: "https://github.com/org/repo/pull/1",
    });

    const meta = readMetadata(dataDir, "upd-1");
    expect(meta!.status).toBe("working");
    expect(meta!.pr).toBe("https://github.com/org/repo/pull/1");
    expect(meta!.worktree).toBe("/tmp/w");
    expect(meta!.branch).toBe("main");
  });

  it("deletes keys set to empty string", () => {
    writeMetadata(dataDir, "upd-2", {
      worktree: "/tmp/w",
      branch: "main",
      status: "working",
      summary: "doing stuff",
    });

    updateMetadata(dataDir, "upd-2", { summary: "" });

    const raw = readMetadataRaw(dataDir, "upd-2");
    expect(raw!["summary"]).toBeUndefined();
    expect(raw!["status"]).toBe("working");
  });

  it("creates file if it does not exist", () => {
    updateMetadata(dataDir, "upd-3", { status: "new", branch: "test" });

    const raw = readMetadataRaw(dataDir, "upd-3");
    expect(raw).toEqual({ status: "new", branch: "test" });
  });

  it("ignores undefined values", () => {
    writeMetadata(dataDir, "upd-4", {
      worktree: "/tmp/w",
      branch: "main",
      status: "working",
    });

    updateMetadata(dataDir, "upd-4", { status: "pr_open", summary: undefined });

    const meta = readMetadata(dataDir, "upd-4");
    expect(meta!.status).toBe("pr_open");
    expect(meta!.summary).toBeUndefined();
  });

  it("returns the normalized record that is actually persisted", () => {
    writeMetadata(dataDir, "upd-5", {
      worktree: "/tmp/w",
      branch: "main",
      status: "working",
      summary: "doing stuff",
    });

    const next = mutateMetadata(dataDir, "upd-5", (existing) => ({
      ...existing,
      summary: "",
      pr: "https://github.com/org/repo/pull/5",
    }));

    expect(next).toEqual({
      worktree: "/tmp/w",
      branch: "main",
      status: "working",
      pr: "https://github.com/org/repo/pull/5",
    });
    expect(readMetadataRaw(dataDir, "upd-5")).toEqual(next);
  });

  it("does not auto-parse string fields that look like JSON", () => {
    writeMetadata(dataDir, "upd-json-safe", {
      worktree: "/tmp/w",
      branch: "main",
      status: "working",
      summary: '["step1","step2"]',
      userPrompt: '{"fix": "bug"}',
    });

    const raw = readMetadataRaw(dataDir, "upd-json-safe");
    // summary and userPrompt must stay as strings, not parsed into objects
    expect(typeof raw!["summary"]).toBe("string");
    expect(typeof raw!["userPrompt"]).toBe("string");
    expect(raw!["summary"]).toBe('["step1","step2"]');
    expect(raw!["userPrompt"]).toBe('{"fix": "bug"}');
  });
});

// Regression for the boundary-bug-hunter Phase 2 review on PR #1466:
// when a metadata file is corrupt JSON, mutateMetadata used to merge
// against an empty record and atomically rewrite the file. The corrupt
// bytes were lost — the user had no signal anything was wrong, just
// "missing fields". The fix side-renames the corrupt file to
// `<path>.corrupt-<ts>` before rewriting so forensics survive.
describe("mutateMetadata corrupt-file handling", () => {
  it("preserves corrupt JSON as `<path>.corrupt-<ts>` before overwriting", () => {
    const sessionPath = join(dataDir, "ao-1.json");
    writeFileSync(sessionPath, "{ this is not json", "utf-8");

    const result = mutateMetadata(
      dataDir,
      "ao-1",
      () => ({ branch: "feat/x", project: "myproject" }),
      { createIfMissing: true },
    );

    expect(result).not.toBeNull();
    expect(result!["branch"]).toBe("feat/x");

    // Forensic copy must exist with the original corrupt bytes.
    const corruptCopies = readdirSync(dataDir).filter((f) =>
      f.startsWith("ao-1.json.corrupt-"),
    );
    expect(corruptCopies).toHaveLength(1);
    const corruptContent = readFileSync(join(dataDir, corruptCopies[0]), "utf-8");
    expect(corruptContent).toBe("{ this is not json");

    // The original path now holds the new (valid) JSON.
    const rewritten = JSON.parse(readFileSync(sessionPath, "utf-8"));
    expect(rewritten.branch).toBe("feat/x");
    expect(rewritten.project).toBe("myproject");
  });

  it("does not create a .corrupt copy for healthy JSON", () => {
    writeMetadata(dataDir, "ao-2", {
      worktree: "/tmp/w",
      branch: "main",
      status: "working",
    });
    mutateMetadata(dataDir, "ao-2", (existing) => ({ ...existing, summary: "hi" }));

    const corruptCopies = readdirSync(dataDir).filter((f) => f.includes(".corrupt-"));
    expect(corruptCopies).toHaveLength(0);
  });
});

describe("readCanonicalLifecycle", () => {
  it("reads canonical lifecycle from lifecycle field", () => {
    writeMetadata(dataDir, "lifecycle-1", {
      worktree: "/tmp/w",
      branch: "main",
      status: "working",
      lifecycle: {
        version: 2,
        session: { kind: "worker", state: "working", reason: "task_in_progress", startedAt: "2025-01-01T00:00:00.000Z", completedAt: null, terminatedAt: null, lastTransitionAt: "2025-01-01T00:00:00.000Z" },
        pr: { state: "open", reason: "in_progress", number: 42, url: "https://github.com/org/repo/pull/42", lastObservedAt: "2025-01-01T00:00:00.000Z" },
        runtime: { state: "alive", reason: "process_running", lastObservedAt: "2025-01-01T00:00:00.000Z", handle: { id: "tmux-1", runtimeName: "tmux", data: {} }, tmuxName: "tmux-1" },
      },
    });

    const lifecycle = readCanonicalLifecycle(dataDir, "lifecycle-1");
    expect(lifecycle).not.toBeNull();
    expect(lifecycle!.session.state).toBe("working");
    expect(lifecycle!.pr.state).toBe("open");
    expect(lifecycle!.runtime.state).toBe("alive");
  });

  it("validates legacy status before synthesizing canonical lifecycle", () => {
    writeMetadata(dataDir, "lifecycle-legacy-invalid", {
      worktree: "/tmp/w",
      branch: "main",
      status: "unknown",
    });

    const lifecycle = readCanonicalLifecycle(dataDir, "lifecycle-legacy-invalid");
    expect(lifecycle).not.toBeNull();
    expect(lifecycle!.session.state).toBe("not_started");
    expect(lifecycle!.session.reason).toBe("spawn_requested");
  });
});

describe("deleteMetadata", () => {
  it("deletes metadata file permanently", () => {
    writeMetadata(dataDir, "del-1", { status: "working", worktree: "/tmp/w", branch: "main" });
    deleteMetadata(dataDir, "del-1");
    expect(readMetadataRaw(dataDir, "del-1")).toBeNull();
    // No archive directory created
    expect(existsSync(join(dataDir, "archive"))).toBe(false);
  });

  it("is a no-op for nonexistent session", () => {
    expect(() => deleteMetadata(dataDir, "nope")).not.toThrow();
  });
});

describe("atomic writes", () => {
  it("writeMetadata leaves no .tmp files behind", () => {
    writeMetadata(dataDir, "atomic-1", {
      worktree: "/tmp/w",
      branch: "main",
      status: "working",
    });

    const files = readdirSync(dataDir);
    const tmpFiles = files.filter((f) => f.includes(".tmp."));
    expect(tmpFiles).toHaveLength(0);
    // Verify the actual file was written correctly
    const meta = readMetadata(dataDir, "atomic-1");
    expect(meta!.status).toBe("working");
  });

  it("updateMetadata leaves no .tmp files behind", () => {
    writeMetadata(dataDir, "atomic-2", {
      worktree: "/tmp/w",
      branch: "main",
      status: "spawning",
    });

    updateMetadata(dataDir, "atomic-2", { status: "working" });

    const files = readdirSync(dataDir);
    const tmpFiles = files.filter((f) => f.includes(".tmp."));
    expect(tmpFiles).toHaveLength(0);
    const meta = readMetadata(dataDir, "atomic-2");
    expect(meta!.status).toBe("working");
  });

  it("concurrent writeMetadata calls do not produce corrupt files", () => {
    for (let i = 0; i < 20; i++) {
      writeMetadata(dataDir, "atomic-3", {
        worktree: "/tmp/w",
        branch: `branch-${i}`,
        status: "working",
        summary: `iteration ${i}`,
      });
    }

    const meta = readMetadata(dataDir, "atomic-3");
    expect(meta).not.toBeNull();
    expect(meta!.branch).toBe("branch-19");
    expect(meta!.summary).toBe("iteration 19");

    // No leftover temp files
    const files = readdirSync(dataDir);
    const tmpFiles = files.filter((f) => f.includes(".tmp."));
    expect(tmpFiles).toHaveLength(0);
  });
});

describe("restoredAt persistence", () => {
  it("roundtrips restoredAt through writeMetadata and readMetadata", () => {
    const now = new Date().toISOString();
    writeMetadata(dataDir, "restore-1", {
      worktree: "/tmp/w",
      branch: "main",
      status: "working",
      restoredAt: now,
    });

    const meta = readMetadata(dataDir, "restore-1");
    expect(meta).not.toBeNull();
    expect(meta!.restoredAt).toBe(now);
  });

  it("restoredAt is persisted in the JSON file", () => {
    const now = "2026-03-01T12:00:00.000Z";
    writeMetadata(dataDir, "restore-2", {
      worktree: "/tmp/w",
      branch: "main",
      status: "working",
      restoredAt: now,
    });

    const content = readFileSync(join(dataDir, "restore-2.json"), "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.restoredAt).toBe(now);
  });

  it("restoredAt is undefined when not set", () => {
    writeMetadata(dataDir, "restore-3", {
      worktree: "/tmp/w",
      branch: "main",
      status: "working",
    });

    const meta = readMetadata(dataDir, "restore-3");
    expect(meta!.restoredAt).toBeUndefined();
  });

  it("updateMetadata can set restoredAt on an existing session", () => {
    writeMetadata(dataDir, "restore-4", {
      worktree: "/tmp/w",
      branch: "main",
      status: "working",
    });

    const now = new Date().toISOString();
    updateMetadata(dataDir, "restore-4", { restoredAt: now });

    const meta = readMetadata(dataDir, "restore-4");
    expect(meta!.restoredAt).toBe(now);
  });
});

describe("listMetadata", () => {
  it("lists all session IDs", () => {
    writeMetadata(dataDir, "app-1", { worktree: "/tmp", branch: "a", status: "s" });
    writeMetadata(dataDir, "app-2", { worktree: "/tmp", branch: "b", status: "s" });
    writeMetadata(dataDir, "app-3", { worktree: "/tmp", branch: "c", status: "s" });

    const list = listMetadata(dataDir);
    expect(list).toHaveLength(3);
    expect(list.sort()).toEqual(["app-1", "app-2", "app-3"]);
  });

  it("excludes archive directory and dotfiles", () => {
    writeMetadata(dataDir, "app-1", { worktree: "/tmp", branch: "a", status: "s" });
    mkdirSync(join(dataDir, "archive"), { recursive: true });
    writeFileSync(join(dataDir, ".hidden"), "x", "utf-8");

    const list = listMetadata(dataDir);
    expect(list).toEqual(["app-1"]);
  });

  it("returns empty array when sessions dir does not exist", () => {
    const emptyDir = join(tmpdir(), `ao-test-empty-${randomUUID()}`);
    const list = listMetadata(emptyDir);
    expect(list).toEqual([]);
  });
});

describe("status derivation from lifecycle", () => {
  it("readMetadata derives status from lifecycle when status is absent", () => {
    // Simulate migrated JSON: has lifecycle but no status field
    writeFileSync(
      join(dataDir, "no-status.json"),
      JSON.stringify({
        worktree: "/tmp/w",
        branch: "main",
        project: "myproject",
        lifecycle: {
          version: 2,
          session: { kind: "worker", state: "working", reason: "task_in_progress", startedAt: "2025-01-01T00:00:00.000Z", completedAt: null, terminatedAt: null, lastTransitionAt: "2025-01-01T00:00:00.000Z" },
          pr: { state: "open", reason: "review_pending", number: 42, url: "https://github.com/org/repo/pull/42", lastObservedAt: "2025-01-01T00:00:00.000Z" },
          runtime: { state: "alive", reason: "process_running", lastObservedAt: "2025-01-01T00:00:00.000Z", handle: null, tmuxName: null },
        },
      }),
    );

    const meta = readMetadata(dataDir, "no-status");
    expect(meta).not.toBeNull();
    expect(meta!.status).toBe("review_pending");
  });

  it("readMetadataRaw derives status from lifecycle when status is absent", () => {
    writeFileSync(
      join(dataDir, "raw-no-status.json"),
      JSON.stringify({
        worktree: "/tmp/w",
        branch: "main",
        lifecycle: {
          version: 2,
          session: { kind: "worker", state: "done", reason: "research_complete", startedAt: "2025-01-01T00:00:00.000Z", completedAt: "2025-01-01T01:00:00.000Z", terminatedAt: null, lastTransitionAt: "2025-01-01T01:00:00.000Z" },
          pr: { state: "merged", reason: "merge_complete", number: 42, url: null, lastObservedAt: null },
          runtime: { state: "dead", reason: "process_exited", lastObservedAt: null, handle: null, tmuxName: null },
        },
      }),
    );

    const raw = readMetadataRaw(dataDir, "raw-no-status");
    expect(raw).not.toBeNull();
    expect(raw!["status"]).toBe("done");
  });

  it("readMetadata falls back to 'unknown' when no status and no lifecycle", () => {
    writeFileSync(
      join(dataDir, "bare.json"),
      JSON.stringify({ worktree: "/tmp/w", branch: "main" }),
    );

    const meta = readMetadata(dataDir, "bare");
    expect(meta).not.toBeNull();
    expect(meta!.status).toBe("unknown");
  });

  it("readMetadata prefers lifecycle-derived status over stored status", () => {
    writeFileSync(
      join(dataDir, "has-both.json"),
      JSON.stringify({
        worktree: "/tmp/w",
        branch: "main",
        status: "working",
        lifecycle: {
          version: 2,
          session: { kind: "worker", state: "done", reason: "research_complete", startedAt: null, completedAt: null, terminatedAt: null, lastTransitionAt: null },
          pr: { state: "none", reason: "not_created", number: null, url: null, lastObservedAt: null },
          runtime: { state: "unknown", reason: "not_checked", lastObservedAt: null, handle: null, tmuxName: null },
        },
      }),
    );

    const meta = readMetadata(dataDir, "has-both");
    expect(meta).not.toBeNull();
    // Lifecycle-derived status wins over stored (lifecycle is source of truth)
    expect(meta!.status).toBe("done");
  });
});

describe("corrupt JSON handling", () => {
  it("readMetadata returns null for truncated JSON", () => {
    writeFileSync(join(dataDir, "corrupt-1.json"), '{"worktree":"/tmp/w","bran', "utf-8");
    expect(readMetadata(dataDir, "corrupt-1")).toBeNull();
  });

  it("readMetadataRaw returns null for invalid JSON", () => {
    writeFileSync(join(dataDir, "corrupt-2.json"), "not json at all", "utf-8");
    expect(readMetadataRaw(dataDir, "corrupt-2")).toBeNull();
  });

  it("readMetadata returns null for JSON array (not an object)", () => {
    writeFileSync(join(dataDir, "corrupt-3.json"), '[1, 2, 3]', "utf-8");
    expect(readMetadata(dataDir, "corrupt-3")).toBeNull();
  });

  it("listMetadata + readMetadata does not crash when one file is corrupt", () => {
    writeMetadata(dataDir, "good-1", { worktree: "/tmp/w", branch: "main", status: "working" });
    writeFileSync(join(dataDir, "bad-1.json"), "{invalid", "utf-8");
    writeMetadata(dataDir, "good-2", { worktree: "/tmp/w", branch: "main", status: "idle" });

    const list = listMetadata(dataDir);
    expect(list).toContain("good-1");
    expect(list).toContain("bad-1");
    expect(list).toContain("good-2");

    // Reading each individually — corrupt one returns null, good ones return data
    expect(readMetadata(dataDir, "good-1")).not.toBeNull();
    expect(readMetadata(dataDir, "bad-1")).toBeNull();
    expect(readMetadata(dataDir, "good-2")).not.toBeNull();
  });

  it("mutateMetadata treats corrupt file as empty record", () => {
    writeFileSync(join(dataDir, "corrupt-mut.json"), "{{bad json", "utf-8");

    mutateMetadata(dataDir, "corrupt-mut", (existing) => {
      return { ...existing, status: "working", worktree: "/tmp/w", branch: "main" };
    }, { createIfMissing: true });

    const meta = readMetadata(dataDir, "corrupt-mut");
    expect(meta).not.toBeNull();
    expect(meta!.status).toBe("working");
  });
});
