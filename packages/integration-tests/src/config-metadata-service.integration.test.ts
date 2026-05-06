/**
 * Integration test for config discovery → metadata service flow.
 *
 * Tests the full chain from config file → hash-based directory calculation →
 * metadata operations, verifying that the service layer architecture works
 * end-to-end with real filesystem I/O.
 */

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getSessionsDir,
  getProjectBaseDir,
  generateConfigHash,
  writeMetadata,
  readMetadata,
  updateMetadata,
  deleteMetadata,
  listMetadata,
  validateAndStoreOrigin,
} from "@aoagents/ao-core";

describe("config → metadata service integration (real filesystem)", () => {
  const storageKeyA = "111111111111";
  const storageKeyB = "222222222222";
  let tmpDir: string;
  let configPath: string;
  let repoPath: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ao-config-meta-integ-"));

    repoPath = join(tmpDir, "my-repo");
    mkdirSync(repoPath, { recursive: true });

    // Create a minimal config file
    const config = {
      port: 3000,
      defaults: {
        runtime: "tmux",
        agent: "claude-code",
        workspace: "worktree",
        notifiers: [],
      },
      projects: {
        "test-project": {
          name: "Test Project",
          repo: "org/test-repo",
          path: repoPath,
          defaultBranch: "main",
          sessionPrefix: "test",
        },
      },
      notifiers: {},
      notificationRouting: { urgent: [], action: [], warning: [], info: [] },
      reactions: {},
    };

    configPath = join(tmpDir, "agent-orchestrator.yaml");
    await writeFile(configPath, JSON.stringify(config, null, 2));
  });

  afterAll(async () => {
    // Clean up hash-based directories in ~/.agent-orchestrator
    try {
      const projectBaseDir = getProjectBaseDir(storageKeyA);
      if (existsSync(projectBaseDir)) {
        await rm(projectBaseDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }

    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("config hash is deterministic", () => {
    const hash1 = generateConfigHash(configPath);
    const hash2 = generateConfigHash(configPath);
    expect(hash1).toBe(hash2);
    expect(hash1.length).toBeGreaterThan(0);
  });

  it("getSessionsDir returns hash-based path including project name", () => {
    const sessionsDir = getSessionsDir(storageKeyA);

    expect(sessionsDir).toContain(".agent-orchestrator");
    expect(sessionsDir).toContain(storageKeyA);
    expect(sessionsDir).toContain("sessions");
  });

  it("different repos get different session directories", () => {
    const repo2Path = join(tmpDir, "other-repo");
    mkdirSync(repo2Path, { recursive: true });

    const dir1 = getSessionsDir(storageKeyA);
    const dir2 = getSessionsDir(storageKeyB);

    expect(dir1).not.toBe(dir2);
    expect(dir1).toContain(storageKeyA);
    expect(dir2).toContain(storageKeyB);
  });

  it("full metadata lifecycle through hash-based directory", () => {
    const sessionsDir = getSessionsDir(storageKeyA);
    mkdirSync(sessionsDir, { recursive: true });

    // 1. Write metadata
    writeMetadata(sessionsDir, "lifecycle-1", {
      worktree: join(tmpDir, "worktrees", "lifecycle-1"),
      branch: "feat/TEST-100",
      status: "spawning",
      project: "test-project",
      issue: "TEST-100",
      createdAt: new Date().toISOString(),
    });

    // 2. Read it back
    const meta = readMetadata(sessionsDir, "lifecycle-1");
    expect(meta).not.toBeNull();
    expect(meta!.branch).toBe("feat/TEST-100");
    expect(meta!.status).toBe("spawning");
    expect(meta!.project).toBe("test-project");
    expect(meta!.issue).toBe("TEST-100");

    // 3. Update status
    updateMetadata(sessionsDir, "lifecycle-1", {
      status: "working",
      pr: "https://github.com/org/test-repo/pull/42",
    });

    const updated = readMetadata(sessionsDir, "lifecycle-1");
    expect(updated!.status).toBe("working");
    expect(updated!.pr).toBe("https://github.com/org/test-repo/pull/42");
    expect(updated!.issue).toBe("TEST-100"); // preserved

    // 4. List sessions
    writeMetadata(sessionsDir, "lifecycle-2", {
      worktree: join(tmpDir, "worktrees", "lifecycle-2"),
      branch: "feat/TEST-200",
      status: "idle",
      project: "test-project",
    });

    const ids = listMetadata(sessionsDir);
    expect(ids).toContain("lifecycle-1");
    expect(ids).toContain("lifecycle-2");

    // 5. Delete with archive
    deleteMetadata(sessionsDir, "lifecycle-1");
    expect(readMetadata(sessionsDir, "lifecycle-1")).toBeNull();

    // 6. Delete second session
    deleteMetadata(sessionsDir, "lifecycle-2");
    expect(readMetadata(sessionsDir, "lifecycle-2")).toBeNull();
  });

  it("origin validation stores and detects repo identity", () => {
    // validateAndStoreOrigin should not throw for a valid repo path
    // (even without a real git remote, it stores path-based identity)
    expect(() => validateAndStoreOrigin(configPath, storageKeyA)).not.toThrow();

    // Calling again with the same path should succeed (same origin)
    expect(() => validateAndStoreOrigin(configPath, storageKeyA)).not.toThrow();
  });

  it("multi-project isolation with shared config", () => {
    const repo2Path = join(tmpDir, "project-b-repo");
    mkdirSync(repo2Path, { recursive: true });

    const dirA = getSessionsDir(storageKeyA);
    const dirB = getSessionsDir(storageKeyB);
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });

    // Write session to project A
    writeMetadata(dirA, "projA-session-1", {
      worktree: "/a/wt",
      branch: "feat/A",
      status: "working",
      project: "project-a",
    });

    // Write session to project B
    writeMetadata(dirB, "projB-session-1", {
      worktree: "/b/wt",
      branch: "feat/B",
      status: "idle",
      project: "project-b",
    });

    // Sessions are isolated
    expect(listMetadata(dirA)).toContain("projA-session-1");
    expect(listMetadata(dirA)).not.toContain("projB-session-1");
    expect(listMetadata(dirB)).toContain("projB-session-1");
    expect(listMetadata(dirB)).not.toContain("projA-session-1");

    // Cleanup
    deleteMetadata(dirA, "projA-session-1");
    deleteMetadata(dirB, "projB-session-1");
  });
});
