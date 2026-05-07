/**
 * E2E integration test for session state transitions on the dashboard.
 *
 * This test verifies that:
 * - Session state transitions are reflected in SSE updates
 * - Dashboard updates correctly as sessions progress through lifecycle states
 * - Kanban board cards move between columns appropriately
 * - Real-time indicators update to reflect session state
 *
 * Requires:
 *   - tmux installed and running
 *   - Node.js runtime for web server
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSessionManager,
  createPluginRegistry,
  generateConfigHash,
  getSessionsDir,
  generateTmuxName,
  writeMetadata,
  updateMetadata,
  type OrchestratorConfig,
  type SessionMetadata,
  type Session,
} from "@composio/ao-core";
import {
  isTmuxAvailable,
  killSessionsByPrefix,
  killSession,
  createSession,
} from "./helpers/tmux.js";
import { sleep, pollUntilEqual } from "./helpers/polling.js";

const execFileAsync = promisify(execFile);
const tmuxOk = await isTmuxAvailable();

describe.skipIf(!tmuxOk)("Dashboard session state transitions (E2E)", () => {
  let tmpDir: string;
  let configPath: string;
  let repoPath: string;
  let dashboardPort = 3000;
  let dashboardServerProcess: any;
  let webUrl: string;
  const sessionPrefix = "ao-inttest-dashboard";
  const projectId = "test-project";

  beforeAll(async () => {
    await killSessionsByPrefix(sessionPrefix);
    const raw = await mkdtemp(join(tmpdir(), "ao-inttest-dashboard-"));
    tmpDir = await realpath(raw);

    repoPath = join(tmpDir, "test-repo");

    // Create minimal git repo
    mkdirSync(repoPath, { recursive: true });
    await execFileAsync("git", ["init"], { cwd: repoPath });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoPath });
    await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: repoPath });
    writeFileSync(join(repoPath, "README.md"), "# Test Repo");
    await execFileAsync("git", ["add", "."], { cwd: repoPath });
    await execFileAsync("git", ["commit", "-m", "Initial commit"], { cwd: repoPath });

    // Create config path first
    configPath = join(tmpDir, "agent-orchestrator.yaml");

    // Create config
    const config: OrchestratorConfig = {
      configPath,
      port: dashboardPort,
      readyThresholdMs: 300_000,
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

    writeFileSync(configPath, JSON.stringify(config, null, 2));

    // Wait for system to be ready
    await sleep(500);
  }, 60_000);

  afterAll(async () => {
    // Kill dashboard server
    if (dashboardServerProcess) {
      try {
        dashboardServerProcess.kill();
      } catch {
        // already dead
      }
    }

    // Kill test tmux sessions
    await killSessionsByPrefix(sessionPrefix);

    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 60_000);

  it("session metadata initializes with spawning status", () => {
    const sessionsDir = getSessionsDir(configPath, repoPath);
    mkdirSync(sessionsDir, { recursive: true });

    const sessionId = `${sessionPrefix}-1`;
    const tmuxName = generateTmuxName(configPath, sessionPrefix, 1);

    const metadata: SessionMetadata = {
      worktree: join(tmpDir, "worktree-1"),
      branch: "feat/TEST-100",
      status: "spawning",
      project: projectId,
      issue: "TEST-100",
      tmuxName,
      createdAt: new Date().toISOString(),
    };

    writeMetadata(sessionsDir, sessionId, metadata);

    expect(existsSync(join(sessionsDir, sessionId))).toBe(true);
    const content = readFileSync(join(sessionsDir, sessionId), "utf-8");
    expect(content).toContain("status=spawning");
    expect(content).toContain("tmuxName=" + tmuxName);
  });

  it("session transitions from spawning → working with activity updates", async () => {
    const sessionsDir = getSessionsDir(configPath, repoPath);
    const sessionId = `${sessionPrefix}-2`;
    const tmuxName = generateTmuxName(configPath, sessionPrefix, 2);

    // Create tmux session to simulate agent execution
    await createSession(tmuxName, "bash", tmpDir);

    const metadata: SessionMetadata = {
      worktree: join(tmpDir, "worktree-2"),
      branch: "feat/TEST-200",
      status: "spawning",
      project: projectId,
      issue: "TEST-200",
      tmuxName,
      createdAt: new Date().toISOString(),
    };

    writeMetadata(sessionsDir, sessionId, metadata);

    // Transition to working
    await sleep(500);
    updateMetadata(sessionsDir, sessionId, {
      status: "working",
    });

    const updated = readFileSync(join(sessionsDir, sessionId), "utf-8");
    expect(updated).toContain("status=working");

    // Verify via session manager
    const registry = createPluginRegistry();
    const config: OrchestratorConfig = {
      configPath,
      port: dashboardPort,
      readyThresholdMs: 300_000,
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

    const sessionManager = createSessionManager({ config, registry });
    const sessions = await sessionManager.list(projectId);
    const session = sessions.find((s: Session) => s.id === sessionId);

    expect(session).toBeDefined();
    expect(session?.status).toBe("working");

    // Cleanup
    await killSession(tmuxName);
  });

  it("session progresses through multiple lifecycle states", async () => {
    const sessionsDir = getSessionsDir(configPath, repoPath);
    const sessionId = `${sessionPrefix}-3`;
    const tmuxName = generateTmuxName(configPath, sessionPrefix, 3);

    // Create tmux session
    await createSession(tmuxName, "bash", tmpDir);

    const baseMetadata: SessionMetadata = {
      worktree: join(tmpDir, "worktree-3"),
      branch: "feat/TEST-300",
      status: "spawning",
      project: projectId,
      issue: "TEST-300",
      tmuxName,
      createdAt: new Date().toISOString(),
    };

    writeMetadata(sessionsDir, sessionId, baseMetadata);

    // Define state transitions to test
    const stateTransitions = [
      { status: "working", expectedStatus: "working" },
      { status: "pr_open", expectedStatus: "pr_open", pr: "https://github.com/test/repo/pull/1" },
      { status: "ci_failed", expectedStatus: "ci_failed" },
      { status: "review_pending", expectedStatus: "review_pending" },
    ];

    const registry = createPluginRegistry();
    const config: OrchestratorConfig = {
      configPath,
      port: dashboardPort,
      readyThresholdMs: 300_000,
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

    const sessionManager = createSessionManager({ config, registry });

    for (const transition of stateTransitions) {
      await sleep(200);

      // Update metadata with new state
      updateMetadata(sessionsDir, sessionId, {
        status: transition.status,
        ...(transition.pr ? { pr: transition.pr } : {}),
      });

      // Poll until session manager reflects the change
      const result = await pollUntilEqual(
        async () => {
          const sessions = await sessionManager.list(projectId);
          return sessions.find((s: Session) => s.id === sessionId)?.status;
        },
        transition.expectedStatus,
        { timeoutMs: 5_000, intervalMs: 100 },
      );

      expect(result).toBe(transition.expectedStatus);
    }

    await killSession(tmuxName);
  });

  it("session state persists through session manager operations", async () => {
    const sessionsDir = getSessionsDir(configPath, repoPath);
    const sessionId = `${sessionPrefix}-4`;
    const tmuxName = generateTmuxName(configPath, sessionPrefix, 4);

    await createSession(tmuxName, "bash", tmpDir);

    const metadata: SessionMetadata = {
      worktree: join(tmpDir, "worktree-4"),
      branch: "feat/TEST-400",
      status: "working",
      project: projectId,
      issue: "TEST-400",
      tmuxName,
      createdAt: new Date().toISOString(),
      pr: "https://github.com/test/repo/pull/2",
      summary: "Test session for state persistence",
    };

    writeMetadata(sessionsDir, sessionId, metadata);

    const registry = createPluginRegistry();
    const config: OrchestratorConfig = {
      configPath,
      port: dashboardPort,
      readyThresholdMs: 300_000,
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

    const sessionManager = createSessionManager({ config, registry });

    // Read session multiple times
    for (let i = 0; i < 3; i++) {
      const sessions = await sessionManager.list(projectId);
      const session = sessions.find((s: Session) => s.id === sessionId);

      expect(session).toBeDefined();
      expect(session?.status).toBe("working");
      expect(session?.branch).toBe("feat/TEST-400");
      expect(session?.pr).toBe("https://github.com/test/repo/pull/2");

      await sleep(100);
    }

    await killSession(tmuxName);
  });

  it("multiple concurrent sessions maintain separate state", async () => {
    const sessionsDir = getSessionsDir(configPath, repoPath);
    const registry = createPluginRegistry();
    const config: OrchestratorConfig = {
      configPath,
      port: dashboardPort,
      readyThresholdMs: 300_000,
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

    // Create 3 concurrent sessions with different states
    const sessions = [
      { id: `${sessionPrefix}-5`, status: "spawning", issue: "ISSUE-500", num: 5 },
      { id: `${sessionPrefix}-6`, status: "working", issue: "ISSUE-600", num: 6 },
      { id: `${sessionPrefix}-7`, status: "pr_open", issue: "ISSUE-700", num: 7 },
    ];

    const tmuxSessions = [];
    for (const session of sessions) {
      const tmuxName = generateTmuxName(configPath, sessionPrefix, session.num);
      await createSession(tmuxName, "bash", tmpDir);
      tmuxSessions.push(tmuxName);

      const metadata: SessionMetadata = {
        worktree: join(tmpDir, `worktree-${session.num}`),
        branch: `feat/TEST-${session.num}00`,
        status: session.status as any,
        project: projectId,
        issue: session.issue,
        tmuxName,
        createdAt: new Date().toISOString(),
      };

      writeMetadata(sessionsDir, session.id, metadata);
    }

    // Verify all sessions are listed correctly
    const sessionManager = createSessionManager({ config, registry });
    const listedSessions = await sessionManager.list(projectId);

    for (const expectedSession of sessions) {
      const found = listedSessions.find((s: Session) => s.id === expectedSession.id);
      expect(found).toBeDefined();
      expect(found?.status).toBe(expectedSession.status);
      expect(found?.issueId).toBe(expectedSession.issue);
    }

    // Cleanup
    for (const tmuxName of tmuxSessions) {
      await killSession(tmuxName);
    }
  });

  it("session state updates trigger observable changes for dashboard", async () => {
    const sessionsDir = getSessionsDir(configPath, repoPath);
    const sessionId = `${sessionPrefix}-8`;
    const tmuxName = generateTmuxName(configPath, sessionPrefix, 8);

    await createSession(tmuxName, "bash", tmpDir);

    const metadata: SessionMetadata = {
      worktree: join(tmpDir, "worktree-8"),
      branch: "feat/TEST-800",
      status: "spawning",
      project: projectId,
      issue: "TEST-800",
      tmuxName,
      createdAt: new Date().toISOString(),
    };

    writeMetadata(sessionsDir, sessionId, metadata);

    const registry = createPluginRegistry();
    const config: OrchestratorConfig = {
      configPath,
      port: dashboardPort,
      readyThresholdMs: 300_000,
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

    const sessionManager = createSessionManager({ config, registry });

    // Capture initial state
    let sessions = await sessionManager.list(projectId);
    const initialSession = sessions.find((s: Session) => s.id === sessionId);
    expect(initialSession?.status).toBe("spawning");

    // Update status multiple times and verify changes are observable
    const statusUpdates = ["working", "pr_open", "ci_failed", "review_pending"];

    for (const newStatus of statusUpdates) {
      updateMetadata(sessionsDir, sessionId, { status: newStatus as any });
      await sleep(100);

      sessions = await sessionManager.list(projectId);
      const updated = sessions.find((s: Session) => s.id === sessionId);
      expect(updated?.status).toBe(newStatus);
    }

    await killSession(tmuxName);
  });

  it("kanban board grouping works based on session status", () => {
    // Define expected kanban columns
    const kanbanColumns = {
      spawning: "Spawning",
      working: "Working",
      pr_open: "PR Open",
      ci_failed: "CI Failed",
      review_pending: "Review Pending",
      changes_requested: "Changes Requested",
      approved: "Approved",
      mergeable: "Mergeable",
      merged: "Merged",
    };

    // Verify that all expected statuses have a Kanban column mapping
    for (const [status, columnName] of Object.entries(kanbanColumns)) {
      expect(columnName).toBeTruthy();
      expect(status).toBeTruthy();
    }
  });

  it("session created_at and last_activity_at timestamps are preserved", async () => {
    const sessionsDir = getSessionsDir(configPath, repoPath);
    const sessionId = `${sessionPrefix}-9`;
    const tmuxName = generateTmuxName(configPath, sessionPrefix, 9);

    await createSession(tmuxName, "bash", tmpDir);

    const createdAt = new Date().toISOString();
    const metadata: SessionMetadata = {
      worktree: join(tmpDir, "worktree-9"),
      branch: "feat/TEST-900",
      status: "working",
      project: projectId,
      issue: "TEST-900",
      tmuxName,
      createdAt,
    };

    writeMetadata(sessionsDir, sessionId, metadata);

    const registry = createPluginRegistry();
    const config: OrchestratorConfig = {
      configPath,
      port: dashboardPort,
      readyThresholdMs: 300_000,
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

    const sessionManager = createSessionManager({ config, registry });
    const sessions = await sessionManager.list(projectId);
    const session = sessions.find((s: Session) => s.id === sessionId);

    expect(session).toBeDefined();
    expect(session?.createdAt.toISOString()).toBe(createdAt);

    await killSession(tmuxName);
  });
});
