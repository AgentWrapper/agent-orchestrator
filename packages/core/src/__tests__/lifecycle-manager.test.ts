import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLifecycleManager } from "../lifecycle-manager.js";
import { recordActivityEvent } from "../activity-events.js";
import { DEFAULT_BUGBOT_COMMENTS_MESSAGE } from "../config.js";
import {
  resolvePREnrichmentDecision,
  resolvePRLiveDecision,
  resolveProbeDecision,
} from "../lifecycle-status-decisions.js";
import { createSessionManager } from "../session-manager.js";
import { writeMetadata, readMetadataRaw } from "../metadata.js";
import { readObservabilitySummary } from "../observability.js";
import type {
  OrchestratorConfig,
  PluginRegistry,
  OpenCodeSessionManager,
  Agent,
  ActivityState,
  SessionStatus,
  SessionMetadata,
  PRInfo,
} from "../types.js";
import {
  createTestEnvironment,
  createMockPlugins,
  createMockRegistry,
  createMockSessionManager,
  createMockSCM,
  createMockNotifier,
  makeSession,
  makePR,
  type TestEnvironment,
  type MockPlugins,
} from "./test-utils.js";

vi.mock("../activity-events.js", () => ({
  recordActivityEvent: vi.fn(),
}));

let env: TestEnvironment;
let plugins: MockPlugins;
let mockRegistry: PluginRegistry;
let mockSessionManager: OpenCodeSessionManager;
let config: OrchestratorConfig;

beforeEach(() => {
  env = createTestEnvironment();
  plugins = createMockPlugins();
  mockRegistry = createMockRegistry({ runtime: plugins.runtime, agent: plugins.agent });
  mockSessionManager = createMockSessionManager();
  config = env.config;
  vi.mocked(recordActivityEvent).mockClear();
});

afterEach(() => {
  env.cleanup();
});

describe("status decision helpers", () => {
  it("promotes conflicting runtime evidence into detecting instead of terminating", () => {
    const decision = resolveProbeDecision({
      currentAttempts: 1,
      runtimeProbe: { state: "dead", failed: false },
      processProbe: { state: "alive", failed: false },
      canProbeRuntimeIdentity: true,
      activitySignal: {
        state: "valid",
        activity: "active",
        timestamp: new Date(),
        source: "native",
      },
      activityEvidence: "activity_signal=valid via_native activity=active",
      idleWasBlocked: false,
    });

    expect(decision).toEqual(
      expect.objectContaining({
        status: "detecting",
        sessionState: "detecting",
        sessionReason: "runtime_lost",
        detecting: expect.objectContaining({ attempts: 2 }),
      }),
    );
  });

  it("maps merged enrichment data to merged lifecycle state", () => {
    const decision = resolvePREnrichmentDecision(
      {
        state: "merged",
        ciStatus: "none",
        reviewDecision: "none",
        mergeable: false,
      },
      {
        shouldEscalateIdleToStuck: false,
        idleWasBlocked: false,
        activityEvidence: "activity_signal=valid",
      },
    );

    expect(decision).toEqual(
      expect.objectContaining({
        status: "merged",
        prState: "merged",
        prReason: "merged",
        sessionState: "idle",
        sessionReason: "merged_waiting_decision",
      }),
    );
  });

  it("maps live PR checks to review_pending without mutating other state", () => {
    const decision = resolvePRLiveDecision({
      prState: "open",
      ciStatus: "passing",
      reviewDecision: "pending",
      mergeable: false,
      shouldEscalateIdleToStuck: false,
      idleWasBlocked: false,
      activityEvidence: "activity_signal=valid",
    });

    expect(decision).toEqual(
      expect.objectContaining({
        status: "review_pending",
        prState: "open",
        prReason: "review_pending",
        sessionState: "idle",
        sessionReason: "awaiting_external_review",
      }),
    );
  });
});

/** Helper: write standard session metadata and return a lifecycle manager */
function setupCheck(
  sessionId: string,
  opts: {
    session: ReturnType<typeof makeSession>;
    metaOverrides?: Record<string, unknown>;
    registry?: PluginRegistry;
    configOverride?: OrchestratorConfig;
  },
) {
  const persistedMetadata = {
    worktree: "/tmp",
    branch: opts.session.branch ?? "main",
    status: opts.session.status,
    project: "my-app",
    runtimeHandle: opts.session.runtimeHandle ?? undefined,
    ...opts.metaOverrides,
  };
  const persistedStringMetadata = Object.fromEntries(
    Object.entries(persistedMetadata).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

  vi.mocked(mockSessionManager.get).mockResolvedValue({
    ...opts.session,
    metadata: {
      ...opts.session.metadata,
      ...persistedStringMetadata,
    },
  });

  writeMetadata(env.sessionsDir, sessionId, persistedMetadata as unknown as SessionMetadata);

  return createLifecycleManager({
    config: opts.configOverride ?? config,
    registry: opts.registry ?? mockRegistry,
    sessionManager: mockSessionManager,
  });
}

/** Create a PR whose owner/repo matches the test config's "org/my-app". */
function makeMatchingPR(overrides: Partial<PRInfo> = {}): PRInfo {
  return makePR({ owner: "org", repo: "my-app", ...overrides });
}

/** Build a batch enrichment mock that returns the given data for any PR. */
function mockBatchEnrichment(data: {
  state?: string;
  ciStatus?: string;
  reviewDecision?: string;
  mergeable?: boolean;
  hasConflicts?: boolean;
  ciChecks?: Array<{ name: string; status: string; conclusion?: string; url?: string }>;
}) {
  return vi.fn().mockImplementation(async (prs: PRInfo[]) => {
    const result = new Map();
    for (const p of prs) {
      result.set(`${p.owner}/${p.repo}#${p.number}`, {
        state: data.state ?? "open",
        ciStatus: data.ciStatus ?? "passing",
        reviewDecision: data.reviewDecision ?? "none",
        mergeable: data.mergeable ?? false,
        ...(data.hasConflicts !== undefined ? { hasConflicts: data.hasConflicts } : {}),
        ...(data.ciChecks !== undefined ? { ciChecks: data.ciChecks } : {}),
      });
    }
    return result;
  });
}

/**
 * Helper: set up a session with PR and run a pollAll cycle so the batch
 * enrichment cache is populated. Returns the lifecycle manager.
 *
 * Must be called inside a test that uses vi.useFakeTimers().
 */
function setupPollCheck(
  sessionId: string,
  opts: {
    session: ReturnType<typeof makeSession>;
    metaOverrides?: Record<string, unknown>;
    registry?: PluginRegistry;
    configOverride?: OrchestratorConfig;
  },
) {
  const persistedMetadata: Record<string, unknown> = {
    worktree: "/tmp",
    branch: opts.session.branch ?? "main",
    status: opts.session.status,
    project: "my-app",
    runtimeHandle: opts.session.runtimeHandle ?? undefined,
    ...opts.metaOverrides,
  };
  const persistedStringMetadata = Object.fromEntries(
    Object.entries(persistedMetadata).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

  const enrichedSession = {
    ...opts.session,
    metadata: {
      ...opts.session.metadata,
      ...persistedStringMetadata,
    },
  };

  vi.mocked(mockSessionManager.list).mockResolvedValue([enrichedSession]);
  vi.mocked(mockSessionManager.get).mockResolvedValue(enrichedSession);

  writeMetadata(env.sessionsDir, sessionId, persistedMetadata as unknown as SessionMetadata);

  return createLifecycleManager({
    config: opts.configOverride ?? config,
    registry: opts.registry ?? mockRegistry,
    sessionManager: mockSessionManager,
  });
}

describe("start / stop", () => {
  it("starts and stops the polling loop", () => {
    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    lm.start(60_000);
    // Should not throw on double start
    lm.start(60_000);
    lm.stop();
    // Should not throw on double stop
    lm.stop();
  });
});

describe("check (single session)", () => {
  it("detects transition from spawning to working", async () => {
    const lm = setupCheck("app-1", {
      session: makeSession({ status: "spawning" }),
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("working");
    const meta = readMetadataRaw(env.sessionsDir, "app-1");
    expect(meta!["status"]).toBe("working");
  });

  it("records lifecycle.transition when status changes", async () => {
    const lm = setupCheck("app-1", {
      session: makeSession({ status: "spawning" }),
    });

    await lm.check("app-1");

    expect(recordActivityEvent).toHaveBeenCalledWith({
      projectId: "my-app",
      sessionId: "app-1",
      source: "lifecycle",
      kind: "lifecycle.transition",
      level: "info",
      summary: "spawning → working",
      data: { from: "spawning", to: "working" },
    });
  });

  it("records activity.transition after observed activity changes", async () => {
    const session = makeSession({ id: "app-activity", status: "working" });
    const lm = setupCheck("app-activity", { session });

    await lm.check("app-activity");
    vi.mocked(recordActivityEvent).mockClear();
    vi.mocked(plugins.agent.getActivityState).mockResolvedValue({ state: "idle" });

    await lm.check("app-activity");

    expect(recordActivityEvent).toHaveBeenCalledWith({
      projectId: "my-app",
      sessionId: "app-activity",
      source: "lifecycle",
      kind: "activity.transition",
      summary: "active → idle",
      data: { from: "active", to: "idle" },
    });
  });

  it("records split lifecycle observability for transitions", async () => {
    const lm = setupCheck("app-1", {
      session: makeSession({ status: "spawning" }),
    });

    await lm.check("app-1");

    const summary = readObservabilitySummary(config);
    const trace = summary.projects["my-app"]?.recentTraces.find(
      (entry) => entry.operation === "lifecycle.transition" && entry.sessionId === "app-1",
    );

    expect(trace?.reason).toBe("task_in_progress");
    expect(trace?.data).toMatchObject({
      oldStatus: "spawning",
      newStatus: "working",
      previousSessionState: "not_started",
      newSessionState: "working",
      previousPRState: "none",
      newPRState: "none",
      previousRuntimeState: "alive",
      newRuntimeState: "alive",
      primaryReason: "task_in_progress",
      evidence: "activity_signal=valid via_native activity=active",
      signalsConsulted: ["activity_signal=valid", "via_native", "activity=active"],
      recoveryAction: null,
    });
  });

  it("does not mirror lifecycle transition observability logs to stderr during polling", async () => {
    const originalAoObservabilityStderr = process.env["AO_OBSERVABILITY_STDERR"];
    delete process.env["AO_OBSERVABILITY_STDERR"];

    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    try {
      const lm = setupCheck("app-1", {
        session: makeSession({ status: "spawning" }),
      });

      await lm.check("app-1");

      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
      if (originalAoObservabilityStderr === undefined) {
        delete process.env["AO_OBSERVABILITY_STDERR"];
      } else {
        process.env["AO_OBSERVABILITY_STDERR"] = originalAoObservabilityStderr;
      }
    }
  });

  it("clears stale lifecycle compatibility metadata in memory and on disk", async () => {
    const session = makeSession({
      status: "working",
      lifecycle: {
        ...makeSession().lifecycle,
        pr: {
          state: "none",
          reason: "not_created",
          number: null,
          url: null,
          lastObservedAt: null,
        },
        runtime: {
          state: "alive",
          reason: "process_running",
          lastObservedAt: null,
          handle: null,
          tmuxName: null,
        },
      },
      runtimeHandle: null,
      pr: null,
      metadata: {
        pr: "https://github.com/org/repo/pull/42",
        runtimeHandle: JSON.stringify({ id: "stale", runtimeName: "mock", data: {} }),
        tmuxName: "stale-tmux",
        role: "orchestrator",
      },
    });
    const staleHandle = { id: "stale", runtimeName: "mock", data: {} };
    const persistedMetadata = {
      worktree: "/tmp",
      branch: session.branch ?? "main",
      status: session.status,
      project: "my-app",
      pr: "https://github.com/org/repo/pull/42",
      runtimeHandle: staleHandle,
      tmuxName: "stale-tmux",
      role: "orchestrator",
    };
    const currentSession = {
      ...session,
      metadata: {
        ...session.metadata,
        ...persistedMetadata,
        runtimeHandle: JSON.stringify(staleHandle),
      },
    };

    vi.mocked(mockSessionManager.get).mockResolvedValue(currentSession);
    writeMetadata(env.sessionsDir, "app-1", persistedMetadata);

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    const metadata = readMetadataRaw(env.sessionsDir, "app-1");
    expect(metadata?.["pr"]).toBeUndefined();
    expect(metadata?.["runtimeHandle"]).toBeUndefined();
    expect(metadata?.["tmuxName"]).toBeUndefined();
    expect(metadata?.["role"]).toBeUndefined();
    expect(currentSession.metadata["pr"]).toBeUndefined();
    expect(currentSession.metadata["runtimeHandle"]).toBeUndefined();
    expect(currentSession.metadata["tmuxName"]).toBeUndefined();
    expect(currentSession.metadata["role"]).toBeUndefined();
  });

  it("does not kill a spawning session when its runtime handle has not been persisted yet", async () => {
    vi.mocked(plugins.runtime.isAlive).mockResolvedValue(false);

    const lm = setupCheck("app-1", {
      session: makeSession({
        status: "spawning",
        runtimeHandle: { id: "app-1", runtimeName: "mock", data: {} },
        metadata: {},
      }),
      metaOverrides: {
        runtimeHandle: undefined,
        tmuxName: undefined,
      },
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("working");
    expect(plugins.runtime.isAlive).not.toHaveBeenCalled();
  });

  it("does not kill a spawning session even when runtimeHandle IS persisted in metadata (#1035)", async () => {
    vi.mocked(plugins.runtime.isAlive).mockResolvedValue(false);

    const lm = setupCheck("app-1", {
      session: makeSession({
        status: "spawning",
        runtimeHandle: { id: "app-1", runtimeName: "mock", data: {} },
        metadata: {},
      }),
      // runtimeHandle IS in metadata — this is the production scenario
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("working");
    expect(plugins.runtime.isAlive).not.toHaveBeenCalled();
  });

  it("does not kill a spawning session when agent reports exited activity (#1035)", async () => {
    vi.mocked(plugins.agent.getActivityState).mockResolvedValue({
      state: "exited" as ActivityState,
      timestamp: new Date(),
    });

    const lm = setupCheck("app-1", {
      session: makeSession({
        status: "spawning",
        runtimeHandle: { id: "app-1", runtimeName: "mock", data: {} },
        metadata: {},
      }),
    });

    await lm.check("app-1");

    // Should transition to working, not killed
    expect(lm.getStates().get("app-1")).toBe("working");
  });

  it("still probes a working session when it relies on a synthesized runtime handle", async () => {
    vi.mocked(plugins.runtime.isAlive).mockResolvedValue(false);

    const lm = setupCheck("app-1", {
      session: makeSession({
        status: "working",
        runtimeHandle: { id: "app-1", runtimeName: "mock", data: {} },
        metadata: {},
      }),
      metaOverrides: {
        runtimeHandle: undefined,
        tmuxName: undefined,
      },
    });

    await lm.check("app-1");

    expect(plugins.runtime.isAlive).toHaveBeenCalledWith({
      id: "app-1",
      runtimeName: "mock",
      data: {},
    });
    expect(lm.getStates().get("app-1")).toBe("detecting");
  });

  it("uses worker-specific agent fallback when metadata does not persist an agent", async () => {
    const codexAgent: Agent = {
      ...plugins.agent,
      name: "codex",
      processName: "codex",
      getActivityState: vi.fn().mockResolvedValue({ state: "active" as ActivityState }),
    };

    const registryWithMultipleAgents: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return plugins.runtime;
        if (slot === "agent") {
          if (name === "codex") return codexAgent;
          if (name === "mock-agent") return plugins.agent;
        }
        return null;
      }),
    };

    const configWithWorkerAgent: OrchestratorConfig = {
      ...config,
      projects: {
        ...config.projects,
        "my-app": {
          ...config.projects["my-app"],
          agent: "mock-agent",
          worker: { agent: "codex" },
        },
      },
    };

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "working", metadata: {} }),
      registry: registryWithMultipleAgents,
      configOverride: configWithWorkerAgent,
    });

    await lm.check("app-1");

    expect(codexAgent.getActivityState).toHaveBeenCalled();
    expect(plugins.agent.getActivityState).not.toHaveBeenCalled();
  });

  it("detects killed state when runtime is dead", async () => {
    vi.mocked(plugins.runtime.isAlive).mockResolvedValue(false);
    vi.mocked(plugins.agent.getActivityState).mockResolvedValue({ state: "idle" });
    vi.mocked(plugins.agent.isProcessRunning).mockResolvedValue(false);

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "working" }),
    });

    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("killed");
  });

  it("detects killed state when getActivityState returns exited", async () => {
    vi.mocked(plugins.agent.getActivityState).mockResolvedValue({ state: "exited" });
    vi.mocked(plugins.runtime.isAlive).mockResolvedValue(true);

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "working" }),
    });

    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("detecting");
  });

  it("detects killed via terminal fallback when getActivityState returns null", async () => {
    vi.mocked(plugins.agent.getActivityState).mockResolvedValue(null);
    vi.mocked(plugins.agent.detectActivity).mockReturnValue("idle");
    vi.mocked(plugins.runtime.isAlive).mockResolvedValue(false);
    vi.mocked(plugins.agent.isProcessRunning).mockResolvedValue(false);

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "working" }),
    });

    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("killed");
  });

  it("enters detecting when runtime is dead but recent activity is still fresh", async () => {
    vi.mocked(plugins.runtime.isAlive).mockResolvedValue(false);
    vi.mocked(plugins.agent.getActivityState).mockResolvedValue({
      state: "active",
      timestamp: new Date(Date.now() - 30_000),
    });
    vi.mocked(plugins.agent.isProcessRunning).mockResolvedValue(false);

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "working" }),
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("detecting");
    const meta = readMetadataRaw(env.sessionsDir, "app-1");
    expect(meta?.["detectingAttempts"]).toBe("1");
    expect(meta?.["lifecycleEvidence"]).toContain("signal_disagreement");
  });

  it("enters detecting when runtime is dead but process state is unknown", async () => {
    const registryWithoutAgent = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
    });
    vi.mocked(registryWithoutAgent.get).mockImplementation((slot: string, _name?: string) => {
      if (slot === "runtime") return plugins.runtime;
      if (slot === "agent") return null;
      return null;
    });
    vi.mocked(plugins.runtime.isAlive).mockResolvedValue(false);

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "working" }),
      registry: registryWithoutAgent,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("detecting");
    const meta = readMetadataRaw(env.sessionsDir, "app-1");
    expect(meta?.["lifecycleEvidence"]).toContain("runtime_dead process_unknown");
    expect(meta?.["detectingAttempts"]).toBe("1");
  });

  it("escalates detecting to stuck after bounded retries", async () => {
    vi.mocked(plugins.runtime.isAlive).mockResolvedValue(false);
    vi.mocked(plugins.agent.getActivityState).mockResolvedValue({
      state: "active",
      timestamp: new Date(Date.now() - 30_000),
    });
    vi.mocked(plugins.agent.isProcessRunning).mockResolvedValue(false);

    const lm = setupCheck("app-1", {
      session: makeSession({
        status: "detecting",
        metadata: { detectingAttempts: "3" },
      }),
      metaOverrides: {
        detectingAttempts: "3",
      },
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("stuck");
    const meta = readMetadataRaw(env.sessionsDir, "app-1");
    expect(meta?.["detectingAttempts"]).toBe("4");
    expect(meta?.["detectingEscalatedAt"]).toBeDefined();
  });

  it("stays working when agent is idle but process is still running (fallback path)", async () => {
    vi.mocked(plugins.agent.getActivityState).mockResolvedValue(null);
    vi.mocked(plugins.agent.detectActivity).mockReturnValue("idle");
    vi.mocked(plugins.agent.isProcessRunning).mockResolvedValue(true);

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "working" }),
    });

    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("working");
  });

  it("leaves lifecycle metadata untouched when process probe is indeterminate", async () => {
    vi.mocked(plugins.runtime.isAlive).mockResolvedValue(true);
    vi.mocked(plugins.agent.getActivityState).mockResolvedValue(null);
    vi.mocked(plugins.agent.isProcessRunning).mockResolvedValue("indeterminate");

    const session = makeSession({
      status: "working",
      workspacePath: null,
      metadata: {
        lifecycleEvidence: "previous_evidence",
        detectingAttempts: "2",
      },
    });
    const lifecycle = JSON.stringify(session.lifecycle);
    const lm = setupCheck("app-1", {
      session,
      metaOverrides: {
        lifecycle,
        lifecycleEvidence: "previous_evidence",
        detectingAttempts: "2",
      },
    });
    const before = readMetadataRaw(env.sessionsDir, "app-1");

    await lm.check("app-1");

    expect(readMetadataRaw(env.sessionsDir, "app-1")).toEqual(before);
    expect(lm.getStates().get("app-1")).toBe("working");
  });

  it("does not mark a session stuck from terminal-only idle evidence without a timestamp", async () => {
    config.reactions = {
      "agent-stuck": { auto: true, action: "notify", threshold: "1m" },
    };

    vi.mocked(plugins.agent.getActivityState).mockResolvedValue(null);
    vi.mocked(plugins.agent.detectActivity).mockReturnValue("idle");
    vi.mocked(plugins.agent.isProcessRunning).mockResolvedValue(true);

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "working" }),
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("working");
    const meta = readMetadataRaw(env.sessionsDir, "app-1");
    expect(meta?.["lifecycleEvidence"]).toContain("activity_signal=stale");
    expect(meta?.["lifecycleEvidence"]).toContain("activity=idle");
  });

  it("does not treat stale activity as recent liveness evidence during runtime-loss detection", async () => {
    vi.mocked(plugins.runtime.isAlive).mockResolvedValue(false);
    vi.mocked(plugins.agent.getActivityState).mockResolvedValue({
      state: "active",
      timestamp: new Date(Date.now() - 10 * 60_000),
    });
    vi.mocked(plugins.agent.isProcessRunning).mockResolvedValue(false);

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "working" }),
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("killed");
    const meta = readMetadataRaw(env.sessionsDir, "app-1");
    expect(meta?.["lifecycleEvidence"]).toContain("activity_signal=stale");
  });

  it("records explicit probe-failure activity evidence", async () => {
    vi.mocked(plugins.agent.getActivityState).mockRejectedValue(new Error("boom"));

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "working" }),
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("detecting");
    const meta = readMetadataRaw(env.sessionsDir, "app-1");
    expect(meta?.["lifecycleEvidence"]).toContain("activity_signal=probe_failure");
  });

  it("degrades stuck probe-failure sessions to detecting when runtime is alive but activity is unavailable", async () => {
    const registryWithoutAgent: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return plugins.runtime;
        return null;
      }),
    };

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "stuck" }),
      registry: registryWithoutAgent,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("detecting");
    const meta = readMetadataRaw(env.sessionsDir, "app-1");
    expect(meta?.["lifecycleEvidence"]).toContain("activity_signal=unavailable");
  });

  it("detects needs_input from agent", async () => {
    vi.mocked(plugins.agent.getActivityState).mockResolvedValue({ state: "waiting_input" });

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "working" }),
    });

    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("needs_input");
  });

  it("transitions to stuck when idle exceeds agent-stuck threshold (OpenCode-style activity)", async () => {
    config.reactions = {
      "agent-stuck": { auto: true, action: "notify", threshold: "1m" },
    };

    vi.mocked(plugins.agent.getActivityState).mockResolvedValue({
      state: "idle",
      timestamp: new Date(Date.now() - 120_000),
    });

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "working", metadata: { agent: "mock-agent" } }),
      metaOverrides: { agent: "mock-agent" },
    });

    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("stuck");
  });

  it("uses global agent-stuck threshold when project override omits threshold", async () => {
    config.reactions = {
      "agent-stuck": { auto: true, action: "notify", threshold: "1m" },
    };
    config.projects["my-app"] = {
      ...config.projects["my-app"],
      reactions: { "agent-stuck": { auto: true, action: "notify" } },
    };

    vi.mocked(plugins.agent.getActivityState).mockResolvedValue({
      state: "idle",
      timestamp: new Date(Date.now() - 120_000),
    });

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "working", metadata: { agent: "mock-agent" } }),
      metaOverrides: { agent: "mock-agent" },
    });

    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("stuck");
  });

  it("still auto-detects PR before marking idle sessions as stuck", async () => {
    config.reactions = {
      "agent-stuck": { auto: true, action: "notify", threshold: "1m" },
    };

    const mockSCM = createMockSCM({
      detectPR: vi.fn().mockResolvedValue(makePR()),
      getMergeability: vi.fn().mockResolvedValue({
        mergeable: false,
        ciPassing: true,
        approved: false,
        noConflicts: true,
        blockers: [],
      }),
    });

    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    vi.mocked(plugins.agent.getActivityState).mockResolvedValue({
      state: "idle",
      timestamp: new Date(Date.now() - 120_000),
    });

    const lm = setupCheck("app-1", {
      session: makeSession({
        status: "working",
        branch: "feat/test",
        pr: null,
        workspacePath: null,
        metadata: { agent: "mock-agent" },
      }),
      metaOverrides: { branch: "feat/test", agent: "mock-agent" },
      registry,
    });

    await lm.check("app-1");

    expect(mockSCM.detectPR).toHaveBeenCalledOnce();
    const meta = readMetadataRaw(env.sessionsDir, "app-1");
    expect(meta?.["pr"]).toBe(makePR().url);
    expect(lm.getStates().get("app-1")).toBe("stuck");
  });

  it("refreshes worker branch metadata from the current worktree HEAD before PR detection", async () => {
    const workspacePath = join(env.tmpDir, "worker-ws");
    const gitDir = join(env.tmpDir, "repo", ".git", "worktrees", "app-1");
    mkdirSync(workspacePath, { recursive: true });
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(workspacePath, ".git"), `gitdir: ${gitDir}\n`);
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/fix-login-v2\n");

    const mockSCM = createMockSCM({ detectPR: vi.fn().mockResolvedValue(null) });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    const lm = setupCheck("app-1", {
      session: makeSession({
        status: "working",
        branch: "fix-login",
        workspacePath,
        pr: null,
        metadata: { agent: "mock-agent" },
      }),
      metaOverrides: {
        worktree: workspacePath,
        branch: "fix-login",
        agent: "mock-agent",
      },
      registry,
    });

    await lm.check("app-1");

    expect(mockSCM.detectPR).toHaveBeenCalledWith(
      expect.objectContaining({ branch: "fix-login-v2" }),
      expect.anything(),
    );
    const meta = readMetadataRaw(env.sessionsDir, "app-1");
    expect(meta?.["branch"]).toBe("fix-login-v2");
  });

  it("refreshes worker branch metadata for clone-style repos with a .git directory", async () => {
    const workspacePath = join(env.tmpDir, "worker-clone");
    const gitDir = join(workspacePath, ".git");
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/fix-login-v2\n");

    const mockSCM = createMockSCM({ detectPR: vi.fn().mockResolvedValue(null) });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    const lm = setupCheck("app-1", {
      session: makeSession({
        status: "working",
        branch: "fix-login",
        workspacePath,
        pr: null,
        metadata: { agent: "mock-agent" },
      }),
      metaOverrides: {
        worktree: workspacePath,
        branch: "fix-login",
        agent: "mock-agent",
      },
      registry,
    });

    await lm.check("app-1");

    expect(mockSCM.detectPR).toHaveBeenCalledWith(
      expect.objectContaining({ branch: "fix-login-v2" }),
      expect.anything(),
    );
    const meta = readMetadataRaw(env.sessionsDir, "app-1");
    expect(meta?.["branch"]).toBe("fix-login-v2");
  });

  it("does not overwrite an attached PR branch from a workspace checkout change", async () => {
    const workspacePath = join(env.tmpDir, "worker-ws-pr");
    const gitDir = join(env.tmpDir, "repo", ".git", "worktrees", "app-1-pr");
    mkdirSync(workspacePath, { recursive: true });
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(workspacePath, ".git"), `gitdir: ${gitDir}\n`);
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/fix-login-v2\n");

    const pr = makePR({ branch: "fix-login" });
    const mockSCM = createMockSCM({ detectPR: vi.fn().mockResolvedValue(null) });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    const lm = setupCheck("app-1", {
      session: makeSession({
        status: "pr_open",
        branch: "fix-login",
        workspacePath,
        pr,
        metadata: { agent: "mock-agent" },
      }),
      metaOverrides: {
        worktree: workspacePath,
        branch: "fix-login",
        pr: pr.url,
        agent: "mock-agent",
      },
      registry,
    });

    await lm.check("app-1");

    expect(mockSCM.detectPR).not.toHaveBeenCalled();
    expect(pr.branch).toBe("fix-login");
    const meta = readMetadataRaw(env.sessionsDir, "app-1");
    expect(meta?.["branch"]).toBe("fix-login");
  });

  it("refreshes branch metadata again after a closed PR when the worker switches branches", async () => {
    const workspacePath = join(env.tmpDir, "worker-ws-closed-pr");
    const gitDir = join(env.tmpDir, "repo", ".git", "worktrees", "app-1-closed-pr");
    mkdirSync(workspacePath, { recursive: true });
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(workspacePath, ".git"), `gitdir: ${gitDir}\n`);
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/follow-up-fix\n");

    const closedPR = makePR({ branch: "fix-login", url: "https://github.com/org/repo/pull/42" });
    const followUpPR = makePR({
      number: 43,
      branch: "follow-up-fix",
      url: "https://github.com/org/repo/pull/43",
      title: "Follow up fix",
    });
    const mockSCM = createMockSCM({ detectPR: vi.fn().mockResolvedValue(followUpPR) });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    const session = makeSession({
      status: "idle",
      branch: "fix-login",
      workspacePath,
      pr: closedPR,
      metadata: { agent: "mock-agent" },
    });
    session.lifecycle.pr.state = "closed";
    session.lifecycle.pr.reason = "closed_unmerged";
    session.lifecycle.pr.number = closedPR.number;
    session.lifecycle.pr.url = closedPR.url;
    session.lifecycle.pr.lastObservedAt = new Date().toISOString();
    session.lifecycle.session.state = "idle";
    session.lifecycle.session.reason = "pr_closed_waiting_decision";

    const lm = setupCheck("app-1", {
      session,
      metaOverrides: {
        worktree: workspacePath,
        branch: "fix-login",
        pr: closedPR.url,
        agent: "mock-agent",
      },
      registry,
    });

    await lm.check("app-1");

    expect(mockSCM.detectPR).toHaveBeenCalledWith(
      expect.objectContaining({ branch: "follow-up-fix" }),
      expect.anything(),
    );
    const meta = readMetadataRaw(env.sessionsDir, "app-1");
    expect(meta?.["branch"]).toBe("follow-up-fix");
    expect(meta?.["pr"]).toBe(followUpPR.url);
  });

  it("clears stale worker branch metadata when the current worktree HEAD is detached", async () => {
    const workspacePath = join(env.tmpDir, "worker-ws-detached");
    const gitDir = join(env.tmpDir, "repo", ".git", "worktrees", "app-1-detached");
    mkdirSync(workspacePath, { recursive: true });
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(workspacePath, ".git"), `gitdir: ${gitDir}\n`);
    writeFileSync(join(gitDir, "HEAD"), "6f1d2c3b4a5e67890123456789abcdef01234567\n");

    const mockSCM = createMockSCM({ detectPR: vi.fn().mockResolvedValue(null) });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    const lm = setupCheck("app-1", {
      session: makeSession({
        status: "working",
        branch: "fix-login",
        workspacePath,
        pr: null,
        metadata: { agent: "mock-agent" },
      }),
      metaOverrides: {
        worktree: workspacePath,
        branch: "fix-login",
        agent: "mock-agent",
      },
      registry,
    });

    await lm.check("app-1");

    expect(mockSCM.detectPR).not.toHaveBeenCalled();
    const meta = readMetadataRaw(env.sessionsDir, "app-1");
    expect(meta?.["branch"]).toBeUndefined();
  });

  for (const marker of [
    "rebase-merge",
    "rebase-apply",
    "CHERRY_PICK_HEAD",
    "BISECT_LOG",
  ] as const) {
    it(`keeps the previous branch during transient detached git state: ${marker}`, async () => {
      const workspacePath = join(env.tmpDir, `worker-ws-${marker}`);
      const gitDir = join(env.tmpDir, "repo", ".git", "worktrees", `app-1-${marker}`);
      mkdirSync(workspacePath, { recursive: true });
      mkdirSync(gitDir, { recursive: true });
      writeFileSync(join(workspacePath, ".git"), `gitdir: ${gitDir}\n`);
      writeFileSync(join(gitDir, "HEAD"), "6f1d2c3b4a5e67890123456789abcdef01234567\n");
      if (marker.includes("/")) {
        mkdirSync(join(gitDir, marker), { recursive: true });
      } else {
        if (marker === "rebase-merge" || marker === "rebase-apply") {
          mkdirSync(join(gitDir, marker), { recursive: true });
        } else {
          writeFileSync(join(gitDir, marker), "in-progress\n");
        }
      }

      const mockSCM = createMockSCM({ detectPR: vi.fn().mockResolvedValue(null) });
      const registry = createMockRegistry({
        runtime: plugins.runtime,
        agent: plugins.agent,
        scm: mockSCM,
      });

      const lm = setupCheck("app-1", {
        session: makeSession({
          status: "working",
          branch: "fix-login",
          workspacePath,
          pr: null,
          metadata: { agent: "mock-agent" },
        }),
        metaOverrides: {
          worktree: workspacePath,
          branch: "fix-login",
          agent: "mock-agent",
        },
        registry,
      });

      await lm.check("app-1");

      expect(mockSCM.detectPR).toHaveBeenCalledWith(
        expect.objectContaining({ branch: "fix-login" }),
        expect.anything(),
      );
      const meta = readMetadataRaw(env.sessionsDir, "app-1");
      expect(meta?.["branch"]).toBe("fix-login");
    });
  }

  it("keeps existing branch metadata when the current worktree HEAD cannot be read", async () => {
    const workspacePath = join(env.tmpDir, "worker-ws-missing-head");
    const gitDir = join(env.tmpDir, "repo", ".git", "worktrees", "app-1-missing-head");
    mkdirSync(workspacePath, { recursive: true });
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(workspacePath, ".git"), `gitdir: ${gitDir}\n`);

    const mockSCM = createMockSCM({ detectPR: vi.fn().mockResolvedValue(null) });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    const lm = setupCheck("app-1", {
      session: makeSession({
        status: "working",
        branch: "fix-login",
        workspacePath,
        pr: null,
        metadata: { agent: "mock-agent" },
      }),
      metaOverrides: {
        worktree: workspacePath,
        branch: "fix-login",
        agent: "mock-agent",
      },
      registry,
    });

    await lm.check("app-1");

    expect(mockSCM.detectPR).toHaveBeenCalledWith(
      expect.objectContaining({ branch: "fix-login" }),
      expect.anything(),
    );
    const meta = readMetadataRaw(env.sessionsDir, "app-1");
    expect(meta?.["branch"]).toBe("fix-login");
  });

  it("does not adopt a branch already tracked by another active worker", async () => {
    const workspacePath = join(env.tmpDir, "worker-ws-conflict");
    const gitDir = join(env.tmpDir, "repo", ".git", "worktrees", "app-1-conflict");
    mkdirSync(workspacePath, { recursive: true });
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(workspacePath, ".git"), `gitdir: ${gitDir}\n`);
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/fix-login-v2\n");

    const mockSCM = createMockSCM({ detectPR: vi.fn().mockResolvedValue(null) });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    const session = makeSession({
      id: "app-1",
      status: "working",
      branch: "fix-login",
      workspacePath,
      pr: null,
      metadata: { agent: "mock-agent" },
    });
    const sibling = makeSession({
      id: "app-2",
      status: "working",
      branch: "fix-login-v2",
      workspacePath: null,
      pr: null,
      metadata: { agent: "mock-agent" },
    });

    const lm = setupCheck("app-1", {
      session,
      metaOverrides: {
        worktree: workspacePath,
        branch: "fix-login",
        agent: "mock-agent",
      },
      registry,
    });
    vi.mocked(mockSessionManager.list).mockResolvedValue([session, sibling]);

    await lm.check("app-1");

    expect(mockSCM.detectPR).toHaveBeenCalledWith(
      expect.objectContaining({ branch: "fix-login" }),
      expect.anything(),
    );
    const meta = readMetadataRaw(env.sessionsDir, "app-1");
    expect(meta?.["branch"]).toBe("fix-login");
  });

  it("serializes competing branch adoption within one poll cycle without extra session list calls", async () => {
    const workspacePathA = join(env.tmpDir, "worker-ws-race-a");
    const workspacePathB = join(env.tmpDir, "worker-ws-race-b");
    const gitDirA = join(env.tmpDir, "repo", ".git", "worktrees", "app-1-race");
    const gitDirB = join(env.tmpDir, "repo", ".git", "worktrees", "app-2-race");
    mkdirSync(workspacePathA, { recursive: true });
    mkdirSync(workspacePathB, { recursive: true });
    mkdirSync(gitDirA, { recursive: true });
    mkdirSync(gitDirB, { recursive: true });
    writeFileSync(join(workspacePathA, ".git"), `gitdir: ${gitDirA}\n`);
    writeFileSync(join(workspacePathB, ".git"), `gitdir: ${gitDirB}\n`);
    writeFileSync(join(gitDirA, "HEAD"), "ref: refs/heads/shared-branch\n");
    writeFileSync(join(gitDirB, "HEAD"), "ref: refs/heads/shared-branch\n");

    const sessionA = makeSession({
      id: "app-1",
      status: "working",
      branch: "old-a",
      workspacePath: workspacePathA,
      pr: null,
      metadata: { agent: "mock-agent" },
    });
    const sessionB = makeSession({
      id: "app-2",
      status: "working",
      branch: "old-b",
      workspacePath: workspacePathB,
      pr: null,
      metadata: { agent: "mock-agent" },
    });
    vi.mocked(mockSessionManager.list).mockResolvedValue([sessionA, sessionB]);

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    try {
      lm.start(60_000);
      // Poll for the cycle to finish — Windows fs is slower, a fixed 25ms wait
      // can race past the lifecycle list() call before adoption resolves.
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        if (vi.mocked(mockSessionManager.list).mock.calls.length >= 1) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const adoptedCount = [sessionA.branch, sessionB.branch].filter(
        (branch) => branch === "shared-branch",
      ).length;
      expect(adoptedCount).toBe(1);
      expect(mockSessionManager.list).toHaveBeenCalledTimes(1);
    } finally {
      lm.stop();
    }
  });

  it("skips branch refresh for orchestrator sessions", async () => {
    const workspacePath = join(env.tmpDir, "orchestrator-ws");
    const gitDir = join(env.tmpDir, "repo", ".git", "worktrees", "app-orchestrator-1");
    mkdirSync(workspacePath, { recursive: true });
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(workspacePath, ".git"), `gitdir: ${gitDir}\n`);
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/orchestrator-new\n");

    const mockSCM = createMockSCM({ detectPR: vi.fn().mockResolvedValue(null) });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    const lm = setupCheck("app-orchestrator-1", {
      session: makeSession({
        id: "app-orchestrator-1",
        status: "working",
        branch: "orchestrator-old",
        workspacePath,
        pr: null,
        metadata: { agent: "mock-agent", role: "orchestrator" },
      }),
      metaOverrides: {
        worktree: workspacePath,
        branch: "orchestrator-old",
        role: "orchestrator",
        agent: "mock-agent",
      },
      registry,
    });

    await lm.check("app-orchestrator-1");

    expect(mockSCM.detectPR).not.toHaveBeenCalled();
    const meta = readMetadataRaw(env.sessionsDir, "app-orchestrator-1");
    expect(meta?.["branch"]).toBe("orchestrator-old");
  });

  it("preserves stuck state when getActivityState throws", async () => {
    vi.mocked(plugins.agent.getActivityState).mockRejectedValue(new Error("probe failed"));

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "stuck" }),
    });

    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("stuck");
  });

  it("preserves needs_input state when getActivityState throws", async () => {
    vi.mocked(plugins.agent.getActivityState).mockRejectedValue(new Error("probe failed"));

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "needs_input" }),
    });

    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("needs_input");
  });

  it("preserves stuck state when getActivityState returns null and getOutput throws", async () => {
    vi.mocked(plugins.agent.getActivityState).mockResolvedValue(null);
    vi.mocked(plugins.runtime.getOutput).mockRejectedValue(new Error("tmux error"));

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "stuck" }),
    });

    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("stuck");
  });

  it("preserves needs_input state when getActivityState returns null with no terminal evidence", async () => {
    vi.mocked(plugins.agent.getActivityState).mockResolvedValue(null);
    vi.mocked(plugins.runtime.getOutput).mockResolvedValue("");

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "needs_input" }),
    });

    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("needs_input");
  });

  it("preserves stuck state across repeated polls with unchanged weak evidence", async () => {
    vi.mocked(plugins.agent.getActivityState).mockResolvedValue(null);
    vi.mocked(plugins.runtime.getOutput).mockResolvedValue("");

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "stuck" }),
    });

    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("stuck");

    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("stuck");
  });

  it("preserves needs_input across repeated polls with unchanged weak evidence", async () => {
    vi.mocked(plugins.agent.getActivityState).mockResolvedValue(null);
    vi.mocked(plugins.runtime.getOutput).mockResolvedValue("");

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "needs_input" }),
    });

    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("needs_input");

    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("needs_input");
  });

  it("preserves canonical needs_input when persisted status is stale working", async () => {
    vi.mocked(plugins.agent.getActivityState).mockResolvedValue(null);
    vi.mocked(plugins.runtime.getOutput).mockResolvedValue("");

    const session = makeSession({ status: "working" });
    session.lifecycle.session.state = "needs_input";
    session.lifecycle.session.reason = "awaiting_user_input";

    const lm = setupCheck("app-1", {
      session,
      metaOverrides: {
        status: "working",
      },
    });

    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("needs_input");
    const meta = readMetadataRaw(env.sessionsDir, "app-1");
    expect(meta?.["status"]).toBe("needs_input");
  });

  it("detects PR states from SCM", async () => {
    vi.useFakeTimers();
    try {
      const pr = makeMatchingPR();
      const mockSCM = createMockSCM({
        getCISummary: vi.fn().mockResolvedValue("failing"),
        enrichSessionsPRBatch: mockBatchEnrichment({ ciStatus: "failing" }),
      });
      const registry = createMockRegistry({
        runtime: plugins.runtime,
        agent: plugins.agent,
        scm: mockSCM,
      });

      const lm = setupPollCheck("app-1", {
        session: makeSession({ status: "pr_open", pr }),
        registry,
      });

      lm.start(60_000);
      await vi.advanceTimersByTimeAsync(0);
      lm.stop();
      expect(lm.getStates().get("app-1")).toBe("ci_failed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps canonical session state idle while waiting on external review", async () => {
    const mockSCM = createMockSCM({
      getReviewDecision: vi.fn().mockResolvedValue("pending"),
      enrichSessionsPRBatch: mockBatchEnrichment({ reviewDecision: "pending" }),
    });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });
    const session = makeSession({ status: "pr_open", pr: makePR() });
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    writeMetadata(env.sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: session.branch ?? "main",
      status: session.status,
      project: "my-app",
      pr: session.pr?.url,
      runtimeHandle: session.runtimeHandle ?? undefined,
    });

    const lm = createLifecycleManager({
      config,
      registry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("review_pending");
    expect(session.lifecycle.session.state).toBe("idle");
    expect(session.lifecycle.session.reason).toBe("awaiting_external_review");
  });

  it("skips PR auto-detection when metadata disables it", async () => {
    const mockSCM = createMockSCM({ detectPR: vi.fn().mockResolvedValue(makePR()) });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    writeMetadata(env.sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "feat/test",
      status: "working",
      project: "my-app",
      prAutoDetect: false,
    });

    const realSessionManager = createSessionManager({ config, registry });
    const session = await realSessionManager.get("app-1");

    expect(session).not.toBeNull();
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    const lm = createLifecycleManager({
      config,
      registry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(mockSCM.detectPR).not.toHaveBeenCalled();
    expect(lm.getStates().get("app-1")).toBe("working");
  });

  it("skips PR auto-detection for orchestrator sessions", async () => {
    const mockSCM = createMockSCM({ detectPR: vi.fn().mockResolvedValue(makePR()) });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    writeMetadata(env.sessionsDir, "app-1", {
      worktree: "/tmp",
      branch: "master",
      status: "working",
      project: "my-app",
      role: "orchestrator",
    });

    const realSessionManager = createSessionManager({ config, registry });
    const session = await realSessionManager.get("app-1");

    expect(session).not.toBeNull();
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    const lm = createLifecycleManager({
      config,
      registry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-1");

    expect(mockSCM.detectPR).not.toHaveBeenCalled();
    expect(lm.getStates().get("app-1")).toBe("working");
  });

  it("skips PR auto-detection for orchestrator sessions identified by ID suffix (fallback)", async () => {
    const mockSCM = createMockSCM({ detectPR: vi.fn().mockResolvedValue(makePR()) });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    writeMetadata(env.sessionsDir, "app-orchestrator", {
      worktree: "/tmp",
      branch: "master",
      status: "working",
      project: "my-app",
    });

    const realSessionManager = createSessionManager({ config, registry });
    const session = await realSessionManager.get("app-orchestrator");

    expect(session).not.toBeNull();
    vi.mocked(mockSessionManager.get).mockResolvedValue(session);

    const lm = createLifecycleManager({
      config,
      registry,
      sessionManager: mockSessionManager,
    });

    await lm.check("app-orchestrator");

    expect(mockSCM.detectPR).not.toHaveBeenCalled();
    expect(lm.getStates().get("app-orchestrator")).toBe("working");
  });

  it("detects merged PR", async () => {
    vi.useFakeTimers();
    try {
      const pr = makeMatchingPR();
      const mockSCM = createMockSCM({
        getPRState: vi.fn().mockResolvedValue("merged"),
        enrichSessionsPRBatch: mockBatchEnrichment({ state: "merged", ciStatus: "none" }),
      });
      const registry = createMockRegistry({
        runtime: plugins.runtime,
        agent: plugins.agent,
        scm: mockSCM,
      });

      const lm = setupPollCheck("app-1", {
        session: makeSession({ status: "approved", pr }),
        registry,
      });

      lm.start(60_000);
      await vi.advanceTimersByTimeAsync(0);
      lm.stop();
      expect(lm.getStates().get("app-1")).toBe("merged");
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves merged PR truth in metadata instead of regressing to no-pr lifecycle state", async () => {
    vi.useFakeTimers();
    try {
      const pr = makeMatchingPR();
      const mockSCM = createMockSCM({
        getPRState: vi.fn().mockResolvedValue("merged"),
        enrichSessionsPRBatch: mockBatchEnrichment({ state: "merged", ciStatus: "none" }),
      });
      const registry = createMockRegistry({
        runtime: plugins.runtime,
        agent: plugins.agent,
        scm: mockSCM,
      });

      const lm = setupPollCheck("app-1", {
        session: makeSession({ status: "pr_open", pr }),
        registry,
      });

      lm.start(60_000);
      await vi.advanceTimersByTimeAsync(0);
      lm.stop();

      const meta = readMetadataRaw(env.sessionsDir, "app-1");
      expect(lm.getStates().get("app-1")).toBe("merged");
      expect(meta?.["status"]).toBe("merged");
      expect(meta?.["pr"]).toBe(pr.url);
      expect(meta?.["lifecycle"]).toContain('"state":"merged"');
      expect(meta?.["lifecycle"]).toContain('"reason":"merged"');
      expect(meta?.["lifecycle"]).not.toContain('"reason":"not_created"');
      expect(mockSessionManager.invalidateCache).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps closed PR sessions idle and emits a PR-closed notification", async () => {
    const mockSCM = createMockSCM({
      getPRState: vi.fn().mockResolvedValue("closed"),
      enrichSessionsPRBatch: mockBatchEnrichment({ state: "closed" }),
    });
    const notifier = createMockNotifier();
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
      notifier,
    });

    const session = makeSession({ status: "pr_open", pr: makePR() });
    const lm = setupCheck("app-1", {
      session,
      registry,
      configOverride: {
        ...config,
        notificationRouting: {
          ...config.notificationRouting,
          info: ["desktop"],
        },
      },
    });

    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("idle");
    const meta = readMetadataRaw(env.sessionsDir, "app-1");
    expect(meta?.["status"]).toBe("idle");
    expect(meta?.["lifecycle"]).toContain('"state":"closed"');
    expect(meta?.["lifecycle"]).toContain('"reason":"pr_closed_waiting_decision"');
    expect(notifier.notify).toHaveBeenCalledWith(expect.objectContaining({ type: "pr.closed" }));
  });

  it("routes closed PR transitions through the pr-closed reaction key", async () => {
    const notifier = createMockNotifier();
    const mockSCM = createMockSCM({
      getPRState: vi.fn().mockResolvedValue("closed"),
      enrichSessionsPRBatch: mockBatchEnrichment({ state: "closed" }),
    });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
      notifier,
    });

    const session = makeSession({ status: "pr_open", pr: makePR() });
    const lm = setupCheck("app-1", {
      session,
      registry,
      configOverride: {
        ...config,
        reactions: {
          ...config.reactions,
          "pr-closed": {
            auto: true,
            action: "notify",
            priority: "action",
          },
        },
        notificationRouting: {
          ...config.notificationRouting,
          action: ["desktop"],
        },
      },
    });

    await lm.check("app-1");

    expect(notifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "reaction.triggered",
        data: expect.objectContaining({ reactionKey: "pr-closed" }),
      }),
    );
  });

  it("detects mergeable when approved + CI green", async () => {
    const mockSCM = createMockSCM({
      getReviewDecision: vi.fn().mockResolvedValue("approved"),
      getMergeability: vi.fn().mockResolvedValue({
        mergeable: true,
        ciPassing: true,
        approved: true,
        noConflicts: true,
        blockers: [],
      }),
      enrichSessionsPRBatch: mockBatchEnrichment({ reviewDecision: "approved", mergeable: true }),
    });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
    });

    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("mergeable");
  });

  it("throws for nonexistent session", async () => {
    vi.mocked(mockSessionManager.get).mockResolvedValue(null);

    const lm = createLifecycleManager({
      config,
      registry: mockRegistry,
      sessionManager: mockSessionManager,
    });

    await expect(lm.check("nonexistent")).rejects.toThrow("not found");
  });

  it("does not change state when status is unchanged", async () => {
    const lm = setupCheck("app-1", {
      session: makeSession({ status: "working" }),
    });

    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("working");

    // Second check — status remains working, no transition
    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("working");
  });
});

describe("reactions", () => {
  it("fires report watcher reactions only once per active trigger", async () => {
    vi.useFakeTimers();

    const notifier = createMockNotifier();
    const registryWithNotifier = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      notifier,
    });
    const staleSession = makeSession({
      id: "app-1",
      status: "working",
      workspacePath: null,
      createdAt: new Date("2025-01-01T11:40:00.000Z"),
      metadata: {
        createdAt: "2025-01-01T11:40:00.000Z",
      },
    });

    config.reactions = {
      "report-no-acknowledge": { auto: true, action: "notify", priority: "urgent" },
    };
    vi.mocked(mockSessionManager.list).mockResolvedValue([staleSession]);

    const lm = createLifecycleManager({
      config,
      registry: registryWithNotifier,
      sessionManager: mockSessionManager,
    });

    try {
      vi.setSystemTime(new Date("2025-01-01T12:00:00.000Z"));
      lm.start(60_000);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(60_000);

      const reactionNotifications = vi.mocked(notifier.notify).mock.calls.filter((call) => {
        const event = call[0] as { type?: string; data?: Record<string, unknown> } | undefined;
        return (
          event?.type === "reaction.triggered" &&
          event.data?.["reactionKey"] === "report-no-acknowledge"
        );
      });

      expect(reactionNotifications).toHaveLength(1);
      expect(staleSession.metadata["reportWatcherTriggerCount"]).toBe("2");
      expect(staleSession.metadata["reportWatcherActiveTrigger"]).toBe("no_acknowledge");
    } finally {
      lm.stop();
      vi.useRealTimers();
    }
  });

  it("triggers send-to-agent reaction on CI failure", async () => {
    config.reactions = {
      "ci-failed": {
        auto: true,
        action: "send-to-agent",
        message: "CI is failing. Fix it.",
        retries: 2,
        escalateAfter: 2,
      },
    };

    const mockSCM = createMockSCM({
      getCISummary: vi.fn().mockResolvedValue("failing"),
      enrichSessionsPRBatch: mockBatchEnrichment({ ciStatus: "failing" }),
    });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
    });

    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledWith("app-1", "CI is failing. Fix it.");
  });

  it("does not trigger reaction when auto=false", async () => {
    config.reactions = {
      "ci-failed": { auto: false, action: "send-to-agent", message: "CI is failing." },
    };

    const mockSCM = createMockSCM({
      getCISummary: vi.fn().mockResolvedValue("failing"),
      enrichSessionsPRBatch: mockBatchEnrichment({ ciStatus: "failing" }),
    });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
    });

    await lm.check("app-1");
    expect(mockSessionManager.send).not.toHaveBeenCalled();
  });

  it("suppresses immediate notification when send-to-agent reaction handles the event", async () => {
    const notifier = createMockNotifier();
    const mockSCM = createMockSCM({
      getCISummary: vi.fn().mockResolvedValue("failing"),
      enrichSessionsPRBatch: mockBatchEnrichment({ ciStatus: "failing" }),
    });

    const registry: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return plugins.runtime;
        if (slot === "agent") return plugins.agent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier" && name === "desktop") return notifier;
        return null;
      }),
    };

    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    const configWithReaction = {
      ...config,
      reactions: {
        "ci-failed": {
          auto: true,
          action: "send-to-agent" as const,
          message: "Fix CI",
          retries: 3,
          escalateAfter: 3,
        },
      },
    };

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
      configOverride: configWithReaction,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("ci_failed");
    expect(mockSessionManager.send).toHaveBeenCalledWith("app-1", "Fix CI");
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it("dispatches unresolved review comments even when reviewDecision stays unchanged", async () => {
    config.reactions = {
      "changes-requested": {
        auto: true,
        action: "send-to-agent",
        message: "Handle review comments.",
      },
    };

    const mockSCM = createMockSCM({
      getReviewThreads: vi.fn().mockResolvedValue({
        threads: [
          {
            id: "c1",
            author: "reviewer",
            body: "Please rename this helper",
            path: "src/app.ts",
            line: 12,
            isResolved: false,
            createdAt: new Date(),
            url: "https://example.com/comment/1",
            isBot: false,
          },
        ],
        reviews: [],
      }),
    });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
    });

    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);
    const sentMessage = vi.mocked(mockSessionManager.send).mock.calls[0]![1] as string;
    expect(sentMessage).toContain("src/app.ts:12");
    expect(sentMessage).toContain("@reviewer");
    expect(sentMessage).toContain("Please rename this helper");

    vi.mocked(mockSessionManager.send).mockClear();
    await lm.check("app-1");
    expect(mockSessionManager.send).not.toHaveBeenCalled();

    const metadata = readMetadataRaw(env.sessionsDir, "app-1");
    expect(metadata?.["lastPendingReviewDispatchHash"]).toBe("c1");
  });

  it("sends enriched review content on changes_requested transition alongside the generic message", async () => {
    config.reactions = {
      "changes-requested": {
        auto: true,
        action: "send-to-agent",
        message: "Handle requested changes.",
      },
    };

    const mockSCM = createMockSCM({
      getReviewDecision: vi.fn().mockResolvedValue("changes_requested"),
      enrichSessionsPRBatch: vi.fn().mockImplementation(async (prs: PRInfo[]) => {
        const result = new Map();
        for (const pr of prs) {
          result.set(`${pr.owner}/${pr.repo}#${pr.number}`, {
            state: "open",
            ciStatus: "passing",
            reviewDecision: "changes_requested",
            mergeable: false,
          });
        }
        return result;
      }),
      getReviewThreads: vi.fn().mockResolvedValue({
        threads: [
          {
            id: "c1",
            author: "reviewer",
            body: "Please add validation",
            path: "src/route.ts",
            line: 44,
            isResolved: false,
            createdAt: new Date(),
            url: "https://example.com/comment/2",
            isBot: false,
          },
        ],
        reviews: [],
      }),
    });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
    });

    await lm.check("app-1");

    // First call is the transition reaction (generic message), second is
    // the backlog dispatch with actual review comment content.
    expect(mockSessionManager.send).toHaveBeenCalledTimes(2);
    const enrichedMessage = vi.mocked(mockSessionManager.send).mock.calls[1]![1] as string;
    expect(enrichedMessage).toContain("src/route.ts:44");
    expect(enrichedMessage).toContain("@reviewer");
    expect(enrichedMessage).toContain("Please add validation");

    // Second check: throttled (within REVIEW_BACKLOG_THROTTLE_MS window) and
    // fingerprint already matches dispatch hash — neither path re-sends.
    vi.mocked(mockSessionManager.send).mockClear();
    await lm.check("app-1");
    expect(mockSessionManager.send).not.toHaveBeenCalled();
  });

  it("does not double-bill reaction attempts on changes_requested transition with retries:1", async () => {
    const notifier = createMockNotifier();

    config.reactions = {
      "changes-requested": {
        auto: true,
        action: "send-to-agent",
        message: "Handle requested changes.",
        retries: 1,
      },
    };

    const mockSCM = createMockSCM({
      getReviewDecision: vi.fn().mockResolvedValue("changes_requested"),
      enrichSessionsPRBatch: vi.fn().mockImplementation(async (prs: PRInfo[]) => {
        const result = new Map();
        for (const pr of prs) {
          result.set(`${pr.owner}/${pr.repo}#${pr.number}`, {
            state: "open",
            ciStatus: "passing",
            reviewDecision: "changes_requested",
            mergeable: false,
          });
        }
        return result;
      }),
      getReviewThreads: vi.fn().mockResolvedValue({
        threads: [
          {
            id: "c1",
            author: "reviewer",
            body: "Needs validation",
            path: "src/handler.ts",
            line: 10,
            isResolved: false,
            createdAt: new Date(),
            url: "https://example.com/comment/retries",
            isBot: false,
          },
        ],
        reviews: [],
      }),
    });

    const registry: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return plugins.runtime;
        if (slot === "agent") return plugins.agent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier" && name === "desktop") return notifier;
        return null;
      }),
    };

    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
    });

    await lm.check("app-1");

    // Transition handler sends the generic message (attempt 1), and the backlog
    // dispatch sends the enriched message directly (no attempt increment).
    // Total sends = 2 but reaction attempts = 1, so no escalation.
    expect(mockSessionManager.send).toHaveBeenCalledTimes(2);
    expect(notifier.notify).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "reaction.escalated" }),
    );

    // The enriched message should contain the actual review content
    const enrichedMessage = vi.mocked(mockSessionManager.send).mock.calls[1]![1] as string;
    expect(enrichedMessage).toContain("src/handler.ts:10");
    expect(enrichedMessage).toContain("Needs validation");
  });

  it("routes enriched review dispatch through executeReaction when action is notify (not send-to-agent)", async () => {
    const notifier = createMockNotifier();

    config.reactions = {
      "changes-requested": {
        auto: true,
        action: "notify",
        message: "Review changes requested.",
      },
    };
    config.notificationRouting = {
      ...config.notificationRouting,
      info: ["desktop"],
    };

    const mockSCM = createMockSCM({
      getReviewDecision: vi.fn().mockResolvedValue("changes_requested"),
      enrichSessionsPRBatch: vi.fn().mockImplementation(async (prs: PRInfo[]) => {
        const result = new Map();
        for (const pr of prs) {
          result.set(`${pr.owner}/${pr.repo}#${pr.number}`, {
            state: "open",
            ciStatus: "passing",
            reviewDecision: "changes_requested",
            mergeable: false,
          });
        }
        return result;
      }),
      getReviewThreads: vi.fn().mockResolvedValue({
        threads: [
          {
            id: "c1",
            author: "reviewer",
            body: "Fix the type",
            path: "src/api.ts",
            line: 5,
            isResolved: false,
            createdAt: new Date(),
            url: "https://example.com/comment/notify",
            isBot: false,
          },
        ],
        reviews: [],
      }),
    });

    const registry: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return plugins.runtime;
        if (slot === "agent") return plugins.agent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier" && name === "desktop") return notifier;
        return null;
      }),
    };

    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
    });

    await lm.check("app-1");

    // action: "notify" should NOT send to the agent — it routes through
    // executeReaction → notifyHuman. The bypass branch must not fire.
    expect(mockSessionManager.send).not.toHaveBeenCalled();
    expect(notifier.notify).toHaveBeenCalled();
  });

  it("dispatches detailed automated review comments when using the default sentinel message", async () => {
    config.reactions = {
      "bugbot-comments": {
        auto: true,
        action: "send-to-agent",
        // Sentinel — dispatcher replaces with formatted detail listing.
        message: DEFAULT_BUGBOT_COMMENTS_MESSAGE,
      },
    };

    const mockSCM = createMockSCM({
      getReviewThreads: vi.fn().mockResolvedValue({
        threads: [
          {
            id: "bot-1",
            author: "cursor[bot]",
            body: "Potential issue detected",
            path: "src/worker.ts",
            line: 9,
            isResolved: false,
            createdAt: new Date(),
            url: "https://example.com/comment/3",
            isBot: true,
          },
        ],
        reviews: [],
      }),
    });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
    });

    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);
    const sentMessage = vi.mocked(mockSessionManager.send).mock.calls[0]![1] as string;
    expect(sentMessage).toContain("src/worker.ts:9");
    expect(sentMessage).toContain("@cursor[bot]");
    expect(sentMessage).toContain("Potential issue detected");

    vi.mocked(mockSessionManager.send).mockClear();
    await lm.check("app-1");
    expect(mockSessionManager.send).not.toHaveBeenCalled();

    const metadata = readMetadataRaw(env.sessionsDir, "app-1");
    expect(metadata?.["lastAutomatedReviewDispatchHash"]).toBe("bot-1");
  });

  it("respects a user-customized bugbot-comments message (no silent override)", async () => {
    // The review backlog dispatch always formats bot comments inline so the
    // agent has the data without re-fetching.  A custom config message is
    // overridden by the formatted detail listing.
    config.reactions = {
      "bugbot-comments": {
        auto: true,
        action: "send-to-agent",
        message: "Custom internal playbook. Follow ORG-1234.",
      },
    };

    const mockSCM = createMockSCM({
      getReviewThreads: vi.fn().mockResolvedValue({
        threads: [
          {
            id: "bot-1",
            author: "cursor[bot]",
            body: "Potential issue detected",
            path: "src/worker.ts",
            line: 9,
            isResolved: false,
            createdAt: new Date(),
            url: "https://example.com/comment/3",
            isBot: true,
          },
        ],
        reviews: [],
      }),
    });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
    });

    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);
    const sentMessage = vi.mocked(mockSessionManager.send).mock.calls[0]![1] as string;
    expect(sentMessage).toContain("src/worker.ts:9");
    expect(sentMessage).toContain("@cursor[bot]");
    expect(sentMessage).toContain("Potential issue detected");
  });

  it("dispatches CI failure summary with failed step and log tail", async () => {
    config.reactions = {
      "ci-failed": {
        auto: true,
        action: "send-to-agent",
        retries: 3,
        escalateAfter: 3,
      },
    };

    const ciChecks = [
      {
        name: "build",
        status: "failed",
        url: "https://github.com/org/repo/actions/runs/123/job/456",
        conclusion: "FAILURE",
      },
    ];
    const mockSCM = createMockSCM({
      getCISummary: vi.fn().mockResolvedValue("failing"),
      getCIFailureSummary: vi.fn().mockResolvedValue({
        failedJobs: [
          {
            name: "build",
            failedStep: "Run pnpm test",
            runUrl: "https://github.com/org/repo/actions/runs/123/job/456",
            logTail:
              "AssertionError: expected true to be false\n```\nProcess completed with exit code 1",
          },
        ],
      }),
      enrichSessionsPRBatch: mockBatchEnrichment({ ciStatus: "failing", ciChecks }),
    });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
    });

    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);
    const sentMessage = vi.mocked(mockSessionManager.send).mock.calls[0]![1];
    expect(sentMessage).toContain("CI is failing on your PR.");
    expect(sentMessage).toContain("Failed: build → Run pnpm test");
    expect(sentMessage).toContain("Failure URL: https://github.com/org/repo/actions/runs/123/job/456");
    expect(sentMessage).toContain("Log tail (last 3 lines):");
    expect(sentMessage).toContain("AssertionError: expected true to be false");
    expect(sentMessage).toContain("\u200B```");
    expect(sentMessage).toContain("Fix the issues and push again.");
    expect(mockSCM.getCIFailureSummary).toHaveBeenCalledWith(makePR(), ciChecks);
  });

  it("falls back to check names and URLs when SCM lacks getCIFailureSummary", async () => {
    config.reactions = {
      "ci-failed": {
        auto: true,
        action: "send-to-agent",
        message: "CI is failing. Fix it.",
        retries: 3,
        escalateAfter: 3,
      },
    };

    const ciChecks = [
      {
        name: "lint",
        status: "failed",
        url: "https://github.com/org/repo/actions/runs/123",
        conclusion: "FAILURE",
      },
      {
        name: "test",
        status: "passed",
        url: "https://github.com/org/repo/actions/runs/124",
        conclusion: "SUCCESS",
      },
      {
        name: "typecheck",
        status: "failed",
        url: "https://github.com/org/repo/actions/runs/125",
        conclusion: "FAILURE",
      },
    ];
    const mockSCM = createMockSCM({
      getCISummary: vi.fn().mockResolvedValue("failing"),
      getCIChecks: vi.fn().mockResolvedValue(ciChecks),
      enrichSessionsPRBatch: mockBatchEnrichment({ ciStatus: "failing", ciChecks }),
    });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
    });

    // First check: transition to ci_failed — sends detailed CI info directly
    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("ci_failed");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);
    const sentMessage = vi.mocked(mockSessionManager.send).mock.calls[0]![1];
    expect(sentMessage).toContain("CI checks are failing on your PR.");
    expect(sentMessage).toContain("lint");
    expect(sentMessage).toContain("typecheck");
    expect(sentMessage).toContain("https://github.com/org/repo/actions/runs/123");
    expect(sentMessage).toContain("https://github.com/org/repo/actions/runs/125");
    // Should NOT include the passing check
    expect(sentMessage).not.toContain("runs/124");
  });

  it("does not re-send CI failure details on subsequent polls (transition fires once)", async () => {
    config.reactions = {
      "ci-failed": {
        auto: true,
        action: "send-to-agent",
        message: "CI is failing.",
        retries: 3,
        escalateAfter: 3,
      },
    };

    const ciChecks = [{ name: "lint", status: "failed", conclusion: "FAILURE" }];
    const mockSCM = createMockSCM({
      getCISummary: vi.fn().mockResolvedValue("failing"),
      getCIChecks: vi.fn().mockResolvedValue(ciChecks),
      enrichSessionsPRBatch: mockBatchEnrichment({ ciStatus: "failing", ciChecks }),
    });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
    });

    // First check: transition to ci_failed — sends detailed CI info
    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);

    vi.mocked(mockSessionManager.send).mockClear();

    // Second check: still ci_failed, same failures — no transition, no message
    await lm.check("app-1");
    expect(mockSessionManager.send).not.toHaveBeenCalled();
  });

  it("uses notify action for merge conflicts when configured", async () => {
    const notifier = createMockNotifier();

    const configWithNotify = {
      ...config,
      reactions: {
        "merge-conflicts": {
          auto: true,
          action: "notify" as const,
        },
      },
      notificationRouting: {
        ...config.notificationRouting,
        warning: ["desktop"],
        info: ["desktop"],
      },
    };

    const mockSCM = createMockSCM({
      getMergeability: vi.fn().mockResolvedValue({
        mergeable: false,
        ciPassing: true,
        approved: false,
        noConflicts: false,
        blockers: ["Merge conflicts"],
      }),
      enrichSessionsPRBatch: mockBatchEnrichment({ hasConflicts: true }),
    });

    const registry: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return plugins.runtime;
        if (slot === "agent") return plugins.agent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier" && name === "desktop") return notifier;
        return null;
      }),
    };

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
      configOverride: configWithNotify,
    });

    await lm.check("app-1");
    expect(notifier.notify).toHaveBeenCalled();
    expect(mockSessionManager.send).not.toHaveBeenCalled();
  });

  it("dispatches merge conflict notification when PR has conflicts", async () => {
    config.reactions = {
      "merge-conflicts": {
        auto: true,
        action: "send-to-agent",
        message: "Your branch has merge conflicts. Rebase and resolve them.",
      },
    };

    const mockSCM = createMockSCM({
      getMergeability: vi.fn().mockResolvedValue({
        mergeable: false,
        ciPassing: true,
        approved: false,
        noConflicts: false,
        blockers: ["Merge conflicts"],
      }),
      enrichSessionsPRBatch: mockBatchEnrichment({ hasConflicts: true }),
    });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
    });

    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledWith(
      "app-1",
      "Your branch has merge conflicts. Rebase and resolve them.",
    );
  });

  it("does not re-dispatch merge conflict notification when already dispatched", async () => {
    config.reactions = {
      "merge-conflicts": {
        auto: true,
        action: "send-to-agent",
        message: "Resolve merge conflicts.",
      },
    };

    const mockSCM = createMockSCM({
      getMergeability: vi.fn().mockResolvedValue({
        mergeable: false,
        ciPassing: true,
        approved: false,
        noConflicts: false,
        blockers: ["Merge conflicts"],
      }),
      enrichSessionsPRBatch: mockBatchEnrichment({ hasConflicts: true }),
    });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
    });

    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);

    vi.mocked(mockSessionManager.send).mockClear();

    // Second check — same conflicts, should not re-send
    await lm.check("app-1");
    expect(mockSessionManager.send).not.toHaveBeenCalled();
  });

  it("re-dispatches merge conflict notification after conflicts are resolved and recur", async () => {
    config.reactions = {
      "merge-conflicts": {
        auto: true,
        action: "send-to-agent",
        message: "Resolve merge conflicts.",
      },
    };

    const getMergeabilityMock = vi.fn().mockResolvedValue({
      mergeable: false,
      ciPassing: true,
      approved: false,
      noConflicts: false,
      blockers: ["Merge conflicts"],
    });
    const mockSCM = createMockSCM({
      getMergeability: getMergeabilityMock,
      enrichSessionsPRBatch: mockBatchEnrichment({ hasConflicts: true }),
    });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
    });

    // First: conflicts detected, notification sent
    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);
    vi.mocked(mockSessionManager.send).mockClear();

    // Second: conflicts resolved
    getMergeabilityMock.mockResolvedValue({
      mergeable: true,
      ciPassing: true,
      approved: false,
      noConflicts: true,
      blockers: [],
    });
    vi.mocked(mockSCM.enrichSessionsPRBatch!).mockImplementation(
      mockBatchEnrichment({ hasConflicts: false }),
    );
    await lm.check("app-1");
    expect(mockSessionManager.send).not.toHaveBeenCalled();

    const metadata = readMetadataRaw(env.sessionsDir, "app-1");
    expect(metadata?.["lastMergeConflictDispatched"]).toBeFalsy();

    // Third: conflicts recur — should re-dispatch
    getMergeabilityMock.mockResolvedValue({
      mergeable: false,
      ciPassing: true,
      approved: false,
      noConflicts: false,
      blockers: ["Merge conflicts"],
    });
    vi.mocked(mockSCM.enrichSessionsPRBatch!).mockImplementation(
      mockBatchEnrichment({ hasConflicts: true }),
    );
    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);
  });

  it("clears merge conflict tracking when PR is merged", async () => {
    config.reactions = {
      "merge-conflicts": {
        auto: true,
        action: "send-to-agent",
        message: "Resolve merge conflicts.",
      },
    };

    const mockSCM = createMockSCM({
      getMergeability: vi.fn().mockResolvedValue({
        mergeable: false,
        ciPassing: true,
        approved: false,
        noConflicts: false,
        blockers: ["Merge conflicts"],
      }),
    });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
    });

    await lm.check("app-1");

    // Now PR is merged
    vi.mocked(mockSCM.getPRState).mockResolvedValue("merged");

    await lm.check("app-1");

    const metadata = readMetadataRaw(env.sessionsDir, "app-1");
    expect(metadata?.["lastMergeConflictDispatched"]).toBeFalsy();
  });

  it("clears merge conflict tracking when PR is closed", async () => {
    config.reactions = {
      "merge-conflicts": {
        auto: true,
        action: "send-to-agent",
        message: "Resolve merge conflicts.",
      },
    };

    const getMergeability = vi.fn();
    const mockSCM = createMockSCM({
      getPRState: vi.fn().mockResolvedValue("closed"),
      getMergeability,
      enrichSessionsPRBatch: mockBatchEnrichment({ state: "closed" }),
    });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    const lm = setupCheck("app-1", {
      session: makeSession({
        status: "pr_open",
        pr: makePR(),
        metadata: { lastMergeConflictDispatched: "true" },
      }),
      registry,
    });

    await lm.check("app-1");

    const metadata = readMetadataRaw(env.sessionsDir, "app-1");
    expect(metadata?.["lastMergeConflictDispatched"]).toBeFalsy();
    expect(getMergeability).not.toHaveBeenCalled();
  });

  it("notifies humans on significant transitions without reaction config", async () => {
    const notifier = createMockNotifier();
    const mockSCM = createMockSCM({
      getPRState: vi.fn().mockResolvedValue("merged"),
      enrichSessionsPRBatch: mockBatchEnrichment({ state: "merged" }),
    });

    const registry: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return plugins.runtime;
        if (slot === "agent") return plugins.agent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier" && name === "desktop") return notifier;
        return null;
      }),
    };

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "approved", pr: makePR() }),
      registry,
    });

    await lm.check("app-1");

    expect(lm.getStates().get("app-1")).toBe("merged");
    expect(notifier.notify).toHaveBeenCalled();
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: "merge.completed" }),
    );
  });

  it("resolves notifier aliases from notificationRouting before dispatch", async () => {
    const notifier = createMockNotifier();
    const mockSCM = createMockSCM({
      getPRState: vi.fn().mockResolvedValue("merged"),
      enrichSessionsPRBatch: mockBatchEnrichment({ state: "merged" }),
    });

    const configWithAliasRouting: OrchestratorConfig = {
      ...config,
      notifiers: {
        alerts: {
          plugin: "desktop",
        },
      },
      notificationRouting: {
        ...config.notificationRouting,
        action: ["alerts"],
      },
    };

    const registry: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return plugins.runtime;
        if (slot === "agent") return plugins.agent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier" && name === "desktop") return notifier;
        return null;
      }),
    };

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "approved", pr: makePR() }),
      registry,
      configOverride: configWithAliasRouting,
    });

    await lm.check("app-1");

    expect(notifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: "merge.completed" }),
    );
  });

  it("resolves notifier aliases from defaults.notifiers when routing falls back", async () => {
    const notifier = createMockNotifier();
    const mockSCM = createMockSCM({
      getPRState: vi.fn().mockResolvedValue("merged"),
      enrichSessionsPRBatch: mockBatchEnrichment({ state: "merged" }),
    });

    const configWithAliasDefaults: OrchestratorConfig = {
      ...config,
      defaults: {
        ...config.defaults,
        notifiers: ["alerts"],
      },
      notifiers: {
        alerts: {
          plugin: "desktop",
        },
      },
      notificationRouting: {
        urgent: ["desktop"],
        warning: ["desktop"],
        info: ["desktop"],
      } as OrchestratorConfig["notificationRouting"],
    };

    const registry: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return plugins.runtime;
        if (slot === "agent") return plugins.agent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier" && name === "desktop") return notifier;
        return null;
      }),
    };

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "approved", pr: makePR() }),
      registry,
      configOverride: configWithAliasDefaults,
    });

    await lm.check("app-1");

    expect(notifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: "merge.completed" }),
    );
  });

  it("prefers alias-specific notifier instances over shared plugin instances", async () => {
    const alertsNotifier = createMockNotifier();
    const opsNotifier = createMockNotifier();
    const mockSCM = createMockSCM({
      getPRState: vi.fn().mockResolvedValue("merged"),
      enrichSessionsPRBatch: mockBatchEnrichment({ state: "merged" }),
    });

    const configWithSharedPluginAliases: OrchestratorConfig = {
      ...config,
      notifiers: {
        alerts: {
          plugin: "desktop",
        },
        ops: {
          plugin: "desktop",
        },
      },
      notificationRouting: {
        ...config.notificationRouting,
        action: ["ops"],
      },
    };

    const registry: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return plugins.runtime;
        if (slot === "agent") return plugins.agent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier" && name === "ops") return opsNotifier;
        if (slot === "notifier" && name === "desktop") return alertsNotifier;
        return null;
      }),
    };

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "approved", pr: makePR() }),
      registry,
      configOverride: configWithSharedPluginAliases,
    });

    await lm.check("app-1");

    expect(opsNotifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: "merge.completed" }),
    );
    expect(alertsNotifier.notify).not.toHaveBeenCalled();
  });

  it("CI failure tracker survives status oscillation and escalates after retries", async () => {
    const notifier = createMockNotifier();

    config.reactions = {
      "ci-failed": {
        auto: true,
        action: "send-to-agent",
        message: "CI is failing. Fix it.",
        retries: 2,
        escalateAfter: 2,
      },
    };

    const batchMock = mockBatchEnrichment({ ciStatus: "failing" });
    const mockSCM = createMockSCM({
      enrichSessionsPRBatch: batchMock,
    });

    const registry: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return plugins.runtime;
        if (slot === "agent") return plugins.agent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier" && name === "desktop") return notifier;
        return null;
      }),
    };

    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
    });

    // Oscillation 1: pr_open → ci_failed (attempt 1 — send to agent)
    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("ci_failed");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);
    vi.mocked(mockSessionManager.send).mockClear();

    // CI starts passing → ci_failed → pr_open (tracker survives)
    vi.mocked(mockSCM.enrichSessionsPRBatch!).mockImplementation(
      mockBatchEnrichment({ ciStatus: "passing" }),
    );
    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("pr_open");
    expect(mockSessionManager.send).not.toHaveBeenCalled();

    // Oscillation 2: pr_open → ci_failed (attempt 2 — send to agent)
    vi.mocked(mockSCM.enrichSessionsPRBatch!).mockImplementation(
      mockBatchEnrichment({ ciStatus: "failing" }),
    );
    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("ci_failed");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);
    vi.mocked(mockSessionManager.send).mockClear();

    // CI passes again
    vi.mocked(mockSCM.enrichSessionsPRBatch!).mockImplementation(
      mockBatchEnrichment({ ciStatus: "passing" }),
    );
    await lm.check("app-1");

    // Oscillation 3: pr_open → ci_failed (attempt 3 > retries:2 — escalate)
    vi.mocked(mockSCM.enrichSessionsPRBatch!).mockImplementation(
      mockBatchEnrichment({ ciStatus: "failing" }),
    );
    vi.mocked(notifier.notify).mockClear();
    await lm.check("app-1");

    // Should NOT send to agent — should escalate to human
    expect(mockSessionManager.send).not.toHaveBeenCalled();
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: "reaction.escalated" }),
    );

    // After escalation, tracker is marked escalated — needs 2 stable passing polls to clear
    vi.mocked(mockSCM.enrichSessionsPRBatch!).mockImplementation(
      mockBatchEnrichment({ ciStatus: "passing" }),
    );
    await lm.check("app-1"); // stableCount = 1
    await lm.check("app-1"); // stableCount = 2 → clearReactionTracker
    vi.mocked(mockSessionManager.send).mockClear();
    vi.mocked(notifier.notify).mockClear();

    vi.mocked(mockSCM.enrichSessionsPRBatch!).mockImplementation(
      mockBatchEnrichment({ ciStatus: "failing" }),
    );
    await lm.check("app-1");

    // Fresh budget — sends to agent (attempt 1 again), not escalate
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);
    expect(notifier.notify).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "reaction.escalated" }),
    );
  });

  it("merge conflict tracker resets on resolve — recurrence gets fresh budget", async () => {
    const notifier = createMockNotifier();

    config.reactions = {
      "merge-conflicts": {
        auto: true,
        action: "send-to-agent",
        message: "Resolve merge conflicts.",
        retries: 1,
        escalateAfter: 1,
      },
    };

    const batchMock = mockBatchEnrichment({ hasConflicts: true });
    const mockSCM = createMockSCM({
      enrichSessionsPRBatch: batchMock,
    });

    const registry: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return plugins.runtime;
        if (slot === "agent") return plugins.agent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier" && name === "desktop") return notifier;
        return null;
      }),
    };

    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
    });

    // First conflict — dispatched to agent (attempt 1)
    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);
    vi.mocked(mockSessionManager.send).mockClear();

    // Conflicts resolve — tracker clears (incident boundary)
    vi.mocked(mockSCM.enrichSessionsPRBatch!).mockImplementation(
      mockBatchEnrichment({ hasConflicts: false }),
    );
    await lm.check("app-1");
    const metadata = readMetadataRaw(env.sessionsDir, "app-1");
    expect(metadata?.["lastMergeConflictDispatched"]).toBeFalsy();

    // Conflicts recur — fresh tracker (attempt 1 again, not 2)
    vi.mocked(mockSCM.enrichSessionsPRBatch!).mockImplementation(
      mockBatchEnrichment({ hasConflicts: true }),
    );
    vi.mocked(notifier.notify).mockClear();
    await lm.check("app-1");

    // Fresh budget — sends to agent (attempt 1), not escalate
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);
    expect(notifier.notify).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "reaction.escalated" }),
    );
  });

  it("non-persistent reaction keys still clear on status exit", async () => {
    config.reactions = {
      "changes-requested": {
        auto: true,
        action: "send-to-agent",
        message: "Address review comments.",
        retries: 1,
        escalateAfter: 1,
      },
    };

    const batchMock = mockBatchEnrichment({ reviewDecision: "changes_requested" });
    const mockSCM = createMockSCM({
      enrichSessionsPRBatch: batchMock,
    });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
    });

    // Transition to changes_requested (attempt 1 — send to agent)
    await lm.check("app-1");
    expect(lm.getStates().get("app-1")).toBe("changes_requested");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);
    vi.mocked(mockSessionManager.send).mockClear();

    // Transition away — tracker clears (non-persistent key)
    vi.mocked(mockSCM.enrichSessionsPRBatch!).mockImplementation(
      mockBatchEnrichment({ ciStatus: "passing", reviewDecision: "none" }),
    );
    await lm.check("app-1");

    // Transition back — fresh tracker (attempt 1 again, NOT 2)
    vi.mocked(mockSCM.enrichSessionsPRBatch!).mockImplementation(
      mockBatchEnrichment({ reviewDecision: "changes_requested" }),
    );
    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);

    // Transition away and back again — still attempt 1, not escalating
    vi.mocked(mockSCM.enrichSessionsPRBatch!).mockImplementation(
      mockBatchEnrichment({ ciStatus: "passing", reviewDecision: "none" }),
    );
    await lm.check("app-1");
    vi.mocked(mockSessionManager.send).mockClear();

    vi.mocked(mockSCM.enrichSessionsPRBatch!).mockImplementation(
      mockBatchEnrichment({ reviewDecision: "changes_requested" }),
    );
    await lm.check("app-1");
    // With retries:1, attempt 2 would escalate. But tracker was cleared,
    // so this is attempt 1 again — still sends to agent.
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);
  });

  it("CI escalation silences further dispatches — clears only after stable CI pass", async () => {
    // retries:1 → attempt 1 sends, attempt 2 escalates.
    // After escalation: tracker.escalated=true silences subsequent oscillations.
    // Tracker clears only after 2 consecutive passing polls; then next failure gets fresh budget.
    const notifier = createMockNotifier();

    config.reactions = {
      "ci-failed": {
        auto: true,
        action: "send-to-agent",
        message: "CI is failing. Fix it.",
        retries: 1,
        escalateAfter: 1,
      },
    };

    const batchMock = mockBatchEnrichment({ ciStatus: "failing" });
    const mockSCM = createMockSCM({
      enrichSessionsPRBatch: batchMock,
    });

    const registry: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return plugins.runtime;
        if (slot === "agent") return plugins.agent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier" && name === "desktop") return notifier;
        return null;
      }),
    };

    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
    });

    // Oscillation 1: pr_open → ci_failed (attempt 1 — send to agent)
    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);
    vi.mocked(mockSessionManager.send).mockClear();

    // CI passes briefly (ci_failed → pr_open, stableCount = 1)
    vi.mocked(mockSCM.enrichSessionsPRBatch!).mockImplementation(
      mockBatchEnrichment({ ciStatus: "passing" }),
    );
    await lm.check("app-1");

    // Oscillation 2: pr_open → ci_failed (attempt 2 > retries:1 — escalate, tracker.escalated = true)
    vi.mocked(mockSCM.enrichSessionsPRBatch!).mockImplementation(
      mockBatchEnrichment({ ciStatus: "failing" }),
    );
    await lm.check("app-1");
    expect(mockSessionManager.send).not.toHaveBeenCalled();
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: "reaction.escalated" }),
    );
    vi.mocked(notifier.notify).mockClear();

    // CI passes once (stableCount = 1 — not enough to clear yet)
    vi.mocked(mockSCM.enrichSessionsPRBatch!).mockImplementation(
      mockBatchEnrichment({ ciStatus: "passing" }),
    );
    await lm.check("app-1");

    // Oscillation 3: pr_open → ci_failed — escalated tracker short-circuits, NO dispatch
    vi.mocked(mockSCM.enrichSessionsPRBatch!).mockImplementation(
      mockBatchEnrichment({ ciStatus: "failing" }),
    );
    await lm.check("app-1");
    expect(mockSessionManager.send).not.toHaveBeenCalled();
    expect(notifier.notify).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "reaction.escalated" }),
    );
    vi.mocked(mockSessionManager.send).mockClear();
    vi.mocked(notifier.notify).mockClear();

    // CI passes twice stably (stableCount → 1 → 2 → tracker cleared)
    vi.mocked(mockSCM.enrichSessionsPRBatch!).mockImplementation(
      mockBatchEnrichment({ ciStatus: "passing" }),
    );
    await lm.check("app-1"); // stableCount = 1
    await lm.check("app-1"); // stableCount = 2 → clearReactionTracker

    // Oscillation 4: pr_open → ci_failed — fresh budget: attempt 1, sends (not escalate)
    vi.mocked(mockSCM.enrichSessionsPRBatch!).mockImplementation(
      mockBatchEnrichment({ ciStatus: "failing" }),
    );
    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);
    expect(notifier.notify).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "reaction.escalated" }),
    );
  });

  it("single passing poll does not reset escalated ci-failed tracker", async () => {
    // Regression: one passing poll must NOT clear the tracker. Requires 2 consecutive passing polls.
    const notifier = createMockNotifier();

    config.reactions = {
      "ci-failed": {
        auto: true,
        action: "send-to-agent",
        message: "CI is failing.",
        retries: 1,
        escalateAfter: 1,
      },
    };

    const batchMock = mockBatchEnrichment({ ciStatus: "failing" });
    const mockSCM = createMockSCM({ enrichSessionsPRBatch: batchMock });

    const registry: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return plugins.runtime;
        if (slot === "agent") return plugins.agent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier" && name === "desktop") return notifier;
        return null;
      }),
    };

    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
    });

    // Reach escalated state: attempt 1 → send, attempt 2 → escalate
    await lm.check("app-1"); // pr_open → ci_failed: attempt 1, send
    vi.mocked(mockSessionManager.send).mockClear();
    vi.mocked(mockSCM.enrichSessionsPRBatch!).mockImplementation(mockBatchEnrichment({ ciStatus: "passing" }));
    await lm.check("app-1"); // ci_failed → pr_open
    vi.mocked(mockSCM.enrichSessionsPRBatch!).mockImplementation(mockBatchEnrichment({ ciStatus: "failing" }));
    await lm.check("app-1"); // pr_open → ci_failed: attempt 2 → escalate
    expect(notifier.notify).toHaveBeenCalledWith(expect.objectContaining({ type: "reaction.escalated" }));
    vi.mocked(notifier.notify).mockClear();

    // ONE passing poll (stableCount = 1, not enough)
    vi.mocked(mockSCM.enrichSessionsPRBatch!).mockImplementation(mockBatchEnrichment({ ciStatus: "passing" }));
    await lm.check("app-1");

    // Next CI failure: tracker still escalated → short-circuit
    vi.mocked(mockSCM.enrichSessionsPRBatch!).mockImplementation(mockBatchEnrichment({ ciStatus: "failing" }));
    await lm.check("app-1");
    expect(mockSessionManager.send).not.toHaveBeenCalled();
    expect(notifier.notify).not.toHaveBeenCalledWith(expect.objectContaining({ type: "reaction.escalated" }));
  });

  it("pending CI does not count toward ci-failed tracker resolution", async () => {
    // Regression: real CI goes failing → pending (new run started) → failing.
    // "pending" must NOT count as resolution — only "passing" does.
    // Without this, 2 pending polls between failures wipe the tracker and we're back at #1409.
    config.reactions = {
      "ci-failed": {
        auto: true,
        action: "send-to-agent",
        message: "CI is failing.",
        retries: 2,
      },
    };

    const batchMock = mockBatchEnrichment({ ciStatus: "failing" });
    const mockSCM = createMockSCM({ enrichSessionsPRBatch: batchMock });

    const registry: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "runtime") return plugins.runtime;
        if (slot === "agent") return plugins.agent;
        if (slot === "scm") return mockSCM;
        return null;
      }),
    };

    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
    });

    // CI failing: pr_open → ci_failed, attempt 1 — send
    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);
    vi.mocked(mockSessionManager.send).mockClear();

    // CI goes pending (agent pushed a fix, new run started): ci_failed → pr_open
    vi.mocked(mockSCM.enrichSessionsPRBatch!).mockImplementation(mockBatchEnrichment({ ciStatus: "pending" }));
    await lm.check("app-1"); // stableCount must NOT increment
    await lm.check("app-1"); // two pending polls — must NOT clear tracker

    // CI fails again (run completed failing): pr_open → ci_failed, attempt 2 — send
    vi.mocked(mockSCM.enrichSessionsPRBatch!).mockImplementation(mockBatchEnrichment({ ciStatus: "failing" }));
    await lm.check("app-1");
    // If pending had wrongly cleared the tracker, this would be attempt 1 (fresh), not attempt 2.
    // Attempt 2 ≤ retries:2 → sends to agent (not escalates)
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);
    vi.mocked(mockSessionManager.send).mockClear();

    // CI goes pending again, then failing — attempt 3 > retries:2 → escalate
    vi.mocked(mockSCM.enrichSessionsPRBatch!).mockImplementation(mockBatchEnrichment({ ciStatus: "pending" }));
    await lm.check("app-1"); // pending: no clear
    await lm.check("app-1"); // pending: no clear
    vi.mocked(mockSCM.enrichSessionsPRBatch!).mockImplementation(mockBatchEnrichment({ ciStatus: "failing" }));
    await lm.check("app-1");
    expect(mockSessionManager.send).not.toHaveBeenCalled(); // escalated, not sent to agent
  });

  it("only passing CI resets ci-failed tracker — pending mid-run does not interfere", async () => {
    // Complementary to previous: failing → pending(many) → passing(2) → failing SHOULD clear.
    // Pending during CI run doesn't block resolution; only the final passing state matters.
    const notifier = createMockNotifier();

    config.reactions = {
      "ci-failed": {
        auto: true,
        action: "send-to-agent",
        message: "CI is failing.",
        retries: 1,
        escalateAfter: 1,
      },
    };

    const batchMock = mockBatchEnrichment({ ciStatus: "failing" });
    const mockSCM = createMockSCM({ enrichSessionsPRBatch: batchMock });

    const registry: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return plugins.runtime;
        if (slot === "agent") return plugins.agent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier" && name === "desktop") return notifier;
        return null;
      }),
    };

    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
    });

    // Reach escalated state: attempt 1 → send, attempt 2 → escalate
    await lm.check("app-1"); // attempt 1, send
    vi.mocked(mockSessionManager.send).mockClear();
    vi.mocked(mockSCM.enrichSessionsPRBatch!).mockImplementation(mockBatchEnrichment({ ciStatus: "passing" }));
    await lm.check("app-1"); // ci_failed → pr_open
    vi.mocked(mockSCM.enrichSessionsPRBatch!).mockImplementation(mockBatchEnrichment({ ciStatus: "failing" }));
    await lm.check("app-1"); // attempt 2 → escalate
    vi.mocked(notifier.notify).mockClear();

    // CI goes pending (new run) — stableCount stays 0, does NOT progress toward resolution
    vi.mocked(mockSCM.enrichSessionsPRBatch!).mockImplementation(mockBatchEnrichment({ ciStatus: "pending" }));
    await lm.check("app-1");
    await lm.check("app-1");
    await lm.check("app-1"); // many pending polls — stableCount never reaches threshold

    // CI finally passes (2 stable polls) → tracker cleared
    vi.mocked(mockSCM.enrichSessionsPRBatch!).mockImplementation(mockBatchEnrichment({ ciStatus: "passing" }));
    await lm.check("app-1"); // stableCount = 1
    await lm.check("app-1"); // stableCount = 2 → clearReactionTracker

    // Next CI failure gets fresh budget: attempt 1, send
    vi.mocked(mockSCM.enrichSessionsPRBatch!).mockImplementation(mockBatchEnrichment({ ciStatus: "failing" }));
    await lm.check("app-1");
    expect(mockSessionManager.send).toHaveBeenCalledTimes(1);
    expect(notifier.notify).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "reaction.escalated" }),
    );
  });

  it("merge-conflict notify action preserves warning priority", async () => {
    const notifier = createMockNotifier();

    config.reactions = {
      "merge-conflicts": {
        auto: true,
        action: "notify",
      },
    };
    config.notificationRouting = {
      urgent: ["desktop"],
      action: ["desktop"],
      warning: ["desktop"],
      info: [],
    };

    const batchMock = mockBatchEnrichment({ hasConflicts: true });
    const mockSCM = createMockSCM({
      enrichSessionsPRBatch: batchMock,
    });

    const registry: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return plugins.runtime;
        if (slot === "agent") return plugins.agent;
        if (slot === "scm") return mockSCM;
        if (slot === "notifier" && name === "desktop") return notifier;
        return null;
      }),
    };

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
    });

    await lm.check("app-1");

    // With info routing empty and warning routing to desktop,
    // notify should fire at "warning" priority (not "info")
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "reaction.triggered",
        priority: "warning",
      }),
    );
  });
});

describe("pollAll terminal status accounting", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("treats all TERMINAL_STATUSES as inactive for all-complete", async () => {
    const notifier = createMockNotifier();
    const registryWithNotifier: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return plugins.runtime;
        if (slot === "agent") return plugins.agent;
        if (slot === "notifier" && name === "desktop") return notifier;
        return null;
      }),
    };

    // All sessions in various terminal states — should count as inactive
    const terminalSessions = [
      makeSession({ id: "s-1", status: "killed" as SessionStatus }),
      makeSession({ id: "s-2", status: "merged" as SessionStatus }),
      makeSession({ id: "s-3", status: "done" as SessionStatus }),
      makeSession({ id: "s-4", status: "errored" as SessionStatus }),
      makeSession({ id: "s-5", status: "terminated" as SessionStatus }),
      makeSession({ id: "s-6", status: "cleanup" as SessionStatus }),
    ];

    vi.mocked(mockSessionManager.list).mockResolvedValue(terminalSessions);

    // Route info-priority notifications to desktop so we can observe them
    config.notificationRouting.info = ["desktop"];
    config.reactions = {
      "all-complete": { auto: true, action: "notify" },
    };

    const lm = createLifecycleManager({
      config,
      registry: registryWithNotifier,
      sessionManager: mockSessionManager,
    });

    lm.start(60_000);
    // Let the immediate pollAll() run
    await vi.advanceTimersByTimeAsync(0);

    expect(notifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: "reaction.triggered" }),
    );

    lm.stop();
  });

  it("does not fire all-complete when a session is in non-terminal status like done is missing", async () => {
    const notifier = createMockNotifier();
    const registryWithNotifier: PluginRegistry = {
      ...mockRegistry,
      get: vi.fn().mockImplementation((slot: string, name: string) => {
        if (slot === "runtime") return plugins.runtime;
        if (slot === "agent") return plugins.agent;
        if (slot === "notifier" && name === "desktop") return notifier;
        return null;
      }),
    };

    // Mix of terminal and active sessions
    const sessions = [
      makeSession({ id: "s-1", status: "killed" as SessionStatus }),
      makeSession({ id: "s-2", status: "working" as SessionStatus }),
    ];

    vi.mocked(mockSessionManager.list).mockResolvedValue(sessions);

    config.reactions = {
      "all-complete": { auto: true, action: "notify" },
    };

    const lm = createLifecycleManager({
      config,
      registry: registryWithNotifier,
      sessionManager: mockSessionManager,
    });

    lm.start(60_000);
    await vi.advanceTimersByTimeAsync(0);

    // all-complete should NOT have fired — "working" is still active
    const allCompleteNotifications = vi
      .mocked(notifier.notify)
      .mock.calls.filter((call: unknown[]) => {
        const event = call[0] as Record<string, unknown> | undefined;
        const data = event?.data as Record<string, unknown> | undefined;
        return event?.type === "reaction.triggered" && data?.reactionKey === "all-complete";
      });
    expect(allCompleteNotifications).toHaveLength(0);

    lm.stop();
  });

  it("skips polling sessions in terminal statuses like done or errored", async () => {
    const isolatedPlugins = createMockPlugins();
    const isolatedRegistry = createMockRegistry({
      runtime: isolatedPlugins.runtime,
      agent: isolatedPlugins.agent,
    });

    // Sessions in "done" / "errored" should not be polled
    const sessions = [
      makeSession({ id: "s-done", status: "done" as SessionStatus }),
      makeSession({ id: "s-errored", status: "errored" as SessionStatus }),
    ];

    vi.mocked(mockSessionManager.list).mockResolvedValue(sessions);

    // If these sessions were polled, determineStatus would call runtime.isAlive.
    // Reset call count and verify it's not called.
    vi.mocked(isolatedPlugins.runtime.isAlive).mockClear();

    const lm = createLifecycleManager({
      config,
      registry: isolatedRegistry,
      sessionManager: mockSessionManager,
    });

    lm.start(60_000);
    await vi.advanceTimersByTimeAsync(0);

    // Terminal sessions should not be polled — runtime.isAlive should not be called
    expect(isolatedPlugins.runtime.isAlive).not.toHaveBeenCalled();

    lm.stop();
  });
});

describe("getStates", () => {
  it("returns copy of states map", async () => {
    const lm = setupCheck("app-1", {
      session: makeSession({ status: "spawning" }),
    });

    await lm.check("app-1");

    const states = lm.getStates();
    expect(states.get("app-1")).toBe("working");

    // Modifying returned map shouldn't affect internal state
    states.set("app-1", "killed");
    expect(lm.getStates().get("app-1")).toBe("working");
  });
});

describe("rate limiting optimizations", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // PR with owner/repo that matches the test config's "org/my-app"
  function makeMatchingPR() {
    return makePR({ owner: "org", repo: "my-app" });
  }

  it("skips getMergeability() when batch enrichment has hasConflicts data", async () => {
    config.reactions = {
      "merge-conflicts": {
        auto: true,
        action: "send-to-agent",
        message: "Resolve conflicts.",
      },
    };

    const pr = makeMatchingPR();
    const getMergeabilityMock = vi.fn();
    const mockSCM = createMockSCM({
      getMergeability: getMergeabilityMock,
      getCISummary: vi.fn().mockResolvedValue("passing"),
      enrichSessionsPRBatch: vi.fn().mockResolvedValue(
        new Map([
          [
            `${pr.owner}/${pr.repo}#${pr.number}`,
            {
              state: "open" as const,
              ciStatus: "passing" as const,
              reviewDecision: "none" as const,
              mergeable: false,
              hasConflicts: true,
            },
          ],
        ]),
      ),
    });

    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    const session = makeSession({ id: "s-1", status: "pr_open", pr, workspacePath: null });
    vi.mocked(mockSessionManager.list).mockResolvedValue([session]);
    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    const lm = createLifecycleManager({ config, registry, sessionManager: mockSessionManager });
    lm.start(60_000);
    await vi.advanceTimersByTimeAsync(0);
    lm.stop();

    // getMergeability() should NOT be called — batch enrichment has the data
    expect(getMergeabilityMock).not.toHaveBeenCalled();
    // Conflict notification should have been sent
    expect(mockSessionManager.send).toHaveBeenCalledWith("s-1", "Resolve conflicts.");
  });

  it("skips getCIChecks() when batch enrichment has ciChecks data", async () => {
    config.reactions = {
      "ci-failed": {
        auto: true,
        action: "send-to-agent",
        message: "CI failing.",
        retries: 3,
        escalateAfter: 3,
      },
    };

    const pr = makeMatchingPR();
    const getCIChecksMock = vi.fn();
    const mockSCM = createMockSCM({
      getCIChecks: getCIChecksMock,
      getCISummary: vi.fn().mockResolvedValue("failing"),
      enrichSessionsPRBatch: vi.fn().mockResolvedValue(
        new Map([
          [
            `${pr.owner}/${pr.repo}#${pr.number}`,
            {
              state: "open" as const,
              ciStatus: "failing" as const,
              reviewDecision: "none" as const,
              mergeable: false,
              hasConflicts: false,
              ciChecks: [
                {
                  name: "lint",
                  status: "failed" as const,
                  conclusion: "FAILURE",
                  url: "https://example.com/lint",
                },
                { name: "test", status: "passed" as const, conclusion: "SUCCESS" },
              ],
            },
          ],
        ]),
      ),
    });

    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    // Start with pr_open state so that ci_failed transition happens on first poll
    const session = makeSession({ id: "s-2", status: "pr_open", pr, workspacePath: null });
    vi.mocked(mockSessionManager.list).mockResolvedValue([session]);
    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    const lm = createLifecycleManager({ config, registry, sessionManager: mockSessionManager });
    lm.start(60_000);
    // First poll: transitions to ci_failed and sends the enriched reaction message.
    await vi.advanceTimersByTimeAsync(0);

    // getCIChecks() should NOT be called — batch enrichment has ciChecks
    expect(getCIChecksMock).not.toHaveBeenCalled();
    // Detailed message with lint check name/URL should be sent
    const calls = vi.mocked(mockSessionManager.send).mock.calls;
    const sentMessages = calls.map((c) => c[1] as string);
    const detailMessage = sentMessages.find((m) => m.includes("lint"));
    expect(detailMessage).toBeDefined();
    expect(detailMessage).toContain("https://example.com/lint");
    // Passing check should not be included
    expect(detailMessage).not.toContain("test");

    lm.stop();
  });

  it("throttles review backlog API calls to at most once per 2 minutes", async () => {
    config.reactions = {
      "changes-requested": {
        auto: true,
        action: "send-to-agent",
        message: "Handle review comments.",
      },
    };

    const getReviewThreadsMock = vi.fn().mockResolvedValue({
      threads: [
        {
          id: "c1",
          author: "reviewer",
          body: "Please fix this",
          path: "src/index.ts",
          line: 10,
          isResolved: false,
          createdAt: new Date(),
          url: "https://example.com/comment/1",
          isBot: false,
        },
      ],
      reviews: [],
    });
    const mockSCM = createMockSCM({
      getReviewThreads: getReviewThreadsMock,
    });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    const lm = setupCheck("app-1", {
      session: makeSession({ status: "pr_open", pr: makePR() }),
      registry,
    });

    // First check: API called, dispatch happens
    await lm.check("app-1");
    expect(getReviewThreadsMock).toHaveBeenCalledTimes(1);
    vi.mocked(mockSessionManager.send).mockClear();
    getReviewThreadsMock.mockClear();

    // Second check immediately after: throttled — API NOT called
    await lm.check("app-1");
    expect(getReviewThreadsMock).not.toHaveBeenCalled();
    expect(mockSessionManager.send).not.toHaveBeenCalled();

    // Advance time past the 2-minute throttle window
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000 + 100);

    // Third check: throttle expired — API called again
    await lm.check("app-1");
    expect(getReviewThreadsMock).toHaveBeenCalledTimes(1);
  });

  it("clears review backlog tracking when PR is closed", async () => {
    const getPendingMock = vi.fn();
    const getAutomatedMock = vi.fn();
    const mockSCM = createMockSCM({
      getPRState: vi.fn().mockResolvedValue("closed"),
      getPendingComments: getPendingMock,
      enrichSessionsPRBatch: mockBatchEnrichment({ state: "closed" }),
    });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
    });

    const lm = setupCheck("app-1", {
      session: makeSession({
        status: "pr_open",
        pr: makePR(),
        metadata: {
          lastPendingReviewFingerprint: "fingerprint",
          lastPendingReviewDispatchHash: "dispatch",
          lastPendingReviewDispatchAt: "2025-01-01T00:00:00.000Z",
          lastAutomatedReviewFingerprint: "auto-fingerprint",
          lastAutomatedReviewDispatchHash: "auto-dispatch",
          lastAutomatedReviewDispatchAt: "2025-01-01T00:00:00.000Z",
        },
      }),
      registry,
    });

    await lm.check("app-1");

    const metadata = readMetadataRaw(env.sessionsDir, "app-1");
    expect(metadata?.["lastPendingReviewFingerprint"]).toBeFalsy();
    expect(metadata?.["lastPendingReviewDispatchHash"]).toBeFalsy();
    expect(metadata?.["lastPendingReviewDispatchAt"]).toBeFalsy();
    expect(metadata?.["lastAutomatedReviewFingerprint"]).toBeFalsy();
    expect(metadata?.["lastAutomatedReviewDispatchHash"]).toBeFalsy();
    expect(metadata?.["lastAutomatedReviewDispatchAt"]).toBeFalsy();
    expect(getPendingMock).not.toHaveBeenCalled();
    expect(getAutomatedMock).not.toHaveBeenCalled();
  });
});
describe("summary pinning", () => {
  it("pins first quality summary when pinnedSummary not set", async () => {
    const session = makeSession({
      status: "working",
      agentInfo: {
        summary: "Implementing authentication flow",
        summaryIsFallback: false,
        agentSessionId: "abc",
      },
      metadata: {},
    });
    const lm = setupCheck("app-1", { session });

    await lm.check("app-1");

    const meta = readMetadataRaw(env.sessionsDir, "app-1");
    expect(meta!["pinnedSummary"]).toBe("Implementing authentication flow");
  });

  it("skips pinning when summaryIsFallback is true", async () => {
    const session = makeSession({
      status: "working",
      agentInfo: {
        summary: "You are working on issue #42...",
        summaryIsFallback: true,
        agentSessionId: "abc",
      },
      metadata: {},
    });
    const lm = setupCheck("app-1", { session });

    await lm.check("app-1");

    const meta = readMetadataRaw(env.sessionsDir, "app-1");
    expect(meta!["pinnedSummary"]).toBeUndefined();
  });

  it("skips pinning when pinnedSummary already exists", async () => {
    const session = makeSession({
      status: "working",
      agentInfo: {
        summary: "New summary that should not overwrite",
        summaryIsFallback: false,
        agentSessionId: "abc",
      },
      metadata: { pinnedSummary: "Original pinned summary" },
    });
    const lm = setupCheck("app-1", {
      session,
      metaOverrides: { pinnedSummary: "Original pinned summary" },
    });

    await lm.check("app-1");

    const meta = readMetadataRaw(env.sessionsDir, "app-1");
    expect(meta!["pinnedSummary"]).toBe("Original pinned summary");
  });

  it("skips pinning when trimmed summary is shorter than 5 chars", async () => {
    const session = makeSession({
      status: "working",
      agentInfo: {
        summary: "  Hi ",
        summaryIsFallback: false,
        agentSessionId: "abc",
      },
      metadata: {},
    });
    const lm = setupCheck("app-1", { session });

    await lm.check("app-1");

    const meta = readMetadataRaw(env.sessionsDir, "app-1");
    expect(meta!["pinnedSummary"]).toBeUndefined();
  });

  it("does not throw when metadata write fails", async () => {
    const session = makeSession({
      status: "working",
      agentInfo: {
        summary: "Valid summary for pinning",
        summaryIsFallback: false,
        agentSessionId: "abc",
      },
      metadata: {},
    });
    // Use a config with invalid path to trigger write failure
    const badConfig = {
      ...config,
      projects: {
        "my-app": {
          ...config.projects["my-app"],
          path: "/nonexistent/path/that/does/not/exist",
        },
      },
    };
    const lm = setupCheck("app-1", { session, configOverride: badConfig });

    // Should not throw — error is swallowed
    await expect(lm.check("app-1")).resolves.not.toThrow();
  });
});

describe("auto-cleanup on merge (#1309)", () => {
  function mergedScm() {
    return createMockSCM({
      getPRState: vi.fn().mockResolvedValue("merged"),
      enrichSessionsPRBatch: mockBatchEnrichment({ state: "merged", ciStatus: "none" }),
    });
  }

  function configWithLifecycle(
    overrides: Partial<{ autoCleanupOnMerge: boolean; mergeCleanupIdleGraceMs: number }>,
  ): OrchestratorConfig {
    return {
      ...config,
      lifecycle: {
        autoCleanupOnMerge: overrides.autoCleanupOnMerge ?? true,
        mergeCleanupIdleGraceMs: overrides.mergeCleanupIdleGraceMs ?? 300_000,
      },
    };
  }

  it("kills session with reason=pr_merged when PR merges and agent is idle", async () => {
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mergedScm(),
    });
    const lm = setupCheck("app-1", {
      session: makeSession({ status: "approved", pr: makePR(), activity: "idle" }),
      registry,
      configOverride: configWithLifecycle({}),
    });

    await lm.check("app-1");

    expect(mockSessionManager.kill).toHaveBeenCalledWith("app-1", {
      purgeOpenCode: true,
      reason: "pr_merged",
    });
  });

  it("defers cleanup when agent is still active and records pending marker", async () => {
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mergedScm(),
    });
    const lm = setupCheck("app-1", {
      session: makeSession({ status: "approved", pr: makePR(), activity: "active" }),
      registry,
      configOverride: configWithLifecycle({}),
    });

    await lm.check("app-1");

    expect(mockSessionManager.kill).not.toHaveBeenCalled();
    const meta = readMetadataRaw(env.sessionsDir, "app-1");
    expect(meta?.["mergedPendingCleanupSince"]).toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(meta?.["status"]).toBe("merged");
  });

  it("forces cleanup after grace window elapses even if agent is still active", async () => {
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mergedScm(),
    });
    const pendingSince = new Date(Date.now() - 10 * 60_000).toISOString(); // 10min ago
    const lm = setupCheck("app-1", {
      session: makeSession({
        status: "approved",
        pr: makePR(),
        activity: "active",
        metadata: { mergedPendingCleanupSince: pendingSince },
      }),
      registry,
      configOverride: configWithLifecycle({ mergeCleanupIdleGraceMs: 300_000 }),
      metaOverrides: { mergedPendingCleanupSince: pendingSince },
    });

    await lm.check("app-1");

    expect(mockSessionManager.kill).toHaveBeenCalledWith("app-1", {
      purgeOpenCode: true,
      reason: "pr_merged",
    });
  });

  it("does not trigger cleanup when autoCleanupOnMerge is disabled", async () => {
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mergedScm(),
    });
    const lm = setupCheck("app-1", {
      session: makeSession({ status: "approved", pr: makePR(), activity: "idle" }),
      registry,
      configOverride: configWithLifecycle({ autoCleanupOnMerge: false }),
    });

    await lm.check("app-1");

    expect(mockSessionManager.kill).not.toHaveBeenCalled();
    expect(lm.getStates().get("app-1")).toBe("merged");
  });

  it("does not trigger cleanup for terminated/killed sessions (no self-recursion)", async () => {
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
    });
    const lm = setupCheck("app-1", {
      session: makeSession({ status: "killed", activity: "exited" }),
      registry,
      configOverride: configWithLifecycle({}),
    });

    await lm.check("app-1");

    expect(mockSessionManager.kill).not.toHaveBeenCalled();
  });

  it("retains merged status when kill() fails so the next poll retries", async () => {
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mergedScm(),
    });
    vi.mocked(mockSessionManager.kill).mockRejectedValueOnce(new Error("tmux busy"));
    const lm = setupCheck("app-1", {
      session: makeSession({ status: "approved", pr: makePR(), activity: "idle" }),
      registry,
      configOverride: configWithLifecycle({}),
    });

    await lm.check("app-1");

    expect(mockSessionManager.kill).toHaveBeenCalledTimes(1);
    const meta = readMetadataRaw(env.sessionsDir, "app-1");
    expect(meta?.["status"]).toBe("merged");
    expect(meta?.["mergedPendingCleanupSince"]).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});

describe("event enrichment", () => {
  it("includes PR context in event data when session has PR", async () => {
    const notifier = createMockNotifier();
    const mockSCM = createMockSCM({ getPRState: vi.fn().mockResolvedValue("closed") });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
      notifier,
    });

    const session = makeSession({
      status: "pr_open",
      pr: makePR({ number: 42, url: "https://github.com/org/repo/pull/42" }),
      branch: "feat/test-123",
    });
    const lm = setupCheck("app-1", {
      session,
      registry,
      configOverride: {
        ...config,
        notificationRouting: {
          ...config.notificationRouting,
          info: ["desktop"],
        },
      },
    });

    await lm.check("app-1");

    expect(notifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "pr.closed",
        data: expect.objectContaining({
          context: expect.objectContaining({
            pr: expect.objectContaining({
              url: "https://github.com/org/repo/pull/42",
              number: 42,
            }),
            branch: "feat/test-123",
          }),
          schemaVersion: 2,
        }),
      }),
    );
  });

  it("includes issue context in event data when session has issue", async () => {
    const notifier = createMockNotifier();
    const mockSCM = createMockSCM({ getPRState: vi.fn().mockResolvedValue("closed") });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
      notifier,
    });

    const session = makeSession({
      status: "pr_open",
      pr: makePR(),
      issueId: "INT-123",
      metadata: { issueTitle: "Fix login bug" },
    });
    const lm = setupCheck("app-1", {
      session,
      registry,
      configOverride: {
        ...config,
        notificationRouting: {
          ...config.notificationRouting,
          info: ["desktop"],
        },
      },
    });

    await lm.check("app-1");

    expect(notifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "pr.closed",
        data: expect.objectContaining({
          context: expect.objectContaining({
            issueId: "INT-123",
            issueTitle: "Fix login bug",
          }),
          schemaVersion: 2,
        }),
      }),
    );
  });

  it("gracefully omits PR context when session has no PR", async () => {
    const notifier = createMockNotifier();
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      notifier,
    });

    // Create a session without PR that will transition to needs_input
    const session = makeSession({
      status: "working",
      pr: null,
      issueId: "INT-456",
    });
    // Mock activity detection to return waiting_input
    vi.mocked(plugins.agent.getActivityState).mockResolvedValue({
      state: "waiting_input",
      timestamp: new Date(),
    });

    const lm = setupCheck("app-1", {
      session,
      registry,
      configOverride: {
        ...config,
        notificationRouting: {
          ...config.notificationRouting,
          urgent: ["desktop"],
        },
      },
    });

    await lm.check("app-1");

    expect(notifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session.needs_input",
        data: expect.objectContaining({
          context: expect.objectContaining({
            pr: null,
            issueId: "INT-456",
          }),
          schemaVersion: 2,
        }),
      }),
    );
  });
});
