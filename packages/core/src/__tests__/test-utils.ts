import { vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { getProjectSessionsDir, getProjectDir } from "../paths.js";
import { resetOpenCodeSessionListCache } from "../session-manager.js";
import { createInitialCanonicalLifecycle, deriveLegacyStatus } from "../lifecycle-state.js";
import { createActivitySignal } from "../activity-signal.js";
import type {
  OrchestratorConfig,
  PluginRegistry,
  OpenCodeSessionManager,
  Session,
  Runtime,
  RuntimeHandle,
  Agent,
  Workspace,
  SCM,
  Notifier,
  ActivityState,
  PRInfo,
} from "../types.js";

// ---------------------------------------------------------------------------
// Data factories
// ---------------------------------------------------------------------------

export function makeHandle(id: string): RuntimeHandle {
  return { id, runtimeName: "mock", data: {} };
}

export function makeSession(overrides: Partial<Session> = {}): Session {
  const lifecycle = createInitialCanonicalLifecycle("worker", new Date());
  const requestedStatus = overrides.status ?? "working";
  switch (requestedStatus) {
    case "spawning":
      lifecycle.session.state = "not_started";
      lifecycle.session.reason = "spawn_requested";
      break;
    case "needs_input":
      lifecycle.session.state = "needs_input";
      lifecycle.session.reason = "awaiting_user_input";
      lifecycle.session.startedAt = lifecycle.session.lastTransitionAt;
      break;
    case "stuck":
      lifecycle.session.state = "stuck";
      lifecycle.session.reason = "probe_failure";
      lifecycle.session.startedAt = lifecycle.session.lastTransitionAt;
      break;
    case "errored":
      lifecycle.session.state = "terminated";
      lifecycle.session.reason = "error_in_process";
      lifecycle.session.startedAt = lifecycle.session.lastTransitionAt;
      lifecycle.session.terminatedAt = lifecycle.session.lastTransitionAt;
      lifecycle.runtime.state = "missing";
      lifecycle.runtime.reason = "process_missing";
      break;
    case "merged":
      lifecycle.session.state = "idle";
      lifecycle.session.reason = "merged_waiting_decision";
      lifecycle.session.startedAt = lifecycle.session.lastTransitionAt;
      lifecycle.pr.state = "merged";
      lifecycle.pr.reason = "merged";
      break;
    case "done":
      lifecycle.session.state = "done";
      lifecycle.session.reason = "research_complete";
      lifecycle.session.startedAt = lifecycle.session.lastTransitionAt;
      lifecycle.session.completedAt = lifecycle.session.lastTransitionAt;
      break;
    case "killed":
    case "terminated":
    case "cleanup":
      lifecycle.session.state = "terminated";
      lifecycle.session.reason = "manually_killed";
      lifecycle.session.startedAt = lifecycle.session.lastTransitionAt;
      lifecycle.session.terminatedAt = lifecycle.session.lastTransitionAt;
      lifecycle.runtime.state = "missing";
      lifecycle.runtime.reason = "manual_kill_requested";
      break;
    default:
      lifecycle.session.state = "working";
      lifecycle.session.reason = "task_in_progress";
      lifecycle.session.startedAt = lifecycle.session.lastTransitionAt;
      break;
  }
  if (lifecycle.session.state !== "terminated") {
    lifecycle.runtime.state = "alive";
    lifecycle.runtime.reason = "process_running";
  }
  lifecycle.runtime.handle = { id: "rt-1", runtimeName: "mock", data: {} };
  const base: Session = {
    id: "app-1",
    projectId: "my-app",
    status: deriveLegacyStatus(lifecycle),
    activity: "active",
    activitySignal: createActivitySignal("valid", {
      activity: "active",
      timestamp: new Date(),
      source: "native",
    }),
    lifecycle,
    branch: "feat/test",
    issueId: null,
    pr: null,
    workspacePath: "/tmp/ws",
    runtimeHandle: { id: "rt-1", runtimeName: "mock", data: {} },
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
  };
  return {
    ...base,
    ...overrides,
    lifecycle: overrides.lifecycle ?? lifecycle,
  };
}

export function makePR(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 42,
    url: "https://github.com/org/my-app/pull/42",
    title: "Fix things",
    owner: "org",
    repo: "my-app",
    branch: "feat/test",
    baseBranch: "main",
    isDraft: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock plugin factories
// ---------------------------------------------------------------------------

export interface MockPlugins {
  runtime: Runtime;
  agent: Agent;
  workspace: Workspace;
}

export function createMockPlugins(): MockPlugins {
  const runtime: Runtime = {
    name: "mock",
    create: vi.fn().mockResolvedValue({ id: "rt-1", runtimeName: "mock", data: {} }),
    destroy: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    getOutput: vi.fn().mockResolvedValue("$ some terminal output\n"),
    isAlive: vi.fn().mockResolvedValue(true),
  };

  const agent: Agent = {
    name: "mock-agent",
    processName: "mock",
    getLaunchCommand: vi.fn().mockReturnValue("mock-agent --start"),
    getEnvironment: vi.fn().mockReturnValue({ AGENT_VAR: "1" }),
    detectActivity: vi.fn().mockReturnValue("active" as ActivityState),
    getActivityState: vi.fn().mockResolvedValue({ state: "active" as ActivityState }),
    isProcessRunning: vi.fn().mockResolvedValue(true),
    getSessionInfo: vi.fn().mockResolvedValue(null),
  };

  const workspace: Workspace = {
    name: "mock-ws",
    create: vi.fn().mockResolvedValue({
      path: "/tmp/ws",
      branch: "feat/test",
      sessionId: "app-1",
      projectId: "my-app",
    }),
    destroy: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    findManagedWorkspace: vi.fn().mockResolvedValue(null),
  };

  return { runtime, agent, workspace };
}

export function createMockSCM(overrides: Partial<SCM> = {}): SCM {
  const scm: SCM = {
    name: "github",
    detectPR: vi.fn().mockResolvedValue(null),
    getPRState: vi.fn().mockResolvedValue("open"),
    mergePR: vi.fn().mockResolvedValue(undefined),
    closePR: vi.fn().mockResolvedValue(undefined),
    getCIChecks: vi.fn().mockResolvedValue([]),
    getCISummary: vi.fn().mockResolvedValue("passing"),
    getReviews: vi.fn().mockResolvedValue([]),
    getReviewDecision: vi.fn().mockResolvedValue("none"),
    getPendingComments: vi.fn().mockResolvedValue([]),
    getReviewThreads: vi.fn().mockResolvedValue({ threads: [], reviews: [] }),
    getMergeability: vi.fn().mockResolvedValue({
      mergeable: false,
      ciPassing: true,
      approved: false,
      noConflicts: true,
      blockers: [],
    }),
    // Default batch mock: resolves individual method mocks at call time
    // so tests that override getPRState/getCISummary/etc. automatically
    // get matching batch enrichment without explicit enrichSessionsPRBatch.
    enrichSessionsPRBatch: vi.fn().mockImplementation(async (prs: PRInfo[]) => {
      const result = new Map();
      for (const pr of prs) {
        const [state, ciStatus, reviewDecision, mergeability, ciChecks] = await Promise.all([
          scm.getPRState(pr),
          scm.getCISummary(pr),
          scm.getReviewDecision(pr),
          scm.getMergeability(pr),
          scm.getCIChecks(pr),
        ]);
        result.set(`${pr.owner}/${pr.repo}#${pr.number}`, {
          state: state ?? "open",
          ciStatus: ciStatus ?? "passing",
          reviewDecision: reviewDecision ?? "none",
          mergeable: mergeability?.mergeable ?? false,
          hasConflicts: mergeability ? !mergeability.noConflicts : false,
          ciChecks: ciChecks ?? [],
        });
      }
      return result;
    }),
    ...overrides,
  };
  return scm;
}

export function createMockNotifier(): Notifier {
  return {
    name: "desktop",
    notify: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Registry factory
// ---------------------------------------------------------------------------

export interface RegistryPlugins {
  runtime: Runtime;
  agent: Agent;
  workspace?: Workspace;
  scm?: SCM;
  notifier?: Notifier;
}

export function createMockRegistry(
  plugins: RegistryPlugins,
  options: { strict?: boolean } = {},
): PluginRegistry {
  return {
    register: vi.fn(),
    get: vi.fn().mockImplementation((slot: string, name?: string) => {
      // Check for exact name match first
      if (slot === "runtime") {
        if (!name || name === plugins.runtime.name) return plugins.runtime;
        if (!options.strict) return plugins.runtime;
      }
      if (slot === "agent") {
        if (!name || name === plugins.agent.name) return plugins.agent;
        if (!options.strict) return plugins.agent;
      }
      if (slot === "workspace" && plugins.workspace) {
        if (!name || name === plugins.workspace.name) return plugins.workspace;
        if (!options.strict) return plugins.workspace;
      }
      if (slot === "scm" && plugins.scm) {
        if (!name || name === plugins.scm.name) return plugins.scm;
        if (!options.strict) return plugins.scm;
      }
      if (slot === "notifier" && plugins.notifier) {
        if (!name || name === plugins.notifier.name) return plugins.notifier;
        if (!options.strict) return plugins.notifier;
      }

      return null;
    }),
    list: vi.fn().mockReturnValue([]),
    loadBuiltins: vi.fn(),
    loadFromConfig: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Test environment
// ---------------------------------------------------------------------------

export interface TestEnvironment {
  tmpDir: string;
  configPath: string;
  sessionsDir: string;
  config: OrchestratorConfig;
  cleanup: () => void;
}

export function createTestEnvironment(): TestEnvironment {
  const tmpDir = join(tmpdir(), `ao-test-lifecycle-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });
  const previousHome = process.env["HOME"];
  process.env["HOME"] = tmpDir;

  const configPath = join(tmpDir, "agent-orchestrator.yaml");
  writeFileSync(configPath, "projects: {}\n");

  const config: OrchestratorConfig = {
    configPath,
    port: 3000,
    power: { preventIdleSleep: false },
    defaults: {
      runtime: "mock",
      agent: "mock-agent",
      workspace: "mock-ws",
      notifiers: ["desktop"],
    },
    projects: {
      "my-app": {
        name: "My App",
        repo: "org/my-app",
        path: join(tmpDir, "my-app"),
        defaultBranch: "main",
        sessionPrefix: "app",
        scm: { plugin: "github" },
      },
    },
    notifiers: {},
    notificationRouting: {
      urgent: ["desktop"],
      action: ["desktop"],
      warning: [],
      info: [],
    },
    reactions: {},
    readyThresholdMs: 300_000,
  };

  const sessionsDir = getProjectSessionsDir("my-app");
  mkdirSync(sessionsDir, { recursive: true });

  const cleanup = () => {
    if (previousHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = previousHome;
    }
    const projectDir = getProjectDir("my-app");
    if (existsSync(projectDir)) {
      rmSync(projectDir, { recursive: true, force: true });
    }
    rmSync(tmpDir, { recursive: true, force: true });
  };

  return { tmpDir, configPath, sessionsDir, config, cleanup };
}

// ---------------------------------------------------------------------------
// Test context (for session-manager tests)
// ---------------------------------------------------------------------------

export interface TestContext {
  tmpDir: string;
  configPath: string;
  sessionsDir: string;
  mockRuntime: Runtime;
  mockAgent: Agent;
  mockWorkspace: Workspace;
  mockRegistry: PluginRegistry;
  config: OrchestratorConfig;
  originalPath: string | undefined;
  originalHome: string | undefined;
}

export function setupTestContext(): TestContext {
  resetOpenCodeSessionListCache();
  const originalPath = process.env.PATH;
  const originalHome = process.env["HOME"];
  const tmpDir = join(tmpdir(), `ao-test-session-mgr-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });
  process.env["HOME"] = tmpDir;

  const configPath = join(tmpDir, "agent-orchestrator.yaml");
  writeFileSync(configPath, "projects: {}\n");

  const { runtime: mockRuntime, agent: mockAgent, workspace: mockWorkspace } = createMockPlugins();
  const mockRegistry = createMockRegistry({
    runtime: mockRuntime,
    agent: mockAgent,
    workspace: mockWorkspace,
  });

  const config: OrchestratorConfig = {
    configPath,
    port: 3000,
    power: { preventIdleSleep: false },
    defaults: {
      runtime: "mock",
      agent: "mock-agent",
      workspace: "mock-ws",
      notifiers: ["desktop"],
    },
    projects: {
      "my-app": {
        name: "My App",
        repo: "org/my-app",
        path: join(tmpDir, "my-app"),
        defaultBranch: "main",
        sessionPrefix: "app",
        scm: { plugin: "github" },
        tracker: { plugin: "github" },
      },
    },
    notifiers: {},
    notificationRouting: {
      urgent: ["desktop"],
      action: ["desktop"],
      warning: [],
      info: [],
    },
    reactions: {},
    readyThresholdMs: 300_000,
  };

  const sessionsDir = getProjectSessionsDir("my-app");
  mkdirSync(sessionsDir, { recursive: true });

  return {
    tmpDir,
    configPath,
    sessionsDir,
    mockRuntime,
    mockAgent,
    mockWorkspace,
    mockRegistry,
    config,
    originalPath,
    originalHome,
  };
}

export function teardownTestContext(ctx: TestContext): void {
  process.env.PATH = ctx.originalPath;
  if (ctx.originalHome === undefined) {
    delete process.env["HOME"];
  } else {
    process.env["HOME"] = ctx.originalHome;
  }
  const projectDir = getProjectDir("my-app");
  if (existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
  rmSync(ctx.tmpDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Session manager mock
// ---------------------------------------------------------------------------

export function createMockSessionManager(): OpenCodeSessionManager {
  return {
    spawn: vi.fn().mockResolvedValue(makeSession()),
    spawnOrchestrator: vi
      .fn()
      .mockResolvedValue(
        makeSession({ id: "app-orchestrator", metadata: { role: "orchestrator" } }),
      ),
    ensureOrchestrator: vi
      .fn()
      .mockResolvedValue(
        makeSession({ id: "app-orchestrator", metadata: { role: "orchestrator" } }),
      ),
    restore: vi.fn().mockResolvedValue(makeSession()),
    list: vi.fn().mockResolvedValue([]),
    listCached: vi.fn().mockResolvedValue([]),
    invalidateCache: vi.fn(),
    remap: vi.fn().mockResolvedValue("app-1"),
    get: vi.fn().mockResolvedValue(null),
    kill: vi.fn().mockResolvedValue({ cleaned: true, alreadyTerminated: false }),
    cleanup: vi.fn().mockResolvedValue({ killed: [], skipped: [], errors: [] }),
    send: vi.fn().mockResolvedValue(undefined),
    claimPR: vi.fn().mockResolvedValue({
      sessionId: "app-1",
      projectId: "my-app",
      pr: makePR(),
      branchChanged: false,
      githubAssigned: true,
      takenOverFrom: [],
    }),
  } as OpenCodeSessionManager;
}
