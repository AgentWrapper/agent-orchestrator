import { describe, it, expect } from "vitest";
import { getActionChipLabel } from "../AttentionZone";
import { makeSession, makePR } from "@/__tests__/helpers";

describe("getActionChipLabel", () => {
  // ── Status-based signals take precedence (most authoritative) ────────

  describe("status-based", () => {
    it("returns 'needs input' for status: needs_input", () => {
      const session = makeSession({ status: "needs_input", activity: "idle" });
      expect(getActionChipLabel(session)).toBe("needs input");
    });

    it("returns 'stuck' for status: stuck", () => {
      const session = makeSession({ status: "stuck", activity: "idle" });
      expect(getActionChipLabel(session)).toBe("stuck");
    });

    it("returns 'errored' for status: errored", () => {
      const session = makeSession({ status: "errored", activity: "idle" });
      expect(getActionChipLabel(session)).toBe("errored");
    });

    it("returns 'ci failed' for status: ci_failed", () => {
      const session = makeSession({ status: "ci_failed", activity: "idle" });
      expect(getActionChipLabel(session)).toBe("ci failed");
    });

    it("returns 'changes' for status: changes_requested", () => {
      const session = makeSession({ status: "changes_requested", activity: "idle" });
      expect(getActionChipLabel(session)).toBe("changes");
    });

    it("status signals win over conflicting activity values", () => {
      // status: stuck + activity: active — status is authoritative
      const session = makeSession({ status: "stuck", activity: "active" });
      expect(getActionChipLabel(session)).toBe("stuck");
    });
  });

  // ── Activity-based signals (used when status is non-authoritative) ───

  describe("activity-based", () => {
    it("returns 'waiting' for activity: waiting_input", () => {
      const session = makeSession({ status: "working", activity: "waiting_input" });
      expect(getActionChipLabel(session)).toBe("waiting");
    });

    it("returns 'crashed' for activity: exited (non-terminal status)", () => {
      // An exited agent with a non-terminal status = the process crashed.
      // Critical: must not be labeled "needs input" — user needs to
      // investigate/restart, not send a message.
      const session = makeSession({ status: "working", activity: "exited", pr: null });
      expect(getActionChipLabel(session)).toBe("crashed");
    });

    it("returns 'blocked' for activity: blocked", () => {
      const session = makeSession({ status: "working", activity: "blocked" });
      expect(getActionChipLabel(session)).toBe("blocked");
    });
  });

  // ── PR-based signals (fallback when session-level is quiet) ──────────

  describe("PR-based", () => {
    it("returns 'ci failed' when PR ciStatus is failing", () => {
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
      const session = makeSession({ status: "working", activity: "idle", pr });
      expect(getActionChipLabel(session)).toBe("ci failed");
    });

    it("returns 'changes' when PR reviewDecision is changes_requested", () => {
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
      const session = makeSession({ status: "working", activity: "idle", pr });
      expect(getActionChipLabel(session)).toBe("changes");
    });

    it("returns 'conflicts' when PR has merge conflicts", () => {
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
      const session = makeSession({ status: "working", activity: "idle", pr });
      expect(getActionChipLabel(session)).toBe("conflicts");
    });
  });

  // ── Precedence (deeper conditions don't leak through) ────────────────

  describe("precedence", () => {
    it("status wins over PR ci_failing", () => {
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
      const session = makeSession({ status: "stuck", activity: "idle", pr });
      expect(getActionChipLabel(session)).toBe("stuck");
    });

    it("activity: exited wins over PR ci_failing", () => {
      // Agent crashed during a PR with failing CI — the crash is the
      // more urgent, more specific signal.
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
      const session = makeSession({ status: "working", activity: "exited", pr });
      expect(getActionChipLabel(session)).toBe("crashed");
    });

    it("activity: exited wins over status: changes_requested", () => {
      // A crashed agent whose PR also has changes_requested must still read
      // as "crashed" — labeling this "changes" hides the crash and steers the
      // operator toward PR review instead of restart. Mirrors the precedence
      // in getDetailedAttentionLevel (lib/types.ts): activity=exited classifies
      // as respond BEFORE status=changes_requested classifies as review.
      const session = makeSession({
        status: "changes_requested",
        activity: "exited",
        pr: null,
      });
      expect(getActionChipLabel(session)).toBe("crashed");
    });

    it("activity: waiting_input wins over status: ci_failed", () => {
      const session = makeSession({
        status: "ci_failed",
        activity: "waiting_input",
        pr: null,
      });
      expect(getActionChipLabel(session)).toBe("waiting");
    });

    it("PR ci_failing wins over PR changes_requested", () => {
      // CI failure is a harder blocker than review feedback.
      const pr = makePR({
        ciStatus: "failing",
        reviewDecision: "changes_requested",
        mergeability: {
          mergeable: false,
          ciPassing: false,
          approved: false,
          noConflicts: true,
          blockers: ["CI failing", "Changes requested"],
        },
      });
      const session = makeSession({ status: "working", activity: "idle", pr });
      expect(getActionChipLabel(session)).toBe("ci failed");
    });
  });

  // ── Generic fallback ─────────────────────────────────────────────────

  describe("fallback", () => {
    it("returns 'action' when no specific signal is available", () => {
      // Session is in the "action" bucket but we can't derive a more
      // specific reason — generic label is the safe default.
      const session = makeSession({ status: "working", activity: "idle", pr: null });
      expect(getActionChipLabel(session)).toBe("action");
    });
  });
});
