/**
 * Tests for activity-event emits added to lifecycle-manager's silent
 * failure paths (scm.review_fetch_failed, scm.poll_pr_failed).
 *
 * Design choices:
 * - vi.mock("../activity-events.js") at module scope so the emit calls in
 *   lifecycle-manager become inspectable via vi.mocked.
 * - Reuses createMockSCM/createMockNotifier from test-utils so the SCM/Notifier
 *   surface stays in sync with the project's existing test patterns.
 * - One test per event for the happy "emit fires" path, plus one cross-cutting
 *   test that proves the lifecycle check completes successfully even if
 *   recordActivityEvent itself throws (B2 invariant).
 *
 * Notifier instrumentation is intentionally omitted — the notifier subsystem
 * is undergoing larger work and AE evidence there is not currently useful.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type * as ActivityEventsModule from "../activity-events.js";

vi.mock("../activity-events.js", async (importOriginal) => {
  const original = await importOriginal<typeof ActivityEventsModule>();
  return {
    ...original,
    recordActivityEvent: vi.fn(),
  };
});

import { recordActivityEvent } from "../activity-events.js";
import { createLifecycleManager } from "../lifecycle-manager.js";
import { writeMetadata } from "../metadata.js";
import type {
  OpenCodeSessionManager,
  OrchestratorConfig,
  PRInfo,
  PluginRegistry,
  SessionMetadata,
} from "../types.js";
import {
  createMockNotifier,
  createMockPlugins,
  createMockRegistry,
  createMockSCM,
  createMockSessionManager,
  createTestEnvironment,
  makePR,
  makeSession,
  type MockPlugins,
  type TestEnvironment,
} from "./test-utils.js";

let env: TestEnvironment;
let plugins: MockPlugins;
let mockSessionManager: OpenCodeSessionManager;
let config: OrchestratorConfig;

beforeEach(() => {
  env = createTestEnvironment();
  plugins = createMockPlugins();
  mockSessionManager = createMockSessionManager();
  config = env.config;
  vi.mocked(recordActivityEvent).mockClear();
});

afterEach(() => {
  env.cleanup();
});

/** Helper: persist session metadata + register the session with the mock manager. */
function persistSession(
  sessionId: string,
  session: ReturnType<typeof makeSession>,
  metaOverrides: Record<string, unknown> = {},
) {
  const persistedMetadata: Record<string, unknown> = {
    worktree: "/tmp",
    branch: session.branch ?? "main",
    status: session.status,
    project: "my-app",
    runtimeHandle: session.runtimeHandle ?? undefined,
    ...metaOverrides,
  };
  const persistedStringMetadata = Object.fromEntries(
    Object.entries(persistedMetadata).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

  const enriched = {
    ...session,
    metadata: { ...session.metadata, ...persistedStringMetadata },
  };

  vi.mocked(mockSessionManager.get).mockResolvedValue(enriched);
  vi.mocked(mockSessionManager.list).mockResolvedValue([enriched]);
  writeMetadata(env.sessionsDir, sessionId, persistedMetadata as unknown as SessionMetadata);
  return enriched;
}

function buildLM(registry: PluginRegistry) {
  return createLifecycleManager({ config, registry, sessionManager: mockSessionManager });
}

function makeMatchingPR(overrides: Partial<PRInfo> = {}): PRInfo {
  return makePR({ owner: "org", repo: "my-app", ...overrides });
}

// ---------------------------------------------------------------------------
// scm.review_fetch_failed
// ---------------------------------------------------------------------------

describe("scm.review_fetch_failed", () => {
  it("records an AE event when scm.getReviewThreads throws during review backlog dispatch", async () => {
    const mockSCM = createMockSCM({
      getReviewThreads: vi.fn().mockRejectedValue(new Error("403 forbidden")),
    });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
      notifier: createMockNotifier(),
    });

    const session = makeSession({ status: "pr_open", pr: makeMatchingPR() });
    persistSession("app-1", session);

    const lm = buildLM(registry);
    await lm.check("app-1");

    const calls = vi.mocked(recordActivityEvent).mock.calls.map((c) => c[0]);
    const reviewFailures = calls.filter((c) => c.kind === "scm.review_fetch_failed");
    expect(reviewFailures).toHaveLength(1);

    const ev = reviewFailures[0]!;
    expect(ev.source).toBe("scm");
    expect(ev.level).toBe("warn");
    expect(ev.summary).toContain("review fetch failed for PR #42");
    expect(ev.projectId).toBe(session.projectId);
    expect(ev.sessionId).toBe(session.id);
    expect(ev.data).toMatchObject({
      prNumber: 42,
      prUrl: "https://github.com/org/my-app/pull/42",
      errorMessage: "403 forbidden",
    });
  });
});

// ---------------------------------------------------------------------------
// scm.poll_pr_failed
// ---------------------------------------------------------------------------

describe("scm.poll_pr_failed", () => {
  it("records an AE event when scm.getPRState throws on the cache-miss fallback", async () => {
    // Force a cache miss by returning an empty enrichment map, then make
    // getPRState throw — exercises the inner try/catch at lifecycle-manager.ts:1053.
    const mockSCM = createMockSCM({
      enrichSessionsPRBatch: vi.fn().mockResolvedValue(new Map()),
      getPRState: vi.fn().mockRejectedValue(new Error("rate limited")),
    });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
      notifier: createMockNotifier(),
    });

    const session = makeSession({ status: "pr_open", pr: makeMatchingPR() });
    persistSession("app-1", session);

    const lm = buildLM(registry);
    await lm.check("app-1");

    const calls = vi.mocked(recordActivityEvent).mock.calls.map((c) => c[0]);
    const pollFailures = calls.filter((c) => c.kind === "scm.poll_pr_failed");
    expect(pollFailures).toHaveLength(1);

    const ev = pollFailures[0]!;
    expect(ev.source).toBe("scm");
    expect(ev.level).toBe("warn");
    expect(ev.summary).toContain("getPRState failed for PR #42");
    expect(ev.data).toMatchObject({
      prNumber: 42,
      prUrl: "https://github.com/org/my-app/pull/42",
      errorMessage: "rate limited",
    });
  });
});

// ---------------------------------------------------------------------------
// scm.batch_enrich_failed
// ---------------------------------------------------------------------------

describe("scm.batch_enrich_failed", () => {
  it("records an AE event when scm.enrichSessionsPRBatch throws", async () => {
    const mockSCM = createMockSCM({
      enrichSessionsPRBatch: vi.fn().mockRejectedValue(new Error("rate limited")),
    });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
      notifier: createMockNotifier(),
    });

    const session = makeSession({ status: "pr_open", pr: makeMatchingPR() });
    persistSession("app-1", session);

    const lm = buildLM(registry);
    await lm.check("app-1");

    const calls = vi.mocked(recordActivityEvent).mock.calls.map((c) => c[0]);
    const batchFailures = calls.filter((c) => c.kind === "scm.batch_enrich_failed");
    expect(batchFailures.length).toBeGreaterThan(0);

    const ev = batchFailures[0]!;
    expect(ev.source).toBe("scm");
    expect(ev.level).toBe("warn");
    expect(ev.summary).toContain("batch_enrich failed");
    expect(ev.data).toMatchObject({
      plugin: "github",
      prCount: 1,
      errorMessage: "rate limited",
    });
  });
});

// ---------------------------------------------------------------------------
// scm.detect_pr_succeeded / scm.detect_pr_failed
// ---------------------------------------------------------------------------

describe("scm.detect_pr", () => {
  it("emits scm.detect_pr_succeeded when scm.detectPR finds a PR for a previously-PR-less session", async () => {
    const detectedPR = makeMatchingPR({ number: 99, url: "https://github.com/org/my-app/pull/99" });
    const mockSCM = createMockSCM({
      detectPR: vi.fn().mockResolvedValue(detectedPR),
    });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
      notifier: createMockNotifier(),
    });

    const session = makeSession({ status: "working" });
    persistSession("app-1", session);

    const lm = buildLM(registry);
    await lm.check("app-1");

    const calls = vi.mocked(recordActivityEvent).mock.calls.map((c) => c[0]);
    const events = calls.filter((c) => c.kind === "scm.detect_pr_succeeded");
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({ prNumber: 99 });
  });

  it("emits scm.detect_pr_failed when scm.detectPR throws", async () => {
    const mockSCM = createMockSCM({
      detectPR: vi.fn().mockRejectedValue(new Error("403 forbidden")),
    });
    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: mockSCM,
      notifier: createMockNotifier(),
    });

    const session = makeSession({ status: "working" });
    persistSession("app-1", session);

    const lm = buildLM(registry);
    await lm.check("app-1");

    const calls = vi.mocked(recordActivityEvent).mock.calls.map((c) => c[0]);
    const events = calls.filter((c) => c.kind === "scm.detect_pr_failed");
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({ errorMessage: "403 forbidden" });
  });
});

// ---------------------------------------------------------------------------
// runtime.probe_failed
// ---------------------------------------------------------------------------

describe("runtime.probe_failed", () => {
  it("records an AE event when runtime.isAlive throws", async () => {
    vi.mocked(plugins.runtime.isAlive).mockRejectedValue(new Error("kill -0 EPERM"));

    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: createMockSCM(),
      notifier: createMockNotifier(),
    });

    const session = makeSession({ status: "working" });
    persistSession("app-1", session);

    const lm = buildLM(registry);
    await lm.check("app-1");

    const calls = vi.mocked(recordActivityEvent).mock.calls.map((c) => c[0]);
    const events = calls.filter((c) => c.kind === "runtime.probe_failed");
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.source).toBe("runtime");
    expect(events[0]!.data).toMatchObject({ errorMessage: "kill -0 EPERM" });
  });
});

// ---------------------------------------------------------------------------
// agent.activity_probe_failed
// ---------------------------------------------------------------------------

describe("agent.activity_probe_failed", () => {
  it("records an AE event when the activity probing block throws", async () => {
    vi.mocked(plugins.agent.getActivityState).mockRejectedValue(new Error("native probe died"));

    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: createMockSCM(),
      notifier: createMockNotifier(),
    });

    const session = makeSession({ status: "working" });
    persistSession("app-1", session);

    const lm = buildLM(registry);
    await lm.check("app-1");

    const calls = vi.mocked(recordActivityEvent).mock.calls.map((c) => c[0]);
    const events = calls.filter((c) => c.kind === "agent.activity_probe_failed");
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.source).toBe("agent");
    expect(events[0]!.data).toMatchObject({ errorMessage: "native probe died" });
  });
});

// ---------------------------------------------------------------------------
// agent.process_probe_failed (standalone path)
// ---------------------------------------------------------------------------

describe("agent.process_probe_failed", () => {
  it("records an AE event with where=standalone when isProcessRunning throws on the standalone probe", async () => {
    // Drive activity probe to return null + force standalone path:
    // - getActivityState resolves null → falls into terminal-output fallback
    // - getOutput returns empty → no terminal-fallback isProcessRunning call
    // - then standalone isProcessRunning at line ~1132 fires (processProbe still unknown)
    vi.mocked(plugins.agent.getActivityState).mockResolvedValue(null);
    vi.mocked(plugins.runtime.getOutput).mockResolvedValue("");
    vi.mocked(plugins.agent.isProcessRunning).mockRejectedValue(new Error("ps lookup failed"));

    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: createMockSCM(),
      notifier: createMockNotifier(),
    });

    const session = makeSession({ status: "working" });
    persistSession("app-1", session);

    const lm = buildLM(registry);
    await lm.check("app-1");

    const calls = vi.mocked(recordActivityEvent).mock.calls.map((c) => c[0]);
    const events = calls.filter((c) => c.kind === "agent.process_probe_failed");
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.source).toBe("agent");
    expect(events[0]!.data).toMatchObject({
      where: "standalone",
      errorMessage: "ps lookup failed",
    });
  });
});

// ---------------------------------------------------------------------------
// reaction.escalated / reaction.send_to_agent_failed / reaction.action_succeeded
// ---------------------------------------------------------------------------

/** Build an SCM mock whose batch enrichment drives the session to ci_failed. */
function makeCiFailedScm(overrides: Partial<Parameters<typeof createMockSCM>[0]> = {}) {
  return createMockSCM({
    enrichSessionsPRBatch: vi.fn().mockImplementation(async (prs: PRInfo[]) => {
      const result = new Map();
      for (const pr of prs) {
        result.set(`${pr.owner}/${pr.repo}#${pr.number}`, {
          state: "open",
          ciStatus: "failing",
          reviewDecision: "none",
          mergeable: false,
          ciChecks: [{ name: "test", status: "failed" }],
        });
      }
      return result;
    }),
    ...overrides,
  });
}

describe("reaction.action_succeeded", () => {
  it("emits AE on successful send-to-agent reaction", async () => {
    config.reactions = {
      "ci-failed": { auto: true, action: "send-to-agent", message: "fix CI", retries: 5 },
    };
    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: makeCiFailedScm(),
      notifier: createMockNotifier(),
    });

    const session = makeSession({ status: "pr_open", pr: makeMatchingPR() });
    persistSession("app-1", session);

    const lm = buildLM(registry);
    await lm.check("app-1");

    const calls = vi.mocked(recordActivityEvent).mock.calls.map((c) => c[0]);
    const events = calls.filter((c) => c.kind === "reaction.action_succeeded");
    expect(events.length).toBeGreaterThan(0);

    const ev = events[0]!;
    expect(ev.source).toBe("reaction");
    expect(ev.data).toMatchObject({
      reactionKey: "ci-failed",
      action: "send-to-agent",
    });
  });
});

describe("reaction.send_to_agent_failed", () => {
  it("emits AE when sessionManager.send throws inside a send-to-agent reaction", async () => {
    config.reactions = {
      "ci-failed": { auto: true, action: "send-to-agent", message: "fix CI", retries: 5 },
    };
    vi.mocked(mockSessionManager.send).mockRejectedValue(new Error("agent unreachable"));

    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: makeCiFailedScm(),
      notifier: createMockNotifier(),
    });

    const session = makeSession({ status: "pr_open", pr: makeMatchingPR() });
    persistSession("app-1", session);

    const lm = buildLM(registry);
    await lm.check("app-1");

    const calls = vi.mocked(recordActivityEvent).mock.calls.map((c) => c[0]);
    const events = calls.filter((c) => c.kind === "reaction.send_to_agent_failed");
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({
      reactionKey: "ci-failed",
      errorMessage: "agent unreachable",
    });
  });
});

describe("reaction.escalated", () => {
  it("emits AE with escalationCause=max_retries when attempts exceed retries", async () => {
    // retries: 0 → first attempt escalates (attempts=1 > 0)
    config.reactions = {
      "ci-failed": { auto: true, action: "send-to-agent", message: "fix CI", retries: 0, priority: "urgent" },
    };
    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: makeCiFailedScm(),
      notifier: createMockNotifier(),
    });

    const session = makeSession({ status: "pr_open", pr: makeMatchingPR() });
    persistSession("app-1", session);

    const lm = buildLM(registry);
    await lm.check("app-1");

    const calls = vi.mocked(recordActivityEvent).mock.calls.map((c) => c[0]);
    const events = calls.filter((c) => c.kind === "reaction.escalated");
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({
      reactionKey: "ci-failed",
      attempts: 1,
      escalationCause: "max_retries",
    });
  });

  it("REGRESSION: escalationCause=max_attempts when numeric escalateAfter triggers (no retries cfg)", async () => {
    // Numeric escalateAfter is an attempt-count gate, not a duration. Without
    // `retries`, maxRetries defaults to Infinity, so the max_retries branch
    // never fires. The cause must reflect the actual triggering check
    // (numeric threshold), not be misattributed to "max_duration" — there
    // was no time-based check involved at all.
    config.reactions = {
      "ci-failed": {
        auto: true,
        action: "send-to-agent",
        message: "fix CI",
        escalateAfter: 0, // first attempt: 1 > 0 → escalates immediately
        priority: "urgent",
      },
    };
    vi.mocked(mockSessionManager.send).mockResolvedValue(undefined);

    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: makeCiFailedScm(),
      notifier: createMockNotifier(),
    });

    const session = makeSession({ status: "pr_open", pr: makeMatchingPR() });
    persistSession("app-1", session);

    const lm = buildLM(registry);
    await lm.check("app-1");

    const events = vi
      .mocked(recordActivityEvent)
      .mock.calls.map((c) => c[0])
      .filter((c) => c.kind === "reaction.escalated");
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({
      reactionKey: "ci-failed",
      attempts: 1,
      escalationCause: "max_attempts",
    });
  });
});

// ---------------------------------------------------------------------------
// session.auto_cleanup_{deferred,completed,failed}
// ---------------------------------------------------------------------------

/** SCM mock whose batch enrichment drives session into MERGED status. */
function makeMergedScm() {
  return createMockSCM({
    getPRState: vi.fn().mockResolvedValue("merged"),
    enrichSessionsPRBatch: vi.fn().mockImplementation(async (prs: PRInfo[]) => {
      const result = new Map();
      for (const pr of prs) {
        result.set(`${pr.owner}/${pr.repo}#${pr.number}`, {
          state: "merged",
          ciStatus: "none",
          reviewDecision: "none",
          mergeable: false,
        });
      }
      return result;
    }),
  });
}

function configWithAutoCleanup(): OrchestratorConfig {
  return {
    ...config,
    lifecycle: { autoCleanupOnMerge: true, mergeCleanupIdleGraceMs: 300_000 },
  };
}

describe("session.auto_cleanup_completed", () => {
  it("emits AE when sessionManager.kill succeeds after PR merges", async () => {
    vi.mocked(mockSessionManager.kill).mockResolvedValue({
      cleaned: true,
      alreadyTerminated: false,
    });

    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: makeMergedScm(),
      notifier: createMockNotifier(),
    });

    const session = makeSession({
      status: "approved",
      pr: makeMatchingPR(),
      activity: "idle",
    });
    persistSession("app-1", session);

    const lm = createLifecycleManager({
      config: configWithAutoCleanup(),
      registry,
      sessionManager: mockSessionManager,
    });
    await lm.check("app-1");

    const calls = vi.mocked(recordActivityEvent).mock.calls.map((c) => c[0]);
    const events = calls.filter((c) => c.kind === "session.auto_cleanup_completed");
    expect(events).toHaveLength(1);
    expect(events[0]!.source).toBe("lifecycle");
    expect(events[0]!.data).toMatchObject({ cleaned: true });
  });
});

describe("session.auto_cleanup_failed", () => {
  it("emits AE when sessionManager.kill throws after PR merges", async () => {
    vi.mocked(mockSessionManager.kill).mockRejectedValue(new Error("worktree busy"));

    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: makeMergedScm(),
      notifier: createMockNotifier(),
    });

    const session = makeSession({
      status: "approved",
      pr: makeMatchingPR(),
      activity: "idle",
    });
    persistSession("app-1", session);

    const lm = createLifecycleManager({
      config: configWithAutoCleanup(),
      registry,
      sessionManager: mockSessionManager,
    });
    await lm.check("app-1");

    const calls = vi.mocked(recordActivityEvent).mock.calls.map((c) => c[0]);
    const events = calls.filter((c) => c.kind === "session.auto_cleanup_failed");
    expect(events).toHaveLength(1);
    expect(events[0]!.level).toBe("error");
    expect(events[0]!.data).toMatchObject({ errorMessage: "worktree busy" });
  });
});

// ---------------------------------------------------------------------------
// lifecycle.poll_failed
// ---------------------------------------------------------------------------

describe("lifecycle.poll_failed", () => {
  it("emits AE when sessionManager.list throws inside pollAll", async () => {
    vi.useFakeTimers();
    vi.mocked(mockSessionManager.list).mockRejectedValue(new Error("storage unreadable"));

    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: createMockSCM(),
      notifier: createMockNotifier(),
    });

    // pollAll only emits per-project poll metrics when scopedProjectId is set.
    // Force it via the deps.
    const lm = createLifecycleManager({
      config,
      registry,
      sessionManager: mockSessionManager,
      projectId: "my-app",
    });

    try {
      lm.start(60_000);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(60_000);

      const calls = vi.mocked(recordActivityEvent).mock.calls.map((c) => c[0]);
      const events = calls.filter((c) => c.kind === "lifecycle.poll_failed");
      expect(events.length).toBeGreaterThan(0);
      expect(events[0]!.level).toBe("error");
      expect(events[0]!.data).toMatchObject({ errorMessage: "storage unreadable" });
    } finally {
      lm.stop();
      vi.useRealTimers();
    }
  });

  it("REGRESSION: summary must not interpolate raw error text (credential leak via FTS)", async () => {
    // sanitizeSummary only truncates; sanitizeData (which runs on `data`)
    // redacts credential URLs. Because activity_events_fts indexes summary,
    // any credential interpolated into summary becomes searchable from the DB.
    // Lifecycle code must keep summary generic and put error reasons in `data`.
    vi.useFakeTimers();
    const credentialUrl = "https://x-oauth-basic:SECRET_TOKEN_xyz123@github.com/foo/bar.git";
    vi.mocked(mockSessionManager.list).mockRejectedValue(
      new Error(`fatal: unable to access '${credentialUrl}/'`),
    );

    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: createMockSCM(),
      notifier: createMockNotifier(),
    });

    const lm = createLifecycleManager({
      config,
      registry,
      sessionManager: mockSessionManager,
      projectId: "my-app",
    });

    try {
      lm.start(60_000);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(60_000);

      const events = vi
        .mocked(recordActivityEvent)
        .mock.calls.map((c) => c[0])
        .filter((c) => c.kind === "lifecycle.poll_failed");
      expect(events.length).toBeGreaterThan(0);

      // Summary stays generic — no secret material.
      expect(events[0]!.summary).not.toContain("SECRET_TOKEN");
      expect(events[0]!.summary).not.toContain("x-oauth-basic");

      // Error reason still surfaces — but only via `data`, where it's sanitized.
      expect(events[0]!.data).toMatchObject({
        errorMessage: expect.stringContaining("unable to access"),
      });
    } finally {
      lm.stop();
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// detecting.escalated
// ---------------------------------------------------------------------------

describe("detecting.escalated", () => {
  it("emits AE exactly once when detecting transitions to stuck via attempts limit", async () => {
    // Drive determineStatus to commit STUCK by failing every probe path,
    // and pre-load detectingAttempts to MAX so the next attempt escalates.
    vi.mocked(plugins.runtime.isAlive).mockRejectedValue(new Error("probe down"));
    vi.mocked(plugins.agent.getActivityState).mockResolvedValue(null);
    vi.mocked(plugins.runtime.getOutput).mockResolvedValue("");
    vi.mocked(plugins.agent.isProcessRunning).mockRejectedValue(new Error("ps down"));

    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: createMockSCM(),
      notifier: createMockNotifier(),
    });

    const session = makeSession({ status: "detecting" });
    persistSession("app-1", session, {
      detectingAttempts: "3", // DETECTING_MAX_ATTEMPTS — next attempt = 4 > 3 → escalates
    });

    const lm = buildLM(registry);
    await lm.check("app-1");

    const calls = vi.mocked(recordActivityEvent).mock.calls.map((c) => c[0]);
    const events = calls.filter((c) => c.kind === "detecting.escalated");
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({ cause: "max_attempts" });

    // Idempotency guard: a second poll while still stuck must NOT re-emit.
    // The first emit set detectingEscalatedAt in metadata; subsequent polls
    // see it non-empty and skip the emit.
    vi.mocked(recordActivityEvent).mockClear();
    await lm.check("app-1");
    const repeat = vi.mocked(recordActivityEvent).mock.calls
      .map((c) => c[0])
      .filter((c) => c.kind === "detecting.escalated");
    expect(repeat).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// report_watcher.triggered
// ---------------------------------------------------------------------------

describe("report_watcher.triggered", () => {
  it("emits AE when the report watcher detects a no_acknowledge trigger", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T12:00:00.000Z"));

    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: createMockSCM(),
      notifier: createMockNotifier(),
    });

    // Session created 20 minutes ago (> default 10min ack timeout) and never reported.
    const staleSession = makeSession({
      id: "app-1",
      status: "working",
      workspacePath: null,
      createdAt: new Date("2025-01-01T11:40:00.000Z"),
      metadata: { createdAt: "2025-01-01T11:40:00.000Z" },
    });
    persistSession("app-1", staleSession, { createdAt: "2025-01-01T11:40:00.000Z" });

    const lm = createLifecycleManager({
      config,
      registry,
      sessionManager: mockSessionManager,
    });

    try {
      await lm.check("app-1");

      const calls = vi.mocked(recordActivityEvent).mock.calls.map((c) => c[0]);
      const events = calls.filter((c) => c.kind === "report_watcher.triggered");
      expect(events.length).toBeGreaterThan(0);
      expect(events[0]!.source).toBe("report-watcher");
      expect(events[0]!.level).toBe("warn");
      expect(events[0]!.data).toMatchObject({ trigger: "no_acknowledge" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT re-emit while the same trigger persists across polls (one-shot guard)", async () => {
    // Regression: we observed 116 identical report_watcher.triggered events
    // landing in production over a few hours because the emit was unguarded
    // and fired every 30s poll while the trigger stayed active. The fix gates
    // the emit on `isNewTrigger` so it fires only on the first poll that
    // detects the trigger.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T12:00:00.000Z"));

    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: createMockSCM(),
      notifier: createMockNotifier(),
    });

    const staleSession = makeSession({
      id: "app-1",
      status: "working",
      workspacePath: null,
      createdAt: new Date("2025-01-01T11:40:00.000Z"),
      metadata: { createdAt: "2025-01-01T11:40:00.000Z" },
    });
    persistSession("app-1", staleSession, { createdAt: "2025-01-01T11:40:00.000Z" });

    const lm = createLifecycleManager({
      config,
      registry,
      sessionManager: mockSessionManager,
    });

    try {
      // First check — trigger fires fresh, AE event lands.
      await lm.check("app-1");
      const firstPass = vi.mocked(recordActivityEvent).mock.calls
        .map((c) => c[0])
        .filter((c) => c.kind === "report_watcher.triggered");
      expect(firstPass).toHaveLength(1);

      // Second check — same trigger still active. Must NOT re-emit.
      vi.mocked(recordActivityEvent).mockClear();
      await lm.check("app-1");
      const secondPass = vi.mocked(recordActivityEvent).mock.calls
        .map((c) => c[0])
        .filter((c) => c.kind === "report_watcher.triggered");
      expect(secondPass).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("REGRESSION: summary must not interpolate auditResult.message (report.note credential leak)", async () => {
    // `auditResult.message` for the agent_needs_input trigger embeds the
    // free-form `report.note` supplied via `ao report --note "..."`. Since
    // sanitizeSummary only truncates and FTS5 indexes summary, a note that
    // happens to contain a credential URL becomes persistently searchable
    // from the DB. Summary must stay generic; the message stays in `data`
    // where sanitizeData redacts credentials.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T12:00:00.000Z"));

    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: createMockSCM(),
      notifier: createMockNotifier(),
    });

    // Seed a needs_input report whose note contains a credential URL.
    // Per agent-report.ts:560, readAgentReport pulls these out of metadata.
    const credentialNote = "stuck on git push https://x-oauth-basic:SECRET_NOTE_TOKEN@github.com/foo/bar.git";
    const blockedSession = makeSession({
      id: "app-1",
      status: "working",
      workspacePath: null,
      createdAt: new Date("2025-01-01T11:55:00.000Z"),
      metadata: { createdAt: "2025-01-01T11:55:00.000Z" },
    });
    persistSession("app-1", blockedSession, {
      createdAt: "2025-01-01T11:55:00.000Z",
      agentReportedState: "needs_input",
      agentReportedAt: "2025-01-01T11:58:00.000Z",
      agentReportedNote: credentialNote,
    });

    const lm = createLifecycleManager({
      config,
      registry,
      sessionManager: mockSessionManager,
    });

    try {
      await lm.check("app-1");

      const events = vi
        .mocked(recordActivityEvent)
        .mock.calls.map((c) => c[0])
        .filter((c) => c.kind === "report_watcher.triggered");
      expect(events.length).toBeGreaterThan(0);
      expect(events[0]!.data).toMatchObject({ trigger: "agent_needs_input" });

      // Summary stays generic — no secret material from report.note.
      expect(events[0]!.summary).not.toContain("SECRET_NOTE_TOKEN");
      expect(events[0]!.summary).not.toContain("x-oauth-basic");

      // The full message still surfaces via `data` where sanitizeData runs.
      expect(events[0]!.data).toMatchObject({
        message: expect.stringContaining("Agent needs input"),
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// B2 invariant: emits never break the lifecycle flow
// ---------------------------------------------------------------------------

describe("invariant: recordActivityEvent failures do not break the lifecycle flow", () => {
  it("lm.check completes successfully even if recordActivityEvent throws", async () => {
    vi.mocked(recordActivityEvent).mockImplementation(() => {
      throw new Error("AE went boom");
    });

    const registry = createMockRegistry({
      runtime: plugins.runtime,
      agent: plugins.agent,
      scm: createMockSCM({
        getReviewThreads: vi.fn().mockRejectedValue(new Error("review fetch down")),
      }),
      notifier: createMockNotifier(),
    });

    const session = makeSession({ status: "pr_open", pr: makeMatchingPR() });
    persistSession("app-1", session);

    const lm = buildLM(registry);
    // Per gist + B2: lifecycle code MUST NOT depend on recordActivityEvent
    // success. If this test fails, a new emit was added without the wrapper
    // safety the real recordActivityEvent provides — find the unsafe call site
    // and wrap it (or rely on the real impl's internal try/catch).
    await expect(lm.check("app-1")).resolves.not.toThrow();
  });
});
