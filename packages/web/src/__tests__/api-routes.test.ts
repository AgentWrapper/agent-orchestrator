import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import {
  SessionNotFoundError,
  SessionNotRestorableError,
  createInitialCanonicalLifecycle,
  createActivitySignal,
  type Session,
  type SessionManager,
  type OrchestratorConfig,
  type PluginRegistry,
  type SCM,
} from "@aoagents/ao-core";
import * as serialize from "@/lib/serialize";
import { getSCM } from "@/lib/services";

// ── Mock Data ─────────────────────────────────────────────────────────
// Provides test sessions covering the key states the dashboard needs.

function makeSession(overrides: Partial<Session> & { id: string }): Session {
  const lifecycle = createInitialCanonicalLifecycle("worker", new Date());
  lifecycle.session.state = "working";
  lifecycle.session.reason = "task_in_progress";
  lifecycle.session.startedAt = lifecycle.session.lastTransitionAt;
  lifecycle.runtime.state = "alive";
  lifecycle.runtime.reason = "process_running";
  return {
    projectId: "my-app",
    status: "working",
    activity: "active",
    activitySignal: createActivitySignal("valid", {
      activity: "active",
      timestamp: new Date(),
      source: "native",
    }),
    lifecycle,
    branch: null,
    issueId: null,
    pr: null,
    workspacePath: null,
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

const testSessions: Session[] = [
  makeSession({ id: "backend-3", status: "needs_input", activity: "waiting_input" }),
  makeSession({
    id: "backend-7",
    status: "mergeable",
    activity: "idle",
    pr: {
      number: 432,
      url: "https://github.com/acme/my-app/pull/432",
      title: "feat: health check",
      owner: "acme",
      repo: "my-app",
      branch: "feat/health-check",
      baseBranch: "main",
      isDraft: false,
    },
  }),
  makeSession({ id: "backend-9", status: "working", activity: "active" }),
  makeSession({
    id: "frontend-1",
    status: "killed",
    activity: "exited",
    projectId: "my-app",
    issueId: "INT-1270",
    branch: "feat/INT-1270-table",
  }),
];

const multiProjectSessions: Session[] = [
  makeSession({
    id: "app-orchestrator",
    projectId: "my-app",
    metadata: { role: "orchestrator" },
  }),
  makeSession({
    id: "backend-3",
    projectId: "my-app",
    status: "working",
    activity: "active",
  }),
  makeSession({
    id: "docs-orchestrator",
    projectId: "docs-app",
    metadata: { role: "orchestrator" },
  }),
  makeSession({
    id: "docs-2",
    projectId: "docs-app",
    status: "review_pending",
    activity: "idle",
  }),
];

// ── Mock Services ─────────────────────────────────────────────────────

const mockSessionManager: SessionManager = {
  list: vi.fn(async () => testSessions),
  listCached: vi.fn(async () => testSessions),
  invalidateCache: vi.fn(),
  get: vi.fn(async (id: string) => testSessions.find((s) => s.id === id) ?? null),
  spawn: vi.fn(async (config) =>
    makeSession({
      id: `session-${Date.now()}`,
      projectId: config.projectId,
      issueId: config.issueId ?? null,
      status: "spawning",
    }),
  ),
  kill: vi.fn(async (id: string) => {
    if (!testSessions.find((s) => s.id === id)) {
      throw new SessionNotFoundError(id);
    }
  }),
  send: vi.fn(async (id: string) => {
    if (!testSessions.find((s) => s.id === id)) {
      throw new SessionNotFoundError(id);
    }
  }),
  cleanup: vi.fn(async () => ({ killed: [], skipped: [], errors: [] })),
  spawnOrchestrator: vi.fn(),
  ensureOrchestrator: vi.fn(),
  remap: vi.fn(async () => "ses_mock"),
  restore: vi.fn(async (id: string) => {
    const session = testSessions.find((s) => s.id === id);
    if (!session) {
      throw new SessionNotFoundError(id);
    }
    // Simulate SessionNotRestorableError for non-terminal sessions
    if (session.status === "working" && session.activity !== "exited") {
      throw new SessionNotRestorableError(id, "session is not in a terminal state");
    }
    return { ...session, status: "spawning" as const, activity: "active" as const };
  }),
};

const mockSCM: SCM = {
  name: "github",
  detectPR: vi.fn(async () => null),
  getPRState: vi.fn(async () => "open" as const),
  mergePR: vi.fn(async () => {}),
  closePR: vi.fn(async () => {}),
  getCIChecks: vi.fn(async () => []),
  getCISummary: vi.fn(async () => "passing" as const),
  getReviews: vi.fn(async () => []),
  getReviewDecision: vi.fn(async () => "approved" as const),
  getPendingComments: vi.fn(async () => []),
  getAutomatedComments: vi.fn(async () => []),
  getMergeability: vi.fn(async () => ({
    mergeable: true,
    ciPassing: true,
    approved: true,
    noConflicts: true,
    blockers: [],
  })),
};

const mockRegistry: PluginRegistry = {
  register: vi.fn(),
  get: vi.fn(() => mockSCM) as PluginRegistry["get"],
  list: vi.fn(() => []),
  loadBuiltins: vi.fn(async () => {}),
  loadFromConfig: vi.fn(async () => {}),
};

const mockConfig: OrchestratorConfig = {
  configPath: "/tmp/ao-test/agent-orchestrator.yaml",
  port: 3000,
  readyThresholdMs: 300_000,
  defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
  projects: {
    "my-app": {
      name: "My App",
      repo: "acme/my-app",
      path: "/tmp/my-app",
      defaultBranch: "main",
      sessionPrefix: "my-app",
      scm: { plugin: "github" },
    },
    "docs-app": {
      name: "Docs App",
      repo: "acme/docs-app",
      path: "/tmp/docs-app",
      defaultBranch: "main",
      sessionPrefix: "docs",
      scm: { plugin: "github" },
    },
  },
  notifiers: {},
  notificationRouting: { urgent: [], action: [], warning: [], info: [] },
  reactions: {},
};

vi.mock("@/lib/services", () => ({
  getServices: vi.fn(async () => ({
    config: mockConfig,
    registry: mockRegistry,
    sessionManager: mockSessionManager,
  })),
  getVerifyIssues: vi.fn(async () => []),
  getSCM: vi.fn(() => mockSCM),
}));

// ── Import routes after mocking ───────────────────────────────────────

import { GET as sessionsGET } from "@/app/api/sessions/route";
import { GET as sessionDetailGET } from "@/app/api/sessions/[id]/route";
import { POST as orchestratorsPOST, GET as orchestratorsGET } from "@/app/api/orchestrators/route";
import { POST as spawnPOST } from "@/app/api/spawn/route";
import { POST as sendPOST } from "@/app/api/sessions/[id]/send/route";
import { POST as messagePOST } from "@/app/api/sessions/[id]/message/route";
import { POST as killPOST } from "@/app/api/sessions/[id]/kill/route";
import { POST as restorePOST } from "@/app/api/sessions/[id]/restore/route";
import { POST as remapPOST } from "@/app/api/sessions/[id]/remap/route";
import { POST as mergePOST } from "@/app/api/prs/[id]/merge/route";
import { GET as observabilityGET } from "@/app/api/observability/route";
import { GET as runtimeTerminalGET } from "@/app/api/runtime/terminal/route";
import { GET as verifyGET, POST as verifyPOST } from "@/app/api/verify/route";
import { GET as patchesGET } from "@/app/api/sessions/patches/route";

function makeRequest(url: string, init?: RequestInit): NextRequest {
  return new NextRequest(
    new URL(url, "http://localhost:3000"),
    init as ConstructorParameters<typeof NextRequest>[1],
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // Re-set default return values
  (mockSessionManager.list as ReturnType<typeof vi.fn>).mockResolvedValue(testSessions);
  (mockSessionManager.listCached as ReturnType<typeof vi.fn>).mockResolvedValue(testSessions);
  (mockSessionManager.get as ReturnType<typeof vi.fn>).mockImplementation(
    async (id: string) => testSessions.find((s) => s.id === id) ?? null,
  );
});

describe("API Routes", () => {
  // ── GET /api/sessions ──────────────────────────────────────────────

  describe("GET /api/sessions", () => {
    it("returns sessions array and stats", async () => {
      const res = await sessionsGET(makeRequest("http://localhost:3000/api/sessions"));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.sessions).toBeDefined();
      expect(Array.isArray(data.sessions)).toBe(true);
      expect(data.sessions.length).toBe(testSessions.length);
      expect(data.stats).toBeDefined();
      expect(data.stats.totalSessions).toBe(data.sessions.length);
    });

    it("stats include expected fields", async () => {
      const res = await sessionsGET(makeRequest("http://localhost:3000/api/sessions"));
      const data = await res.json();
      expect(data.stats).toHaveProperty("totalSessions");
      expect(data.stats).toHaveProperty("workingSessions");
      expect(data.stats).toHaveProperty("openPRs");
      expect(data.stats).toHaveProperty("needsReview");
    });

    it("sessions have expected shape", async () => {
      const res = await sessionsGET(makeRequest("http://localhost:3000/api/sessions"));
      const data = await res.json();
      const session = data.sessions[0];
      expect(session).toHaveProperty("id");
      expect(session).toHaveProperty("projectId");
      expect(session).toHaveProperty("status");
      expect(session).toHaveProperty("activity");
      expect(session).toHaveProperty("createdAt");
    });

    it("skips PR enrichment when metadata enrichment hits timeout", async () => {
      vi.useFakeTimers();

      const metadataSpy = vi
        .spyOn(serialize, "enrichSessionsMetadata")
        .mockImplementation(() => new Promise<void>(() => {}));

      const responsePromise = sessionsGET(makeRequest("http://localhost:3000/api/sessions"));
      await vi.advanceTimersByTimeAsync(3_000);
      const res = await responsePromise;

      expect(res.status).toBe(200);
      expect(getSCM).not.toHaveBeenCalled();

      metadataSpy.mockRestore();
      vi.useRealTimers();
    });

    it("returns per-project orchestrators and excludes them from worker sessions", async () => {
      (mockSessionManager.listCached as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        multiProjectSessions,
      );

      const res = await sessionsGET(makeRequest("http://localhost:3000/api/sessions"));
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.orchestratorId).toBeNull();
      expect(data.orchestrators).toEqual([
        { id: "docs-orchestrator", projectId: "docs-app", projectName: "Docs App" },
        { id: "app-orchestrator", projectId: "my-app", projectName: "My App" },
      ]);
      expect(data.sessions.map((session: { id: string }) => session.id)).toEqual([
        "backend-3",
        "docs-2",
      ]);
      expect(data.stats.totalSessions).toBe(2);
    });

    it("supports project-scoped session queries for orchestrator detail views", async () => {
      (mockSessionManager.listCached as ReturnType<typeof vi.fn>).mockImplementationOnce(
        async (projectId?: string) =>
          multiProjectSessions.filter((session) => !projectId || session.projectId === projectId),
      );

      const res = await sessionsGET(
        makeRequest("http://localhost:3000/api/sessions?project=docs-app"),
      );
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.orchestratorId).toBe("docs-orchestrator");
      expect(data.orchestrators).toEqual([
        { id: "docs-orchestrator", projectId: "docs-app", projectName: "Docs App" },
      ]);
      expect(data.sessions.map((session: { id: string }) => session.id)).toEqual(["docs-2"]);
      expect(mockSessionManager.listCached).toHaveBeenCalledWith("docs-app");
    });

    it("uses the live session list when fresh=true is requested", async () => {
      (mockSessionManager.list as ReturnType<typeof vi.fn>).mockImplementationOnce(
        async (projectId?: string) =>
          multiProjectSessions.filter((session) => !projectId || session.projectId === projectId),
      );

      const res = await sessionsGET(
        makeRequest("http://localhost:3000/api/sessions?project=docs-app&fresh=true"),
      );
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.orchestratorId).toBe("docs-orchestrator");
      expect(data.sessions.map((session: { id: string }) => session.id)).toEqual(["docs-2"]);
      expect(mockSessionManager.list).toHaveBeenCalledWith("docs-app");
      expect(mockSessionManager.listCached).not.toHaveBeenCalledWith("docs-app");
    });

    it("prefers the most recently active live orchestrator for project-scoped worker navigation", async () => {
      const deadLifecycle = createInitialCanonicalLifecycle("orchestrator", new Date("2026-04-19T11:00:00.000Z"));
      deadLifecycle.session.state = "terminated";
      deadLifecycle.session.reason = "runtime_missing";
      deadLifecycle.session.terminatedAt = "2026-04-19T11:00:00.000Z";
      deadLifecycle.session.lastTransitionAt = "2026-04-19T11:00:00.000Z";
      deadLifecycle.runtime.state = "missing";
      deadLifecycle.runtime.reason = "process_missing";
      deadLifecycle.runtime.lastObservedAt = "2026-04-19T11:00:00.000Z";

      const olderLive = makeSession({
        id: "my-app-orchestrator-1",
        projectId: "my-app",
        metadata: { role: "orchestrator" },
        lastActivityAt: new Date("2026-04-19T09:00:00.000Z"),
      });
      const newerLive = makeSession({
        id: "my-app-orchestrator",
        projectId: "my-app",
        metadata: { role: "orchestrator" },
        lastActivityAt: new Date("2026-04-19T10:00:00.000Z"),
      });
      const deadOlder = makeSession({
        id: "my-app-orchestrator-0",
        projectId: "my-app",
        metadata: { role: "orchestrator" },
        status: "killed",
        activity: "exited",
        lastActivityAt: new Date("2026-04-19T11:00:00.000Z"),
        lifecycle: deadLifecycle,
      });
      (mockSessionManager.listCached as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        deadOlder,
        olderLive,
        newerLive,
        makeSession({
          id: "backend-3",
          projectId: "my-app",
          status: "working",
          activity: "active",
        }),
      ]);

      const res = await sessionsGET(
        makeRequest("http://localhost:3000/api/sessions?project=my-app&orchestratorOnly=true"),
      );
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.orchestratorId).toBe("my-app-orchestrator");
      expect(data.orchestrators.map((session: { id: string }) => session.id)).toEqual([
        "my-app-orchestrator",
        "my-app-orchestrator-1",
      ]);
      expect(data.sessions).toEqual([]);
      expect(mockSessionManager.listCached).toHaveBeenCalledWith("my-app");
    });

    it("keeps dead orchestrators as the fallback project-scoped payload when none are live", async () => {
      const deadLifecycle = createInitialCanonicalLifecycle("orchestrator", new Date("2026-04-19T11:00:00.000Z"));
      deadLifecycle.session.state = "terminated";
      deadLifecycle.session.reason = "runtime_missing";
      deadLifecycle.session.terminatedAt = "2026-04-19T11:00:00.000Z";
      deadLifecycle.session.lastTransitionAt = "2026-04-19T11:00:00.000Z";
      deadLifecycle.runtime.state = "missing";
      deadLifecycle.runtime.reason = "process_missing";
      deadLifecycle.runtime.lastObservedAt = "2026-04-19T11:00:00.000Z";

      (mockSessionManager.listCached as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        makeSession({
          id: "my-app-orchestrator-0",
          projectId: "my-app",
          metadata: { role: "orchestrator" },
          status: "killed",
          activity: "exited",
          lastActivityAt: new Date("2026-04-19T11:00:00.000Z"),
          lifecycle: deadLifecycle,
        }),
      ]);

      const res = await sessionsGET(
        makeRequest("http://localhost:3000/api/sessions?project=my-app&orchestratorOnly=true"),
      );
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.orchestratorId).toBe("my-app-orchestrator-0");
      expect(data.orchestrators).toEqual([
        { id: "my-app-orchestrator-0", projectId: "my-app", projectName: "My App" },
      ]);
      expect(data.sessions).toEqual([]);
    });

    it("prefers the most recently active dead orchestrator when no live project orchestrator exists", async () => {
      const olderDeadLifecycle = createInitialCanonicalLifecycle("orchestrator", new Date("2026-04-19T10:00:00.000Z"));
      olderDeadLifecycle.session.state = "terminated";
      olderDeadLifecycle.session.reason = "runtime_missing";
      olderDeadLifecycle.session.terminatedAt = "2026-04-19T10:00:00.000Z";
      olderDeadLifecycle.session.lastTransitionAt = "2026-04-19T10:00:00.000Z";
      olderDeadLifecycle.runtime.state = "missing";
      olderDeadLifecycle.runtime.reason = "process_missing";
      olderDeadLifecycle.runtime.lastObservedAt = "2026-04-19T10:00:00.000Z";

      const newerDeadLifecycle = createInitialCanonicalLifecycle("orchestrator", new Date("2026-04-19T11:00:00.000Z"));
      newerDeadLifecycle.session.state = "terminated";
      newerDeadLifecycle.session.reason = "runtime_missing";
      newerDeadLifecycle.session.terminatedAt = "2026-04-19T11:00:00.000Z";
      newerDeadLifecycle.session.lastTransitionAt = "2026-04-19T11:00:00.000Z";
      newerDeadLifecycle.runtime.state = "missing";
      newerDeadLifecycle.runtime.reason = "process_missing";
      newerDeadLifecycle.runtime.lastObservedAt = "2026-04-19T11:00:00.000Z";

      (mockSessionManager.listCached as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        makeSession({
          id: "my-app-orchestrator-0",
          projectId: "my-app",
          metadata: { role: "orchestrator" },
          status: "killed",
          activity: "exited",
          lastActivityAt: new Date("2026-04-19T10:00:00.000Z"),
          lifecycle: olderDeadLifecycle,
        }),
        makeSession({
          id: "my-app-orchestrator-9",
          projectId: "my-app",
          metadata: { role: "orchestrator" },
          status: "killed",
          activity: "exited",
          lastActivityAt: new Date("2026-04-19T11:00:00.000Z"),
          lifecycle: newerDeadLifecycle,
        }),
      ]);

      const res = await sessionsGET(
        makeRequest("http://localhost:3000/api/sessions?project=my-app&orchestratorOnly=true"),
      );
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.orchestratorId).toBe("my-app-orchestrator-9");
      expect(data.orchestrators).toEqual([
        { id: "my-app-orchestrator-0", projectId: "my-app", projectName: "My App" },
        { id: "my-app-orchestrator-9", projectId: "my-app", projectName: "My App" },
      ]);
      expect(data.sessions).toEqual([]);
    });

    it("enriches all PRs concurrently, not sequentially", async () => {
      vi.useFakeTimers();

      const sessionsWithPRs = Array.from({ length: 6 }, (_, i) =>
        makeSession({
          id: `worker-${i}`,
          status: "pr_open",
          activity: "idle",
          pr: {
            number: 100 + i,
            url: `https://github.com/acme/my-app/pull/${100 + i}`,
            title: `PR ${i}`,
            owner: "acme",
            repo: "my-app",
            branch: `feat/pr-${i}`,
            baseBranch: "main",
            isDraft: false,
          },
        }),
      );
      (mockSessionManager.listCached as ReturnType<typeof vi.fn>).mockResolvedValue(sessionsWithPRs);

      const metadataSpy = vi
        .spyOn(serialize, "enrichSessionsMetadata")
        .mockResolvedValue(undefined);

      const enrichSpy = vi
        .spyOn(serialize, "enrichSessionPR")
        .mockImplementation(
          () => new Promise<void>((resolve) => { setTimeout(resolve, 1_000); }),
        );

      const responsePromise = sessionsGET(makeRequest("http://localhost:3000/api/sessions"));

      // Flush microtasks so the handler reaches the PR enrichment loop
      await vi.advanceTimersByTimeAsync(0);

      // Sequential would only have 1 call pending; parallel fires all 6 immediately
      expect(enrichSpy.mock.calls.length).toBe(6);

      await vi.advanceTimersByTimeAsync(5_000);
      const res = await responsePromise;
      expect(res.status).toBe(200);

      metadataSpy.mockRestore();
      enrichSpy.mockRestore();
      vi.useRealTimers();
    });

    it("uses cache-first PR enrichment with live fallback for terminal PR states", async () => {
      const terminalLifecycle = createInitialCanonicalLifecycle("worker", new Date());
      terminalLifecycle.session.state = "terminated";
      terminalLifecycle.session.reason = "user_killed";
      terminalLifecycle.session.terminatedAt = terminalLifecycle.session.lastTransitionAt;
      terminalLifecycle.runtime.state = "exited";
      terminalLifecycle.runtime.reason = "process_exited";
      terminalLifecycle.pr.state = "merged";
      terminalLifecycle.pr.reason = "merged";

      const sessionsWithPRs = [
        makeSession({
          id: "worker-live",
          status: "pr_open",
          activity: "idle",
          pr: {
            number: 201,
            url: "https://github.com/acme/my-app/pull/201",
            title: "Live PR",
            owner: "acme",
            repo: "my-app",
            branch: "feat/live-pr",
            baseBranch: "main",
            isDraft: false,
          },
        }),
        makeSession({
          id: "worker-killed",
          status: "killed",
          activity: "exited",
          lifecycle: terminalLifecycle,
          pr: {
            number: 202,
            url: "https://github.com/acme/my-app/pull/202",
            title: "Terminal PR",
            owner: "acme",
            repo: "my-app",
            branch: "feat/terminal-pr",
            baseBranch: "main",
            isDraft: false,
          },
        }),
      ];
      (mockSessionManager.listCached as ReturnType<typeof vi.fn>).mockResolvedValue(sessionsWithPRs);

      const metadataSpy = vi
        .spyOn(serialize, "enrichSessionsMetadata")
        .mockResolvedValue(undefined);

      const enrichSpy = vi
        .spyOn(serialize, "enrichSessionPR")
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

      const res = await sessionsGET(makeRequest("http://localhost:3000/api/sessions"));

      expect(res.status).toBe(200);
      expect(enrichSpy).toHaveBeenCalledTimes(3);
      expect(enrichSpy.mock.calls[0]).toEqual([
        expect.objectContaining({ id: "worker-live" }),
        expect.anything(),
        sessionsWithPRs[0]!.pr,
      ]);
      expect(enrichSpy.mock.calls[1]).toEqual([
        expect.objectContaining({ id: "worker-killed" }),
        expect.anything(),
        sessionsWithPRs[1]!.pr,
        { cacheOnly: true },
      ]);
      expect(enrichSpy.mock.calls[2]).toEqual([
        expect.objectContaining({ id: "worker-killed" }),
        expect.anything(),
        sessionsWithPRs[1]!.pr,
      ]);

      metadataSpy.mockRestore();
      enrichSpy.mockRestore();
    });

    it("keeps live PR refreshes for killed sessions whose PR is still open", async () => {
      const runtimeTerminalLifecycle = createInitialCanonicalLifecycle("worker", new Date());
      runtimeTerminalLifecycle.session.state = "terminated";
      runtimeTerminalLifecycle.session.reason = "user_killed";
      runtimeTerminalLifecycle.session.terminatedAt = runtimeTerminalLifecycle.session.lastTransitionAt;
      runtimeTerminalLifecycle.runtime.state = "missing";
      runtimeTerminalLifecycle.runtime.reason = "process_missing";
      runtimeTerminalLifecycle.pr.state = "open";
      runtimeTerminalLifecycle.pr.reason = "in_progress";

      const sessionWithOpenPR = [
        makeSession({
          id: "worker-open-pr",
          status: "killed",
          activity: "exited",
          lifecycle: runtimeTerminalLifecycle,
          pr: {
            number: 203,
            url: "https://github.com/acme/my-app/pull/203",
            title: "Open PR on killed runtime",
            owner: "acme",
            repo: "my-app",
            branch: "feat/open-pr-runtime-dead",
            baseBranch: "main",
            isDraft: false,
          },
        }),
      ];
      (mockSessionManager.listCached as ReturnType<typeof vi.fn>).mockResolvedValue(sessionWithOpenPR);

      const metadataSpy = vi
        .spyOn(serialize, "enrichSessionsMetadata")
        .mockResolvedValue(undefined);

      const enrichSpy = vi
        .spyOn(serialize, "enrichSessionPR")
        .mockResolvedValue(true);

      const res = await sessionsGET(makeRequest("http://localhost:3000/api/sessions"));

      expect(res.status).toBe(200);
      expect(enrichSpy).toHaveBeenCalledTimes(1);
      expect(enrichSpy.mock.calls[0]).toEqual([
        expect.objectContaining({ id: "worker-open-pr" }),
        expect.anything(),
        sessionWithOpenPR[0]!.pr,
      ]);

      metadataSpy.mockRestore();
      enrichSpy.mockRestore();
    });
  });

  describe("GET /api/sessions/[id]", () => {
    it("returns partial session data when metadata and PR enrichment stall", async () => {
      const metadataSpy = vi
        .spyOn(serialize, "enrichSessionsMetadata")
        .mockImplementation(() => new Promise<void>(() => {}));
      const prSpy = vi
        .spyOn(serialize, "enrichSessionPR")
        .mockImplementation(() => new Promise<boolean>(() => {}));

      const responsePromise = sessionDetailGET(
        makeRequest("http://localhost:3000/api/sessions/backend-7"),
        { params: Promise.resolve({ id: "backend-7" }) },
      );

      const res = await responsePromise;
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.id).toBe("backend-7");
      expect(data.projectId).toBe("my-app");

      metadataSpy.mockRestore();
      prSpy.mockRestore();
    }, 10_000);
  });

  describe("GET /api/runtime/terminal", () => {
    function withEnv(overrides: Record<string, string | undefined>, fn: () => Promise<void>) {
      const saved: Record<string, string | undefined> = {};
      for (const key of Object.keys(overrides)) {
        saved[key] = process.env[key];
        if (overrides[key] === undefined) {
          Reflect.deleteProperty(process.env, key);
        } else {
          process.env[key] = overrides[key];
        }
      }
      return fn().finally(() => {
        for (const key of Object.keys(saved)) {
          if (saved[key] === undefined) {
            Reflect.deleteProperty(process.env, key);
          } else {
            process.env[key] = saved[key];
          }
        }
      });
    }

    it("returns runtime direct terminal port from server env", async () => {
      await withEnv({ DIRECT_TERMINAL_PORT: "14803", TERMINAL_PORT: "14802" }, async () => {
        const res = await runtimeTerminalGET();
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.directTerminalPort).toBe("14803");
        expect(data.terminalPort).toBe("14802");
      });
    });

    it("falls back to default ports when env vars are absent", async () => {
      await withEnv({ DIRECT_TERMINAL_PORT: undefined, TERMINAL_PORT: undefined }, async () => {
        const res = await runtimeTerminalGET();
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.directTerminalPort).toBe("14801");
        expect(data.terminalPort).toBe("14800");
      });
    });

    it("falls back to default ports for non-numeric env values", async () => {
      await withEnv({ DIRECT_TERMINAL_PORT: "abc", TERMINAL_PORT: "not-a-port" }, async () => {
        const res = await runtimeTerminalGET();
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.directTerminalPort).toBe("14801");
        expect(data.terminalPort).toBe("14800");
      });
    });

    it("falls back to default ports for out-of-range port values", async () => {
      await withEnv({ DIRECT_TERMINAL_PORT: "99999", TERMINAL_PORT: "0" }, async () => {
        const res = await runtimeTerminalGET();
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.directTerminalPort).toBe("14801");
        expect(data.terminalPort).toBe("14800");
      });
    });

    it("returns null proxyWsPath when TERMINAL_WS_PATH is absent", async () => {
      await withEnv(
        { TERMINAL_WS_PATH: undefined, NEXT_PUBLIC_TERMINAL_WS_PATH: undefined },
        async () => {
          const res = await runtimeTerminalGET();
          expect(res.status).toBe(200);
          const data = await res.json();
          expect(data.proxyWsPath).toBeNull();
        },
      );
    });

    it("rejects proxyWsPath that does not start with /", async () => {
      await withEnv({ TERMINAL_WS_PATH: "no-leading-slash" }, async () => {
        const res = await runtimeTerminalGET();
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.proxyWsPath).toBeNull();
      });
    });

    it("sets Cache-Control: no-store header", async () => {
      const res = await runtimeTerminalGET();
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    });
  });

  // ── POST /api/spawn ────────────────────────────────────────────────

  describe("POST /api/spawn", () => {
    it("creates a session with valid input", async () => {
      const req = makeRequest("/api/spawn", {
        method: "POST",
        body: JSON.stringify({ projectId: "my-app", issueId: "INT-100" }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await spawnPOST(req);
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.session).toBeDefined();
      expect(data.session.projectId).toBe("my-app");
      expect(data.session.status).toBe("spawning");
      expect(res.headers.get("x-correlation-id")).toBeTruthy();
    });

    it("returns 400 when projectId is missing", async () => {
      const req = makeRequest("/api/spawn", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      });
      const res = await spawnPOST(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/projectId/);
    });

    it("returns 404 when projectId does not exist in config", async () => {
      const req = makeRequest("/api/spawn", {
        method: "POST",
        body: JSON.stringify({ projectId: "mono-orchestrator" }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await spawnPOST(req);

      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe("Unknown project: mono-orchestrator");
      expect(mockSessionManager.spawn).not.toHaveBeenCalled();
    });

    it("returns 400 with invalid JSON", async () => {
      const req = makeRequest("/api/spawn", {
        method: "POST",
        body: "not json",
        headers: { "Content-Type": "application/json" },
      });
      const res = await spawnPOST(req);
      expect(res.status).toBe(400);
    });

    it("handles missing issueId gracefully", async () => {
      const req = makeRequest("/api/spawn", {
        method: "POST",
        body: JSON.stringify({ projectId: "my-app" }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await spawnPOST(req);
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.session.issueId).toBeNull();
    });
  });

  describe("POST /api/orchestrators", () => {
    it("creates a per-project orchestrator with the generated prompt", async () => {
      (mockSessionManager.spawnOrchestrator as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        makeSession({
          id: "my-app-orchestrator",
          projectId: "my-app",
          metadata: { role: "orchestrator" },
        }),
      );

      const req = makeRequest("/api/orchestrators", {
        method: "POST",
        body: JSON.stringify({ projectId: "my-app" }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await orchestratorsPOST(req);

      expect(res.status).toBe(201);
      expect(mockSessionManager.spawnOrchestrator).toHaveBeenCalledWith({
        projectId: "my-app",
        systemPrompt: expect.stringContaining("# My App Orchestrator"),
      });

      const data = await res.json();
      expect(data.orchestrator).toEqual({
        id: "my-app-orchestrator",
        projectId: "my-app",
        projectName: "My App",
      });
    });

    it("returns 404 for an unknown project", async () => {
      const req = makeRequest("/api/orchestrators", {
        method: "POST",
        body: JSON.stringify({ projectId: "unknown-app" }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await orchestratorsPOST(req);

      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toMatch(/Unknown project/);
    });

    it("returns 400 for invalid JSON", async () => {
      const req = makeRequest("/api/orchestrators", {
        method: "POST",
        body: "not json",
        headers: { "Content-Type": "application/json" },
      });

      const res = await orchestratorsPOST(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/Invalid JSON body/);
    });

    it("returns 400 when projectId is missing", async () => {
      const req = makeRequest("/api/orchestrators", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      });

      const res = await orchestratorsPOST(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/projectId/);
    });

    it("returns 500 when orchestrator spawn fails", async () => {
      (mockSessionManager.spawnOrchestrator as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("boom"),
      );

      const req = makeRequest("/api/orchestrators", {
        method: "POST",
        body: JSON.stringify({ projectId: "my-app" }),
        headers: { "Content-Type": "application/json" },
      });

      const res = await orchestratorsPOST(req);
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toBe("boom");
    });

    it("returns a guided recovery message for registered orchestrator worktree collisions", async () => {
      (mockSessionManager.spawnOrchestrator as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error(
          'Worktree path "/Users/test/.worktrees/my-app/my-app-orchestrator" already exists and is still registered with git',
        ),
      );

      const req = makeRequest("/api/orchestrators", {
        method: "POST",
        body: JSON.stringify({ projectId: "my-app" }),
        headers: { "Content-Type": "application/json" },
      });

      const res = await orchestratorsPOST(req);
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data).toEqual({
        error: expect.stringContaining(
          'AO found an older orchestrator workspace for "my-app" but could not safely reuse it automatically.',
        ),
        code: "orchestrator_workspace_conflict",
        recovery: "reuse-or-recreate-workspace",
      });
    });

    it("returns the same recovery message when a matching branch is outside AO-managed worktree directories", async () => {
      (mockSessionManager.spawnOrchestrator as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error(
          'Found existing worktree for orchestrator branch "orchestrator/my-app-orchestrator" at "/tmp/manual-worktree", but it is outside AO-managed worktree directories. Reuse it manually or remove it and try again.',
        ),
      );

      const req = makeRequest("/api/orchestrators", {
        method: "POST",
        body: JSON.stringify({ projectId: "my-app" }),
        headers: { "Content-Type": "application/json" },
      });

      const res = await orchestratorsPOST(req);
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.recovery).toBe("reuse-or-recreate-workspace");
      expect(data.error).toContain('AO found an older orchestrator workspace for "my-app"');
    });
  });

  describe("GET /api/orchestrators", () => {
    it("returns orchestrators for a project", async () => {
      const orchestrator = makeSession({
        id: "my-app-orchestrator",
        projectId: "my-app",
        metadata: { role: "orchestrator" },
      });
      (mockSessionManager.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce([orchestrator]);

      const res = await orchestratorsGET(
        makeRequest("http://localhost:3000/api/orchestrators?project=my-app"),
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.orchestrators).toHaveLength(1);
      expect(data.orchestrators[0].id).toBe("my-app-orchestrator");
      expect(data.projectName).toBe("My App");
    });

    it("returns 400 when project parameter is missing", async () => {
      const res = await orchestratorsGET(makeRequest("http://localhost:3000/api/orchestrators"));
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/Missing project query parameter/);
    });

    it("returns 404 for unknown project", async () => {
      const res = await orchestratorsGET(
        makeRequest("http://localhost:3000/api/orchestrators?project=unknown-app"),
      );
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toMatch(/Unknown project/);
    });

    it("returns 500 when list fails", async () => {
      (mockSessionManager.list as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));
      const res = await orchestratorsGET(
        makeRequest("http://localhost:3000/api/orchestrators?project=my-app"),
      );
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toBe("boom");
    });
  });

  // ── POST /api/sessions/:id/send ────────────────────────────────────

  describe("POST /api/sessions/:id/send", () => {
    it("sends a message to a valid session", async () => {
      const req = makeRequest("/api/sessions/backend-3/send", {
        method: "POST",
        body: JSON.stringify({ message: "Fix the tests" }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await sendPOST(req, { params: Promise.resolve({ id: "backend-3" }) });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.message).toBe("Fix the tests");
    });

    it("returns 404 for unknown session", async () => {
      (mockSessionManager.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new SessionNotFoundError("nonexistent"),
      );
      const req = makeRequest("/api/sessions/nonexistent/send", {
        method: "POST",
        body: JSON.stringify({ message: "hello" }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await sendPOST(req, { params: Promise.resolve({ id: "nonexistent" }) });
      expect(res.status).toBe(404);
    });

    it("returns 400 when message is missing", async () => {
      const req = makeRequest("/api/sessions/backend-3/send", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      });
      const res = await sendPOST(req, { params: Promise.resolve({ id: "backend-3" }) });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/message/);
    });

    it("returns 400 for invalid JSON body", async () => {
      const req = makeRequest("/api/sessions/backend-3/send", {
        method: "POST",
        body: "not json",
        headers: { "Content-Type": "application/json" },
      });
      const res = await sendPOST(req, { params: Promise.resolve({ id: "backend-3" }) });
      expect(res.status).toBe(400);
    });

    it("returns 400 for control-char-only message", async () => {
      const req = makeRequest("/api/sessions/backend-3/send", {
        method: "POST",
        body: JSON.stringify({ message: "\x00\x01\x02" }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await sendPOST(req, { params: Promise.resolve({ id: "backend-3" }) });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/empty/);
    });
  });

  describe("POST /api/sessions/:id/message", () => {
    it("sends a message to a valid session", async () => {
      const req = makeRequest("/api/sessions/backend-3/message", {
        method: "POST",
        body: JSON.stringify({ message: "Fix the tests" }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await messagePOST(req, { params: Promise.resolve({ id: "backend-3" }) });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
    });

    it("returns 404 for unknown session", async () => {
      (mockSessionManager.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new SessionNotFoundError("nonexistent"),
      );

      const req = makeRequest("/api/sessions/nonexistent/message", {
        method: "POST",
        body: JSON.stringify({ message: "hello" }),
        headers: { "Content-Type": "application/json" },
      });

      const res = await messagePOST(req, { params: Promise.resolve({ id: "nonexistent" }) });
      expect(res.status).toBe(404);
    });

    it("returns 400 when message is missing", async () => {
      const req = makeRequest("/api/sessions/backend-3/message", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      });
      const res = await messagePOST(req, { params: Promise.resolve({ id: "backend-3" }) });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/message/);
    });

    it("returns 400 for invalid JSON body", async () => {
      const req = makeRequest("/api/sessions/backend-3/message", {
        method: "POST",
        body: "not json",
        headers: { "Content-Type": "application/json" },
      });
      const res = await messagePOST(req, { params: Promise.resolve({ id: "backend-3" }) });
      expect(res.status).toBe(400);
    });

    it("returns 400 for control-char-only message", async () => {
      const req = makeRequest("/api/sessions/backend-3/message", {
        method: "POST",
        body: JSON.stringify({ message: "\x00\x01\x02" }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await messagePOST(req, { params: Promise.resolve({ id: "backend-3" }) });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/empty/);
    });
  });

  // ── POST /api/sessions/:id/kill ────────────────────────────────────

  describe("POST /api/sessions/:id/kill", () => {
    it("kills a valid session", async () => {
      const req = makeRequest("/api/sessions/backend-3/kill", { method: "POST" });
      const res = await killPOST(req, { params: Promise.resolve({ id: "backend-3" }) });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.sessionId).toBe("backend-3");
    });

    it("returns 404 for unknown session", async () => {
      (mockSessionManager.kill as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new SessionNotFoundError("nonexistent"),
      );
      const req = makeRequest("/api/sessions/nonexistent/kill", { method: "POST" });
      const res = await killPOST(req, { params: Promise.resolve({ id: "nonexistent" }) });
      expect(res.status).toBe(404);
    });
  });

  // ── POST /api/sessions/:id/restore ─────────────────────────────────

  describe("POST /api/sessions/:id/restore", () => {
    it("restores a killed session", async () => {
      const req = makeRequest("/api/sessions/frontend-1/restore", { method: "POST" });
      const res = await restorePOST(req, { params: Promise.resolve({ id: "frontend-1" }) });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.sessionId).toBe("frontend-1");
    });

    it("returns 404 for unknown session", async () => {
      const req = makeRequest("/api/sessions/nonexistent/restore", { method: "POST" });
      const res = await restorePOST(req, { params: Promise.resolve({ id: "nonexistent" }) });
      expect(res.status).toBe(404);
    });

    it("returns 409 for active session", async () => {
      const req = makeRequest("/api/sessions/backend-9/restore", { method: "POST" });
      const res = await restorePOST(req, { params: Promise.resolve({ id: "backend-9" }) });
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error).toMatch(/not in a terminal state/);
    });
  });

  describe("POST /api/sessions/:id/remap", () => {
    it("remaps a valid session", async () => {
      const req = makeRequest("/api/sessions/backend-3/remap", { method: "POST" });
      const res = await remapPOST(req, { params: Promise.resolve({ id: "backend-3" }) });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.opencodeSessionId).toBe("ses_mock");
      expect(mockSessionManager.remap).toHaveBeenCalledWith("backend-3", true);
    });

    it("returns 404 when session is missing", async () => {
      (mockSessionManager.remap as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new SessionNotFoundError("missing"),
      );
      const req = makeRequest("/api/sessions/missing/remap", { method: "POST" });
      const res = await remapPOST(req, { params: Promise.resolve({ id: "missing" }) });
      expect(res.status).toBe(404);
    });

    it("returns 422 for non-opencode sessions", async () => {
      (mockSessionManager.remap as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Session backend-3 is not using the opencode agent"),
      );
      const req = makeRequest("/api/sessions/backend-3/remap", { method: "POST" });
      const res = await remapPOST(req, { params: Promise.resolve({ id: "backend-3" }) });
      expect(res.status).toBe(422);
      const data = await res.json();
      expect(data.error).toMatch(/not using the opencode agent/);
    });
  });

  // ── POST /api/prs/:id/merge ────────────────────────────────────────

  describe("POST /api/prs/:id/merge", () => {
    it("merges a mergeable PR", async () => {
      const req = makeRequest("/api/prs/432/merge", { method: "POST" });
      const res = await mergePOST(req, { params: Promise.resolve({ id: "432" }) });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.prNumber).toBe(432);
    });

    it("returns 404 for unknown PR", async () => {
      const req = makeRequest("/api/prs/99999/merge", { method: "POST" });
      const res = await mergePOST(req, { params: Promise.resolve({ id: "99999" }) });
      expect(res.status).toBe(404);
    });

    it("returns 422 for non-mergeable PR", async () => {
      (mockSCM.getMergeability as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        mergeable: false,
        ciPassing: false,
        approved: false,
        noConflicts: true,
        blockers: ["CI checks failing", "Needs review"],
      });
      const req = makeRequest("/api/prs/432/merge", { method: "POST" });
      const res = await mergePOST(req, { params: Promise.resolve({ id: "432" }) });
      expect(res.status).toBe(422);
      const data = await res.json();
      expect(data.error).toMatch(/not mergeable/);
      expect(data.blockers).toBeDefined();
    });

    it("returns 400 for non-numeric PR id", async () => {
      const req = makeRequest("/api/prs/abc/merge", { method: "POST" });
      const res = await mergePOST(req, { params: Promise.resolve({ id: "abc" }) });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/Invalid PR number/);
    });

    it("returns 409 for merged PR", async () => {
      (mockSCM.getPRState as ReturnType<typeof vi.fn>).mockResolvedValueOnce("merged");
      const req = makeRequest("/api/prs/432/merge", { method: "POST" });
      const res = await mergePOST(req, { params: Promise.resolve({ id: "432" }) });
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error).toMatch(/merged/);
    });
  });

  describe("GET /api/observability", () => {
    it("returns observability summary with correlation header", async () => {
      const req = makeRequest("/api/observability", { method: "GET" });
      const res = await observabilityGET(req);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-correlation-id")).toBeTruthy();
      const data = await res.json();
      expect(data).toHaveProperty("generatedAt");
      expect(data).toHaveProperty("overallStatus");
      expect(data).toHaveProperty("projects");
    });
  });

  describe("GET /api/verify", () => {
    it("returns verify issues", async () => {
      const res = await verifyGET();
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data.issues)).toBe(true);
    });
  });

  describe("POST /api/verify", () => {
    it("returns 400 for invalid JSON body", async () => {
      const req = makeRequest("/api/verify", {
        method: "POST",
        body: "not json",
        headers: { "Content-Type": "application/json" },
      });
      const res = await verifyPOST(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/Invalid JSON body/);
    });
  });
  // ── GET /api/sessions/patches ──────────────────────────────────────────

  describe("GET /api/sessions/patches", () => {
    it("returns patches array with lightweight fields", async () => {
      const res = await patchesGET(makeRequest("http://localhost:3000/api/sessions/patches"));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data.sessions)).toBe(true);
      expect(data.sessions.length).toBe(testSessions.length);
    });

    it("each patch contains id, status, activity, attentionLevel, lastActivityAt", async () => {
      const res = await patchesGET(makeRequest("http://localhost:3000/api/sessions/patches"));
      const data = await res.json();
      for (const patch of data.sessions) {
        expect(patch).toHaveProperty("id");
        expect(patch).toHaveProperty("status");
        expect(patch).toHaveProperty("activity");
        expect(patch).toHaveProperty("attentionLevel");
        expect(patch).toHaveProperty("lastActivityAt");
      }
    });

    it("filters by project query param", async () => {
      const res = await patchesGET(
        makeRequest("http://localhost:3000/api/sessions/patches?project=my-app"),
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data.sessions)).toBe(true);
    });

    it("returns 500 when getServices throws", async () => {
      const { getServices } = await import("@/lib/services");
      vi.mocked(getServices).mockRejectedValueOnce(new Error("db down"));
      const res = await patchesGET(makeRequest("http://localhost:3000/api/sessions/patches"));
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toBe("db down");
    });
  });
});
