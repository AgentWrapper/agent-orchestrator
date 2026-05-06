import { describe, it, expect } from "vitest";
import { getAttentionLevel } from "@/lib/types";
import { makeSession, makePR } from "./helpers";

describe("getAttentionLevel", () => {
  // ── MERGE (green zone — PRs ready to merge) ────────────────────────

  describe("merge zone", () => {
    it("returns merge when status is mergeable", () => {
      const pr = makePR({
        mergeability: {
          mergeable: true,
          ciPassing: true,
          approved: true,
          noConflicts: true,
          blockers: [],
        },
      });
      const session = makeSession({ status: "mergeable", activity: "idle", pr });
      expect(getAttentionLevel(session)).toBe("merge");
    });

    it("returns merge when PR mergeability is true", () => {
      const pr = makePR({
        mergeability: {
          mergeable: true,
          ciPassing: true,
          approved: true,
          noConflicts: true,
          blockers: [],
        },
      });
      const session = makeSession({ status: "pr_open", activity: "idle", pr });
      expect(getAttentionLevel(session)).toBe("merge");
    });
  });

  // ── RESPOND (red zone — agent needs human input) ───────────────────

  describe("respond zone", () => {
    it("returns respond when activity is waiting_input", () => {
      const session = makeSession({ activity: "waiting_input" });
      expect(getAttentionLevel(session)).toBe("respond");
    });

    it("returns respond when activity is blocked", () => {
      const session = makeSession({ activity: "blocked" });
      expect(getAttentionLevel(session)).toBe("respond");
    });

    it("returns respond when status is needs_input", () => {
      const session = makeSession({ status: "needs_input", activity: "idle" });
      expect(getAttentionLevel(session)).toBe("respond");
    });

    it("returns respond when status is stuck", () => {
      const session = makeSession({ status: "stuck", activity: "idle" });
      expect(getAttentionLevel(session)).toBe("respond");
    });

    it("returns respond when status is errored", () => {
      const session = makeSession({ status: "errored", activity: "idle" });
      expect(getAttentionLevel(session)).toBe("respond");
    });

    it("returns respond when agent has exited unexpectedly (non-terminal status)", () => {
      const session = makeSession({ status: "working", activity: "exited", pr: null });
      expect(getAttentionLevel(session)).toBe("respond");
    });

    it("returns respond when status is errored even if activity is active", () => {
      const session = makeSession({ status: "errored", activity: "active" });
      expect(getAttentionLevel(session)).toBe("respond");
    });

    it("returns respond when status is needs_input even if activity is active", () => {
      const session = makeSession({ status: "needs_input", activity: "active" });
      expect(getAttentionLevel(session)).toBe("respond");
    });

    it("returns respond when status is stuck even if activity is active", () => {
      const session = makeSession({ status: "stuck", activity: "active" });
      expect(getAttentionLevel(session)).toBe("respond");
    });

    it("merge takes priority over respond (mergeable PR + blocked agent)", () => {
      const pr = makePR({
        mergeability: {
          mergeable: true,
          ciPassing: true,
          approved: true,
          noConflicts: true,
          blockers: [],
        },
      });
      const session = makeSession({ status: "mergeable", activity: "blocked", pr });
      expect(getAttentionLevel(session)).toBe("merge");
    });
  });

  // ── REVIEW (orange zone — needs investigation) ─────────────────────

  describe("review zone", () => {
    it("returns review when CI is failing", () => {
      const pr = makePR({
        ciStatus: "failing",
        ciChecks: [{ name: "test", status: "failed" }],
        reviewDecision: "approved",
        mergeability: {
          mergeable: false,
          ciPassing: false,
          approved: true,
          noConflicts: true,
          blockers: ["CI failing"],
        },
      });
      const session = makeSession({ status: "ci_failed", activity: "idle", pr });
      expect(getAttentionLevel(session)).toBe("review");
    });

    it("returns review when changes are requested", () => {
      const pr = makePR({
        ciStatus: "passing",
        reviewDecision: "changes_requested",
        mergeability: {
          mergeable: false,
          ciPassing: true,
          approved: false,
          noConflicts: true,
          blockers: ["Changes requested"],
        },
      });
      const session = makeSession({ status: "changes_requested", activity: "idle", pr });
      expect(getAttentionLevel(session)).toBe("review");
    });

    it("returns review when there are merge conflicts", () => {
      const pr = makePR({
        ciStatus: "passing",
        reviewDecision: "approved",
        mergeability: {
          mergeable: false,
          ciPassing: true,
          approved: true,
          noConflicts: false,
          blockers: ["Merge conflict"],
        },
      });
      const session = makeSession({ status: "pr_open", activity: "idle", pr });
      expect(getAttentionLevel(session)).toBe("review");
    });
  });

  // ── PENDING (yellow zone — waiting on external) ────────────────────

  describe("pending zone", () => {
    it("returns pending when review is pending", () => {
      const pr = makePR({
        reviewDecision: "pending",
        mergeability: {
          mergeable: false,
          ciPassing: true,
          approved: false,
          noConflicts: true,
          blockers: ["Needs review"],
        },
      });
      const session = makeSession({ status: "review_pending", activity: "idle", pr });
      expect(getAttentionLevel(session)).toBe("pending");
    });

    it("returns pending when review decision is none", () => {
      const pr = makePR({
        reviewDecision: "none",
        mergeability: {
          mergeable: false,
          ciPassing: true,
          approved: false,
          noConflicts: true,
          blockers: ["Needs review"],
        },
      });
      const session = makeSession({ status: "pr_open", activity: "idle", pr });
      expect(getAttentionLevel(session)).toBe("pending");
    });

    it("returns pending when there are unresolved threads", () => {
      const pr = makePR({
        reviewDecision: "approved",
        unresolvedThreads: 2,
        unresolvedComments: [
          { url: "https://example.com/1", path: "src/foo.ts", author: "bob", body: "fix this" },
          { url: "https://example.com/2", path: "src/bar.ts", author: "bob", body: "also this" },
        ],
        mergeability: {
          mergeable: false,
          ciPassing: true,
          approved: true,
          noConflicts: true,
          blockers: ["Unresolved comments"],
        },
      });
      const session = makeSession({ status: "pr_open", activity: "idle", pr });
      expect(getAttentionLevel(session)).toBe("pending");
    });
  });

  // ── WORKING (blue zone — agents doing their thing) ─────────────────

  describe("working zone", () => {
    it("returns working when actively working with no PR", () => {
      const session = makeSession({ status: "working", activity: "active", pr: null });
      expect(getAttentionLevel(session)).toBe("working");
    });

    it("returns working when spawning", () => {
      const session = makeSession({ status: "spawning", activity: "active", pr: null });
      expect(getAttentionLevel(session)).toBe("working");
    });

    it("returns working for idle session with no PR", () => {
      const session = makeSession({ status: "working", activity: "idle", pr: null });
      expect(getAttentionLevel(session)).toBe("working");
    });

    it("returns working for draft PR with reviewDecision none", () => {
      const pr = makePR({
        isDraft: true,
        reviewDecision: "none",
        mergeability: {
          mergeable: false,
          ciPassing: true,
          approved: false,
          noConflicts: true,
          blockers: ["Draft PR"],
        },
      });
      const session = makeSession({ status: "working", activity: "active", pr });
      expect(getAttentionLevel(session)).toBe("working");
    });
  });

  // ── DONE (grey zone — archived) ────────────────────────────────────

  describe("done zone", () => {
    it("returns done when PR is merged", () => {
      const pr = makePR({ state: "merged" });
      const session = makeSession({
        status: "merged",
        activity: "exited",
        pr,
        lifecycle: {
          ...makeSession().lifecycle!,
          sessionState: "idle",
          sessionReason: "merged_waiting_decision",
          prState: "merged",
          prReason: "merged",
        },
      });
      expect(getAttentionLevel(session)).toBe("done");
    });

    it("returns pending when the PR is closed without merge but runtime is still alive", () => {
      const pr = makePR({
        state: "closed",
        reviewDecision: "none",
        mergeability: {
          mergeable: false,
          ciPassing: false,
          approved: false,
          noConflicts: true,
          blockers: [],
        },
      });
      const session = makeSession({
        status: "idle",
        activity: "idle",
        pr,
        lifecycle: {
          ...makeSession().lifecycle!,
          sessionState: "idle",
          sessionReason: "pr_closed_waiting_decision",
          prState: "closed",
          prReason: "closed_unmerged",
          runtimeState: "alive",
        },
      });
      expect(getAttentionLevel(session)).toBe("pending");
    });

    it("returns done when session status is merged (even with open PR state)", () => {
      const pr = makePR({ state: "merged" });
      const session = makeSession({ status: "merged", activity: "idle", pr, lifecycle: undefined });
      expect(getAttentionLevel(session)).toBe("done");
    });

    it("returns done when session is killed", () => {
      const session = makeSession({
        status: "killed",
        activity: "exited",
        pr: null,
        lifecycle: undefined,
      });
      expect(getAttentionLevel(session)).toBe("done");
    });

    it("returns done when agent has exited with cleanup status", () => {
      const session = makeSession({
        status: "cleanup",
        activity: "exited",
        pr: null,
        lifecycle: undefined,
      });
      expect(getAttentionLevel(session)).toBe("done");
    });
  });

  // ── SIMPLE MODE (4-zone Kanban — respond + review → action) ───────
  describe("simple mode", () => {
    it("collapses waiting_input (respond) into action", () => {
      const session = makeSession({ activity: "waiting_input" });
      expect(getAttentionLevel(session, "simple")).toBe("action");
    });

    it("collapses needs_input status into action", () => {
      const session = makeSession({ status: "needs_input", activity: "idle" });
      expect(getAttentionLevel(session, "simple")).toBe("action");
    });

    it("collapses stuck/errored statuses into action", () => {
      expect(
        getAttentionLevel(makeSession({ status: "stuck", activity: "idle" }), "simple"),
      ).toBe("action");
      expect(
        getAttentionLevel(makeSession({ status: "errored", activity: "idle" }), "simple"),
      ).toBe("action");
    });

    it("collapses CI failure (review) into action", () => {
      const pr = makePR({
        ciStatus: "failing",
        reviewDecision: "approved",
        mergeability: {
          mergeable: false,
          ciPassing: false,
          approved: true,
          noConflicts: true,
          blockers: ["CI failing"],
        },
      });
      const session = makeSession({ status: "ci_failed", activity: "idle", pr });
      expect(getAttentionLevel(session, "simple")).toBe("action");
    });

    it("collapses changes_requested (review) into action", () => {
      const pr = makePR({
        reviewDecision: "changes_requested",
        mergeability: {
          mergeable: false,
          ciPassing: true,
          approved: false,
          noConflicts: true,
          blockers: ["Changes requested"],
        },
      });
      const session = makeSession({ status: "changes_requested", activity: "idle", pr });
      expect(getAttentionLevel(session, "simple")).toBe("action");
    });

    it("preserves merge zone in simple mode", () => {
      const pr = makePR({
        mergeability: {
          mergeable: true,
          ciPassing: true,
          approved: true,
          noConflicts: true,
          blockers: [],
        },
      });
      const session = makeSession({ status: "mergeable", activity: "idle", pr });
      expect(getAttentionLevel(session, "simple")).toBe("merge");
    });

    it("preserves pending zone in simple mode", () => {
      const pr = makePR({
        reviewDecision: "pending",
        mergeability: {
          mergeable: false,
          ciPassing: true,
          approved: false,
          noConflicts: true,
          blockers: ["Needs review"],
        },
      });
      const session = makeSession({ status: "review_pending", activity: "idle", pr });
      expect(getAttentionLevel(session, "simple")).toBe("pending");
    });

    it("preserves working zone in simple mode", () => {
      const session = makeSession({ status: "working", activity: "active", pr: null });
      expect(getAttentionLevel(session, "simple")).toBe("working");
    });

    it("preserves done zone in simple mode", () => {
      const session = makeSession({ status: "killed", activity: "exited", pr: null });
      expect(getAttentionLevel(session, "simple")).toBe("done");
    });

    it("merge takes priority over action in simple mode", () => {
      const pr = makePR({
        mergeability: {
          mergeable: true,
          ciPassing: true,
          approved: true,
          noConflicts: true,
          blockers: [],
        },
      });
      const session = makeSession({ status: "mergeable", activity: "blocked", pr });
      expect(getAttentionLevel(session, "simple")).toBe("merge");
    });
  });

  // ── DETAILED MODE (explicit — should match function default) ──────
  describe("detailed mode", () => {
    it("keeps respond and review as distinct levels", () => {
      const waiting = makeSession({ activity: "waiting_input" });
      expect(getAttentionLevel(waiting, "detailed")).toBe("respond");

      const pr = makePR({
        ciStatus: "failing",
        mergeability: {
          mergeable: false,
          ciPassing: false,
          approved: true,
          noConflicts: true,
          blockers: ["CI failing"],
        },
      });
      const ciFailed = makeSession({ status: "ci_failed", activity: "idle", pr });
      expect(getAttentionLevel(ciFailed, "detailed")).toBe("review");
    });

    it("matches the function default (detailed is the default mode)", () => {
      const session = makeSession({ activity: "waiting_input" });
      expect(getAttentionLevel(session)).toBe(getAttentionLevel(session, "detailed"));
    });
  });
});
