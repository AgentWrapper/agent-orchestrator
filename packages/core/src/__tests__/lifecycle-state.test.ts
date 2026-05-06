import { describe, expect, it } from "vitest";
import {
  cloneLifecycle,
  createInitialCanonicalLifecycle,
  deriveLegacyStatus,
  parseCanonicalLifecycle,
} from "../lifecycle-state.js";

function createOpenPRLifecycle() {
  const lifecycle = createInitialCanonicalLifecycle("worker", new Date("2025-01-01T00:00:00Z"));
  lifecycle.session.startedAt = lifecycle.session.lastTransitionAt;
  lifecycle.pr.state = "open";
  lifecycle.pr.reason = "review_pending";
  lifecycle.pr.number = 42;
  lifecycle.pr.url = "https://github.com/org/repo/pull/42";
  lifecycle.pr.lastObservedAt = lifecycle.session.lastTransitionAt;
  lifecycle.runtime.state = "alive";
  lifecycle.runtime.reason = "process_running";
  return lifecycle;
}

describe("deriveLegacyStatus", () => {
  it("preserves urgent session states ahead of open PR aliases", () => {
    const needsInput = createOpenPRLifecycle();
    needsInput.session.state = "needs_input";
    needsInput.session.reason = "awaiting_user_input";

    const stuck = createOpenPRLifecycle();
    stuck.session.state = "stuck";
    stuck.session.reason = "probe_failure";

    const terminated = createOpenPRLifecycle();
    terminated.session.state = "terminated";
    terminated.session.reason = "manually_killed";

    expect(deriveLegacyStatus(needsInput)).toBe("needs_input");
    expect(deriveLegacyStatus(stuck)).toBe("stuck");
    expect(deriveLegacyStatus(terminated)).toBe("killed");
  });

  it("derives specific terminal statuses from lifecycle reason", () => {
    const killed = createOpenPRLifecycle();
    killed.session.state = "terminated";
    killed.session.reason = "manually_killed";

    const cleanup = createOpenPRLifecycle();
    cleanup.session.state = "terminated";
    cleanup.session.reason = "auto_cleanup";

    const errored = createOpenPRLifecycle();
    errored.session.state = "terminated";
    errored.session.reason = "error_in_process";

    const merged = createOpenPRLifecycle();
    merged.session.state = "terminated";
    merged.session.reason = "pr_merged";

    expect(deriveLegacyStatus(killed)).toBe("killed");
    expect(deriveLegacyStatus(cleanup)).toBe("cleanup");
    expect(deriveLegacyStatus(errored)).toBe("errored");
    expect(deriveLegacyStatus(merged)).toBe("cleanup");
  });

  it("keeps PR-oriented aliases for idle workers with open PRs", () => {
    const reviewPending = createOpenPRLifecycle();
    reviewPending.session.state = "idle";
    reviewPending.session.reason = "awaiting_external_review";

    const mergeReady = createOpenPRLifecycle();
    mergeReady.session.state = "idle";
    mergeReady.session.reason = "awaiting_external_review";
    mergeReady.pr.reason = "merge_ready";

    expect(deriveLegacyStatus(reviewPending)).toBe("review_pending");
    expect(deriveLegacyStatus(mergeReady)).toBe("mergeable");
  });
});

describe("parseCanonicalLifecycle", () => {
  it("rehydrates legacy merged sessions with a merged PR state", () => {
    const parsed = parseCanonicalLifecycle({
      status: "merged",
      pr: "https://github.com/org/repo/pull/42",
      createdAt: "2025-01-01T00:00:00.000Z",
    });

    expect(parsed.session.state).toBe("idle");
    expect(parsed.session.reason).toBe("merged_waiting_decision");
    expect(parsed.pr.state).toBe("merged");
    expect(parsed.pr.reason).toBe("merged");
    expect(parsed.pr.number).toBe(42);
    expect(deriveLegacyStatus(parsed)).toBe("merged");
  });

  it("preserves terminal merged state on legacy metadata with no pr URL", () => {
    // Regression: `status=merged` without `pr=` used to rehydrate as
    // `pr.state=none` + `session.state=idle`, making isTerminalSession() return
    // false and leaking merged sessions into active CLI listings.
    const parsed = parseCanonicalLifecycle({
      status: "merged",
      createdAt: "2025-01-01T00:00:00.000Z",
    });

    expect(parsed.pr.state).toBe("merged");
    expect(parsed.pr.reason).toBe("merged");
    expect(parsed.pr.number).toBeNull();
    expect(parsed.pr.url).toBeNull();
    expect(deriveLegacyStatus(parsed)).toBe("merged");
  });

  it("preserves explicit null payload fields instead of rehydrating stale flat metadata", () => {
    const lifecycle = createInitialCanonicalLifecycle("worker", new Date("2025-01-01T00:00:00Z"));
    lifecycle.session.state = "working";
    lifecycle.session.reason = "task_in_progress";
    lifecycle.session.startedAt = "2025-01-01T00:00:00.000Z";
    lifecycle.runtime.state = "alive";
    lifecycle.runtime.reason = "process_running";

    const parsed = parseCanonicalLifecycle({
      status: "working",
      role: "orchestrator",
      pr: "https://github.com/org/repo/pull/42",
      runtimeHandle: JSON.stringify({ id: "rt-1", runtimeName: "tmux", data: {} }),
      tmuxName: "tmux-1",
      stateVersion: "2",
      statePayload: JSON.stringify(lifecycle),
    });

    expect(parsed.session.kind).toBe("worker");
    expect(parsed.pr.url).toBeNull();
    expect(parsed.runtime.handle).toBeNull();
    expect(parsed.runtime.tmuxName).toBeNull();
  });

  it("falls back to synthesized lifecycle when a v2 payload is malformed", () => {
    const parsed = parseCanonicalLifecycle({
      status: "review_pending",
      pr: "https://github.com/org/repo/pull/42",
      stateVersion: "2",
      statePayload: JSON.stringify({
        version: 2,
        session: {
          kind: "worker",
          state: "working",
          reason: 123,
        },
      }),
    });

    expect(parsed.session.state).toBe("working");
    expect(parsed.session.reason).toBe("task_in_progress");
    expect(parsed.pr.state).toBe("open");
    expect(parsed.pr.reason).toBe("in_progress");
    expect(parsed.pr.number).toBe(42);
  });

  it("preserves valid partial v2 payload fields while synthesizing missing sections", () => {
    const parsed = parseCanonicalLifecycle({
      status: "review_pending",
      pr: "https://github.com/org/repo/pull/42",
      stateVersion: "2",
      statePayload: JSON.stringify({
        version: 2,
        session: {
          kind: "orchestrator",
          state: "idle",
          reason: "awaiting_external_review",
        },
      }),
    });

    expect(parsed.session.kind).toBe("orchestrator");
    expect(parsed.session.state).toBe("idle");
    expect(parsed.session.reason).toBe("awaiting_external_review");
    expect(parsed.pr.state).toBe("open");
    expect(parsed.pr.reason).toBe("in_progress");
    expect(parsed.pr.number).toBe(42);
  });

  it("normalizes runtime handles without data instead of discarding the payload", () => {
    const parsed = parseCanonicalLifecycle({
      status: "working",
      stateVersion: "2",
      statePayload: JSON.stringify({
        version: 2,
        runtime: {
          handle: {
            id: "rt-1",
            runtimeName: "tmux",
          },
        },
      }),
    });

    expect(parsed.runtime.handle).toEqual({
      id: "rt-1",
      runtimeName: "tmux",
      data: {},
    });
    expect(parsed.runtime.state).toBe("unknown");
    expect(parsed.runtime.reason).toBe("spawn_incomplete");
  });
});

describe("cloneLifecycle", () => {
  it("deep-clones nested runtime handle data", () => {
    const lifecycle = createInitialCanonicalLifecycle("worker", new Date("2025-01-01T00:00:00Z"));
    lifecycle.runtime.handle = {
      id: "rt-1",
      runtimeName: "tmux",
      data: {
        nested: { attempts: [1, 2, 3] },
      },
    };

    const cloned = cloneLifecycle(lifecycle);
    const clonedNested = cloned.runtime.handle?.data["nested"] as {
      attempts: number[];
    };
    clonedNested.attempts.push(4);

    expect(lifecycle.runtime.handle?.data).toEqual({
      nested: { attempts: [1, 2, 3] },
    });
    expect(cloned.runtime.handle?.data).toEqual({
      nested: { attempts: [1, 2, 3, 4] },
    });
  });
});
