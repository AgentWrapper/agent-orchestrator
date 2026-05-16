import type {
  DashboardActivitySignal,
  DashboardLifecycle,
  DashboardPR,
  DashboardSession,
} from "@/lib/types";

function humanize(token: string): string {
  return token.replace(/_/g, " ");
}

function deriveActivitySignal(session: DashboardSession): DashboardActivitySignal {
  if (session.activitySignal) {
    return session.activitySignal;
  }

  if (session.activity === "exited") {
    return {
      state: "valid",
      activity: "exited",
      timestamp: session.lastActivityAt,
      source: "runtime",
    };
  }

  if (session.activity === null) {
    return {
      state: "unavailable",
      activity: null,
      timestamp: null,
      source: "none",
    };
  }

  return {
    state: "valid",
    activity: session.activity,
    timestamp: session.lastActivityAt,
    source: "native",
  };
}

function deriveLifecycle(session: DashboardSession): DashboardLifecycle {
  const isRuntimeEnded =
    session.activity === "exited" ||
    session.status === "killed" ||
    session.status === "terminated" ||
    session.status === "cleanup" ||
    session.status === "done" ||
    session.status === "merged";

  const sessionFacet = (() => {
    switch (session.status) {
      case "spawning":
        return { state: "not_started", reason: "spawn_requested" };
      case "detecting":
        return { state: "detecting", reason: "probe_failure" };
      case "needs_input":
        return { state: "needs_input", reason: "awaiting_user_input" };
      case "stuck":
      case "errored":
        return { state: "stuck", reason: "probe_failure" };
      case "done":
        return { state: "done", reason: "research_complete" };
      case "merged":
        return { state: "done", reason: "merged_waiting_decision" };
      case "cleanup":
        return { state: "terminated", reason: "agent_process_exited" };
      case "killed":
        return { state: "terminated", reason: "manually_killed" };
      case "terminated":
        return { state: "terminated", reason: "runtime_lost" };
      case "pr_open":
        return { state: "working", reason: "pr_created" };
      case "ci_failed":
        return { state: "working", reason: "fixing_ci" };
      case "changes_requested":
        return { state: "working", reason: "resolving_review_comments" };
      case "review_pending":
      case "approved":
      case "mergeable":
      case "idle":
        return { state: "idle", reason: "awaiting_external_review" };
      case "working":
      default:
        return { state: "working", reason: "task_in_progress" };
    }
  })();

  const prFacet = (() => {
    if (session.pr?.state === "merged" || session.status === "merged") {
      return { state: "merged", reason: "merged" };
    }
    if (session.pr?.state === "closed") {
      return { state: "closed", reason: "closed_unmerged" };
    }
    if (session.pr) {
      if (session.pr.isDraft) {
        return { state: "open", reason: "in_progress" };
      }
      if (session.pr.ciStatus === "failing") {
        return { state: "open", reason: "ci_failing" };
      }
      if (session.pr.reviewDecision === "changes_requested") {
        return { state: "open", reason: "changes_requested" };
      }
      if (session.pr.unresolvedThreads > 0) {
        return { state: "open", reason: "review_pending" };
      }
      if (session.pr.reviewDecision === "approved") {
        const ready =
          session.pr.mergeability.mergeable &&
          session.pr.mergeability.ciPassing &&
          session.pr.mergeability.approved &&
          session.pr.mergeability.noConflicts;
        return { state: "open", reason: ready ? "merge_ready" : "in_progress" };
      }
      if (session.pr.reviewDecision === "pending" || session.pr.reviewDecision === "none") {
        return { state: "open", reason: "review_pending" };
      }
      return { state: "open", reason: "in_progress" };
    }
    return { state: "none", reason: "not_created" };
  })();

  const runtimeFacet = (() => {
    if (session.status === "detecting") {
      return { state: "probe_failed", reason: "probe_error" };
    }
    if (session.status === "killed") {
      return { state: "missing", reason: "manual_kill_requested" };
    }
    if (session.status === "terminated") {
      return { state: "missing", reason: "process_missing" };
    }
    if (isRuntimeEnded) {
      return { state: "exited", reason: "process_missing" };
    }
    if (session.status === "spawning") {
      return { state: "unknown", reason: "spawn_incomplete" };
    }
    return { state: "alive", reason: "process_running" };
  })();

  return {
    sessionState: sessionFacet.state,
    sessionReason: sessionFacet.reason,
    prState: prFacet.state,
    prReason: prFacet.reason,
    runtimeState: runtimeFacet.state,
    runtimeReason: runtimeFacet.reason,
    session: {
      state: sessionFacet.state,
      reason: sessionFacet.reason,
      label: humanize(sessionFacet.state),
      reasonLabel: humanize(sessionFacet.reason),
      startedAt: session.createdAt,
      completedAt: sessionFacet.state === "done" ? session.lastActivityAt : null,
      terminatedAt: sessionFacet.state === "terminated" ? session.lastActivityAt : null,
      lastTransitionAt: session.lastActivityAt,
    },
    pr: {
      state: prFacet.state,
      reason: prFacet.reason,
      label: humanize(prFacet.state),
      reasonLabel: humanize(prFacet.reason),
      number: session.pr?.number ?? null,
      url: session.pr?.url ?? null,
      lastObservedAt: session.lastActivityAt,
    },
    runtime: {
      state: runtimeFacet.state,
      reason: runtimeFacet.reason,
      label: humanize(runtimeFacet.state),
      reasonLabel: humanize(runtimeFacet.reason),
      lastObservedAt: session.lastActivityAt,
    },
    legacyStatus: session.status,
    evidence: null,
    detectingAttempts: session.status === "detecting" ? 1 : 0,
    detectingEscalatedAt: null,
    summary: `Session ${humanize(sessionFacet.state)}, PR ${humanize(prFacet.state)}, runtime ${humanize(runtimeFacet.state)}`,
    guidance: null,
  };
}

/** Create a minimal mock session with overrides */
export function makeSession(overrides: Partial<DashboardSession> = {}): DashboardSession {
  const baseSession: DashboardSession = {
    id: "test-1",
    projectId: "my-app",
    status: "working",
    activity: "active",
    activitySignal: {
      state: "valid",
      activity: "active",
      timestamp: new Date().toISOString(),
      source: "native",
    },
    lifecycle: undefined,
    branch: "feat/test",
    issueId: "https://linear.app/test/issue/INT-100",
    issueUrl: "https://linear.app/test/issue/INT-100",
    issueLabel: "INT-100",
    issueTitle: null,
    userPrompt: null,
    displayName: null,
    displayNameUserSet: false,
    summary: "Test session",
    summaryIsFallback: false,
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    pr: null,
    metadata: {},
    agentReportAudit: [],
  };

  const session = {
    ...baseSession,
    ...overrides,
    issueLabel: overrides.issueLabel ?? overrides.issueId ?? baseSession.issueLabel,
  } satisfies DashboardSession;

  return {
    ...session,
    activitySignal: overrides.activitySignal ?? deriveActivitySignal(session),
    lifecycle: overrides.lifecycle ?? deriveLifecycle(session),
  };
}

/** Create a minimal mock PR with overrides */
export function makePR(overrides: Partial<DashboardPR> = {}): DashboardPR {
  return {
    number: 100,
    url: "https://github.com/acme/app/pull/100",
    title: "feat: test PR",
    owner: "acme",
    repo: "app",
    branch: "feat/test",
    baseBranch: "main",
    isDraft: false,
    state: "open",
    additions: 50,
    deletions: 10,
    ciStatus: "passing",
    ciChecks: [
      { name: "build", status: "passed" },
      { name: "test", status: "passed" },
    ],
    reviewDecision: "approved",
    mergeability: {
      mergeable: true,
      ciPassing: true,
      approved: true,
      noConflicts: true,
      blockers: [],
    },
    unresolvedThreads: 0,
    unresolvedComments: [],
    enriched: true,
    ...overrides,
  };
}
