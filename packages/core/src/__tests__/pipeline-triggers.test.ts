/**
 * Trigger evaluation + concurrency policy + auto-trigger pass tests.
 *
 * Three layers, in order of widening scope:
 *  1. Pure glob + filter evaluation (`evaluateTrigger`)
 *  2. Concurrency decision (`decideConcurrencyAction`)
 *  3. End-to-end pass (`runAutoTriggerPass`) with fake SCM + dispatcher,
 *     covering: dispatch, cancel_then_start, skip, queue, drain, and the
 *     last-checked timestamp advance.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  anyValueMatchesAnyGlob,
  asPipelineId,
  decideConcurrencyAction,
  evaluateTrigger,
  matchesAnyGlob,
  runAutoTriggerPass,
  readAutoTriggerState,
  writeAutoTriggerState,
  type AutoTriggerState,
  type ConcurrencyPolicy,
  type Pipeline,
  type PipelineTrigger,
} from "../pipeline/index.js";
import type { SCM, PREvent } from "../types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function trigger(overrides: Partial<PipelineTrigger> = {}): PipelineTrigger {
  return { on: "pr_opened", ...overrides };
}

function makeEvent(overrides: Partial<PREvent> = {}): PREvent {
  return {
    type: "pr_opened",
    prNumber: 1,
    baseBranch: "main",
    headBranch: "feature/x",
    labels: [],
    changedFiles: [],
    isDraft: false,
    occurredAt: new Date("2026-05-06T10:00:00Z"),
    ...overrides,
  };
}

function makePipeline(overrides: Partial<Pipeline> = {}): Pipeline {
  return {
    id: asPipelineId("review"),
    name: "review",
    stages: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Glob matching
// ---------------------------------------------------------------------------

describe("matchesAnyGlob", () => {
  it("returns true when patterns is undefined or empty (filter not set)", () => {
    expect(matchesAnyGlob(undefined, "anything")).toBe(true);
    expect(matchesAnyGlob([], "anything")).toBe(true);
  });

  it("matches exact strings", () => {
    expect(matchesAnyGlob(["main"], "main")).toBe(true);
    expect(matchesAnyGlob(["main"], "develop")).toBe(false);
  });

  it("supports * single-segment wildcard", () => {
    expect(matchesAnyGlob(["release/*"], "release/1.2.3")).toBe(true);
    expect(matchesAnyGlob(["release/*"], "release/feature/x")).toBe(false);
  });

  it("supports ** any-segment wildcard", () => {
    expect(matchesAnyGlob(["src/**"], "src/foo/bar.ts")).toBe(true);
    expect(matchesAnyGlob(["src/**"], "src/foo.ts")).toBe(true);
    expect(matchesAnyGlob(["src/**"], "lib/foo.ts")).toBe(false);
  });

  it("matches root-level files with **\\/X (GitHub Actions semantics)", () => {
    // **\/*.ts must match both `config.ts` (root) and `src/foo.ts` (nested)
    expect(matchesAnyGlob(["**/*.ts"], "config.ts")).toBe(true);
    expect(matchesAnyGlob(["**/*.ts"], "src/foo.ts")).toBe(true);
    expect(matchesAnyGlob(["**/*.ts"], "src/nested/foo.ts")).toBe(true);
    expect(matchesAnyGlob(["**/*.ts"], "config.js")).toBe(false);
  });

  it("escapes regex metacharacters in literal segments", () => {
    expect(matchesAnyGlob(["a.b"], "axb")).toBe(false); // dot is literal
    expect(matchesAnyGlob(["a.b"], "a.b")).toBe(true);
  });
});

describe("anyValueMatchesAnyGlob", () => {
  it("returns true when patterns is undefined (filter not set)", () => {
    expect(anyValueMatchesAnyGlob(undefined, [])).toBe(true);
    expect(anyValueMatchesAnyGlob(undefined, ["anything"])).toBe(true);
  });

  it("returns false when patterns is set but values is empty", () => {
    expect(anyValueMatchesAnyGlob(["src/**"], [])).toBe(false);
  });

  it("returns true if any value matches any pattern", () => {
    expect(
      anyValueMatchesAnyGlob(
        ["src/**", "packages/**"],
        ["docs/intro.md", "src/foo.ts"],
      ),
    ).toBe(true);
  });

  it("returns false if no value matches any pattern", () => {
    expect(
      anyValueMatchesAnyGlob(
        ["src/**", "packages/**"],
        ["docs/intro.md", "README.md"],
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluateTrigger
// ---------------------------------------------------------------------------

describe("evaluateTrigger", () => {
  it("fires on event-type match with no filters", () => {
    expect(
      evaluateTrigger({ trigger: trigger({ on: "pr_opened" }), event: makeEvent() }),
    ).toBe(true);
  });

  it("does not fire when event type differs from trigger.on", () => {
    expect(
      evaluateTrigger({
        trigger: trigger({ on: "pr_push" }),
        event: makeEvent({ type: "pr_opened" }),
      }),
    ).toBe(false);
  });

  it("never fires for manual triggers", () => {
    expect(
      evaluateTrigger({
        trigger: trigger({ on: "manual" }),
        event: makeEvent({ type: "pr_opened" }),
      }),
    ).toBe(false);
  });

  it("respects branches filter", () => {
    expect(
      evaluateTrigger({
        trigger: trigger({ branches: ["main", "develop"] }),
        event: makeEvent({ baseBranch: "main" }),
      }),
    ).toBe(true);
    expect(
      evaluateTrigger({
        trigger: trigger({ branches: ["main"] }),
        event: makeEvent({ baseBranch: "feature" }),
      }),
    ).toBe(false);
  });

  it("respects files filter (any-match across changed files)", () => {
    expect(
      evaluateTrigger({
        trigger: trigger({ on: "pr_push", files: ["src/**"] }),
        event: makeEvent({ type: "pr_push", changedFiles: ["docs/x.md", "src/y.ts"] }),
      }),
    ).toBe(true);
    expect(
      evaluateTrigger({
        trigger: trigger({ on: "pr_push", files: ["src/**"] }),
        event: makeEvent({ type: "pr_push", changedFiles: ["docs/x.md"] }),
      }),
    ).toBe(false);
  });

  it("respects labels filter", () => {
    expect(
      evaluateTrigger({
        trigger: trigger({ labels: ["needs-review"] }),
        event: makeEvent({ labels: ["bug", "needs-review"] }),
      }),
    ).toBe(true);
    expect(
      evaluateTrigger({
        trigger: trigger({ labels: ["needs-review"] }),
        event: makeEvent({ labels: ["bug"] }),
      }),
    ).toBe(false);
  });

  it("respects excludeDrafts", () => {
    expect(
      evaluateTrigger({
        trigger: trigger({ excludeDrafts: true }),
        event: makeEvent({ isDraft: true }),
      }),
    ).toBe(false);
    expect(
      evaluateTrigger({
        trigger: trigger({ excludeDrafts: true }),
        event: makeEvent({ isDraft: false }),
      }),
    ).toBe(true);
    // Default: drafts are allowed.
    expect(
      evaluateTrigger({ trigger: trigger(), event: makeEvent({ isDraft: true }) }),
    ).toBe(true);
  });

  it("conjoins all filters", () => {
    const t = trigger({
      branches: ["main"],
      files: ["src/**"],
      labels: ["ci-ok"],
      excludeDrafts: true,
    });
    expect(
      evaluateTrigger({
        trigger: t,
        event: makeEvent({
          baseBranch: "main",
          changedFiles: ["src/x.ts"],
          labels: ["ci-ok"],
          isDraft: false,
        }),
      }),
    ).toBe(true);
    // Any one mismatch breaks the conjunction.
    expect(
      evaluateTrigger({
        trigger: t,
        event: makeEvent({
          baseBranch: "main",
          changedFiles: ["src/x.ts"],
          labels: ["ci-ok"],
          isDraft: true,
        }),
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// decideConcurrencyAction
// ---------------------------------------------------------------------------

describe("decideConcurrencyAction", () => {
  const policies: ConcurrencyPolicy[] = ["cancel_in_progress", "skip", "queue"];

  it.each(policies)("starts immediately when no active run (policy=%s)", (policy) => {
    expect(decideConcurrencyAction({ policy, hasActiveRun: false })).toBe("start");
  });

  it("returns cancel_then_start for cancel_in_progress with active run", () => {
    expect(
      decideConcurrencyAction({ policy: "cancel_in_progress", hasActiveRun: true }),
    ).toBe("cancel_then_start");
  });

  it("returns skip for skip policy with active run", () => {
    expect(decideConcurrencyAction({ policy: "skip", hasActiveRun: true })).toBe(
      "skip",
    );
  });

  it("returns queue for queue policy with active run", () => {
    expect(decideConcurrencyAction({ policy: "queue", hasActiveRun: true })).toBe(
      "queue",
    );
  });
});

// ---------------------------------------------------------------------------
// runAutoTriggerPass — end-to-end with fake SCM + dispatcher
// ---------------------------------------------------------------------------

function fakeScm(events: PREvent[]): SCM {
  return {
    name: "fake",
    detectPR: async () => null,
    getPRState: async () => "open",
    mergePR: async () => undefined,
    closePR: async () => undefined,
    getCIChecks: async () => [],
    getCISummary: async () => "none",
    getReviews: async () => [],
    getReviewDecision: async () => "none",
    getPendingComments: async () => [],
    getMergeability: async () => ({
      mergeable: false,
      ciPassing: false,
      approved: false,
      noConflicts: true,
      blockers: [],
    }),
    async getRecentPREvents() {
      return events;
    },
  };
}

function emptyState(at = new Date(0)): AutoTriggerState {
  return { lastCheckedAt: at.toISOString(), queued: [] };
}

describe("runAutoTriggerPass", () => {
  it("dispatches when a trigger matches and no run is active", async () => {
    const events = [makeEvent({ type: "pr_opened", prNumber: 7 })];
    const startRun = vi.fn();
    const cancelActiveRun = vi.fn();
    const pipeline = makePipeline({
      triggers: [trigger({ on: "pr_opened", branches: ["main"] })],
    });

    const result = await runAutoTriggerPass(emptyState(), {
      scm: fakeScm(events),
      pipelines: [pipeline],
      isActiveRun: () => false,
      startRun,
      cancelActiveRun,
      now: () => new Date("2026-05-06T11:00:00Z"),
    });

    expect(startRun.mock.calls).toHaveLength(1);
    expect(cancelActiveRun.mock.calls).toHaveLength(0);
    expect(result.dispatched).toBe(1);
    expect(result.state.lastCheckedAt).toBe("2026-05-06T11:00:00.000Z");
  });

  it("cancels active run and starts new one under cancel_in_progress", async () => {
    const events = [makeEvent({ type: "pr_push", prNumber: 9 })];
    const startRun = vi.fn();
    const cancelActiveRun = vi.fn();
    const pipeline = makePipeline({
      concurrency: "cancel_in_progress",
      triggers: [trigger({ on: "pr_push" })],
    });

    const result = await runAutoTriggerPass(emptyState(), {
      scm: fakeScm(events),
      pipelines: [pipeline],
      isActiveRun: () => true,
      startRun,
      cancelActiveRun,
    });

    expect(cancelActiveRun.mock.calls).toEqual([["review"]]);
    expect(startRun.mock.calls).toHaveLength(1);
    expect(result.dispatched).toBe(1);
  });

  it("skips trigger silently under skip policy when run is active", async () => {
    const events = [makeEvent({ type: "pr_push", prNumber: 9 })];
    const startRun = vi.fn();
    const cancelActiveRun = vi.fn();
    const pipeline = makePipeline({
      concurrency: "skip",
      triggers: [trigger({ on: "pr_push" })],
    });

    const result = await runAutoTriggerPass(emptyState(), {
      scm: fakeScm(events),
      pipelines: [pipeline],
      isActiveRun: () => true,
      startRun,
      cancelActiveRun,
    });

    expect(startRun.mock.calls).toHaveLength(0);
    expect(cancelActiveRun.mock.calls).toHaveLength(0);
    expect(result.skipped).toBe(1);
  });

  it("queues trigger and drains it on a later pass when run becomes idle", async () => {
    const startRun = vi.fn();
    const cancelActiveRun = vi.fn();
    const pipeline = makePipeline({
      concurrency: "queue",
      triggers: [trigger({ on: "pr_push" })],
    });

    let active = true;
    // First pass: run is active → queue.
    const events = [makeEvent({ type: "pr_push", prNumber: 11 })];
    const pass1 = await runAutoTriggerPass(emptyState(), {
      scm: fakeScm(events),
      pipelines: [pipeline],
      isActiveRun: () => active,
      startRun,
      cancelActiveRun,
      now: () => new Date("2026-05-06T11:00:00Z"),
    });
    expect(pass1.queued).toBe(1);
    expect(pass1.dispatched).toBe(0);
    expect(pass1.state.queued).toHaveLength(1);

    // Second pass: no new events, run now idle → drain the queue.
    active = false;
    const pass2 = await runAutoTriggerPass(pass1.state, {
      scm: fakeScm([]),
      pipelines: [pipeline],
      isActiveRun: () => active,
      startRun,
      cancelActiveRun,
      now: () => new Date("2026-05-06T11:05:00Z"),
    });
    expect(pass2.drained).toBe(1);
    expect(startRun.mock.calls).toHaveLength(1);
    expect(pass2.state.queued).toHaveLength(0);
  });

  it("ages out queued entries past queueMaxAgeMs", async () => {
    const startRun = vi.fn();
    const pipeline = makePipeline({
      concurrency: "queue",
      triggers: [trigger({ on: "pr_push" })],
    });

    const seedState: AutoTriggerState = {
      lastCheckedAt: "2026-05-05T10:00:00.000Z",
      queued: [
        {
          pipelineName: "review",
          prNumber: 33,
          queuedAt: "2026-05-05T10:00:00.000Z", // 24h+ old
          triggerEventType: "pr_push",
        },
      ],
    };

    const result = await runAutoTriggerPass(seedState, {
      scm: fakeScm([]),
      pipelines: [pipeline],
      isActiveRun: () => false,
      startRun,
      cancelActiveRun: vi.fn(),
      now: () => new Date("2026-05-06T11:00:00Z"), // 25h later
      queueMaxAgeMs: 24 * 60 * 60 * 1000,
    });

    expect(result.drained).toBe(0);
    expect(startRun.mock.calls).toHaveLength(0);
    expect(result.state.queued).toHaveLength(0);
  });

  it("advances lastCheckedAt even when SCM has no getRecentPREvents", async () => {
    const startRun = vi.fn();
    const cancelActiveRun = vi.fn();
    const pipeline = makePipeline({
      triggers: [trigger({ on: "pr_opened" })],
    });
    const scm: SCM = {
      name: "fake-no-events",
      detectPR: async () => null,
      getPRState: async () => "open",
      mergePR: async () => undefined,
      closePR: async () => undefined,
      getCIChecks: async () => [],
      getCISummary: async () => "none",
      getReviews: async () => [],
      getReviewDecision: async () => "none",
      getPendingComments: async () => [],
      getMergeability: async () => ({
      mergeable: false,
      ciPassing: false,
      approved: false,
      noConflicts: true,
      blockers: [],
    }),
    };

    const result = await runAutoTriggerPass(emptyState(), {
      scm,
      pipelines: [pipeline],
      isActiveRun: () => false,
      startRun,
      cancelActiveRun,
      now: () => new Date("2026-05-06T11:00:00Z"),
    });

    expect(startRun.mock.calls).toHaveLength(0);
    expect(result.state.lastCheckedAt).toBe("2026-05-06T11:00:00.000Z");
  });

  it("never fires manual triggers from PR events", async () => {
    const events = [makeEvent({ type: "pr_opened", prNumber: 1 })];
    const startRun = vi.fn();
    const pipeline = makePipeline({
      triggers: [trigger({ on: "manual" })],
    });

    const result = await runAutoTriggerPass(emptyState(), {
      scm: fakeScm(events),
      pipelines: [pipeline],
      isActiveRun: () => false,
      startRun,
      cancelActiveRun: vi.fn(),
    });

    expect(result.dispatched).toBe(0);
    expect(startRun.mock.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Persistence (last-checked timestamp survives restarts)
// ---------------------------------------------------------------------------

describe("readAutoTriggerState / writeAutoTriggerState", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "ao-trigger-state-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns empty state when file is missing", async () => {
    const state = await readAutoTriggerState(join(tmp, "missing.json"));
    expect(state.queued).toEqual([]);
    expect(new Date(state.lastCheckedAt).getTime()).toBe(0);
  });

  it("round-trips a state through write+read", async () => {
    const path = join(tmp, "auto-trigger-state.json");
    const stateOut: AutoTriggerState = {
      lastCheckedAt: "2026-05-06T11:00:00.000Z",
      queued: [
        {
          pipelineName: "review",
          prNumber: 42,
          queuedAt: "2026-05-06T10:59:00.000Z",
          triggerEventType: "pr_push",
        },
      ],
    };
    await writeAutoTriggerState(path, stateOut);
    const stateIn = await readAutoTriggerState(path);
    expect(stateIn).toEqual(stateOut);

    const raw = await readFile(path, "utf8");
    expect(JSON.parse(raw)).toEqual(stateOut);
  });

  it("recovers gracefully from corrupt JSON", async () => {
    const path = join(tmp, "corrupt.json");
    await writeAutoTriggerState(path, {
      lastCheckedAt: "ignored",
      queued: [],
    });
    // Stomp the file with junk.
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(path, "not json", "utf8"),
    );
    const state = await readAutoTriggerState(path);
    expect(state.queued).toEqual([]);
  });
});
