import type { DashboardSession, DashboardPR } from "@/lib/types";

/** Create a minimal mock session with overrides */
export function makeSession(overrides: Partial<DashboardSession> = {}): DashboardSession {
  return {
    id: "test-1",
    projectId: "my-app",
    status: "working",
    activity: "active",
    branch: "feat/test",
    issueId: "https://linear.app/test/issue/INT-100",
    issueUrl: "https://linear.app/test/issue/INT-100",
    issueLabel: "INT-100",
    issueTitle: null,
    summary: "Test session",
    summaryIsFallback: false,
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    pr: null,
    metadata: {},
    ...overrides,
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
    ...overrides,
  };
}
