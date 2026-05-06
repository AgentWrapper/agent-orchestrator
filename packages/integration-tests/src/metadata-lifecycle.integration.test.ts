/**
 * Integration test for metadata lifecycle — real filesystem operations.
 *
 * Tests the full metadata CRUD cycle (write, read, update, list, delete)
 * and concurrent access patterns using @aoagents/ao-core metadata functions
 * with real filesystem I/O.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  writeMetadata,
  readMetadata,
  readMetadataRaw,
  updateMetadata,
  deleteMetadata,
  listMetadata,
  type SessionMetadata,
} from "@aoagents/ao-core";

describe("metadata lifecycle (real filesystem)", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ao-meta-lifecycle-"));
  });

  afterAll(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("write + read round-trip preserves all fields", () => {
    const sessionsDir = join(tmpDir, "test-roundtrip");
    mkdirSync(sessionsDir, { recursive: true });

    const metadata: SessionMetadata = {
      worktree: "/tmp/wt/session-1",
      branch: "feat/INT-100",
      status: "working",
      tmuxName: "abc123-session-1",
      issue: "INT-100",
      pr: "https://github.com/org/repo/pull/42",
      summary: "Implementing feature INT-100",
      project: "my-project",
      createdAt: "2026-01-01T00:00:00.000Z",
      dashboard: { port: 4000 },
    };

    writeMetadata(sessionsDir, "session-1", metadata);
    const result = readMetadata(sessionsDir, "session-1");

    expect(result).not.toBeNull();
    expect(result!.worktree).toBe(metadata.worktree);
    expect(result!.branch).toBe(metadata.branch);
    expect(result!.status).toBe(metadata.status);
    expect(result!.tmuxName).toBe(metadata.tmuxName);
    expect(result!.issue).toBe(metadata.issue);
    expect(result!.pr).toBe(metadata.pr);
    expect(result!.summary).toBe(metadata.summary);
    expect(result!.project).toBe(metadata.project);
    expect(result!.createdAt).toBe(metadata.createdAt);
    expect(result!.dashboard?.port).toBe(4000);
  });

  it("readMetadataRaw returns all key-value pairs", () => {
    const sessionsDir = join(tmpDir, "test-raw");
    mkdirSync(sessionsDir, { recursive: true });

    writeMetadata(sessionsDir, "session-raw", {
      worktree: "/w",
      branch: "main",
      status: "idle",
      project: "proj",
    });

    const raw = readMetadataRaw(sessionsDir, "session-raw");
    expect(raw).not.toBeNull();
    expect(raw!["worktree"]).toBe("/w");
    expect(raw!["branch"]).toBe("main");
    expect(raw!["status"]).toBe("idle");
    expect(raw!["project"]).toBe("proj");
  });

  it("read returns null for non-existent session", () => {
    const sessionsDir = join(tmpDir, "test-nonexistent");
    mkdirSync(sessionsDir, { recursive: true });

    const result = readMetadata(sessionsDir, "no-such-session");
    expect(result).toBeNull();
  });

  it("updateMetadata merges fields into existing file", () => {
    const sessionsDir = join(tmpDir, "test-update");
    mkdirSync(sessionsDir, { recursive: true });

    writeMetadata(sessionsDir, "session-upd", {
      worktree: "/w",
      branch: "feat/x",
      status: "spawning",
      project: "proj",
    });

    updateMetadata(sessionsDir, "session-upd", {
      status: "working",
      pr: "https://github.com/org/repo/pull/99",
    });

    const result = readMetadata(sessionsDir, "session-upd");
    expect(result!.status).toBe("working");
    expect(result!.pr).toBe("https://github.com/org/repo/pull/99");
    // Original fields preserved
    expect(result!.worktree).toBe("/w");
    expect(result!.branch).toBe("feat/x");
    expect(result!.project).toBe("proj");
  });

  it("updateMetadata removes keys set to empty string", () => {
    const sessionsDir = join(tmpDir, "test-remove-key");
    mkdirSync(sessionsDir, { recursive: true });

    writeMetadata(sessionsDir, "session-rmk", {
      worktree: "/w",
      branch: "main",
      status: "working",
      summary: "Remove me",
    });

    updateMetadata(sessionsDir, "session-rmk", {
      summary: "",
    });

    const raw = readMetadataRaw(sessionsDir, "session-rmk");
    expect(raw!["summary"]).toBeUndefined();
    expect(raw!["worktree"]).toBe("/w");
  });

  it("updateMetadata creates file if it does not exist", () => {
    const sessionsDir = join(tmpDir, "test-update-create");
    mkdirSync(sessionsDir, { recursive: true });

    updateMetadata(sessionsDir, "session-new", {
      worktree: "/w",
      branch: "main",
      status: "spawning",
    });

    const result = readMetadata(sessionsDir, "session-new");
    expect(result).not.toBeNull();
    expect(result!.status).toBe("spawning");
  });

  it("listMetadata returns session IDs, excluding archive directory", () => {
    const sessionsDir = join(tmpDir, "test-list");
    mkdirSync(sessionsDir, { recursive: true });

    writeMetadata(sessionsDir, "session-a", { worktree: "/a", branch: "a", status: "idle" });
    writeMetadata(sessionsDir, "session-b", { worktree: "/b", branch: "b", status: "working" });
    writeMetadata(sessionsDir, "session-c", { worktree: "/c", branch: "c", status: "done" });

    const ids = listMetadata(sessionsDir);
    expect(ids).toContain("session-a");
    expect(ids).toContain("session-b");
    expect(ids).toContain("session-c");
    expect(ids).not.toContain("archive");
  });

  it("deleteMetadata permanently removes file", () => {
    const sessionsDir = join(tmpDir, "test-archive");
    mkdirSync(sessionsDir, { recursive: true });

    writeMetadata(sessionsDir, "session-del", { status: "working", worktree: "/tmp/w", branch: "main" });
    expect(readMetadataRaw(sessionsDir, "session-del")).not.toBeNull();
    deleteMetadata(sessionsDir, "session-del");
    expect(readMetadataRaw(sessionsDir, "session-del")).toBeNull();
  });

  it("deleteMetadata is a no-op for non-existent session", () => {
    const sessionsDir = join(tmpDir, "test-delete-noop");
    mkdirSync(sessionsDir, { recursive: true });

    // Should not throw
    deleteMetadata(sessionsDir, "no-such-session");
  });

  it("validates session ID rejects path traversal attempts", () => {
    const sessionsDir = join(tmpDir, "test-validation");
    mkdirSync(sessionsDir, { recursive: true });

    expect(() => readMetadata(sessionsDir, "../escape")).toThrow("Invalid session ID");
    expect(() => readMetadata(sessionsDir, "foo/bar")).toThrow("Invalid session ID");
    expect(() => readMetadata(sessionsDir, "foo bar")).toThrow("Invalid session ID");
  });

  describe("concurrent access patterns", () => {
    it("concurrent writes to different sessions do not interfere", async () => {
      const sessionsDir = join(tmpDir, "test-concurrent-different");
      mkdirSync(sessionsDir, { recursive: true });

      // Write 20 sessions concurrently
      const count = 20;
      const promises = Array.from({ length: count }, (_, i) =>
        Promise.resolve().then(() => {
          writeMetadata(sessionsDir, `concurrent-${i}`, {
            worktree: `/w/${i}`,
            branch: `branch-${i}`,
            status: "working",
            issue: `ISSUE-${i}`,
          });
        }),
      );

      await Promise.all(promises);

      // Verify all sessions were written correctly
      const ids = listMetadata(sessionsDir);
      expect(ids.length).toBe(count);

      for (let i = 0; i < count; i++) {
        const meta = readMetadata(sessionsDir, `concurrent-${i}`);
        expect(meta).not.toBeNull();
        expect(meta!.worktree).toBe(`/w/${i}`);
        expect(meta!.branch).toBe(`branch-${i}`);
        expect(meta!.issue).toBe(`ISSUE-${i}`);
      }
    });

    it("concurrent updates to the same session preserve last-write wins", async () => {
      const sessionsDir = join(tmpDir, "test-concurrent-same");
      mkdirSync(sessionsDir, { recursive: true });

      // Create initial session
      writeMetadata(sessionsDir, "shared-session", {
        worktree: "/w",
        branch: "main",
        status: "spawning",
      });

      // Rapidly update the same session from multiple "tasks"
      const updates = Array.from({ length: 10 }, (_, i) =>
        Promise.resolve().then(() => {
          updateMetadata(sessionsDir, "shared-session", {
            status: `status-${i}`,
            summary: `Update ${i}`,
          });
        }),
      );

      await Promise.all(updates);

      // Verify the file is valid (not corrupted)
      const result = readMetadata(sessionsDir, "shared-session");
      expect(result).not.toBeNull();
      expect(result!.worktree).toBe("/w");
      expect(result!.branch).toBe("main");
      // Status should be one of the updates (last-write-wins)
      expect(result!.status).toMatch(/^status-\d$/);
      expect(result!.summary).toMatch(/^Update \d$/);
    });
  });

  describe("dashboard port serialization", () => {
    it("preserves dashboard ports through write/read cycle", () => {
      const sessionsDir = join(tmpDir, "test-dashboard-port");
      mkdirSync(sessionsDir, { recursive: true });

      writeMetadata(sessionsDir, "port-session", {
        worktree: "/w",
        branch: "main",
        status: "working",
        dashboard: { port: 4567 },
      });

      const result = readMetadata(sessionsDir, "port-session");
      expect(result!.dashboard?.port).toBe(4567);
    });

    it("omits dashboard when undefined", () => {
      const sessionsDir = join(tmpDir, "test-no-dashboard-port");
      mkdirSync(sessionsDir, { recursive: true });

      writeMetadata(sessionsDir, "no-port-session", {
        worktree: "/w",
        branch: "main",
        status: "working",
      });

      const raw = readMetadataRaw(sessionsDir, "no-port-session");
      expect(raw!["dashboard"]).toBeUndefined();

      const result = readMetadata(sessionsDir, "no-port-session");
      expect(result!.dashboard).toBeUndefined();
    });
  });
});
