/**
 * Tests for session serialization and PR enrichment
 */

import { describe, it, expect, vi } from "vitest";
import {
  createInitialCanonicalLifecycle,
  type Session,
  type PRInfo,
  type Agent,
  type Tracker,
  type ProjectConfig,
  type OrchestratorConfig,
  type PluginRegistry,
} from "@aoagents/ao-core";
import {
  sessionToDashboard,
  resolveProject,
  enrichSessionPR,
  enrichSessionIssue,
  readPREnrichmentFromMetadata,
  enrichSessionAgentSummary,
  enrichSessionIssueTitle,
  enrichSessionsMetadata,
  enrichSessionsMetadataFast,
  computeStats,
  listDashboardOrchestrators,
} from "../serialize";
import type { DashboardSession } from "../types";

// Helper to create a minimal Session for testing
function createCoreSession(overrides?: Partial<Session>): Session {
  const lifecycle = createInitialCanonicalLifecycle("worker", new Date("2025-01-01T00:00:00Z"));
  lifecycle.session.state = "working";
  lifecycle.session.reason = "task_in_progress";
  lifecycle.session.startedAt = lifecycle.session.lastTransitionAt;
  lifecycle.runtime.state = "alive";
  lifecycle.runtime.reason = "process_running";
  return {
    id: "test-1",
    projectId: "test",
    status: "working",
    activity: "active",
    activitySignal: {
      state: "valid",
      activity: "active",
      timestamp: new Date("2025-01-01T01:00:00Z"),
      source: "native",
    },
    lifecycle,
    branch: "feat/test",
    issueId: null,
    pr: null,
    workspacePath: "/test",
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date("2025-01-01T00:00:00Z"),
    lastActivityAt: new Date("2025-01-01T01:00:00Z"),
    metadata: {},
    ...overrides,
  };
}

// Helper to create a minimal PRInfo for testing
function createPRInfo(overrides?: Partial<PRInfo>): PRInfo {
  return {
    number: 1,
    url: "https://github.com/test/repo/pull/1",
    title: "Test PR",
    owner: "test",
    repo: "repo",
    branch: "feat/test",
    baseBranch: "main",
    isDraft: false,
    ...overrides,
  };
}

// Helper to create prEnrichment metadata JSON
function createEnrichmentMetadata(overrides?: Record<string, unknown>): string {
  return JSON.stringify({
    state: "open",
    title: "Test PR",
    additions: 100,
    deletions: 50,
    ciStatus: "passing",
    reviewDecision: "approved",
    mergeable: true,
    isDraft: false,
    hasConflicts: false,
    ciChecks: [{ name: "test", status: "passed", url: "https://example.com" }],
    enrichedAt: new Date().toISOString(),
    ...overrides,
  });
}

// Helper to create prReviewComments metadata JSON
function createReviewCommentsMetadata(overrides?: Record<string, unknown>): string {
  return JSON.stringify({
    unresolvedThreads: 0,
    unresolvedComments: [],
    commentsUpdatedAt: new Date().toISOString(),
    ...overrides,
  });
}

describe("sessionToDashboard", () => {
  it("should convert a core Session to DashboardSession", () => {
    const coreSession = createCoreSession();
    const dashboard = sessionToDashboard(coreSession);

    expect(dashboard.id).toBe("test-1");
    expect(dashboard.projectId).toBe("test");
    expect(dashboard.status).toBe("working");
    expect(dashboard.activity).toBe("active");
    expect(dashboard.activitySignal).toEqual({
      state: "valid",
      activity: "active",
      timestamp: "2025-01-01T01:00:00.000Z",
      source: "native",
      detail: undefined,
    });
    expect(dashboard.branch).toBe("feat/test");
    expect(dashboard.createdAt).toBe("2025-01-01T00:00:00.000Z");
    expect(dashboard.lastActivityAt).toBe("2025-01-01T01:00:00.000Z");
  });

  it("should expose canonical lifecycle fields", () => {
    const coreSession = createCoreSession();
    const dashboard = sessionToDashboard(coreSession);

    expect(dashboard.lifecycle?.sessionState).toBe("working");
    expect(dashboard.lifecycle?.sessionReason).toBe("task_in_progress");
    expect(dashboard.lifecycle?.prState).toBe("none");
    expect(dashboard.lifecycle?.prReason).toBe("not_created");
    expect(dashboard.lifecycle?.runtimeState).toBe("alive");
    expect(dashboard.lifecycle?.runtimeReason).toBe("process_running");
    expect(dashboard.lifecycle?.session.label).toBe("working");
    expect(dashboard.lifecycle?.pr.label).toBe("not created");
    expect(dashboard.lifecycle?.runtime.label).toBe("alive");
    expect(dashboard.lifecycle?.summary).toContain("Session working");
    expect(dashboard.attentionLevel).toBe("working");
  });

  it("should expose detecting evidence from legacy metadata without card guidance copy", () => {
    const lifecycle = createInitialCanonicalLifecycle("worker", new Date("2025-01-01T00:00:00Z"));
    lifecycle.session.state = "detecting";
    lifecycle.session.reason = "probe_failure";
    lifecycle.runtime.state = "probe_failed";
    lifecycle.runtime.reason = "probe_error";
    const coreSession = createCoreSession({
      lifecycle,
      status: "detecting",
      metadata: {
        lifecycleEvidence: "signal_disagreement runtime_alive process_unknown",
        detectingAttempts: "2",
      },
    });

    const dashboard = sessionToDashboard(coreSession);

    expect(dashboard.lifecycle?.guidance).toBeNull();
    expect(dashboard.lifecycle?.evidence).toContain("signal_disagreement");
    expect(dashboard.attentionLevel).toBe("respond");
  });

  it("should seed dashboard PR state from canonical lifecycle truth", () => {
    const lifecycle = createInitialCanonicalLifecycle("worker", new Date("2025-01-01T00:00:00Z"));
    lifecycle.session.state = "idle";
    lifecycle.session.reason = "merged_waiting_decision";
    lifecycle.session.startedAt = lifecycle.session.lastTransitionAt;
    lifecycle.pr.state = "merged";
    lifecycle.pr.reason = "merged";
    lifecycle.runtime.state = "alive";
    lifecycle.runtime.reason = "process_running";

    const coreSession = createCoreSession({
      status: "idle",
      lifecycle,
      pr: createPRInfo(),
    });

    const dashboard = sessionToDashboard(coreSession);

    expect(dashboard.pr?.state).toBe("merged");
  });

  it("should use agentInfo summary with summaryIsFallback false", () => {
    const coreSession = createCoreSession({
      agentInfo: {
        summary: "Working on feature X",
        summaryIsFallback: false,
        agentSessionId: "abc123",
      },
    });
    const dashboard = sessionToDashboard(coreSession);

    expect(dashboard.summary).toBe("Working on feature X");
    expect(dashboard.summaryIsFallback).toBe(false);
  });

  it("should propagate summaryIsFallback true from agentInfo", () => {
    const coreSession = createCoreSession({
      agentInfo: {
        summary: "You are working on issue #42...",
        summaryIsFallback: true,
        agentSessionId: "abc123",
      },
    });
    const dashboard = sessionToDashboard(coreSession);

    expect(dashboard.summary).toBe("You are working on issue #42...");
    expect(dashboard.summaryIsFallback).toBe(true);
  });

  it("should default summaryIsFallback to false when agentInfo omits it", () => {
    const coreSession = createCoreSession({
      agentInfo: {
        summary: "Working on feature X",
        agentSessionId: "abc123",
        // summaryIsFallback intentionally omitted (older plugin)
      },
    });
    const dashboard = sessionToDashboard(coreSession);

    expect(dashboard.summary).toBe("Working on feature X");
    expect(dashboard.summaryIsFallback).toBe(false);
  });

  it("should set summaryIsFallback false for metadata summary", () => {
    const coreSession = createCoreSession({
      agentInfo: null,
      metadata: { summary: "Metadata summary" },
    });
    const dashboard = sessionToDashboard(coreSession);

    expect(dashboard.summary).toBe("Metadata summary");
    expect(dashboard.summaryIsFallback).toBe(false);
  });

  it("should set summaryIsFallback false when no summary exists", () => {
    const coreSession = createCoreSession({
      agentInfo: null,
      metadata: {},
    });
    const dashboard = sessionToDashboard(coreSession);

    expect(dashboard.summary).toBeNull();
    expect(dashboard.summaryIsFallback).toBe(false);
  });

  it("should use live agentInfo summary even when pinnedSummary is set in metadata", () => {
    const coreSession = createCoreSession({
      agentInfo: {
        summary: "Latest live summary from agent",
        summaryIsFallback: false,
        agentSessionId: "abc123",
      },
      metadata: { pinnedSummary: "First pinned summary" },
    });
    const dashboard = sessionToDashboard(coreSession);

    // pinnedSummary must NOT replace dashboard.summary — live summary wins
    expect(dashboard.summary).toBe("Latest live summary from agent");
    expect(dashboard.summaryIsFallback).toBe(false);
    // pinnedSummary remains accessible via metadata for title selection
    expect(dashboard.metadata["pinnedSummary"]).toBe("First pinned summary");
  });

  it("should use metadata summary when pinnedSummary is also set (pinnedSummary only for titles)", () => {
    const coreSession = createCoreSession({
      agentInfo: null,
      metadata: { pinnedSummary: "Pinned summary", summary: "Metadata summary" },
    });
    const dashboard = sessionToDashboard(coreSession);

    // pinnedSummary must NOT override the regular metadata summary
    expect(dashboard.summary).toBe("Metadata summary");
    expect(dashboard.summaryIsFallback).toBe(false);
  });

  it("should use agentInfo summary regardless of pinnedSummary value", () => {
    const coreSession = createCoreSession({
      agentInfo: {
        summary: "Agent summary",
        summaryIsFallback: false,
        agentSessionId: "abc123",
      },
      metadata: { pinnedSummary: "" },
    });
    const dashboard = sessionToDashboard(coreSession);

    expect(dashboard.summary).toBe("Agent summary");
    expect(dashboard.summaryIsFallback).toBe(false);
  });

  it("should convert PRInfo to DashboardPR with defaults", () => {
    const pr = createPRInfo();
    const coreSession = createCoreSession({ pr });
    const dashboard = sessionToDashboard(coreSession);

    expect(dashboard.pr).not.toBeNull();
    expect(dashboard.pr?.number).toBe(1);
    expect(dashboard.pr?.url).toBe("https://github.com/test/repo/pull/1");
    expect(dashboard.pr?.title).toBe("Test PR");
    expect(dashboard.pr?.state).toBe("open");
    expect(dashboard.pr?.additions).toBe(0);
    expect(dashboard.pr?.deletions).toBe(0);
    expect(dashboard.pr?.ciStatus).toBe("none");
    expect(dashboard.pr?.reviewDecision).toBe("none");
    expect(dashboard.pr?.mergeability.blockers).toEqual([]);
    expect(dashboard.pr?.enriched).toBe(false);
  });

  it("should set pr to null when session has no PR", () => {
    const coreSession = createCoreSession({ pr: null });
    const dashboard = sessionToDashboard(coreSession);

    expect(dashboard.pr).toBeNull();
  });
});

describe("resolveProject", () => {
  function makeProject(overrides?: Partial<ProjectConfig>): ProjectConfig {
    return {
      name: "test",
      repo: "test/repo",
      path: "/test",
      defaultBranch: "main",
      sessionPrefix: "test",
      ...overrides,
    };
  }

  it("should match by explicit projectId", () => {
    const projects = {
      app: makeProject({ name: "app", sessionPrefix: "app" }),
      lib: makeProject({ name: "lib", sessionPrefix: "lib" }),
    };
    const session = createCoreSession({ projectId: "app" });
    expect(resolveProject(session, projects)).toBe(projects.app);
  });

  it("should fall back to session prefix match", () => {
    const projects = {
      app: makeProject({ name: "app", sessionPrefix: "app" }),
      lib: makeProject({ name: "lib", sessionPrefix: "lib" }),
    };
    const session = createCoreSession({ id: "lib-42", projectId: "unknown" });
    expect(resolveProject(session, projects)).toBe(projects.lib);
  });

  it("should not match another project's longer prefix", () => {
    const projects = {
      app: makeProject({ name: "app", sessionPrefix: "app" }),
      appx: makeProject({ name: "appx", sessionPrefix: "appx" }),
    };
    // Regression: prefix containment could resolve appx sessions as app.
    // Found by /qa on 2026-05-01.
    const session = createCoreSession({ id: "appx-1", projectId: "unknown" });
    expect(resolveProject(session, projects)).toBe(projects.appx);
  });

  it("should fall back to first project when nothing matches", () => {
    const projects = {
      app: makeProject({ name: "app", sessionPrefix: "app" }),
    };
    const session = createCoreSession({ id: "other-1", projectId: "unknown" });
    expect(resolveProject(session, projects)).toBe(projects.app);
  });

  it("should return undefined for empty projects", () => {
    const session = createCoreSession();
    expect(resolveProject(session, {})).toBeUndefined();
  });

  it("should prefer exact projectId over prefix match", () => {
    const projects = {
      app: makeProject({ name: "app", sessionPrefix: "lib" }),
      lib: makeProject({ name: "lib", sessionPrefix: "app" }),
    };
    // session id starts with "app" (matches lib's prefix), but projectId is "app" (direct match)
    const session = createCoreSession({ id: "app-1", projectId: "app" });
    expect(resolveProject(session, projects)).toBe(projects.app);
  });
});

describe("enrichSessionPR", () => {
  it("should enrich PR from metadata", () => {
    const pr = createPRInfo();
    const coreSession = createCoreSession({
      pr,
      metadata: {
        prEnrichment: createEnrichmentMetadata(),
        prReviewComments: createReviewCommentsMetadata(),
      },
    });
    const dashboard = sessionToDashboard(coreSession);

    const result = enrichSessionPR(dashboard);

    expect(result).toBe(true);
    expect(dashboard.pr?.state).toBe("open");
    expect(dashboard.pr?.additions).toBe(100);
    expect(dashboard.pr?.deletions).toBe(50);
    expect(dashboard.pr?.ciStatus).toBe("passing");
    expect(dashboard.pr?.reviewDecision).toBe("approved");
    expect(dashboard.pr?.mergeability.mergeable).toBe(true);
    expect(dashboard.pr?.ciChecks).toHaveLength(1);
    expect(dashboard.pr?.ciChecks[0]?.name).toBe("test");
    expect(dashboard.pr?.enriched).toBe(true);
  });

  it("should return false when prEnrichment metadata is missing", () => {
    const pr = createPRInfo();
    const coreSession = createCoreSession({ pr, metadata: {} });
    const dashboard = sessionToDashboard(coreSession);

    const result = enrichSessionPR(dashboard);

    expect(result).toBe(false);
    expect(dashboard.pr?.enriched).toBe(false);
  });

  it("should enrich review comments from metadata", () => {
    const pr = createPRInfo();
    const coreSession = createCoreSession({
      pr,
      metadata: {
        prEnrichment: createEnrichmentMetadata(),
        prReviewComments: createReviewCommentsMetadata({
          unresolvedThreads: 2,
          unresolvedComments: [
            { url: "https://example.com", path: "src/app.ts", author: "reviewer", body: "Fix this" },
          ],
        }),
      },
    });
    const dashboard = sessionToDashboard(coreSession);

    enrichSessionPR(dashboard);

    expect(dashboard.pr?.unresolvedThreads).toBe(2);
    expect(dashboard.pr?.unresolvedComments).toHaveLength(1);
    expect(dashboard.pr?.unresolvedComments[0]?.author).toBe("reviewer");
  });

  it("should handle missing review comments metadata gracefully", () => {
    const pr = createPRInfo();
    const coreSession = createCoreSession({
      pr,
      metadata: {
        prEnrichment: createEnrichmentMetadata(),
        // No prReviewComments
      },
    });
    const dashboard = sessionToDashboard(coreSession);

    enrichSessionPR(dashboard);

    expect(dashboard.pr?.unresolvedThreads).toBe(0);
    expect(dashboard.pr?.unresolvedComments).toEqual([]);
  });

  it("should handle malformed prEnrichment JSON gracefully", () => {
    const pr = createPRInfo();
    const coreSession = createCoreSession({
      pr,
      metadata: { prEnrichment: "not valid json{" },
    });
    const dashboard = sessionToDashboard(coreSession);

    const result = enrichSessionPR(dashboard);

    expect(result).toBe(false);
    expect(dashboard.pr?.enriched).toBe(false);
  });

  it("should do nothing if dashboard.pr is null", () => {
    const dashboard: DashboardSession = {
      id: "test-1",
      projectId: "test",
      status: "working",
      activity: "active",
      activitySignal: {
        state: "valid",
        activity: "active",
        timestamp: new Date().toISOString(),
        source: "native",
      },
      branch: "feat/test",
      issueId: null,
      issueUrl: null,
      issueLabel: null,
      issueTitle: null,
      summary: null,
      summaryIsFallback: false,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      pr: null,
      metadata: { prEnrichment: createEnrichmentMetadata() },
    };

    const result = enrichSessionPR(dashboard);

    expect(result).toBe(false);
  });

  it("should derive mergeability fields from enrichment data", () => {
    const pr = createPRInfo();
    const coreSession = createCoreSession({
      pr,
      metadata: {
        prEnrichment: createEnrichmentMetadata({
          ciStatus: "failing",
          reviewDecision: "changes_requested",
          mergeable: false,
          hasConflicts: true,
        }),
      },
    });
    const dashboard = sessionToDashboard(coreSession);

    enrichSessionPR(dashboard);

    expect(dashboard.pr?.mergeability.mergeable).toBe(false);
    expect(dashboard.pr?.mergeability.ciPassing).toBe(false);
    expect(dashboard.pr?.mergeability.approved).toBe(false);
    expect(dashboard.pr?.mergeability.noConflicts).toBe(false);
  });

  it("should set enriched flag on successful enrichment", () => {
    const pr = createPRInfo();
    const coreSession = createCoreSession({
      pr,
      metadata: { prEnrichment: createEnrichmentMetadata() },
    });
    const dashboard = sessionToDashboard(coreSession);
    expect(dashboard.pr?.enriched).toBe(false);

    enrichSessionPR(dashboard);

    expect(dashboard.pr?.enriched).toBe(true);
  });
});

describe("readPREnrichmentFromMetadata", () => {
  it("should parse valid enrichment metadata", () => {
    const data = readPREnrichmentFromMetadata({
      prEnrichment: createEnrichmentMetadata(),
    });

    expect(data).not.toBeNull();
    expect(data?.state).toBe("open");
    expect(data?.additions).toBe(100);
    expect(data?.deletions).toBe(50);
  });

  it("should return null when prEnrichment is missing", () => {
    const data = readPREnrichmentFromMetadata({});
    expect(data).toBeNull();
  });

  it("should return null for invalid JSON", () => {
    const data = readPREnrichmentFromMetadata({ prEnrichment: "bad json{" });
    expect(data).toBeNull();
  });

  it("should include review comments when present", () => {
    const data = readPREnrichmentFromMetadata({
      prEnrichment: createEnrichmentMetadata(),
      prReviewComments: createReviewCommentsMetadata({
        unresolvedThreads: 3,
        unresolvedComments: [
          { url: "https://example.com", path: "src/app.ts", author: "alice", body: "Please fix" },
        ],
      }),
    });

    expect(data?.unresolvedThreads).toBe(3);
    expect(data?.unresolvedComments).toHaveLength(1);
  });
});

describe("enrichSessionAgentSummary", () => {
  function createMockAgent(
    info: Partial<Awaited<ReturnType<Agent["getSessionInfo"]>>> | null = null,
  ): Agent {
    return {
      name: "mock",
      processName: "mock",
      getLaunchCommand: vi.fn().mockReturnValue("mock"),
      getEnvironment: vi.fn().mockReturnValue({}),
      detectActivity: vi.fn().mockReturnValue("active"),
      getActivityState: vi.fn().mockResolvedValue({ activity: "active" }),
      getSessionInfo: vi.fn().mockResolvedValue(
        info
          ? {
              summary: info.summary ?? null,
              summaryIsFallback: info.summaryIsFallback,
              agentSessionId: info.agentSessionId ?? null,
            }
          : null,
      ),
      sendMessage: vi.fn(),
    };
  }

  it("should set summary and summaryIsFallback false from agent", async () => {
    const core = createCoreSession();
    const dashboard = sessionToDashboard(core);
    expect(dashboard.summary).toBeNull();

    const agent = createMockAgent({
      summary: "Working on feature X",
      summaryIsFallback: false,
    });

    await enrichSessionAgentSummary(dashboard, core, agent);

    expect(dashboard.summary).toBe("Working on feature X");
    expect(dashboard.summaryIsFallback).toBe(false);
  });

  it("should propagate summaryIsFallback true from agent", async () => {
    const core = createCoreSession();
    const dashboard = sessionToDashboard(core);

    const agent = createMockAgent({
      summary: "You are working on issue #42...",
      summaryIsFallback: true,
    });

    await enrichSessionAgentSummary(dashboard, core, agent);

    expect(dashboard.summary).toBe("You are working on issue #42...");
    expect(dashboard.summaryIsFallback).toBe(true);
  });

  it("should default summaryIsFallback to false when agent omits it", async () => {
    const core = createCoreSession();
    const dashboard = sessionToDashboard(core);

    const agent = createMockAgent({
      summary: "Working on feature X",
      // summaryIsFallback intentionally omitted (backwards compat)
    });

    await enrichSessionAgentSummary(dashboard, core, agent);

    expect(dashboard.summary).toBe("Working on feature X");
    expect(dashboard.summaryIsFallback).toBe(false);
  });

  it("should skip enrichment when dashboard already has a summary", async () => {
    const core = createCoreSession({
      agentInfo: {
        summary: "Existing summary",
        summaryIsFallback: false,
        agentSessionId: "abc",
      },
    });
    const dashboard = sessionToDashboard(core);
    expect(dashboard.summary).toBe("Existing summary");

    const agent = createMockAgent({
      summary: "New summary from agent",
      summaryIsFallback: false,
    });

    await enrichSessionAgentSummary(dashboard, core, agent);

    // Should keep original summary, not overwrite
    expect(dashboard.summary).toBe("Existing summary");
    expect(agent.getSessionInfo).not.toHaveBeenCalled();
  });

  it("should handle agent.getSessionInfo throwing", async () => {
    const core = createCoreSession();
    const dashboard = sessionToDashboard(core);

    const agent: Agent = {
      ...createMockAgent(),
      getSessionInfo: vi.fn().mockRejectedValue(new Error("JSONL corrupted")),
    };

    await enrichSessionAgentSummary(dashboard, core, agent);

    expect(dashboard.summary).toBeNull();
    expect(dashboard.summaryIsFallback).toBe(false);
  });

  it("should not update when agent returns null info", async () => {
    const core = createCoreSession();
    const dashboard = sessionToDashboard(core);
    const agent = createMockAgent(null);

    await enrichSessionAgentSummary(dashboard, core, agent);

    expect(dashboard.summary).toBeNull();
    expect(dashboard.summaryIsFallback).toBe(false);
  });

  it("should not update when agent returns info with null summary", async () => {
    const core = createCoreSession();
    const dashboard = sessionToDashboard(core);
    const agent = createMockAgent({ summary: null });

    await enrichSessionAgentSummary(dashboard, core, agent);

    expect(dashboard.summary).toBeNull();
    expect(dashboard.summaryIsFallback).toBe(false);
  });
});

describe("enrichSessionIssueTitle", () => {
  function makeProject(overrides?: Partial<ProjectConfig>): ProjectConfig {
    return {
      name: "test",
      repo: "test/repo",
      path: "/test",
      defaultBranch: "main",
      sessionPrefix: "test",
      ...overrides,
    };
  }

  function createMockTracker(title = "Add user authentication"): Tracker {
    return {
      name: "mock",
      getIssue: vi.fn().mockResolvedValue({
        id: "42",
        title,
        description: "Description",
        url: "https://github.com/test/repo/issues/42",
        state: "open",
        labels: [],
      }),
      isCompleted: vi.fn().mockResolvedValue(false),
      issueUrl: vi.fn().mockReturnValue("https://github.com/test/repo/issues/42"),
      issueLabel: vi.fn().mockReturnValue("#42"),
      branchName: vi.fn().mockReturnValue("feat/issue-42"),
      generatePrompt: vi.fn().mockResolvedValue("prompt"),
    };
  }

  function makeDashboard(overrides?: Partial<DashboardSession>): DashboardSession {
    return {
      id: "test-1",
      projectId: "test",
      status: "working",
      activity: "active",
      activitySignal: {
        state: "valid",
        activity: "active",
        timestamp: new Date().toISOString(),
        source: "native",
      },
      branch: "feat/test",
      issueId: null,
      issueUrl: null,
      issueLabel: null,
      issueTitle: null,
      summary: null,
      summaryIsFallback: false,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      pr: null,
      metadata: {},
      ...overrides,
    };
  }

  it("should enrich issue title from tracker", async () => {
    const dashboard = makeDashboard({
      issueUrl: "https://github.com/test/repo/issues/42",
      issueLabel: "#42",
    });
    const tracker = createMockTracker();
    const project = makeProject();

    await enrichSessionIssueTitle(dashboard, tracker, project);

    expect(dashboard.issueTitle).toBe("Add user authentication");
    expect(tracker.getIssue).toHaveBeenCalledWith("42", project);
  });

  it("should strip # prefix from GitHub-style labels", async () => {
    const dashboard = makeDashboard({
      issueUrl: "https://github.com/test/repo/issues/99",
      issueLabel: "#99",
    });
    const tracker = createMockTracker();
    const project = makeProject();

    await enrichSessionIssueTitle(dashboard, tracker, project);

    expect(tracker.getIssue).toHaveBeenCalledWith("99", project);
  });

  it("should pass through non-GitHub labels unchanged", async () => {
    const dashboard = makeDashboard({
      issueUrl: "https://linear.app/team/INT-100",
      issueLabel: "INT-100",
    });
    const tracker = createMockTracker();
    const project = makeProject();

    await enrichSessionIssueTitle(dashboard, tracker, project);

    expect(tracker.getIssue).toHaveBeenCalledWith("INT-100", project);
  });

  it("should skip when issueUrl is null", async () => {
    const dashboard = makeDashboard({ issueUrl: null, issueLabel: "#42" });
    const tracker = createMockTracker();
    const project = makeProject();

    await enrichSessionIssueTitle(dashboard, tracker, project);

    expect(tracker.getIssue).not.toHaveBeenCalled();
    expect(dashboard.issueTitle).toBeNull();
  });

  it("should skip when issueLabel is null", async () => {
    const dashboard = makeDashboard({
      issueUrl: "https://github.com/test/repo/issues/42",
      issueLabel: null,
    });
    const tracker = createMockTracker();
    const project = makeProject();

    await enrichSessionIssueTitle(dashboard, tracker, project);

    expect(tracker.getIssue).not.toHaveBeenCalled();
    expect(dashboard.issueTitle).toBeNull();
  });

  it("should handle tracker errors gracefully", async () => {
    // Unique URL to avoid cache from other tests
    const dashboard = makeDashboard({
      issueUrl: "https://github.com/test/repo/issues/error-test",
      issueLabel: "#error-test",
    });
    const tracker: Tracker = {
      ...createMockTracker(),
      getIssue: vi.fn().mockRejectedValue(new Error("API error")),
    };
    const project = makeProject();

    await enrichSessionIssueTitle(dashboard, tracker, project);

    expect(dashboard.issueTitle).toBeNull();
  });

  it("should avoid repeated issue lookups after a recent failure", async () => {
    const issueUrl = "https://github.com/test/repo/issues/failure-cache";
    const dashboard = makeDashboard({
      issueUrl,
      issueLabel: "#failure-cache",
    });
    const tracker: Tracker = {
      ...createMockTracker(),
      getIssue: vi.fn().mockRejectedValue(new Error("API error")),
    };
    const project = makeProject();

    await enrichSessionIssueTitle(dashboard, tracker, project);
    await enrichSessionIssueTitle(dashboard, tracker, project);

    expect(tracker.getIssue).toHaveBeenCalledTimes(1);
    expect(dashboard.issueTitle).toBeNull();
  });

  it("should cache results across calls", async () => {
    // Unique URL to avoid cache from other tests
    const issueUrl = "https://github.com/test/repo/issues/cache-test";
    const dashboard1 = makeDashboard({ issueUrl, issueLabel: "#cache-test" });
    const dashboard2 = makeDashboard({ issueUrl, issueLabel: "#cache-test" });
    const tracker = createMockTracker();
    const project = makeProject();

    await enrichSessionIssueTitle(dashboard1, tracker, project);
    await enrichSessionIssueTitle(dashboard2, tracker, project);

    expect(tracker.getIssue).toHaveBeenCalledTimes(1);
    expect(dashboard2.issueTitle).toBe("Add user authentication");
  });
});

describe("enrichSessionsMetadata", () => {
  // Unique URL base to avoid cross-test cache collisions
  const urlBase = "https://github.com/test/repo/issues/meta";

  function mockTracker(title = "Add user authentication"): Tracker {
    return {
      name: "mock-tracker",
      getIssue: vi.fn().mockResolvedValue({
        id: "42",
        title,
        description: "",
        url: `${urlBase}-default`,
        state: "open",
        labels: [],
      }),
      isCompleted: vi.fn().mockResolvedValue(false),
      issueUrl: vi.fn().mockImplementation((identifier: string) => `${urlBase}-${identifier}`),
      issueLabel: vi.fn().mockReturnValue("#42"),
      branchName: vi.fn().mockReturnValue("feat/issue-42"),
      generatePrompt: vi.fn().mockResolvedValue("prompt"),
    };
  }

  function mockAgent(summary = "Working on feature"): Agent {
    return {
      name: "mock-agent",
      processName: "mock",
      getLaunchCommand: vi.fn().mockReturnValue("mock"),
      getEnvironment: vi.fn().mockReturnValue({}),
      detectActivity: vi.fn().mockReturnValue("active"),
      getActivityState: vi.fn().mockResolvedValue({ activity: "active" }),
      getSessionInfo: vi.fn().mockResolvedValue({
        summary,
        summaryIsFallback: false,
        agentSessionId: "abc",
      }),
      sendMessage: vi.fn(),
    };
  }

  function mockRegistry(tracker: Tracker | null, agent: Agent | null): PluginRegistry {
    return {
      get: vi.fn((slot: string) => {
        if (slot === "tracker") return tracker;
        if (slot === "agent") return agent;
        return null;
      }),
      register: vi.fn(),
      list: vi.fn().mockReturnValue([]),
      loadBuiltins: vi.fn(),
      loadFromConfig: vi.fn(),
    } as unknown as PluginRegistry;
  }

  const testProject: ProjectConfig = {
    name: "test",
    repo: "test/repo",
    path: "/test",
    defaultBranch: "main",
    sessionPrefix: "test",
    tracker: { plugin: "mock-tracker" },
    agent: "mock-agent",
  };

  const testConfig = {
    configPath: "/test",
    defaults: { runtime: "tmux", agent: "mock-agent", workspace: "worktree", notifiers: [] },
    projects: { test: testProject },
    notifiers: {},
    notificationRouting: { urgent: [], action: [], warning: [], info: [] },
    reactions: {},
    readyThresholdMs: 300000,
  } as OrchestratorConfig;

  it("should enrich issue labels, agent summaries, and issue titles", async () => {
    const tracker = mockTracker("Fix auth bug");
    const agent = mockAgent("Implementing auth fix");
    const registry = mockRegistry(tracker, agent);

    const core = createCoreSession({ issueId: `${urlBase}-full` });
    const dashboard = sessionToDashboard(core);
    expect(dashboard.summary).toBeNull();

    await enrichSessionsMetadata([core], [dashboard], testConfig, registry);

    // Issue label enriched (sync)
    expect(dashboard.issueLabel).toBe("#42");
    // Summary enriched (async)
    expect(dashboard.summary).toBe("Implementing auth fix");
    // Issue title enriched (async, depends on issueLabel from sync step)
    expect(dashboard.issueTitle).toBe("Fix auth bug");
  });

  it("should derive issue URL from issue identifier via tracker", async () => {
    const tracker = mockTracker("Fix auth bug");
    const agent = mockAgent("Implementing auth fix");
    const registry = mockRegistry(tracker, agent);

    const core = createCoreSession({ issueId: "42" });
    const dashboard = sessionToDashboard(core);
    expect(dashboard.issueUrl).toBeNull();

    await enrichSessionsMetadata([core], [dashboard], testConfig, registry);

    expect(tracker.issueUrl).toHaveBeenCalledWith("42", testProject);
    expect(dashboard.issueUrl).toBe(`${urlBase}-42`);
    expect(dashboard.issueLabel).toBe("#42");
    expect(dashboard.issueTitle).toBe("Fix auth bug");
  });

  it("preserves URL-shaped issueId without passing it through tracker.issueUrl", async () => {
    const tracker = mockTracker("Fix auth bug");
    const agent = mockAgent("Implementing auth fix");
    const registry = mockRegistry(tracker, agent);
    const originalUrl = "https://github.com/acme/repo/issues/99";
    const core = createCoreSession({ issueId: originalUrl });
    const dashboard = sessionToDashboard(core);

    await enrichSessionsMetadata([core], [dashboard], testConfig, registry);

    expect(dashboard.issueUrl).toBe(originalUrl);
    expect(tracker.issueUrl).not.toHaveBeenCalledWith(originalUrl, testProject);
  });

  it("does not create synthetic URLs for free-text issueId", async () => {
    const tracker = mockTracker();
    const agent = mockAgent();
    const registry = mockRegistry(tracker, agent);
    const core = createCoreSession({ issueId: "fix login bug" });
    const dashboard = sessionToDashboard(core);

    await enrichSessionsMetadata([core], [dashboard], testConfig, registry);

    expect(dashboard.issueUrl).toBeNull();
    expect(dashboard.issueLabel).toBeNull();
    expect(tracker.getIssue).not.toHaveBeenCalled();
  });

  it("keeps URL unset when tracker.issueUrl throws", async () => {
    const tracker = mockTracker();
    tracker.issueUrl = vi.fn().mockImplementation(() => {
      throw new Error("bad template");
    });
    const dashboard = sessionToDashboard(createCoreSession({ issueId: "42" }));

    enrichSessionIssue(dashboard, tracker, testProject);

    expect(dashboard.issueUrl).toBeNull();
    expect(dashboard.issueLabel).toBeNull();
  });

  it("starts issue-title fetches before agent summaries finish", async () => {
    let resolveSummary:
      | ((value: { summary: string; summaryIsFallback: false; agentSessionId: string }) => void)
      | null = null;

    const tracker = mockTracker("Fix auth bug");
    const agent = {
      ...mockAgent(),
      getSessionInfo: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveSummary = resolve;
          }),
      ),
    } as Agent;
    const registry = mockRegistry(tracker, agent);

    const core = createCoreSession({ issueId: `${urlBase}-parallel` });
    const dashboard = sessionToDashboard(core);

    const enrichmentPromise = enrichSessionsMetadata([core], [dashboard], testConfig, registry);
    await Promise.resolve();

    expect(tracker.getIssue).toHaveBeenCalledTimes(1);
    expect(dashboard.issueLabel).toBe("#42");
    expect(dashboard.summary).toBeNull();

    resolveSummary?.({
      summary: "Implementing auth fix",
      summaryIsFallback: false,
      agentSessionId: "abc",
    });
    await enrichmentPromise;

    expect(dashboard.summary).toBe("Implementing auth fix");
    expect(dashboard.issueTitle).toBe("Fix auth bug");
  });

  it("should skip sessions without issue URLs", async () => {
    const tracker = mockTracker();
    const agent = mockAgent();
    const registry = mockRegistry(tracker, agent);

    const core = createCoreSession({ issueId: null });
    const dashboard = sessionToDashboard(core);

    await enrichSessionsMetadata([core], [dashboard], testConfig, registry);

    expect(tracker.issueLabel).not.toHaveBeenCalled();
    expect(tracker.getIssue).not.toHaveBeenCalled();
    // Summary still enriched (independent of issue)
    expect(dashboard.summary).toBe("Working on feature");
  });

  it("should skip summary enrichment when session already has one", async () => {
    const tracker = mockTracker();
    const agent = mockAgent();
    const registry = mockRegistry(tracker, agent);

    const core = createCoreSession({
      agentInfo: { summary: "Existing summary", summaryIsFallback: false, agentSessionId: "x" },
    });
    const dashboard = sessionToDashboard(core);

    await enrichSessionsMetadata([core], [dashboard], testConfig, registry);

    expect(agent.getSessionInfo).not.toHaveBeenCalled();
    expect(dashboard.summary).toBe("Existing summary");
  });

  it("should handle missing tracker plugin gracefully", async () => {
    const agent = mockAgent();
    const registry = mockRegistry(null, agent);

    const core = createCoreSession({ issueId: `${urlBase}-no-tracker` });
    const dashboard = sessionToDashboard(core);

    await enrichSessionsMetadata([core], [dashboard], testConfig, registry);

    // Issue enrichment skipped (no tracker)
    expect(dashboard.issueLabel).toBeNull();
    expect(dashboard.issueTitle).toBeNull();
    // Agent summary still works
    expect(dashboard.summary).toBe("Working on feature");
  });

  it("should handle missing agent plugin gracefully", async () => {
    const tracker = mockTracker();
    const registry = mockRegistry(tracker, null);

    const core = createCoreSession({ issueId: `${urlBase}-no-agent` });
    const dashboard = sessionToDashboard(core);

    await enrichSessionsMetadata([core], [dashboard], testConfig, registry);

    // Issue enrichment still works
    expect(dashboard.issueLabel).toBe("#42");
    // Summary stays null (no agent)
    expect(dashboard.summary).toBeNull();
  });

  it("should handle project with no tracker config", async () => {
    const agent = mockAgent();
    const registry = mockRegistry(null, agent);
    const configNoTracker = {
      ...testConfig,
      projects: {
        test: { ...testProject, tracker: undefined } as ProjectConfig,
      },
    } as OrchestratorConfig;

    const core = createCoreSession({ issueId: `${urlBase}-no-tracker-cfg` });
    const dashboard = sessionToDashboard(core);

    await enrichSessionsMetadata([core], [dashboard], configNoTracker, registry);

    // No tracker resolution attempted
    expect(registry.get).not.toHaveBeenCalledWith("tracker", expect.anything());
    expect(dashboard.issueLabel).toBeNull();
    // Agent still works
    expect(dashboard.summary).toBe("Working on feature");
  });

  it("should enrich multiple sessions independently", async () => {
    const tracker = mockTracker();
    const agent = mockAgent();
    const registry = mockRegistry(tracker, agent);

    const cores = [
      createCoreSession({ id: "test-1", issueId: `${urlBase}-multi-1` }),
      createCoreSession({ id: "test-2", issueId: null }), // no issue
      createCoreSession({
        id: "test-3",
        issueId: `${urlBase}-multi-3`,
        agentInfo: { summary: "Already has one", summaryIsFallback: false, agentSessionId: "y" },
      }),
    ];
    const dashboards = cores.map(sessionToDashboard);

    await enrichSessionsMetadata(cores, dashboards, testConfig, registry);

    // Session 1: full enrichment
    expect(dashboards[0].issueLabel).toBe("#42");
    expect(dashboards[0].summary).toBe("Working on feature");

    // Session 2: no issue, but summary enriched
    expect(dashboards[1].issueLabel).toBeNull();
    expect(dashboards[1].summary).toBe("Working on feature");

    // Session 3: issue enriched, summary kept from agentInfo
    expect(dashboards[2].issueLabel).toBe("#42");
    expect(dashboards[2].summary).toBe("Already has one");
    // Agent not called for session 3 (already had summary)
    expect(agent.getSessionInfo).toHaveBeenCalledTimes(2); // sessions 1 and 2 only
  });

  it("should use default agent when project has no agent override", async () => {
    const tracker = mockTracker();
    const agent = mockAgent("From default agent");
    const registry = mockRegistry(tracker, agent);
    const configNoProjectAgent = {
      ...testConfig,
      projects: {
        test: { ...testProject, agent: undefined } as ProjectConfig,
      },
    } as OrchestratorConfig;

    const core = createCoreSession();
    const dashboard = sessionToDashboard(core);

    await enrichSessionsMetadata([core], [dashboard], configNoProjectAgent, registry);

    // Falls back to config.defaults.agent
    expect(registry.get).toHaveBeenCalledWith("agent", "mock-agent");
    expect(dashboard.summary).toBe("From default agent");
  });
});

describe("enrichSessionsMetadataFast", () => {
  it("should enrich issue labels and agent summaries but NOT issue titles", async () => {
    const urlBase = "https://github.com/test/repo/issues/fast";
    const tracker: Tracker = {
      name: "mock-tracker",
      getIssue: vi
        .fn()
        .mockResolvedValue({ id: "99", title: "Should not be called", url: urlBase }),
      issueLabel: vi.fn().mockReturnValue("#99"),
    } as unknown as Tracker;
    const agent: Agent = {
      getSessionInfo: vi.fn().mockResolvedValue({
        summary: "Fast summary",
        summaryIsFallback: false,
        agentSessionId: "abc",
      }),
    } as unknown as Agent;
    const registry = {
      get: vi.fn().mockImplementation((slot: string) => {
        if (slot === "tracker") return tracker;
        if (slot === "agent") return agent;
        return null;
      }),
    } as unknown as PluginRegistry;

    const config: OrchestratorConfig = {
      projects: {
        test: {
          path: "/test",
          repo: "test/repo",
          defaultBranch: "main",
          sessionPrefix: "test-",
          tracker: { plugin: "mock-tracker" },
        },
      } as Record<string, ProjectConfig>,
      defaults: { agent: "mock-agent", runtime: "tmux" },
      configPath: "/test/config.yaml",
    } as OrchestratorConfig;

    const core = createCoreSession({
      issueId: `${urlBase}-fast`,
      agentInfo: undefined,
    });
    const dashboard = sessionToDashboard(core);

    await enrichSessionsMetadataFast([core], [dashboard], config, registry);

    // Issue label should be set (synchronous)
    expect(dashboard.issueLabel).toBe("#99");
    // Agent summary should be set (local I/O)
    expect(dashboard.summary).toBe("Fast summary");
    // Issue title should NOT be set (tracker API is not called by fast path)
    expect(dashboard.issueTitle).toBeNull();
    expect(tracker.getIssue).not.toHaveBeenCalled();
  });
});

describe("computeStats", () => {
  function makeDashboard(overrides: Partial<DashboardSession> = {}): DashboardSession {
    return {
      id: "test-1",
      projectId: "test",
      status: "working",
      activity: "active",
      branch: "feat/test",
      issueId: null,
      issueUrl: null,
      issueLabel: null,
      issueTitle: null,
      summary: null,
      summaryIsFallback: false,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      pr: null,
      metadata: {},
      ...overrides,
    };
  }

  it("counts active sessions as working", () => {
    const sessions = [makeDashboard({ activity: "active" })];
    expect(computeStats(sessions).workingSessions).toBe(1);
  });

  it("counts idle sessions as working", () => {
    const sessions = [makeDashboard({ activity: "idle" })];
    expect(computeStats(sessions).workingSessions).toBe(1);
  });

  it("counts ready sessions as working", () => {
    const sessions = [makeDashboard({ activity: "ready" })];
    expect(computeStats(sessions).workingSessions).toBe(1);
  });

  it("excludes exited sessions from working count", () => {
    const sessions = [makeDashboard({ activity: "exited" })];
    expect(computeStats(sessions).workingSessions).toBe(0);
  });

  it("excludes sessions with null activity from working count", () => {
    const sessions = [makeDashboard({ activity: null })];
    expect(computeStats(sessions).workingSessions).toBe(0);
  });

  it("counts mixed activity states correctly", () => {
    const sessions = [
      makeDashboard({ id: "s1", activity: "active" }),
      makeDashboard({ id: "s2", activity: "idle" }),
      makeDashboard({ id: "s3", activity: "ready" }),
      makeDashboard({ id: "s4", activity: "exited" }),
      makeDashboard({ id: "s5", activity: null }),
    ];
    const stats = computeStats(sessions);
    expect(stats.totalSessions).toBe(5);
    expect(stats.workingSessions).toBe(3); // active + idle + ready
  });
});

describe("listDashboardOrchestrators (issue #1048)", () => {
  // ProjectConfig only needs the fields the function reads.
  const projects = {
    "my-app": { name: "My App", sessionPrefix: "app" },
  } as unknown as Record<string, ProjectConfig>;

  it("excludes stale {projectId}-orchestrator legacy records that lack role metadata", () => {
    // Pre-numbered AO version wrote bare-named records without `role`. After
    // tightening isOrchestratorSession, these must NOT leak into the dashboard's
    // orchestrator list, otherwise the dashboard link points at a stale id while
    // the CLI prints a different (numbered) id.
    const sessions: Session[] = [
      createCoreSession({
        id: "my-app-orchestrator", // legacy bare name
        projectId: "my-app",
        metadata: {}, // no role stamp
      }),
    ];

    const result = listDashboardOrchestrators(sessions, projects);

    expect(result).toEqual([]);
  });

  it("includes the numbered live orchestrator with the matching id", () => {
    const sessions: Session[] = [
      createCoreSession({
        id: "app-orchestrator-3",
        projectId: "my-app",
        metadata: { role: "orchestrator" },
      }),
    ];

    const result = listDashboardOrchestrators(sessions, projects);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: "app-orchestrator-3",
      projectId: "my-app",
      projectName: "My App",
    });
  });

  it("still includes legacy bare records when they have explicit role metadata", () => {
    // When `role: orchestrator` is explicitly stamped on a record,
    // `isOrchestratorSession` honors it unconditionally — the id shape check
    // is a fallback, not a gate.
    //
    // Note: for this specific fixture (id `my-app-orchestrator`, sessionPrefix
    // `app`), the SM repair-on-read path does NOT stamp role (wrong prefix —
    // see `isRepairableOrchestratorRecord`). This test passes in a synthetic
    // role-stamped session directly to exercise the explicit-role branch,
    // which matters for records that got their role from some other source
    // (hand-crafted metadata, external tooling, or a correct-prefix bare
    // record that the repair path did stamp).
    const sessions: Session[] = [
      createCoreSession({
        id: "my-app-orchestrator",
        projectId: "my-app",
        metadata: { role: "orchestrator" },
      }),
    ];

    const result = listDashboardOrchestrators(sessions, projects);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("my-app-orchestrator");
  });

  it("prefers the live orchestrator over stale exited ones for the same project", () => {
    const now = Date.now();
    const sessions: Session[] = [
      createCoreSession({
        id: "ao-orchestrator-9",
        projectId: "my-app",
        status: "killed",
        activity: "exited",
        lastActivityAt: new Date(now - 60_000),
        metadata: { role: "orchestrator" },
      }),
      createCoreSession({
        id: "ao-orchestrator-26",
        projectId: "my-app",
        status: "working",
        activity: "active",
        lastActivityAt: new Date(now),
        metadata: { role: "orchestrator" },
      }),
    ];

    const result = listDashboardOrchestrators(sessions, projects);

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("ao-orchestrator-26");
  });

  it("prefers the most recently active live orchestrator when multiple are running", () => {
    const now = Date.now();
    const sessions: Session[] = [
      createCoreSession({
        id: "app-orchestrator-12",
        projectId: "my-app",
        status: "working",
        activity: "idle",
        lastActivityAt: new Date(now - 120_000),
        metadata: { role: "orchestrator" },
      }),
      createCoreSession({
        id: "app-orchestrator-13",
        projectId: "my-app",
        status: "working",
        activity: "active",
        lastActivityAt: new Date(now),
        metadata: { role: "orchestrator" },
      }),
    ];

    const result = listDashboardOrchestrators(sessions, projects);

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("app-orchestrator-13");
  });
});

describe("basicPRToDashboard defaults", () => {
  it("should not look like failing CI", () => {
    const pr = createPRInfo();
    const coreSession = createCoreSession({ pr });
    const dashboard = sessionToDashboard(coreSession);

    // ciStatus "none" is neutral (no checks configured), not failing
    expect(dashboard.pr?.ciStatus).toBe("none");
    expect(dashboard.pr?.ciStatus).not.toBe("failing");
  });

  it("should not look like changes requested", () => {
    const pr = createPRInfo();
    const coreSession = createCoreSession({ pr });
    const dashboard = sessionToDashboard(coreSession);

    // reviewDecision "none" is neutral (no review required), not changes_requested
    expect(dashboard.pr?.reviewDecision).toBe("none");
    expect(dashboard.pr?.reviewDecision).not.toBe("changes_requested");
  });

  it("should mark unenriched PR with enriched: false", () => {
    const pr = createPRInfo();
    const coreSession = createCoreSession({ pr });
    const dashboard = sessionToDashboard(coreSession);

    expect(dashboard.pr?.enriched).toBe(false);
    expect(dashboard.pr?.mergeability.blockers).toEqual([]);
  });
});
