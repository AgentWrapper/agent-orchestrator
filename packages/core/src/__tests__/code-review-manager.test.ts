import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActivitySignal } from "../activity-signal.js";
import { createCodeReviewStore, type CodeReviewStore } from "../code-review-store.js";
import {
  buildClaudeCodeReviewArgs,
  buildCodexCodeReviewArgs,
  CODEX_CLAUDE_FALLBACK_SUMMARY,
  CodeReviewNoOpenFindingsError,
  createCodexWithClaudeFallbackRunner,
  executeCodeReviewRun,
  isCodexProviderUnavailableError,
  markOutdatedCodeReviewRunsForSession,
  parseReviewerOutput,
  prepareGitReviewerWorkspace,
  resolveCodeReviewRunner,
  runClaudeCodeReview,
  runCodexCodeReview,
  sendCodeReviewFindingsToAgent,
  triggerCodeReviewForSession,
  type CodeReviewRunner,
  type CodeReviewRunnerContext,
} from "../code-review-manager.js";
import { createInitialCanonicalLifecycle } from "../lifecycle-state.js";
import {
  SessionNotFoundError,
  type OrchestratorConfig,
  type PluginRegistry,
  type PRInfo,
  type SCM,
  type Session,
  type SessionManager,
} from "../types.js";

// Mock only spawn() so the reviewer CLIs (codex/claude via
// execFileWithClosedStdin) are programmable; execFile/execFileSync stay real so
// the git-backed tests in this file keep working.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, spawn: spawnMock };
});

function fakeChild(opts: { stdout?: string; stderr?: string; code?: number }) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    pid: number;
    kill: (signal?: string) => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4242;
  child.kill = () => {};
  queueMicrotask(() => {
    if (opts.stdout) child.stdout.emit("data", Buffer.from(opts.stdout));
    if (opts.stderr) child.stderr.emit("data", Buffer.from(opts.stderr));
    child.emit("close", opts.code ?? 0, null);
  });
  return child;
}

let storeDir: string;
let store: CodeReviewStore;

const config: OrchestratorConfig = {
  configPath: "/tmp/ao/agent-orchestrator.yaml",
  readyThresholdMs: 300_000,
  defaults: { runtime: "tmux", agent: "codex", workspace: "worktree", notifiers: [] },
  projects: {
    app: {
      name: "App",
      path: "/tmp/app",
      defaultBranch: "main",
      sessionPrefix: "app",
    },
  },
  notifiers: {},
  notificationRouting: { urgent: [], action: [], warning: [], info: [] },
  reactions: {},
};

function makeSession(overrides: Partial<Session> & { id?: string } = {}): Session {
  const lifecycle = createInitialCanonicalLifecycle("worker", new Date("2026-05-10T10:00:00.000Z"));
  lifecycle.session.state = "idle";
  lifecycle.session.reason = "awaiting_external_review";
  lifecycle.pr.state = "open";
  lifecycle.pr.reason = "review_pending";
  lifecycle.pr.number = 7;
  lifecycle.pr.url = "https://github.com/acme/app/pull/7";
  lifecycle.runtime.state = "alive";
  lifecycle.runtime.reason = "process_running";

  return {
    id: "app-1",
    projectId: "app",
    status: "review_pending",
    activity: "idle",
    activitySignal: createActivitySignal("valid", {
      activity: "idle",
      timestamp: new Date("2026-05-10T10:00:00.000Z"),
      source: "native",
    }),
    lifecycle,
    branch: "feat/todos",
    issueId: null,
    pr: {
      number: 7,
      url: "https://github.com/acme/app/pull/7",
      title: "feat: todos",
      owner: "acme",
      repo: "app",
      branch: "feat/todos",
      baseBranch: "main",
      isDraft: false,
    },
    prs: [
      {
        number: 7,
        url: "https://github.com/acme/app/pull/7",
        title: "feat: todos",
        owner: "acme",
        repo: "app",
        branch: "feat/todos",
        baseBranch: "main",
        isDraft: false,
      },
    ],
    workspacePath: "/tmp/app-worktree",
    runtimeHandle: { id: "tmux-app-1", runtimeName: "tmux", data: {} },
    agentInfo: null,
    createdAt: new Date("2026-05-10T09:00:00.000Z"),
    lastActivityAt: new Date("2026-05-10T10:00:00.000Z"),
    metadata: {},
    ...overrides,
  };
}

function makeSessionManager(
  session: Session | null,
  overrides: Partial<SessionManager> = {},
): SessionManager {
  const manager: SessionManager = {
    get: async (sessionId: string) => (session?.id === sessionId ? session : null),
    list: async () => (session ? [session] : []),
    spawn: async () => {
      throw new Error("not implemented");
    },
    spawnOrchestrator: async () => {
      throw new Error("not implemented");
    },
    ensureOrchestrator: async () => {
      throw new Error("not implemented");
    },
    relaunchOrchestrator: async () => {
      throw new Error("not implemented");
    },
    restore: async () => {
      throw new Error("not implemented");
    },
    kill: async () => ({ cleaned: false, alreadyTerminated: false }),
    cleanup: async () => ({ killed: [], skipped: [], errors: [] }),
    send: async () => {},
    claimPR: async () => {
      throw new Error("not implemented");
    },
    setModel: async () => {
      throw new Error("not implemented");
    },
    compact: async () => {
      throw new Error("not implemented");
    },
  };

  return Object.assign(manager, overrides);
}

beforeEach(() => {
  storeDir = join(tmpdir(), `ao-test-code-review-manager-${randomUUID()}`);
  mkdirSync(storeDir, { recursive: true });
  store = createCodeReviewStore("app", { storeDir });
});

afterEach(() => {
  rmSync(storeDir, { recursive: true, force: true });
});

describe("triggerCodeReviewForSession", () => {
  it("creates a queued review run linked to the worker session", async () => {
    const session = makeSession();
    const run = await triggerCodeReviewForSession(
      {
        config,
        sessionManager: makeSessionManager(session),
        storeFactory: () => store,
        resolveTargetSha: async () => "abc123",
        now: new Date("2026-05-10T11:00:00.000Z"),
      },
      { sessionId: "app-1", requestedBy: "cli" },
    );

    expect(run).toMatchObject({
      projectId: "app",
      linkedSessionId: "app-1",
      reviewerSessionId: "app-rev-1",
      status: "queued",
      targetSha: "abc123",
      prNumber: 7,
      prUrl: "https://github.com/acme/app/pull/7",
      summary: "Review requested from CLI for app-1.",
      findingCount: 0,
    });
    expect(store.listRuns()).toHaveLength(1);
  });

  it("allocates reviewer ids from all prior project review runs", async () => {
    store.createRun({ linkedSessionId: "app-1", reviewerSessionId: "app-rev-1" });
    store.createRun({ linkedSessionId: "app-2", reviewerSessionId: "app-rev-7" });

    const run = await triggerCodeReviewForSession(
      {
        config,
        sessionManager: makeSessionManager(makeSession({ id: "app-3" })),
        storeFactory: () => store,
        resolveTargetSha: async () => undefined,
      },
      { sessionId: "app-3", requestedBy: "web" },
    );

    expect(run.reviewerSessionId).toBe("app-rev-8");
  });

  it("serializes concurrent triggers for the same session into a single reviewer run", async () => {
    let resolveGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    let shaLookups = 0;
    const options = {
      config,
      sessionManager: makeSessionManager(makeSession()),
      storeFactory: () => store,
      resolveTargetSha: async () => {
        shaLookups++;
        if (shaLookups === 2) {
          resolveGate?.();
        }
        await gate;
        return "abc123";
      },
    };

    const [first, second] = await Promise.all([
      triggerCodeReviewForSession(options, { sessionId: "app-1", requestedBy: "web" }),
      triggerCodeReviewForSession(options, { sessionId: "app-1", requestedBy: "web" }),
    ]);

    expect(first.id).toBe(second.id);
    expect(first.reviewerSessionId).toBe(second.reviewerSessionId);
    expect(store.listRuns()).toHaveLength(1);
  });

  it("does not block concurrent triggers for different sessions", async () => {
    const options = {
      config,
      sessionManager: makeSessionManager(null, {
        get: async (sessionId: string) =>
          sessionId === "app-1" ? makeSession({ id: "app-1" }) : makeSession({ id: "app-2" }),
      }),
      storeFactory: () => store,
      resolveTargetSha: async () => "abc123",
    };

    const [first, second] = await Promise.all([
      triggerCodeReviewForSession(options, { sessionId: "app-1", requestedBy: "web" }),
      triggerCodeReviewForSession(options, { sessionId: "app-2", requestedBy: "web" }),
    ]);

    expect(first.id).not.toBe(second.id);
    expect(new Set([first.linkedSessionId, second.linkedSessionId])).toEqual(
      new Set(["app-1", "app-2"]),
    );
    expect(store.listRuns()).toHaveLength(2);
  });

  it("returns the existing active run instead of creating a duplicate", async () => {
    const existing = store.createRun({
      linkedSessionId: "app-1",
      reviewerSessionId: "app-rev-1",
      status: "running",
      targetSha: "abc123",
    });

    const run = await triggerCodeReviewForSession(
      {
        config,
        sessionManager: makeSessionManager(makeSession()),
        storeFactory: () => store,
        resolveTargetSha: async () => "abc123",
      },
      { sessionId: "app-1", requestedBy: "web" },
    );

    expect(run.id).toBe(existing.id);
    expect(store.listRuns()).toHaveLength(1);
  });

  it("marks previous review runs for older worker SHAs as outdated", async () => {
    const oldTriage = store.createRun({
      linkedSessionId: "app-1",
      reviewerSessionId: "app-rev-1",
      status: "needs_triage",
      targetSha: "old-sha",
    });
    const oldClean = store.createRun({
      linkedSessionId: "app-1",
      reviewerSessionId: "app-rev-2",
      status: "clean",
      targetSha: "old-sha",
    });
    const failed = store.createRun({
      linkedSessionId: "app-1",
      reviewerSessionId: "app-rev-3",
      status: "failed",
      targetSha: "old-sha",
    });
    const otherWorker = store.createRun({
      linkedSessionId: "app-2",
      reviewerSessionId: "app-rev-4",
      status: "needs_triage",
      targetSha: "old-sha",
    });

    const run = await triggerCodeReviewForSession(
      {
        config,
        sessionManager: makeSessionManager(makeSession()),
        storeFactory: () => store,
        resolveTargetSha: async () => "new-sha",
        now: new Date("2026-05-10T12:00:00.000Z"),
      },
      { sessionId: "app-1", requestedBy: "web" },
    );

    expect(run.reviewerSessionId).toBe("app-rev-5");
    expect(store.getRun(oldTriage.id)?.status).toBe("outdated");
    expect(store.getRun(oldClean.id)?.status).toBe("outdated");
    expect(store.getRun(failed.id)?.status).toBe("failed");
    expect(store.getRun(otherWorker.id)?.status).toBe("needs_triage");
  });

  it("marks stale review runs outdated when the worker HEAD changes", async () => {
    const oldWaiting = store.createRun({
      linkedSessionId: "app-1",
      reviewerSessionId: "app-rev-1",
      status: "waiting_update",
      targetSha: "old-sha",
    });
    const currentQueued = store.createRun({
      linkedSessionId: "app-1",
      reviewerSessionId: "app-rev-2",
      status: "queued",
      targetSha: "new-sha",
    });
    const failed = store.createRun({
      linkedSessionId: "app-1",
      reviewerSessionId: "app-rev-3",
      status: "failed",
      targetSha: "old-sha",
    });

    const updatedCount = await markOutdatedCodeReviewRunsForSession({
      store,
      session: makeSession(),
      resolveTargetSha: async () => "new-sha",
      now: new Date("2026-05-10T12:00:00.000Z"),
    });

    expect(updatedCount).toBe(1);
    expect(store.getRun(oldWaiting.id)?.status).toBe("outdated");
    expect(store.getRun(currentQueued.id)?.status).toBe("queued");
    expect(store.getRun(failed.id)?.status).toBe("failed");
  });

  it("rejects missing and orchestrator sessions", async () => {
    await expect(
      triggerCodeReviewForSession(
        { config, sessionManager: makeSessionManager(null), storeFactory: () => store },
        { sessionId: "app-404" },
      ),
    ).rejects.toBeInstanceOf(SessionNotFoundError);

    await expect(
      triggerCodeReviewForSession(
        {
          config,
          sessionManager: makeSessionManager(
            makeSession({ id: "app-orchestrator", metadata: { role: "orchestrator" } }),
          ),
          storeFactory: () => store,
        },
        { sessionId: "app-orchestrator" },
      ),
    ).rejects.toThrow(/Cannot request code review for orchestrator session/);
  });
});

describe("executeCodeReviewRun", () => {
  it("runs a reviewer in an isolated workspace and persists findings", async () => {
    const run = store.createRun({
      linkedSessionId: "app-1",
      reviewerSessionId: "app-rev-1",
      status: "queued",
      targetSha: "abc123",
    });

    const summary = await executeCodeReviewRun(
      {
        config,
        sessionManager: makeSessionManager(makeSession()),
        storeFactory: () => store,
        prepareWorkspace: async ({ run }) => `/tmp/reviews/${run.reviewerSessionId}`,
        runReviewer: async ({ workspacePath }) => ({
          summary: `Reviewed ${workspacePath}`,
          findings: [
            {
              severity: "error",
              title: "Broken save path",
              body: "The save handler drops failed writes.",
              filePath: "src/save.ts",
              startLine: 12,
              confidence: 0.9,
            },
          ],
        }),
      },
      { projectId: "app", runId: run.id },
    );

    expect(summary).toMatchObject({
      status: "needs_triage",
      reviewerWorkspacePath: "/tmp/reviews/app-rev-1",
      findingCount: 1,
      openFindingCount: 1,
      summary: "Reviewed /tmp/reviews/app-rev-1",
    });
    expect(store.listFindings({ runId: run.id })[0]).toMatchObject({
      severity: "error",
      title: "Broken save path",
      filePath: "src/save.ts",
      startLine: 12,
    });
  });

  it("falls back to the project default branch when the session PR base branch is empty", async () => {
    const run = store.createRun({
      linkedSessionId: "app-1",
      reviewerSessionId: "app-rev-1",
      status: "queued",
      targetSha: "abc123",
    });
    let observedBaseRef: string | undefined;
    const session = makeSession({
      pr: {
        ...makeSession().pr!,
        baseBranch: "",
      },
    });

    const summary = await executeCodeReviewRun(
      {
        config,
        sessionManager: makeSessionManager(session),
        storeFactory: () => store,
        prepareWorkspace: async () => "/tmp/reviews/app-rev-1",
        runReviewer: async ({ baseRef }) => {
          observedBaseRef = baseRef;
          return { findings: [] };
        },
      },
      { projectId: "app", runId: run.id },
    );

    expect(observedBaseRef).toBe("main");
    expect(summary.status).toBe("clean");
  });

  it("allows only one concurrent execution to claim the same queued review run", async () => {
    const run = store.createRun({
      linkedSessionId: "app-1",
      reviewerSessionId: "app-rev-1",
      status: "queued",
      targetSha: "abc123",
    });
    let resolveSessionLookup: (() => void) | undefined;
    const sessionLookupGate = new Promise<void>((resolve) => {
      resolveSessionLookup = resolve;
    });
    let sessionLookups = 0;
    let prepareCalls = 0;
    const sessionManager = makeSessionManager(makeSession(), {
      get: async () => {
        sessionLookups++;
        if (sessionLookups === 2) {
          resolveSessionLookup?.();
        }
        await sessionLookupGate;
        return makeSession();
      },
    });

    const first = executeCodeReviewRun(
      {
        config,
        sessionManager,
        storeFactory: () => store,
        prepareWorkspace: async () => {
          prepareCalls++;
          return "/tmp/reviews/app-rev-1";
        },
        runReviewer: async () => ({ findings: [] }),
      },
      { projectId: "app", runId: run.id },
    );
    while (sessionLookups === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const second = executeCodeReviewRun(
      {
        config,
        sessionManager,
        storeFactory: () => store,
        prepareWorkspace: async () => {
          prepareCalls++;
          return "/tmp/reviews/app-rev-1";
        },
        runReviewer: async () => ({ findings: [] }),
      },
      { projectId: "app", runId: run.id },
    );
    await Promise.resolve();
    resolveSessionLookup?.();

    const results = await Promise.allSettled([first, second]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(prepareCalls).toBe(1);
    expect(store.getRun(run.id)?.status).toBe("clean");
  });

  it("marks clean reviews clean and records failed reviewer executions", async () => {
    const cleanRun = store.createRun({
      linkedSessionId: "app-1",
      reviewerSessionId: "app-rev-1",
      status: "queued",
    });

    const cleanSummary = await executeCodeReviewRun(
      {
        config,
        sessionManager: makeSessionManager(makeSession()),
        storeFactory: () => store,
        prepareWorkspace: async () => "/tmp/reviews/app-rev-1",
        runReviewer: async () => ({ rawOutput: '{"findings":[]}' }),
      },
      { projectId: "app", runId: cleanRun.id },
    );
    expect(cleanSummary.status).toBe("clean");
    expect(cleanSummary.findingCount).toBe(0);

    const failedRun = store.createRun({
      linkedSessionId: "app-1",
      reviewerSessionId: "app-rev-2",
      status: "queued",
    });
    const failedSummary = await executeCodeReviewRun(
      {
        config,
        sessionManager: makeSessionManager(makeSession()),
        storeFactory: () => store,
        prepareWorkspace: async () => "/tmp/reviews/app-rev-2",
        runReviewer: async () => {
          throw new Error("review command crashed");
        },
      },
      { projectId: "app", runId: failedRun.id },
    );
    expect(failedSummary.status).toBe("failed");
    expect(failedSummary.terminationReason).toBe("review command crashed");
  });
});

describe("executeCodeReviewRun — autoPostVerdict", () => {
  function makeRegistry(scm: Partial<SCM> | null): PluginRegistry {
    return {
      register: () => {},
      get: <T,>() => (scm as T) ?? null,
      list: () => [],
      loadBuiltins: async () => {},
      loadFromConfig: async () => {},
    };
  }

  const autoPostConfig: OrchestratorConfig = {
    ...config,
    projects: {
      app: {
        ...config.projects.app,
        scm: { plugin: "github" },
        review: { agent: "codex", autoPostVerdict: true },
      },
    },
  };

  it("does not post when autoPostVerdict is off (default)", async () => {
    const run = store.createRun({
      linkedSessionId: "app-1",
      reviewerSessionId: "app-rev-1",
      status: "queued",
    });
    const commentOnPR = vi.fn();

    await executeCodeReviewRun(
      {
        config, // no review.autoPostVerdict
        sessionManager: makeSessionManager(makeSession()),
        storeFactory: () => store,
        prepareWorkspace: async () => "/tmp/reviews/app-rev-1",
        runReviewer: async () => ({ findings: [{ severity: "error", title: "bug" }] }),
        registry: makeRegistry({ name: "github", commentOnPR }),
      },
      { projectId: "app", runId: run.id },
    );

    expect(commentOnPR).not.toHaveBeenCalled();
  });

  it("posts the verdict to the PR via SCM when autoPostVerdict is on and findings exist", async () => {
    const run = store.createRun({
      linkedSessionId: "app-1",
      reviewerSessionId: "app-rev-1",
      status: "queued",
    });
    const commentOnPR = vi.fn(async (_pr: PRInfo, _body: string) => {});

    const summary = await executeCodeReviewRun(
      {
        config: autoPostConfig,
        sessionManager: makeSessionManager(makeSession()),
        storeFactory: () => store,
        prepareWorkspace: async () => "/tmp/reviews/app-rev-1",
        runReviewer: async () => ({
          findings: [
            {
              severity: "error",
              title: "Broken save path",
              body: "details",
              filePath: "src/save.ts",
              startLine: 12,
            },
          ],
        }),
        registry: makeRegistry({ name: "github", commentOnPR }),
      },
      { projectId: "app", runId: run.id },
    );

    expect(commentOnPR).toHaveBeenCalledTimes(1);
    const [pr, body] = commentOnPR.mock.calls[0];
    expect(pr).toMatchObject({ number: 7 });
    expect(body).toContain("[error] Broken save path");
    expect(body).toContain("src/save.ts:12");
    expect(store.getRun(run.id)?.verdictPostedAt).toBeDefined();
    expect(summary.status).toBe("needs_triage");
  });

  it("no-ops with a warning when the session has no PR", async () => {
    const run = store.createRun({
      linkedSessionId: "app-1",
      reviewerSessionId: "app-rev-1",
      status: "queued",
    });
    const commentOnPR = vi.fn();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await executeCodeReviewRun(
      {
        config: autoPostConfig,
        sessionManager: makeSessionManager(makeSession({ pr: null })),
        storeFactory: () => store,
        prepareWorkspace: async () => "/tmp/reviews/app-rev-1",
        runReviewer: async () => ({ findings: [{ severity: "error", title: "bug" }] }),
        registry: makeRegistry({ name: "github", commentOnPR }),
      },
      { projectId: "app", runId: run.id },
    );

    expect(commentOnPR).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("does not post the verdict twice when a run is re-executed", async () => {
    const created = store.createRun({
      linkedSessionId: "app-1",
      reviewerSessionId: "app-rev-1",
      status: "needs_triage",
    });
    const run = store.updateRun(created.id, {
      verdictPostedAt: "2026-05-10T11:00:00.000Z",
    });
    const commentOnPR = vi.fn(async () => {});

    await executeCodeReviewRun(
      {
        config: autoPostConfig,
        sessionManager: makeSessionManager(makeSession()),
        storeFactory: () => store,
        force: true,
        prepareWorkspace: async () => "/tmp/reviews/app-rev-1",
        runReviewer: async () => ({ findings: [{ severity: "error", title: "bug again" }] }),
        registry: makeRegistry({ name: "github", commentOnPR }),
      },
      { projectId: "app", runId: run.id },
    );

    expect(commentOnPR).not.toHaveBeenCalled();
  });
});

describe("sendCodeReviewFindingsToAgent", () => {
  it("sends open review findings to the linked coding worker and marks them sent", async () => {
    const session = makeSession();
    const sentMessages: Array<{ sessionId: string; message: string }> = [];
    const run = store.createRun({
      linkedSessionId: session.id,
      reviewerSessionId: "app-rev-1",
      status: "needs_triage",
      targetSha: "abc123",
      prNumber: 7,
      prUrl: "https://github.com/acme/app/pull/7",
    });
    const first = store.createFinding({
      runId: run.id,
      linkedSessionId: session.id,
      severity: "error",
      title: "Broken save path",
      body: "The save handler drops failed writes.",
      filePath: "src/save.ts",
      startLine: 12,
      confidence: 0.9,
    });
    const second = store.createFinding({
      runId: run.id,
      linkedSessionId: session.id,
      severity: "warning",
      title: "Missing retry",
      body: "The request fails permanently on transient network errors.",
      filePath: "src/api.ts",
      startLine: 4,
      endLine: 8,
    });
    const dismissed = store.createFinding({
      runId: run.id,
      linkedSessionId: session.id,
      severity: "info",
      title: "Dismissed nit",
      body: "This should not be sent.",
      status: "dismissed",
    });

    const result = await sendCodeReviewFindingsToAgent(
      {
        config,
        sessionManager: makeSessionManager(session, {
          send: async (sessionId, message) => {
            sentMessages.push({ sessionId, message });
          },
        }),
        storeFactory: () => store,
        now: () => new Date("2026-05-10T12:00:00.000Z"),
      },
      { projectId: "app", runId: run.id },
    );

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.sessionId).toBe("app-1");
    expect(sentMessages[0]?.message).toContain("AO reviewer app-rev-1 found 2 open issues");
    expect(sentMessages[0]?.message).toContain("Review run:");
    expect(sentMessages[0]?.message).toContain("[error] Broken save path");
    expect(sentMessages[0]?.message).toContain("Location: src/save.ts:12");
    expect(sentMessages[0]?.message).toContain("[warning] Missing retry");
    expect(sentMessages[0]?.message).toContain("Location: src/api.ts:4-8");
    expect(sentMessages[0]?.message).not.toContain("Dismissed nit");
    expect(result).toMatchObject({
      sentFindingCount: 2,
      run: {
        status: "waiting_update",
        openFindingCount: 0,
        sentFindingCount: 2,
        dismissedFindingCount: 1,
      },
    });
    expect(store.getFinding(first.id)).toMatchObject({
      status: "sent_to_agent",
      sentToAgentAt: "2026-05-10T12:00:00.000Z",
    });
    expect(store.getFinding(second.id)?.status).toBe("sent_to_agent");
    expect(store.getFinding(dismissed.id)?.status).toBe("dismissed");
  });

  it("does not send or mutate when there are no open findings", async () => {
    const session = makeSession();
    const run = store.createRun({
      linkedSessionId: session.id,
      reviewerSessionId: "app-rev-1",
      status: "clean",
    });
    store.createFinding({
      runId: run.id,
      linkedSessionId: session.id,
      severity: "warning",
      title: "Already sent",
      body: "Do not resend this.",
      status: "sent_to_agent",
    });
    const sentMessages: string[] = [];

    await expect(
      sendCodeReviewFindingsToAgent(
        {
          config,
          sessionManager: makeSessionManager(session, {
            send: async (_sessionId, message) => {
              sentMessages.push(message);
            },
          }),
          storeFactory: () => store,
        },
        { projectId: "app", runId: run.id },
      ),
    ).rejects.toBeInstanceOf(CodeReviewNoOpenFindingsError);

    expect(sentMessages).toEqual([]);
    expect(store.getRun(run.id)?.status).toBe("clean");
  });
});

describe("runCodexCodeReview", () => {
  it("uses generic codex exec instead of the review subcommand base/prompt combination", () => {
    const args = buildCodexCodeReviewArgs("/tmp/review-output.json", "Return JSON only.");

    expect(args).toEqual([
      "exec",
      "--sandbox",
      "read-only",
      "--output-last-message",
      "/tmp/review-output.json",
      "Return JSON only.",
    ]);
    expect(args).not.toContain("review");
    expect(args).not.toContain("--base");
  });

  it("injects --model when a review model is configured", () => {
    expect(buildCodexCodeReviewArgs("/tmp/out.json", "Prompt", "gpt-5.5")).toEqual([
      "exec",
      "--model",
      "gpt-5.5",
      "--sandbox",
      "read-only",
      "--output-last-message",
      "/tmp/out.json",
      "Prompt",
    ]);
  });
});

describe("reviewer selection and resilience", () => {
  function makeRunnerContext(
    overrides: Partial<CodeReviewRunnerContext> = {},
  ): CodeReviewRunnerContext {
    const run = store.createRun({
      linkedSessionId: "app-1",
      reviewerSessionId: "app-rev-ctx",
      status: "running",
    });
    return {
      config,
      project: config.projects.app!,
      session: makeSession(),
      run,
      workspacePath: storeDir,
      baseRef: "main",
      ...overrides,
    };
  }

  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("builds read-only headless claude args, optionally with a model", () => {
    const args = buildClaudeCodeReviewArgs("Return JSON only.");
    expect(args.slice(0, 4)).toEqual(["-p", "Return JSON only.", "--output-format", "text"]);
    expect(args).toContain("--allowedTools");
    expect(args).not.toContain("--model");

    const withModel = buildClaudeCodeReviewArgs("Return JSON only.", "claude-opus-4-8");
    expect(withModel.slice(-2)).toEqual(["--model", "claude-opus-4-8"]);
  });

  it("(a) default project config selects and runs codex (behaviour unchanged)", async () => {
    spawnMock.mockImplementation(() => fakeChild({ stdout: '{"findings":[]}', code: 0 }));

    const runner = resolveCodeReviewRunner(config.projects.app!);
    const result = await runner(makeRunnerContext());

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[0]).toBe("codex");
    expect(result.rawOutput).toBe('{"findings":[]}');
    expect(result.summary).toBeUndefined();
  });

  it("(a) review.agent=claude selects and runs claude", async () => {
    const project = { ...config.projects.app!, review: { agent: "claude" as const } };
    expect(resolveCodeReviewRunner(project)).toBe(runClaudeCodeReview);

    spawnMock.mockImplementation(() => fakeChild({ stdout: '{"findings":[]}', code: 0 }));

    const runner = resolveCodeReviewRunner(project);
    await runner(makeRunnerContext({ project }));

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[0]).toBe("claude");
  });

  it("(b) falls back to claude when codex hits its usage limit", async () => {
    const calls: string[] = [];
    spawnMock.mockImplementation((file: string) => {
      calls.push(file);
      if (file === "codex") {
        return fakeChild({
          stderr: "stream error: You hit your usage limit. Try again at 2:39.",
          code: 1,
        });
      }
      return fakeChild({
        stdout: '{"findings":[{"severity":"error","title":"Bug","body":"Concrete issue."}]}',
        code: 0,
      });
    });

    const runner = resolveCodeReviewRunner(config.projects.app!);
    const result = await runner(makeRunnerContext());

    expect(calls).toEqual(["codex", "claude"]);
    expect(result.summary).toBe(CODEX_CLAUDE_FALLBACK_SUMMARY);
    expect(parseReviewerOutput(result.rawOutput ?? "")).toHaveLength(1);
  });

  it("(extra) does not fall back when codex fails for a non-provider reason", async () => {
    const calls: string[] = [];
    spawnMock.mockImplementation((file: string) => {
      calls.push(file);
      return fakeChild({ stderr: "Command timed out after 600000ms", code: 1 });
    });

    const runner = resolveCodeReviewRunner(config.projects.app!);
    await expect(runner(makeRunnerContext())).rejects.toThrow(/Codex review failed/);
    expect(calls).toEqual(["codex"]);
  });

  it("(d) codex and claude runners feed the same JSON through one parser", async () => {
    const json =
      '{"findings":[{"severity":"warning","title":"Risk","body":"Same issue.","filePath":"src/x.ts","startLine":3}]}';
    spawnMock.mockImplementation(() => fakeChild({ stdout: json, code: 0 }));

    const ctx = makeRunnerContext();
    const codexResult = await runCodexCodeReview(ctx);
    const claudeResult = await runClaudeCodeReview(ctx);

    expect(codexResult.rawOutput).toBe(json);
    expect(claudeResult.rawOutput).toBe(json);
    expect(parseReviewerOutput(codexResult.rawOutput ?? "")).toEqual(
      parseReviewerOutput(claudeResult.rawOutput ?? ""),
    );
    expect(parseReviewerOutput(codexResult.rawOutput ?? "")).toHaveLength(1);
  });

  it("createCodexWithClaudeFallbackRunner retries via fallback and tags the summary", async () => {
    const primary: CodeReviewRunner = async () => {
      throw new Error("Codex review failed: usage limit reached");
    };
    const fallback = vi.fn(async () => ({ rawOutput: '{"findings":[]}' }));

    const result = await createCodexWithClaudeFallbackRunner(primary, fallback)(makeRunnerContext());

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(result.summary).toBe(CODEX_CLAUDE_FALLBACK_SUMMARY);
  });

  it("createCodexWithClaudeFallbackRunner preserves a summary the fallback already set", async () => {
    const primary: CodeReviewRunner = async () => {
      throw new Error("rate limit");
    };
    const fallback: CodeReviewRunner = async () => ({ rawOutput: "{}", summary: "custom" });

    const result = await createCodexWithClaudeFallbackRunner(primary, fallback)(makeRunnerContext());
    expect(result.summary).toBe("custom");
  });

  it("createCodexWithClaudeFallbackRunner rethrows non-provider failures untouched", async () => {
    const primary: CodeReviewRunner = async () => {
      throw new Error("Codex review failed: Command timed out after 600000ms");
    };
    const fallback = vi.fn(async () => ({ rawOutput: "{}" }));

    await expect(
      createCodexWithClaudeFallbackRunner(primary, fallback)(makeRunnerContext()),
    ).rejects.toThrow(/timed out/);
    expect(fallback).not.toHaveBeenCalled();
  });
});

describe("isCodexProviderUnavailableError", () => {
  it("matches provider-availability signatures only", () => {
    for (const message of [
      "Codex review failed: You hit your usage limit, try again at 2:39",
      "rate limit exceeded",
      "request failed with status 429",
      "Transport channel closed",
      "401 Unauthorized",
      "Error: authentication failed",
      "you are not logged in",
    ]) {
      expect(isCodexProviderUnavailableError(new Error(message))).toBe(true);
    }

    for (const message of [
      "Command timed out after 600000ms",
      "Unexpected token < in JSON",
      "boom: internal reviewer crash",
    ]) {
      expect(isCodexProviderUnavailableError(new Error(message))).toBe(false);
    }
  });

  it("inspects nested cause chains", () => {
    const inner = new Error("HTTP 429 Too Many Requests");
    const outer = new Error("Codex review failed: wrapper", { cause: inner });
    expect(isCodexProviderUnavailableError(outer)).toBe(true);
  });
});

describe("prepareGitReviewerWorkspace", () => {
  it("prunes stale git worktree metadata when the reviewer workspace directory is gone", async () => {
    const tmpHome = join(tmpdir(), `ao-test-review-worktree-${randomUUID()}`);
    const originalHome = process.env["HOME"];
    process.env["HOME"] = tmpHome;

    try {
      const repoPath = join(tmpHome, "repo");
      mkdirSync(repoPath, { recursive: true });
      execFileSync("git", ["init", "-b", "main"], { cwd: repoPath });
      writeFileSync(join(repoPath, "README.md"), "# App\n");
      execFileSync("git", ["add", "README.md"], { cwd: repoPath });
      execFileSync("git", ["commit", "-m", "initial"], {
        cwd: repoPath,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "AO Test",
          GIT_AUTHOR_EMAIL: "ao@example.com",
          GIT_COMMITTER_NAME: "AO Test",
          GIT_COMMITTER_EMAIL: "ao@example.com",
        },
      });

      const run = store.createRun({
        linkedSessionId: "app-1",
        reviewerSessionId: "app-rev-stale",
        status: "queued",
      });
      const project = { ...config.projects.app!, path: repoPath };
      const workspaceRoot = join(
        tmpHome,
        ".agent-orchestrator",
        "projects",
        "app",
        "code-reviews",
        "workspaces",
      );
      const workspacePath = join(workspaceRoot, run.reviewerSessionId);
      mkdirSync(workspaceRoot, { recursive: true });
      execFileSync("git", ["worktree", "add", "--detach", workspacePath, "HEAD"], {
        cwd: repoPath,
      });
      rmSync(workspacePath, { recursive: true, force: true });

      const preparedPath = await prepareGitReviewerWorkspace({
        projectId: "app",
        project,
        session: makeSession({ workspacePath: repoPath }),
        run,
      });

      expect(preparedPath).toBe(workspacePath);
      expect(existsSync(workspacePath)).toBe(true);
    } finally {
      if (originalHome === undefined) {
        delete process.env["HOME"];
      } else {
        process.env["HOME"] = originalHome;
      }
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

describe("parseReviewerOutput", () => {
  it("parses JSON findings and falls back to a single reviewer-output finding", () => {
    expect(
      parseReviewerOutput(
        JSON.stringify({
          findings: [{ severity: "warning", title: "Risk", body: "A concrete issue." }],
        }),
      ),
    ).toMatchObject([{ severity: "warning", title: "Risk", body: "A concrete issue." }]);
    expect(parseReviewerOutput("No findings.")).toEqual([]);
    expect(parseReviewerOutput("Unexpected reviewer text")).toMatchObject([
      { severity: "warning", title: "Reviewer output", body: "Unexpected reviewer text" },
    ]);
  });

  it("does not drop structured findings whose text mentions no findings", () => {
    expect(
      parseReviewerOutput(
        JSON.stringify({
          findings: [
            {
              severity: "warning",
              title: "No findings banner is stale",
              body: "The UI still says no findings even when the reviewer found one.",
              filePath: "src/review.ts",
              startLine: 42,
            },
          ],
        }),
      ),
    ).toMatchObject([
      {
        severity: "warning",
        title: "No findings banner is stale",
        body: "The UI still says no findings even when the reviewer found one.",
        filePath: "src/review.ts",
        startLine: 42,
      },
    ]);
  });
});
