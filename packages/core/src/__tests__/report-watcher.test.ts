import { describe, it, expect } from "vitest";
import {
  auditAgentReports,
  checkAcknowledgeTimeout,
  checkStaleReport,
  checkBlockedAgent,
  shouldAuditSession,
  getReactionKeyForTrigger,
  DEFAULT_REPORT_WATCHER_CONFIG,
  type ReportWatcherConfig,
} from "../report-watcher.js";
import { createInitialCanonicalLifecycle } from "../lifecycle-state.js";
import type { Session, SessionStatus } from "../types.js";
import type { AgentReport } from "../agent-report.js";

function createMockSession(overrides: Partial<Session> = {}): Session {
  const lifecycle = createInitialCanonicalLifecycle("worker");
  lifecycle.session.state = "working";
  lifecycle.session.reason = "task_in_progress";

  return {
    id: "test-session",
    projectId: "test-project",
    status: "working" as SessionStatus,
    branch: "main",
    createdAt: new Date(),
    lifecycle,
    metadata: {},
    ...overrides,
  } as Session;
}

describe("shouldAuditSession", () => {
  it("returns true for active working sessions", () => {
    const session = createMockSession({ status: "working" });
    expect(shouldAuditSession(session)).toBe(true);
  });

  it("returns false for terminal sessions", () => {
    const terminalStatuses: SessionStatus[] = [
      "done",
      "terminated",
      "killed",
      "cleanup",
      "merged",
      "errored",
    ];

    for (const status of terminalStatuses) {
      const session = createMockSession({ status });
      expect(shouldAuditSession(session)).toBe(false);
    }
  });

  it("returns true for spawning sessions (allows acknowledge timeout check)", () => {
    const session = createMockSession({ status: "spawning" });
    expect(shouldAuditSession(session)).toBe(true);
  });

  it("returns false for orchestrator sessions", () => {
    const lifecycle = createInitialCanonicalLifecycle("orchestrator");
    const session = createMockSession({ lifecycle });
    expect(shouldAuditSession(session)).toBe(false);
  });
});

describe("checkAcknowledgeTimeout", () => {
  const config = DEFAULT_REPORT_WATCHER_CONFIG;

  it("returns null when report exists", () => {
    const session = createMockSession();
    const report: AgentReport = {
      state: "started",
      timestamp: new Date().toISOString(),
    };
    const now = new Date();

    const result = checkAcknowledgeTimeout(session, report, now, config);
    expect(result).toBeNull();
  });

  it("returns null when within timeout window", () => {
    const now = new Date();
    const spawnTime = new Date(now.getTime() - 5 * 60 * 1000); // 5 minutes ago
    const session = createMockSession({
      createdAt: spawnTime,
      metadata: { createdAt: spawnTime.toISOString() },
    });

    const result = checkAcknowledgeTimeout(session, null, now, config);
    expect(result).toBeNull();
  });

  it("returns trigger when timeout exceeded", () => {
    const now = new Date();
    const spawnTime = new Date(now.getTime() - 15 * 60 * 1000); // 15 minutes ago
    const session = createMockSession({
      createdAt: spawnTime,
      metadata: { createdAt: spawnTime.toISOString() },
    });

    const result = checkAcknowledgeTimeout(session, null, now, config);
    expect(result).not.toBeNull();
    expect(result?.trigger).toBe("no_acknowledge");
    expect(result?.timeSinceSpawnMs).toBeGreaterThan(config.acknowledgeTimeoutMs);
  });

  it("respects checkAcknowledge config flag", () => {
    const now = new Date();
    const spawnTime = new Date(now.getTime() - 15 * 60 * 1000);
    const session = createMockSession({
      createdAt: spawnTime,
      metadata: { createdAt: spawnTime.toISOString() },
    });
    const disabledConfig: ReportWatcherConfig = {
      ...config,
      checkAcknowledge: false,
    };

    const result = checkAcknowledgeTimeout(session, null, now, disabledConfig);
    expect(result).toBeNull();
  });
});

describe("checkStaleReport", () => {
  const config = DEFAULT_REPORT_WATCHER_CONFIG;

  it("returns null when no report exists", () => {
    const session = createMockSession();
    const result = checkStaleReport(session, null, new Date(), config);
    expect(result).toBeNull();
  });

  it("returns null when report is fresh", () => {
    const now = new Date();
    const reportTime = new Date(now.getTime() - 5 * 60 * 1000); // 5 minutes ago
    const session = createMockSession();
    const report: AgentReport = {
      state: "working",
      timestamp: reportTime.toISOString(),
    };

    const result = checkStaleReport(session, report, now, config);
    expect(result).toBeNull();
  });

  it("returns trigger when report is stale", () => {
    const now = new Date();
    const reportTime = new Date(now.getTime() - 45 * 60 * 1000); // 45 minutes ago
    const session = createMockSession();
    const report: AgentReport = {
      state: "working",
      timestamp: reportTime.toISOString(),
    };

    const result = checkStaleReport(session, report, now, config);
    expect(result).not.toBeNull();
    expect(result?.trigger).toBe("stale_report");
    expect(result?.timeSinceReportMs).toBeGreaterThan(config.staleReportTimeoutMs);
  });

  it("does not flag waiting states as stale", () => {
    const now = new Date();
    const reportTime = new Date(now.getTime() - 45 * 60 * 1000); // 45 minutes ago
    const session = createMockSession();

    for (const waitingState of ["waiting", "needs_input"] as const) {
      const report: AgentReport = {
        state: waitingState,
        timestamp: reportTime.toISOString(),
      };
      const result = checkStaleReport(session, report, now, config);
      expect(result).toBeNull();
    }
  });
});

describe("checkBlockedAgent", () => {
  const config = DEFAULT_REPORT_WATCHER_CONFIG;

  it("returns null when no report exists", () => {
    const session = createMockSession();
    const result = checkBlockedAgent(session, null, new Date(), config);
    expect(result).toBeNull();
  });

  it("returns trigger for needs_input state", () => {
    const now = new Date();
    const session = createMockSession();
    const report: AgentReport = {
      state: "needs_input",
      timestamp: now.toISOString(),
      note: "Need API key",
    };

    const result = checkBlockedAgent(session, report, now, config);
    expect(result).not.toBeNull();
    expect(result?.trigger).toBe("agent_needs_input");
    expect(result?.message).toContain("Need API key");
  });

  it("keeps needs_input visible even after the freshness window", () => {
    const now = new Date();
    const oldReportTime = new Date(now.getTime() - 10 * 60 * 1000); // 10 minutes ago
    const session = createMockSession();
    const report: AgentReport = {
      state: "needs_input",
      timestamp: oldReportTime.toISOString(),
    };

    const result = checkBlockedAgent(session, report, now, config);
    expect(result?.trigger).toBe("agent_needs_input");
    expect(result?.timeSinceReportMs).toBeGreaterThan(0);
  });
});

describe("auditAgentReports", () => {
  it("returns null for terminal sessions", () => {
    const session = createMockSession({ status: "done" });
    expect(auditAgentReports(session)).toBeNull();
  });

  it("returns null when no issues found", () => {
    const now = new Date();
    const session = createMockSession({
      createdAt: now,
      metadata: {
        createdAt: now.toISOString(),
        agentReportedState: "working",
        agentReportedAt: now.toISOString(),
      },
    });

    expect(auditAgentReports(session, {}, now)).toBeNull();
  });

  it("prioritizes blocked over acknowledge timeout", () => {
    const now = new Date();
    const spawnTime = new Date(now.getTime() - 15 * 60 * 1000); // Would trigger no_acknowledge
    const session = createMockSession({
      createdAt: spawnTime,
      metadata: {
        createdAt: spawnTime.toISOString(),
        agentReportedState: "needs_input",
        agentReportedAt: now.toISOString(), // Fresh needs_input
      },
    });

    const result = auditAgentReports(session, {}, now);
    expect(result?.trigger).toBe("agent_needs_input");
  });
});

describe("getReactionKeyForTrigger", () => {
  it("maps triggers to reaction keys", () => {
    expect(getReactionKeyForTrigger("no_acknowledge")).toBe("report-no-acknowledge");
    expect(getReactionKeyForTrigger("stale_report")).toBe("report-stale");
    expect(getReactionKeyForTrigger("agent_needs_input")).toBe("report-needs-input");
  });
});
