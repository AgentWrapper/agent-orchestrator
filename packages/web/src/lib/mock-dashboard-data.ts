import type { DashboardPR, DashboardSession } from "@/lib/types";
import { computeStats } from "@/lib/serialize";

const NOW = "2026-05-25T12:00:00.000Z";

function ago(minutes: number): string {
  return new Date(new Date(NOW).getTime() - minutes * 60_000).toISOString();
}

function makePR(overrides: Partial<DashboardPR> & { number: number; title: string }): DashboardPR {
  const { number, title, ...rest } = overrides;
  return {
    number,
    url: `https://github.com/ComposioHQ/agent-orchestrator/pull/${number}`,
    title,
    owner: "ComposioHQ",
    repo: "agent-orchestrator",
    branch: `feat/mock-${number}`,
    baseBranch: "main",
    isDraft: false,
    state: "open",
    additions: 128,
    deletions: 24,
    changedFiles: 6,
    ciStatus: "passing",
    ciChecks: [
      { name: "build", status: "passed" },
      { name: "typecheck", status: "passed" },
      { name: "lint", status: "passed" },
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
    ...rest,
  };
}

function makeSession(overrides: Partial<DashboardSession> & { id: string }): DashboardSession {
  const { id, ...rest } = overrides;
  const lastActivityAt = rest.lastActivityAt ?? ago(5);
  const status = rest.status ?? "working";
  const activity = rest.activity ?? "active";
  return {
    id,
    projectId: "agent-orchestrator",
    status,
    activity,
    activitySignal: {
      state: activity === null ? "unavailable" : "valid",
      activity,
      timestamp: activity === null ? null : lastActivityAt,
      source: activity === null ? "none" : "native",
    },
    lifecycle: undefined,
    branch: `feat/${id}`,
    issueId: null,
    issueUrl: "https://github.com/ComposioHQ/agent-orchestrator/issues/1",
    issueLabel: "#1",
    issueTitle: "feat: implement web dashboard with attention-zone UI and API routes",
    userPrompt: null,
    displayName: null,
    displayNameUserSet: false,
    summary: "Mock dashboard session for local UI development.",
    summaryIsFallback: false,
    createdAt: ago(180),
    lastActivityAt,
    pr: null,
    metadata: { source: "mock" },
    agentReportAudit: [],
    ...rest,
  };
}

export const mockDashboardSessions: DashboardSession[] = [
  makeSession({
    id: "backend-3",
    status: "needs_input",
    activity: "waiting_input",
    summary: "Agent is waiting for confirmation before applying a database migration.",
    lastActivityAt: ago(2),
  }),
  makeSession({
    id: "frontend-2",
    status: "stuck",
    activity: "blocked",
    summary: "Package install failed and needs a human retry decision.",
    lastActivityAt: ago(7),
  }),
  makeSession({
    id: "api-5",
    status: "mergeable",
    activity: "idle",
    pr: makePR({ number: 101, title: "feat: add spawn API route" }),
    summary: "PR is approved with green CI and ready to merge.",
    lastActivityAt: ago(12),
  }),
  makeSession({
    id: "dashboard-8",
    status: "approved",
    activity: "ready",
    pr: makePR({ number: 102, title: "feat: attention-zone cards" }),
    summary: "Review is approved and the merge button can clear this work.",
    lastActivityAt: ago(18),
  }),
  makeSession({
    id: "ci-1",
    status: "ci_failed",
    activity: "idle",
    pr: makePR({
      number: 103,
      title: "fix: stabilize SSE stream tests",
      ciStatus: "failing",
      ciChecks: [
        { name: "build", status: "passed" },
        { name: "test", status: "failed" },
        { name: "lint", status: "passed" },
      ],
      mergeability: {
        mergeable: false,
        ciPassing: false,
        approved: true,
        noConflicts: true,
        blockers: ["CI failing"],
      },
    }),
    summary: "CI is failing and needs investigation.",
    lastActivityAt: ago(24),
  }),
  makeSession({
    id: "review-4",
    status: "changes_requested",
    activity: "idle",
    pr: makePR({
      number: 104,
      title: "refactor: terminal placeholder component",
      reviewDecision: "changes_requested",
      mergeability: {
        mergeable: false,
        ciPassing: true,
        approved: false,
        noConflicts: true,
        blockers: ["Changes requested"],
      },
      unresolvedThreads: 2,
      unresolvedComments: [
        {
          url: "https://github.com/ComposioHQ/agent-orchestrator/pull/104#discussion_r1",
          path: "packages/web/src/components/Terminal.tsx",
          author: "reviewer",
          body: "Please keep this as an xterm.js placeholder until PTY wiring lands.",
        },
      ],
    }),
    summary: "Reviewer requested changes on the terminal placeholder.",
    lastActivityAt: ago(31),
  }),
  makeSession({
    id: "review-6",
    status: "review_pending",
    activity: "ready",
    pr: makePR({
      number: 105,
      title: "feat: session detail merge readiness",
      reviewDecision: "pending",
      mergeability: {
        mergeable: false,
        ciPassing: true,
        approved: false,
        noConflicts: true,
        blockers: ["Needs review"],
      },
    }),
    summary: "Waiting on reviewer approval.",
    lastActivityAt: ago(45),
  }),
  makeSession({
    id: "docs-7",
    status: "pr_open",
    activity: "ready",
    pr: makePR({
      number: 106,
      title: "docs: dashboard test plan",
      reviewDecision: "none",
      ciStatus: "pending",
      ciChecks: [
        { name: "build", status: "running" },
        { name: "test", status: "pending" },
      ],
      mergeability: {
        mergeable: false,
        ciPassing: false,
        approved: false,
        noConflicts: true,
        blockers: ["CI pending", "Needs review"],
      },
    }),
    summary: "CI and review are pending.",
    lastActivityAt: ago(55),
  }),
  makeSession({
    id: "worker-9",
    status: "working",
    activity: "active",
    summary: "Implementing the dashboard home screen.",
    lastActivityAt: ago(1),
  }),
  makeSession({
    id: "worker-10",
    status: "working",
    activity: "ready",
    summary: "Agent finished a turn and is ready for the next check-in.",
    lastActivityAt: ago(9),
  }),
  makeSession({
    id: "merged-11",
    status: "merged",
    activity: "exited",
    pr: makePR({ number: 107, title: "feat: PR table", state: "merged" }),
    summary: "Merged dashboard PR table work.",
    lastActivityAt: ago(90),
  }),
  makeSession({
    id: "killed-12",
    status: "killed",
    activity: "exited",
    summary: "Terminated duplicate exploration session.",
    lastActivityAt: ago(120),
  }),
];

export function getMockDashboardPayload() {
  return {
    sessions: mockDashboardSessions,
    stats: computeStats(mockDashboardSessions),
    orchestratorId: "ao-mock-orchestrator",
    orchestrators: [
      {
        id: "ao-mock-orchestrator",
        projectId: "agent-orchestrator",
        projectName: "Agent Orchestrator",
        status: "working",
        activity: "active",
      },
    ],
  };
}

export function isMockDashboardRequested(url: string): boolean {
  const requestUrl = new URL(url);
  return requestUrl.searchParams.get("mock") === "true" || process.env.AO_WEB_MOCK_DATA === "true";
}
