/**
 * Integration test for CLI spawn → Core session-manager with projectId-based architecture.
 *
 * This test verifies that sessions work correctly with the projectId-based
 * project isolation architecture:
 * - Sessions stored in project-specific directories (~/.agent-orchestrator/projects/{projectId}/)
 * - projectId-based namespacing prevents collisions
 * - tmuxName field correctly maps user-facing → tmux names
 * - Core session-manager finds sessions in new structure
 *
 * Requires:
 *   - tmux installed and running
 *   - git repository for worktree creation
 */

import { mkdtemp, rm, realpath, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSessionManager,
  createPluginRegistry,
  type OrchestratorConfig,
  getProjectSessionsDir,
  generateSessionName,
} from "@aoagents/ao-core";
import { isTmuxAvailable, killSessionsByPrefix, killSession } from "./helpers/tmux.js";

const tmuxOk = await isTmuxAvailable();

describe.skipIf(!tmuxOk)("CLI-Core integration (projectId-based architecture)", () => {
  const projectId = "test-project";
  let tmpDir: string;
  let configPath: string;
  let repoPath: string;
  let originalHome: string | undefined;
  const sessionPrefix = "ao-inttest-new";
  const sessionName = `${sessionPrefix}-1`;

  beforeAll(async () => {
    await killSessionsByPrefix(sessionPrefix);
    const raw = await mkdtemp(join(tmpdir(), "ao-inttest-new-"));
    tmpDir = await realpath(raw);

    // HOME isolation so getProjectSessionsDir resolves under tmpDir
    originalHome = process.env["HOME"];
    process.env["HOME"] = tmpDir;

    repoPath = join(tmpDir, "test-repo");

    // Create a minimal git repo
    mkdirSync(repoPath, { recursive: true });
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    await execFileAsync("git", ["init"], { cwd: repoPath });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoPath });
    await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: repoPath });
    writeFileSync(join(repoPath, "README.md"), "# Test Repo");
    await execFileAsync("git", ["add", "."], { cwd: repoPath });
    await execFileAsync("git", ["commit", "-m", "Initial commit"], { cwd: repoPath });

    // Create config WITHOUT dataDir/worktreeDir (new architecture)
    const config = {
      port: 3000,
      defaults: {
        runtime: "tmux",
        agent: "claude-code",
        workspace: "worktree",
        notifiers: [],
      },
      projects: {
        [projectId]: {
          name: "Test Project",
          repo: "test/test-repo",
          path: repoPath,
          defaultBranch: "main",
          sessionPrefix,
        },
      },
      notifiers: {},
      notificationRouting: {
        urgent: [],
        action: [],
        warning: [],
        info: [],
      },
      reactions: {},
    };

    configPath = join(tmpDir, "agent-orchestrator.yaml");
    await writeFile(configPath, JSON.stringify(config, null, 2));
  }, 30_000);

  afterAll(async () => {
    if (originalHome !== undefined) process.env["HOME"] = originalHome;
    else delete process.env["HOME"];
    // Cleanup tmux sessions
    for (let i = 1; i <= 3; i++) {
      await killSession(`${sessionPrefix}-${i}`).catch(() => {});
    }
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 30_000);

  it("sessions are stored in projectId-based project-specific directory", () => {
    const sessionsDir = getProjectSessionsDir(projectId);

    expect(sessionsDir).toMatch(/\.agent-orchestrator\/projects\/test-project\/sessions$/);
  });

  it("session metadata includes tmuxName field", () => {
    const sessionsDir = getProjectSessionsDir(projectId);
    mkdirSync(sessionsDir, { recursive: true });

    // Write metadata as CLI would do
    const tmuxName = generateSessionName(sessionPrefix, 1);
    const metadataPath = join(sessionsDir, `${sessionName}.json`);
    const metadata = {
      worktree: tmpDir,
      branch: "feat/test",
      status: "spawning",
      project: "test-project",
      issue: "TEST-123",
      tmuxName,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + "\n");

    // Verify file exists in correct location
    expect(existsSync(metadataPath)).toBe(true);

    // Verify tmuxName field is present
    const content = readFileSync(metadataPath, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.tmuxName).toBe(tmuxName);
    expect(parsed.project).toBe("test-project");
  });

  it("core session-manager finds session in projectId-based directory", async () => {
    const sessionsDir = getProjectSessionsDir(projectId);
    mkdirSync(sessionsDir, { recursive: true });

    // Write metadata
    const tmuxName = generateSessionName(sessionPrefix, 1);
    const metadataPath = join(sessionsDir, `${sessionName}.json`);
    const metadata = {
      worktree: tmpDir,
      branch: "feat/test",
      status: "working",
      project: "test-project",
      issue: "TEST-123",
      tmuxName,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + "\n");

    // Create session-manager with configPath
    const config: OrchestratorConfig = {
      configPath,
      port: 3000,
      readyThresholdMs: 300_000,
      power: { preventIdleSleep: false },
      defaults: {
        runtime: "tmux",
        agent: "claude-code",
        workspace: "worktree",
        notifiers: [],
      },
      projects: {
        [projectId]: {
          name: "Test Project",
          repo: "test/test-repo",
          path: repoPath,
          defaultBranch: "main",
          sessionPrefix,
        },
      },
      notifiers: {},
      notificationRouting: {
        urgent: [],
        action: [],
        warning: [],
        info: [],
      },
      reactions: {},
    };

    const registry = createPluginRegistry();
    const sessionManager = createSessionManager({ config, registry });

    // List sessions
    const sessions = await sessionManager.list("test-project");

    // Verify session is found
    expect(sessions.length).toBeGreaterThan(0);
    const session = sessions.find((s) => s.id === sessionName);
    expect(session).toBeDefined();
    expect(session?.projectId).toBe("test-project");
    expect(session?.branch).toBe("feat/test");
    expect(session?.issueId).toBe("TEST-123");
    expect(session?.status).toBe("working");
  });

  it("session name matches user-facing name (no hash prefix)", () => {
    const tmuxName = generateSessionName(sessionPrefix, 1);

    expect(tmuxName).toBe(`${sessionPrefix}-1`);
    expect(tmuxName).toBe(sessionName); // Session name equals user-facing name
  });

  it("cross-project isolation with projectId-based directories", async () => {
    const projectIdA = "project-a";
    const projectIdB = "project-b";
    // Create second project path
    const repo2Path = join(tmpDir, "project-b");
    const repoAPath = join(tmpDir, "project-a"); // Use separate path for project A
    mkdirSync(repo2Path, { recursive: true });
    mkdirSync(repoAPath, { recursive: true });

    const config: OrchestratorConfig = {
      configPath,
      port: 3000,
      readyThresholdMs: 300_000,
      power: { preventIdleSleep: false },
      defaults: {
        runtime: "tmux",
        agent: "claude-code",
        workspace: "worktree",
        notifiers: [],
      },
      projects: {
        [projectIdA]: {
          name: "Project A",
          repo: "test/project-a",
          path: repoAPath, // Different path from test-repo
          defaultBranch: "main",
          sessionPrefix: `${sessionPrefix}-a`,
        },
        [projectIdB]: {
          name: "Project B",
          repo: "test/project-b",
          path: repo2Path,
          defaultBranch: "main",
          sessionPrefix: `${sessionPrefix}-b`,
        },
      },
      notifiers: {},
      notificationRouting: {
        urgent: [],
        action: [],
        warning: [],
        info: [],
      },
      reactions: {},
    };

    // Write metadata for project A
    const sessionsDirA = getProjectSessionsDir(projectIdA);
    rmSync(sessionsDirA, { recursive: true, force: true });
    mkdirSync(sessionsDirA, { recursive: true });
    const sessionAName = `${sessionPrefix}-a-1`;
    writeFileSync(
      join(sessionsDirA, `${sessionAName}.json`),
      JSON.stringify({
        worktree: `${tmpDir}/a`,
        branch: "feat/A-100",
        status: "working",
        project: "project-a",
        issue: "A-100",
      }, null, 2) + "\n",
    );

    // Write metadata for project B
    const sessionsDirB = getProjectSessionsDir(projectIdB);
    rmSync(sessionsDirB, { recursive: true, force: true });
    mkdirSync(sessionsDirB, { recursive: true });
    const sessionBName = `${sessionPrefix}-b-1`;
    writeFileSync(
      join(sessionsDirB, `${sessionBName}.json`),
      JSON.stringify({
        worktree: `${tmpDir}/b`,
        branch: "feat/B-100",
        status: "working",
        project: "project-b",
        issue: "B-100",
      }, null, 2) + "\n",
    );

    const registry = createPluginRegistry();
    const sessionManager = createSessionManager({ config, registry });

    // List sessions for each project
    const projectASessions = await sessionManager.list("project-a");
    const projectBSessions = await sessionManager.list("project-b");

    // Verify isolation
    expect(projectASessions.length).toBe(1);
    expect(projectBSessions.length).toBe(1);
    expect(projectASessions[0].id).toBe(sessionAName);
    expect(projectBSessions[0].id).toBe(sessionBName);

    // Verify sessions are in different directories
    expect(sessionsDirA).not.toBe(sessionsDirB);
    expect(sessionsDirA).toContain("project-a");
    expect(sessionsDirB).toContain("project-b");
  });
});
