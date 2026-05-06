/**
 * Plugin integration tests — core services calling real plugin instances.
 *
 * These tests verify the full path: core service → real plugin → mocked external API.
 * Both tracker-github and scm-github use `gh` CLI via `execFile`, so a single
 * `vi.mock("node:child_process")` covers both plugins.
 *
 * Runtime, Agent, and Workspace remain mock objects — we're testing the
 * tracker/SCM integration path, not those.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Mock node:child_process — must be hoisted before plugin imports
// ---------------------------------------------------------------------------

const { ghMock } = vi.hoisted(() => ({ ghMock: vi.fn() }));

vi.mock("node:child_process", () => {
  const execFile = Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: ghMock,
  });
  return { execFile };
});

// ---------------------------------------------------------------------------
// Imports — plugins resolve the mocked child_process at import time
// ---------------------------------------------------------------------------

import { createPluginRegistry } from "../plugin-registry.js";
import { createSessionManager } from "../session-manager.js";
import { createLifecycleManager } from "../lifecycle-manager.js";
import { writeMetadata } from "../metadata.js";
import { getProjectSessionsDir, getProjectDir } from "../paths.js";
import trackerGithub from "@aoagents/ao-plugin-tracker-github";
import scmGithub from "@aoagents/ao-plugin-scm-github";
import { createMockPlugins, makeHandle, makeSession as makeSessionBase, makePR, type TestEnvironment } from "./test-utils.js";
import type {
  OrchestratorConfig,
  PluginRegistry,
  Runtime,
  Agent,
  Workspace,
  OpenCodeSessionManager,
  Session,
} from "../types.js";

// ---------------------------------------------------------------------------
// Shared fixtures + helpers
// ---------------------------------------------------------------------------

let env: TestEnvironment;
let mockRuntime: Runtime;
let mockAgent: Agent;
let mockWorkspace: Workspace;
let config: OrchestratorConfig;
let project: OrchestratorConfig["projects"][string];

function mockGh(result: unknown): void {
  ghMock.mockResolvedValueOnce({ stdout: JSON.stringify(result) });
}

const pr = makePR({
  number: 42,
  url: "https://github.com/acme/app/pull/42",
  title: "feat: add feature",
  owner: "acme",
  repo: "app",
  branch: "feat/issue-99",
  baseBranch: "main",
});

function makeSession(overrides: Partial<Session> = {}): Session {
  return makeSessionBase({
    id: "app-1",
    projectId: "my-app",
    status: "working",
    branch: "feat/issue-99",
    workspacePath: "/tmp/test-app",
    runtimeHandle: makeHandle("rt-1"),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let previousHome: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();

  // Use test-utils to create the test environment
  env = {
    tmpDir: join(tmpdir(), `ao-test-plugin-int-${randomUUID()}`),
    configPath: "",
    sessionsDir: "",
    config: {} as OrchestratorConfig,
    cleanup: () => {},
  };

  mkdirSync(env.tmpDir, { recursive: true });
  previousHome = process.env["HOME"];
  process.env["HOME"] = env.tmpDir;
  env.configPath = join(env.tmpDir, "agent-orchestrator.yaml");
  writeFileSync(env.configPath, "projects: {}\n");

  // Create mock plugins using test-utils
  const plugins = createMockPlugins();
  mockRuntime = plugins.runtime;
  mockAgent = plugins.agent;
  mockWorkspace = plugins.workspace;

  // Initialize project
  project = {
    name: "Test App",
    repo: "acme/app",
    path: join(env.tmpDir, "test-app"),
    defaultBranch: "main",
    sessionPrefix: "app",
    tracker: { plugin: "github" },
    scm: { plugin: "github" },
  };

  config = {
    configPath: env.configPath,
    port: 3000,
    defaults: {
      runtime: "mock",
      agent: "mock-agent",
      workspace: "mock-ws",
      notifiers: [],
    },
    projects: {
      "my-app": project,
    },
    notifiers: {},
    notificationRouting: {
      urgent: [],
      action: [],
      warning: [],
      info: [],
    },
    reactions: {},
    readyThresholdMs: 300_000,
  };

  env.config = config;
  env.sessionsDir = getProjectSessionsDir("my-app");
  mkdirSync(env.sessionsDir, { recursive: true });

  env.cleanup = () => {
    const projectDir = getProjectDir("my-app");
    if (existsSync(projectDir)) {
      rmSync(projectDir, { recursive: true, force: true });
    }
    rmSync(env.tmpDir, { recursive: true, force: true });
  };
});

afterEach(() => {
  env.cleanup();
  if (previousHome === undefined) {
    delete process.env["HOME"];
  } else {
    process.env["HOME"] = previousHome;
  }
});

// ---------------------------------------------------------------------------
// Helper: create a registry with real tracker-github and scm-github
// ---------------------------------------------------------------------------

function createTestRegistry(): PluginRegistry {
  const registry = createPluginRegistry();

  // Register mock plugins for runtime/agent/workspace
  registry.register({
    manifest: { name: "mock", slot: "runtime", description: "mock", version: "0.0.0" },
    create: () => mockRuntime,
  });
  registry.register({
    manifest: { name: "mock-agent", slot: "agent", description: "mock", version: "0.0.0" },
    create: () => mockAgent,
  });
  registry.register({
    manifest: { name: "mock-ws", slot: "workspace", description: "mock", version: "0.0.0" },
    create: () => mockWorkspace,
  });

  // Register REAL plugins
  registry.register(trackerGithub);
  registry.register(scmGithub);

  return registry;
}

// ===========================================================================
// Tests
// ===========================================================================

describe("plugin integration", () => {
  // -------------------------------------------------------------------------
  describe("registry + real plugins", () => {
    it("registers tracker-github and scm-github via real registry", () => {
      const registry = createTestRegistry();

      const trackers = registry.list("tracker");
      const scms = registry.list("scm");

      expect(trackers).toContainEqual(expect.objectContaining({ name: "github", slot: "tracker" }));
      expect(scms).toContainEqual(expect.objectContaining({ name: "github", slot: "scm" }));
    });

    it("registry.get returns correct plugin instances by slot+name", () => {
      const registry = createTestRegistry();

      const tracker = registry.get("tracker", "github");
      const scm = registry.get("scm", "github");

      expect(tracker).not.toBeNull();
      expect(scm).not.toBeNull();
      expect(tracker).toHaveProperty("name", "github");
      expect(scm).toHaveProperty("name", "github");
      // Verify they have the expected methods
      expect(tracker).toHaveProperty("branchName");
      expect(tracker).toHaveProperty("isCompleted");
      expect(scm).toHaveProperty("getPRState");
      expect(scm).toHaveProperty("getCISummary");
    });
  });

  // -------------------------------------------------------------------------
  describe("SessionManager + Tracker", () => {
    it("spawn() uses tracker-github branchName() to derive branch", async () => {
      const registry = createTestRegistry();
      const sm = createSessionManager({ config, registry });

      // Mock gh issue view response for validation
      mockGh({
        number: 99,
        title: "Test issue",
        body: "Test description",
        url: "https://github.com/acme/app/issues/99",
        state: "OPEN",
        stateReason: null,
        labels: [],
        assignees: [],
      });

      const session = await sm.spawn({
        projectId: "my-app",
        issueId: "99",
      });

      // tracker-github.branchName("99", project) → "feat/issue-99"
      expect(session.branch).toBe("feat/issue-99");

      // Workspace should have been called with the tracker-derived branch
      expect(mockWorkspace.create).toHaveBeenCalledWith(
        expect.objectContaining({ branch: "feat/issue-99" }),
      );
    });

    it("spawn() falls back to generic branch when no tracker configured", async () => {
      // Remove tracker from project config
      const noTrackerConfig: OrchestratorConfig = {
        ...config,
        projects: {
          "my-app": { ...project, tracker: undefined },
        },
      };
      const registry = createTestRegistry();
      const sm = createSessionManager({ config: noTrackerConfig, registry });

      const session = await sm.spawn({
        projectId: "my-app",
        issueId: "99",
      });

      // Without tracker, falls back to "feat/<issueId>"
      expect(session.branch).toBe("feat/99");
    });

    it("cleanup() never kills orchestrator sessions even when issue is closed", async () => {
      const registry = createTestRegistry();
      const sm = createSessionManager({ config, registry });

      // Seed an orchestrator session with a closed issue — it should still be skipped
      writeMetadata(env.sessionsDir, "app-orchestrator", {
        worktree: "/tmp/mock-ws/app-orchestrator",
        branch: "main",
        status: "working",
        role: "orchestrator",
        issue: "99",
        project: "my-app",
        runtimeHandle: JSON.stringify(makeHandle("rt-orch")),
      });

      // Also seed a regular session with the same closed issue — it SHOULD be killed
      writeMetadata(env.sessionsDir, "app-1", {
        worktree: "/tmp/mock-ws/app-1",
        branch: "feat/issue-99",
        status: "working",
        issue: "99",
        project: "my-app",
        runtimeHandle: JSON.stringify(makeHandle("rt-1")),
      });

      // Mock gh: issue is closed (full Issue shape so getIssue/isCompleted parse it)
      mockGh({
        number: 99,
        title: "test",
        body: "",
        url: "https://github.com/acme/app/issues/99",
        state: "CLOSED",
        stateReason: "COMPLETED",
        labels: [],
        assignees: [],
      });

      const result = await sm.cleanup("my-app");

      // Regular session killed, orchestrator skipped
      expect(result.killed).toContain("app-1");
      expect(result.killed).not.toContain("app-orchestrator");
      expect(result.skipped).toContain("app-orchestrator");
    });

    it("cleanup() calls tracker-github isCompleted() and kills completed sessions", async () => {
      const registry = createTestRegistry();
      const sm = createSessionManager({ config, registry });

      // Seed a session with an issueId but no PR
      writeMetadata(env.sessionsDir, "app-1", {
        worktree: "/tmp/mock-ws/app-1",
        branch: "feat/issue-99",
        status: "working",
        issue: "99",
        project: "my-app",
        runtimeHandle: JSON.stringify(makeHandle("rt-1")),
      });

      // Mock gh: issue is closed (full Issue shape so getIssue/isCompleted parse it)
      mockGh({
        number: 99,
        title: "test",
        body: "",
        url: "https://github.com/acme/app/issues/99",
        state: "CLOSED",
        stateReason: "COMPLETED",
        labels: [],
        assignees: [],
      });

      const result = await sm.cleanup("my-app");

      expect(result.killed).toContain("app-1");
      // Verify the gh CLI was called with the right args
      expect(ghMock).toHaveBeenCalledWith(
        expect.stringMatching(/(?:^|\/)?gh$/),
        expect.arrayContaining(["issue", "view", "99", "--repo", "acme/app"]),
        expect.any(Object),
      );
    });

    it("cleanup() skips sessions when issue is still open", async () => {
      const registry = createTestRegistry();
      const sm = createSessionManager({ config, registry });

      writeMetadata(env.sessionsDir, "app-1", {
        worktree: "/tmp/mock-ws/app-1",
        branch: "feat/issue-99",
        status: "working",
        issue: "99",
        project: "my-app",
        runtimeHandle: JSON.stringify(makeHandle("rt-1")),
      });

      // Mock gh: issue is still open (full Issue shape so getIssue/isCompleted parse it)
      mockGh({
        number: 99,
        title: "test",
        body: "",
        url: "https://github.com/acme/app/issues/99",
        state: "OPEN",
        stateReason: null,
        labels: [],
        assignees: [],
      });

      const result = await sm.cleanup("my-app");

      expect(result.skipped).toContain("app-1");
      expect(result.killed).not.toContain("app-1");
    });

    it("list() clears enrichment timeout after fast enrichment", async () => {
      vi.useFakeTimers();
      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

      const registry = createTestRegistry();
      const sm = createSessionManager({ config, registry });

      writeMetadata(env.sessionsDir, "app-1", {
        worktree: "/tmp/mock-ws/app-1",
        branch: "feat/issue-99",
        status: "working",
        project: "my-app",
        runtimeHandle: JSON.stringify(makeHandle("rt-1")),
      });

      const sessions = await sm.list("my-app");

      expect(sessions).toHaveLength(1);
      expect(clearTimeoutSpy).toHaveBeenCalled();

      clearTimeoutSpy.mockRestore();
      vi.useRealTimers();
    });
  });

  // -------------------------------------------------------------------------
  describe("SessionManager + SCM", () => {
    it("cleanup() calls scm-github getPRState() but keeps merged PR sessions alive", async () => {
      const registry = createTestRegistry();
      const sm = createSessionManager({ config, registry });

      // metadataToSession extracts PR number from the URL tail (/42),
      // and owner/repo stay empty — scm-github receives exactly that.
      writeMetadata(env.sessionsDir, "app-1", {
        worktree: "/tmp/mock-ws/app-1",
        branch: "feat/issue-99",
        status: "working",
        pr: pr.url,
        project: "my-app",
        runtimeHandle: JSON.stringify(makeHandle("rt-1")),
      });

      // Mock gh: PR is merged
      mockGh({ state: "MERGED" });

      const result = await sm.cleanup("my-app");

      expect(result.skipped).toContain("app-1");
      // Verify gh CLI was called for PR state check
      expect(ghMock).toHaveBeenCalledWith(
        expect.stringMatching(/(?:^|\/)?gh$/),
        expect.arrayContaining(["pr", "view", "42"]),
        expect.any(Object),
      );
    });

    it("cleanup() skips sessions when PR is still open", async () => {
      const registry = createTestRegistry();
      const sm = createSessionManager({ config, registry });

      writeMetadata(env.sessionsDir, "app-1", {
        worktree: "/tmp/mock-ws/app-1",
        branch: "feat/issue-99",
        status: "working",
        pr: pr.url,
        project: "my-app",
        runtimeHandle: JSON.stringify(makeHandle("rt-1")),
      });

      // Mock gh: PR is still open — runtime also alive
      mockGh({ state: "OPEN" });

      const result = await sm.cleanup("my-app");

      expect(result.skipped).toContain("app-1");
    });
  });

  // -------------------------------------------------------------------------
  describe("LifecycleManager + SCM", () => {
    let registry: PluginRegistry;
    let sm: OpenCodeSessionManager;

    beforeEach(() => {
      registry = createTestRegistry();
      sm = createSessionManager({ config, registry });
    });

    function seedSession(overrides: Partial<Session> = {}): Session {
      const session = makeSession(overrides);

      writeMetadata(env.sessionsDir, session.id, {
        worktree: session.workspacePath ?? "/tmp/test-app",
        branch: session.branch ?? "feat/issue-99",
        status: session.status,
        project: session.projectId,
        ...(session.pr ? { pr: JSON.stringify(session.pr) } : {}),
        ...(session.issueId ? { issue: session.issueId } : {}),
        runtimeHandle: JSON.stringify(session.runtimeHandle),
      });

      return session;
    }

    it("check() detects ci_failed via batch enrichment", async () => {
      seedSession({ status: "pr_open", pr });

      // Spy on the real SCM plugin's enrichSessionsPRBatch to return batch data
      const scmPlugin = registry.get("scm", "github") as ReturnType<typeof scmGithub.create>;
      const originalBatch = scmPlugin.enrichSessionsPRBatch;
      scmPlugin.enrichSessionsPRBatch = vi.fn().mockResolvedValue(
        new Map([[`${pr.owner}/${pr.repo}#${pr.number}`, {
          state: "open", ciStatus: "failing", reviewDecision: "none", mergeable: false,
          ciChecks: [{ name: "lint", status: "failed", conclusion: "FAILURE" }],
        }]]),
      );

      const mockSM: OpenCodeSessionManager = {
        ...sm,
        list: vi.fn().mockResolvedValue([makeSession({ status: "pr_open", pr })]),
        get: vi.fn().mockResolvedValue(makeSession({ status: "pr_open", pr })),
        kill: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue(undefined),
        claimPR: vi.fn(),
        spawnOrchestrator: vi.fn(),
      };

      const lm = createLifecycleManager({
        config,
        registry,
        sessionManager: mockSM,
      });

      await lm.check("app-1");
      scmPlugin.enrichSessionsPRBatch = originalBatch;

      const states = lm.getStates();
      expect(states.get("app-1")).toBe("ci_failed");
    });

    it("check() detects merged via batch enrichment", async () => {
      seedSession({ status: "pr_open", pr });

      const scmPlugin = registry.get("scm", "github") as ReturnType<typeof scmGithub.create>;
      const originalBatch = scmPlugin.enrichSessionsPRBatch;
      scmPlugin.enrichSessionsPRBatch = vi.fn().mockResolvedValue(
        new Map([[`${pr.owner}/${pr.repo}#${pr.number}`, {
          state: "merged", ciStatus: "none", reviewDecision: "none", mergeable: false,
        }]]),
      );

      const mockSM: OpenCodeSessionManager = {
        ...sm,
        list: vi.fn().mockResolvedValue([makeSession({ status: "pr_open", pr })]),
        get: vi.fn().mockResolvedValue(makeSession({ status: "pr_open", pr })),
        kill: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue(undefined),
        claimPR: vi.fn(),
        spawnOrchestrator: vi.fn(),
      };

      const lm = createLifecycleManager({
        config,
        registry,
        sessionManager: mockSM,
      });

      await lm.check("app-1");
      scmPlugin.enrichSessionsPRBatch = originalBatch;

      const states = lm.getStates();
      expect(states.get("app-1")).toBe("merged");
    });

    it("check() detects changes_requested via batch enrichment", async () => {
      seedSession({ status: "pr_open", pr });

      const scmPlugin = registry.get("scm", "github") as ReturnType<typeof scmGithub.create>;
      const originalBatch = scmPlugin.enrichSessionsPRBatch;
      scmPlugin.enrichSessionsPRBatch = vi.fn().mockResolvedValue(
        new Map([[`${pr.owner}/${pr.repo}#${pr.number}`, {
          state: "open", ciStatus: "passing", reviewDecision: "changes_requested", mergeable: false,
        }]]),
      );

      const mockSM: OpenCodeSessionManager = {
        ...sm,
        list: vi.fn().mockResolvedValue([makeSession({ status: "pr_open", pr })]),
        get: vi.fn().mockResolvedValue(makeSession({ status: "pr_open", pr })),
        kill: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue(undefined),
        claimPR: vi.fn(),
        spawnOrchestrator: vi.fn(),
      };

      const lm = createLifecycleManager({
        config,
        registry,
        sessionManager: mockSM,
      });

      await lm.check("app-1");
      scmPlugin.enrichSessionsPRBatch = originalBatch;

      const states = lm.getStates();
      expect(states.get("app-1")).toBe("changes_requested");
    });
  });
});
