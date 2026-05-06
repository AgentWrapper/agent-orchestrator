/**
 * Tests for dashboard types and attention level classification
 */

import { describe, it, expect } from "vitest";
import {
  getAttentionLevel,
  getActivitySignalLabel,
  getActivitySignalReasonLabel,
  isPRMergeReady,
  TERMINAL_STATUSES,
  TERMINAL_ACTIVITIES,
  NON_RESTORABLE_STATUSES,
  isDashboardSessionDone,
  isDashboardSessionRestorable,
  type DashboardSession,
  type DashboardPR,
} from "../types";
import {
  TERMINAL_STATUSES as CORE_TERMINAL_STATUSES,
  TERMINAL_ACTIVITIES as CORE_TERMINAL_ACTIVITIES,
  NON_RESTORABLE_STATUSES as CORE_NON_RESTORABLE_STATUSES,
} from "@aoagents/ao-core/types";

// Helper to create a minimal DashboardSession for testing
function createSession(overrides?: Partial<DashboardSession>): DashboardSession {
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
    summary: "Test session",
    summaryIsFallback: false,
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    pr: null,
    metadata: {},
    ...overrides,
  };
}

describe("getAttentionLevel", () => {
  describe("done state", () => {
    it("should return 'done' for merged status", () => {
      const session = createSession({ status: "merged" });
      expect(getAttentionLevel(session)).toBe("done");
    });

    it("should return 'done' for killed status", () => {
      const session = createSession({ status: "killed" });
      expect(getAttentionLevel(session)).toBe("done");
    });

    it("should return 'done' for cleanup status", () => {
      const session = createSession({ status: "cleanup" });
      expect(getAttentionLevel(session)).toBe("done");
    });

    it("should return 'done' for done status", () => {
      const session = createSession({ status: "done" });
      expect(getAttentionLevel(session)).toBe("done");
    });

    it("should return 'done' for terminated status", () => {
      const session = createSession({ status: "terminated" });
      expect(getAttentionLevel(session)).toBe("done");
    });

    it("should return 'done' for merged PR regardless of session status", () => {
      const session = createSession({
        status: "working",
        lifecycle: {
          sessionState: "idle",
          sessionReason: "merged_waiting_decision",
          prState: "merged",
          prReason: "merged",
          runtimeState: "alive",
          runtimeReason: "process_running",
          session: {
            state: "idle",
            reason: "merged_waiting_decision",
            label: "merged, waiting decision",
            reasonLabel: "merged waiting decision",
          },
          pr: { state: "merged", reason: "merged", label: "merged", reasonLabel: "merged" },
          runtime: {
            state: "alive",
            reason: "process_running",
            label: "alive",
            reasonLabel: "process running",
          },
          legacyStatus: "merged",
          evidence: null,
          detectingAttempts: 0,
          detectingEscalatedAt: null,
          summary: "PR merged; worker session will be cleaned up automatically",
          guidance: null,
        },
        pr: {
          number: 1,
          url: "https://github.com/test/repo/pull/1",
          title: "Test PR",
          owner: "test",
          repo: "repo",
          branch: "feat/test",
          baseBranch: "main",
          isDraft: false,
          state: "merged",
          additions: 10,
          deletions: 5,
          ciStatus: "passing",
          ciChecks: [],
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
        },
      });
      expect(getAttentionLevel(session)).toBe("done");
    });

    it("should keep closed-unmerged PR sessions actionable", () => {
      const session = createSession({
        status: "working",
        lifecycle: {
          sessionState: "idle",
          sessionReason: "pr_closed_waiting_decision",
          prState: "closed",
          prReason: "closed_unmerged",
          runtimeState: "alive",
          runtimeReason: "process_running",
          session: {
            state: "idle",
            reason: "pr_closed_waiting_decision",
            label: "idle",
            reasonLabel: "pr closed waiting decision",
          },
          pr: {
            state: "closed",
            reason: "closed_unmerged",
            label: "closed",
            reasonLabel: "closed unmerged",
          },
          runtime: {
            state: "alive",
            reason: "process_running",
            label: "alive",
            reasonLabel: "process running",
          },
          legacyStatus: "idle",
          evidence: null,
          detectingAttempts: 0,
          detectingEscalatedAt: null,
          summary: "PR closed without merge",
          guidance: null,
        },
        pr: {
          number: 1,
          url: "https://github.com/test/repo/pull/1",
          title: "Test PR",
          owner: "test",
          repo: "repo",
          branch: "feat/test",
          baseBranch: "main",
          isDraft: false,
          state: "closed",
          additions: 10,
          deletions: 5,
          ciStatus: "none",
          ciChecks: [],
          reviewDecision: "none",
          mergeability: {
            mergeable: false,
            ciPassing: false,
            approved: false,
            noConflicts: true,
            blockers: [],
          },
          unresolvedThreads: 0,
          unresolvedComments: [],
        },
      });
      expect(isDashboardSessionDone(session)).toBe(false);
      expect(isDashboardSessionRestorable(session)).toBe(false);
      expect(getAttentionLevel(session)).toBe("pending");
    });

    it("should ignore metadata attention overrides for terminal sessions", () => {
      const session = createSession({
        status: "terminated",
        metadata: { attentionLevel: "working" },
      });
      expect(getAttentionLevel(session)).toBe("done");
    });
  });

  describe("merge state", () => {
    it("should return 'merge' for mergeable status", () => {
      const session = createSession({ status: "mergeable" });
      expect(getAttentionLevel(session)).toBe("merge");
    });

    it("should return 'merge' for approved status", () => {
      const session = createSession({ status: "approved" });
      expect(getAttentionLevel(session)).toBe("merge");
    });

    it("should return 'merge' when PR is mergeable", () => {
      const session = createSession({
        status: "pr_open",
        pr: {
          number: 1,
          url: "https://github.com/test/repo/pull/1",
          title: "Test PR",
          owner: "test",
          repo: "repo",
          branch: "feat/test",
          baseBranch: "main",
          isDraft: false,
          state: "open",
          additions: 10,
          deletions: 5,
          ciStatus: "passing",
          ciChecks: [],
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
        },
      });
      expect(getAttentionLevel(session)).toBe("merge");
    });

    it("should ignore metadata attention overrides when merge criteria are met", () => {
      const session = createSession({
        status: "mergeable",
        metadata: { attentionLevel: "working" },
      });
      expect(getAttentionLevel(session)).toBe("merge");
    });
  });

  describe("restore affordances", () => {
    it("should not mark merged sessions as restorable", () => {
      const session = createSession({
        status: "merged",
        lifecycle: {
          sessionState: "idle",
          sessionReason: "merged_waiting_decision",
          prState: "merged",
          prReason: "merged",
          runtimeState: "alive",
          runtimeReason: "process_running",
          session: {
            state: "idle",
            reason: "merged_waiting_decision",
            label: "merged, waiting decision",
            reasonLabel: "merged waiting decision",
          },
          pr: { state: "merged", reason: "merged", label: "merged", reasonLabel: "merged" },
          runtime: {
            state: "alive",
            reason: "process_running",
            label: "alive",
            reasonLabel: "process running",
          },
          legacyStatus: "merged",
          evidence: null,
          detectingAttempts: 0,
          detectingEscalatedAt: null,
          summary: "PR merged; worker session will be cleaned up automatically",
          guidance: null,
        },
      });

      expect(isDashboardSessionRestorable(session)).toBe(false);
    });
  });

  describe("respond state", () => {
    it("should return 'respond' for waiting_input activity", () => {
      const session = createSession({ activity: "waiting_input" });
      expect(getAttentionLevel(session)).toBe("respond");
    });

    it("should return 'respond' for detecting lifecycle state", () => {
      const session = createSession({
        status: "detecting",
        lifecycle: {
          sessionState: "detecting",
          sessionReason: "probe_failure",
          prState: "open",
          prReason: "in_progress",
          runtimeState: "probe_failed",
          runtimeReason: "probe_error",
          session: {
            state: "detecting",
            reason: "probe_failure",
            label: "detecting",
            reasonLabel: "probe failure",
          },
          pr: { state: "open", reason: "in_progress", label: "open", reasonLabel: "in progress" },
          runtime: {
            state: "probe_failed",
            reason: "probe_error",
            label: "probe failed",
            reasonLabel: "probe error",
          },
          legacyStatus: "detecting",
          evidence: "signal_disagreement",
          detectingAttempts: 1,
          detectingEscalatedAt: null,
          summary: "Detecting runtime truth (probe failure)",
          guidance: "Checking runtime and process evidence now. Retry 1 is in progress.",
        },
      });
      expect(getAttentionLevel(session)).toBe("respond");
    });

    it("should return 'respond' for blocked activity", () => {
      const session = createSession({ activity: "blocked" });
      expect(getAttentionLevel(session)).toBe("respond");
    });

    it("should return 'respond' for needs_input status", () => {
      const session = createSession({ status: "needs_input" });
      expect(getAttentionLevel(session)).toBe("respond");
    });

    it("should return 'respond' for stuck status", () => {
      const session = createSession({ status: "stuck" });
      expect(getAttentionLevel(session)).toBe("respond");
    });

    it("should return 'respond' for errored status", () => {
      const session = createSession({ status: "errored" });
      expect(getAttentionLevel(session)).toBe("respond");
    });

    it("should return 'respond' for exited activity", () => {
      const session = createSession({ activity: "exited" });
      expect(getAttentionLevel(session)).toBe("respond");
    });
  });

  describe("review state", () => {
    it("should return 'review' for ci_failed status", () => {
      const session = createSession({ status: "ci_failed" });
      expect(getAttentionLevel(session)).toBe("review");
    });

    it("should return 'review' for changes_requested status", () => {
      const session = createSession({ status: "changes_requested" });
      expect(getAttentionLevel(session)).toBe("review");
    });

    it("should return 'review' when PR has failing CI", () => {
      const session = createSession({
        status: "pr_open",
        pr: {
          number: 1,
          url: "https://github.com/test/repo/pull/1",
          title: "Test PR",
          owner: "test",
          repo: "repo",
          branch: "feat/test",
          baseBranch: "main",
          isDraft: false,
          state: "open",
          additions: 10,
          deletions: 5,
          ciStatus: "failing",
          ciChecks: [],
          reviewDecision: "none",
          mergeability: {
            mergeable: false,
            ciPassing: false,
            approved: false,
            noConflicts: true,
            blockers: ["CI is failing"],
          },
          unresolvedThreads: 0,
          unresolvedComments: [],
        },
      });
      expect(getAttentionLevel(session)).toBe("review");
    });

    it("should return 'review' when PR has changes requested", () => {
      const session = createSession({
        status: "pr_open",
        pr: {
          number: 1,
          url: "https://github.com/test/repo/pull/1",
          title: "Test PR",
          owner: "test",
          repo: "repo",
          branch: "feat/test",
          baseBranch: "main",
          isDraft: false,
          state: "open",
          additions: 10,
          deletions: 5,
          ciStatus: "passing",
          ciChecks: [],
          reviewDecision: "changes_requested",
          mergeability: {
            mergeable: false,
            ciPassing: true,
            approved: false,
            noConflicts: true,
            blockers: ["Changes requested in review"],
          },
          unresolvedThreads: 0,
          unresolvedComments: [],
        },
      });
      expect(getAttentionLevel(session)).toBe("review");
    });

    it("should return 'review' when PR has merge conflicts", () => {
      const session = createSession({
        status: "pr_open",
        pr: {
          number: 1,
          url: "https://github.com/test/repo/pull/1",
          title: "Test PR",
          owner: "test",
          repo: "repo",
          branch: "feat/test",
          baseBranch: "main",
          isDraft: false,
          state: "open",
          additions: 10,
          deletions: 5,
          ciStatus: "passing",
          ciChecks: [],
          reviewDecision: "none",
          mergeability: {
            mergeable: false,
            ciPassing: true,
            approved: false,
            noConflicts: false,
            blockers: ["Merge conflicts"],
          },
          unresolvedThreads: 0,
          unresolvedComments: [],
        },
      });
      expect(getAttentionLevel(session)).toBe("review");
    });
  });

  describe("pending state", () => {
    it("should return 'pending' for review_pending status", () => {
      const session = createSession({ status: "review_pending" });
      expect(getAttentionLevel(session)).toBe("pending");
    });

    it("should return 'pending' when PR has unresolved threads", () => {
      const session = createSession({
        status: "pr_open",
        pr: {
          number: 1,
          url: "https://github.com/test/repo/pull/1",
          title: "Test PR",
          owner: "test",
          repo: "repo",
          branch: "feat/test",
          baseBranch: "main",
          isDraft: false,
          state: "open",
          additions: 10,
          deletions: 5,
          ciStatus: "passing",
          ciChecks: [],
          reviewDecision: "none",
          mergeability: {
            mergeable: false,
            ciPassing: true,
            approved: false,
            noConflicts: true,
            blockers: [],
          },
          unresolvedThreads: 3,
          unresolvedComments: [{ url: "", path: "", author: "reviewer", body: "comment" }],
        },
      });
      expect(getAttentionLevel(session)).toBe("pending");
    });

    it("should return 'pending' when PR is waiting for review", () => {
      const session = createSession({
        status: "pr_open",
        pr: {
          number: 1,
          url: "https://github.com/test/repo/pull/1",
          title: "Test PR",
          owner: "test",
          repo: "repo",
          branch: "feat/test",
          baseBranch: "main",
          isDraft: false,
          state: "open",
          additions: 10,
          deletions: 5,
          ciStatus: "passing",
          ciChecks: [],
          reviewDecision: "pending",
          mergeability: {
            mergeable: false,
            ciPassing: true,
            approved: false,
            noConflicts: true,
            blockers: ["Review required"],
          },
          unresolvedThreads: 0,
          unresolvedComments: [],
        },
      });
      expect(getAttentionLevel(session)).toBe("pending");
    });

    it("should not mark an actively working session as pending only because PR truth is in progress", () => {
      const session = createSession({
        status: "working",
        activity: "active",
        lifecycle: {
          sessionState: "working",
          sessionReason: "task_in_progress",
          prState: "open",
          prReason: "in_progress",
          runtimeState: "alive",
          runtimeReason: "process_running",
          session: {
            state: "working",
            reason: "task_in_progress",
            label: "working",
            reasonLabel: "task in progress",
          },
          pr: { state: "open", reason: "in_progress", label: "open", reasonLabel: "in progress" },
          runtime: {
            state: "alive",
            reason: "process_running",
            label: "alive",
            reasonLabel: "process running",
          },
          legacyStatus: "pr_open",
          evidence: null,
          detectingAttempts: 0,
          detectingEscalatedAt: null,
          summary: "Session working (task in progress)",
          guidance: null,
        },
      });

      expect(getAttentionLevel(session)).toBe("working");
    });

    it("should not flag draft PRs as pending", () => {
      const session = createSession({
        status: "working",
        pr: {
          number: 1,
          url: "https://github.com/test/repo/pull/1",
          title: "Test PR",
          owner: "test",
          repo: "repo",
          branch: "feat/test",
          baseBranch: "main",
          isDraft: true,
          state: "open",
          additions: 10,
          deletions: 5,
          ciStatus: "passing",
          ciChecks: [],
          reviewDecision: "none",
          mergeability: {
            mergeable: false,
            ciPassing: true,
            approved: false,
            noConflicts: true,
            blockers: ["PR is still a draft"],
          },
          unresolvedThreads: 2,
          unresolvedComments: [],
        },
      });
      expect(getAttentionLevel(session)).toBe("working");
    });

    it("should keep idle sessions with open PRs and in-flight CI in working", () => {
      const session = createSession({
        status: "working",
        lifecycle: {
          sessionState: "idle",
          sessionReason: "task_in_progress",
          prState: "open",
          prReason: "in_progress",
          runtimeState: "alive",
          runtimeReason: "process_running",
          session: {
            state: "idle",
            reason: "task_in_progress",
            label: "idle",
            reasonLabel: "task in progress",
          },
          pr: {
            state: "open",
            reason: "in_progress",
            label: "open",
            reasonLabel: "in progress",
          },
          runtime: {
            state: "alive",
            reason: "process_running",
            label: "alive",
            reasonLabel: "process running",
          },
          legacyStatus: "working",
          evidence: null,
          detectingAttempts: 0,
          detectingEscalatedAt: null,
          summary: "Session idle while CI is still running",
          guidance: null,
        },
        pr: null,
      });

      expect(getAttentionLevel(session)).toBe("working");
    });
  });

  describe("working state", () => {
    it("should return 'working' for spawning status", () => {
      const session = createSession({ status: "spawning" });
      expect(getAttentionLevel(session)).toBe("working");
    });

    it("should return 'working' for working status with active activity", () => {
      const session = createSession({
        status: "working",
        activity: "active",
      });
      expect(getAttentionLevel(session)).toBe("working");
    });

    it("should return 'working' for idle agent", () => {
      const session = createSession({
        status: "working",
        activity: "idle",
      });
      expect(getAttentionLevel(session)).toBe("working");
    });

    it("should return 'working' for session with draft PR", () => {
      const session = createSession({
        status: "working",
        pr: {
          number: 1,
          url: "https://github.com/test/repo/pull/1",
          title: "Test PR",
          owner: "test",
          repo: "repo",
          branch: "feat/test",
          baseBranch: "main",
          isDraft: true,
          state: "open",
          additions: 10,
          deletions: 5,
          ciStatus: "none",
          ciChecks: [],
          reviewDecision: "none",
          mergeability: {
            mergeable: false,
            ciPassing: false,
            approved: false,
            noConflicts: true,
            blockers: ["PR is still a draft"],
          },
          unresolvedThreads: 0,
          unresolvedComments: [],
        },
      });
      expect(getAttentionLevel(session)).toBe("working");
    });
  });
});

// Helper to create a minimal DashboardPR for testing
function createPR(overrides?: Partial<DashboardPR>): DashboardPR {
  return {
    number: 1,
    url: "https://github.com/test/repo/pull/1",
    title: "Test PR",
    owner: "test",
    repo: "repo",
    branch: "feat/test",
    baseBranch: "main",
    isDraft: false,
    state: "open",
    additions: 10,
    deletions: 5,
    ciStatus: "passing",
    ciChecks: [],
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

describe("isPRMergeReady", () => {
  it("returns true for open PR with all criteria met", () => {
    const pr = createPR();
    expect(isPRMergeReady(pr)).toBe(true);
  });

  it("returns false for merged PR even with all criteria met", () => {
    const pr = createPR({ state: "merged" });
    expect(isPRMergeReady(pr)).toBe(false);
  });

  it("returns false for closed PR even with all criteria met", () => {
    const pr = createPR({ state: "closed" });
    expect(isPRMergeReady(pr)).toBe(false);
  });

  it("returns false for open PR that is not mergeable", () => {
    const pr = createPR({
      mergeability: {
        mergeable: false,
        ciPassing: true,
        approved: true,
        noConflicts: true,
        blockers: ["Not mergeable"],
      },
    });
    expect(isPRMergeReady(pr)).toBe(false);
  });

  it("returns false for open PR with failing CI", () => {
    const pr = createPR({
      mergeability: {
        mergeable: true,
        ciPassing: false,
        approved: true,
        noConflicts: true,
        blockers: [],
      },
    });
    expect(isPRMergeReady(pr)).toBe(false);
  });

  it("returns false for open PR that is not approved", () => {
    const pr = createPR({
      mergeability: {
        mergeable: true,
        ciPassing: true,
        approved: false,
        noConflicts: true,
        blockers: [],
      },
    });
    expect(isPRMergeReady(pr)).toBe(false);
  });

  it("returns false for open PR with merge conflicts", () => {
    const pr = createPR({
      mergeability: {
        mergeable: true,
        ciPassing: true,
        approved: true,
        noConflicts: false,
        blockers: [],
      },
    });
    expect(isPRMergeReady(pr)).toBe(false);
  });
});

describe("constants sync with core", () => {
  it("TERMINAL_STATUSES matches core", () => {
    expect(TERMINAL_STATUSES).toBe(CORE_TERMINAL_STATUSES);
  });

  it("TERMINAL_ACTIVITIES matches core", () => {
    expect(TERMINAL_ACTIVITIES).toBe(CORE_TERMINAL_ACTIVITIES);
  });

  it("NON_RESTORABLE_STATUSES matches core", () => {
    expect(NON_RESTORABLE_STATUSES).toBe(CORE_NON_RESTORABLE_STATUSES);
  });
});

describe("activity signal fallback", () => {
  it("treats legacy idle activity without a timestamp as stale", () => {
    const session = createSession({
      activity: "idle",
      activitySignal: undefined,
    });

    expect(getActivitySignalLabel(session)).toBe("idle (stale)");
    expect(getActivitySignalReasonLabel(session)).toBe("missing timestamp");
  });

  it("treats legacy blocked activity without a timestamp as stale", () => {
    const session = createSession({
      activity: "blocked",
      activitySignal: undefined,
    });

    expect(getActivitySignalLabel(session)).toBe("blocked (stale)");
    expect(getActivitySignalReasonLabel(session)).toBe("missing timestamp");
  });

  it("keeps legacy active activity valid", () => {
    const session = createSession({
      activity: "active",
      activitySignal: undefined,
    });

    expect(getActivitySignalLabel(session)).toBe("active");
    expect(getActivitySignalReasonLabel(session)).toBeNull();
  });
});
