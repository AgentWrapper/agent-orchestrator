import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import {
  SessionNotFoundError,
  SessionNotRestorableError,
  WorkspaceMissingError,
  recordActivityEvent,
  createInitialCanonicalLifecycle,
  createActivitySignal,
  type Session,
  type SessionManager,
  type OrchestratorConfig,
  type PluginRegistry,
  type SCM,
} from "@aoagents/ao-core";

// Partial mock so we replace recordActivityEvent but keep types/helpers
vi.mock("@aoagents/ao-core", async () => {
  const actual = await vi.importActual("@aoagents/ao-core");
  return {
    ...(actual as Record<string, unknown>),
    recordActivityEvent: vi.fn(),
  };
});

vi.mock("@/lib/observability", async () => {
  const actual = await vi.importActual("@/lib/observability");
  return {
    ...(actual as Record<string, unknown>),
    recordApiObservation: vi.fn(),
  };
});

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

const baseSessions: Session[] = [
  makeSession({ id: "backend-3" }),
  makeSession({
    id: "backend-7",
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
  makeSession({ id: "frontend-1", status: "killed", activity: "exited" }),
];

const mockSessionManager: SessionManager = {
  list: vi.fn(async () => baseSessions),
  listCached: vi.fn(async () => baseSessions),
  invalidateCache: vi.fn(),
  get: vi.fn(async (id: string) => baseSessions.find((s) => s.id === id) ?? null),
  spawn: vi.fn(async (cfg) =>
    makeSession({
      id: `session-${Date.now()}`,
      projectId: cfg.projectId,
      issueId: cfg.issueId ?? null,
      status: "spawning",
    }),
  ),
  kill: vi.fn(async (id: string) => {
    if (!baseSessions.find((s) => s.id === id)) {
      throw new SessionNotFoundError(id);
    }
  }),
  send: vi.fn(async (id: string) => {
    if (!baseSessions.find((s) => s.id === id)) {
      throw new SessionNotFoundError(id);
    }
  }),
  cleanup: vi.fn(async () => ({ killed: [], skipped: [], errors: [] })),
  spawnOrchestrator: vi.fn(async () =>
    makeSession({
      id: "my-app-orchestrator",
      projectId: "my-app",
      metadata: { role: "orchestrator" },
    }),
  ),
  relaunchOrchestrator: vi.fn(async () =>
    makeSession({
      id: "my-app-orchestrator",
      projectId: "my-app",
      metadata: { role: "orchestrator" },
    }),
  ),
  ensureOrchestrator: vi.fn(),
  remap: vi.fn(async () => "ses_mock"),
  restore: vi.fn(async (id: string) => {
    const session = baseSessions.find((s) => s.id === id);
    if (!session) throw new SessionNotFoundError(id);
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
  invalidatePortfolioServicesCache: vi.fn(),
}));

import { getServices } from "@/lib/services";
import { recordApiObservation } from "@/lib/observability";
import { POST as spawnPOST } from "@/app/api/spawn/route";
import { POST as killPOST } from "@/app/api/sessions/[id]/kill/route";
import { POST as sendPOST } from "@/app/api/sessions/[id]/send/route";
import { POST as messagePOST } from "@/app/api/sessions/[id]/message/route";
import { POST as restorePOST } from "@/app/api/sessions/[id]/restore/route";
import { POST as orchestratorsPOST } from "@/app/api/orchestrators/route";
import { POST as mergePOST } from "@/app/api/prs/[id]/merge/route";

function makeRequest(url: string, init?: RequestInit): NextRequest {
  return new NextRequest(
    new URL(url, "http://localhost:3000"),
    init as ConstructorParameters<typeof NextRequest>[1],
  );
}

const recorded = vi.mocked(recordActivityEvent);

beforeEach(() => {
  recorded.mockClear();
  vi.mocked(recordApiObservation).mockClear();
  vi.mocked(getServices).mockClear();
});

describe("API mutation routes emit activity events (api source)", () => {
  describe("MUST emits — session mutations", () => {
    it("POST /api/spawn emits api.session_spawn_requested on success", async () => {
      const req = makeRequest("/api/spawn", {
        method: "POST",
        body: JSON.stringify({ projectId: "my-app", issueId: "INT-100" }),
        headers: { "Content-Type": "application/json" },
      });
      await spawnPOST(req);

      expect(recorded).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "api",
          kind: "api.session_spawn_requested",
          projectId: "my-app",
        }),
      );
    });

    it("POST /api/sessions/:id/kill emits api.session_kill_requested on success", async () => {
      const req = makeRequest("/api/sessions/backend-3/kill", { method: "POST" });
      await killPOST(req, { params: Promise.resolve({ id: "backend-3" }) });

      expect(recorded).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "api",
          kind: "api.session_kill_requested",
          sessionId: "backend-3",
        }),
      );
    });

    it("POST /api/sessions/:id/send emits api.session_message_sent with messageLength", async () => {
      const req = makeRequest("/api/sessions/backend-3/send", {
        method: "POST",
        body: JSON.stringify({ message: "Fix the tests" }),
        headers: { "Content-Type": "application/json" },
      });
      await sendPOST(req, { params: Promise.resolve({ id: "backend-3" }) });

      expect(recorded).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "api",
          kind: "api.session_message_sent",
          sessionId: "backend-3",
          data: expect.objectContaining({ messageLength: "Fix the tests".length }),
        }),
      );
    });

    it("POST /api/sessions/:id/send does NOT include the raw message in data", async () => {
      const secret = "very-secret-PII content";
      const req = makeRequest("/api/sessions/backend-3/send", {
        method: "POST",
        body: JSON.stringify({ message: secret }),
        headers: { "Content-Type": "application/json" },
      });
      await sendPOST(req, { params: Promise.resolve({ id: "backend-3" }) });

      const calls = recorded.mock.calls.filter(
        (c) => (c[0] as { kind: string }).kind === "api.session_message_sent",
      );
      expect(calls.length).toBeGreaterThan(0);
      for (const [event] of calls) {
        const json = JSON.stringify(event);
        expect(json).not.toContain(secret);
      }
    });

    it("POST /api/sessions/:id/message emits api.session_message_sent with messageLength", async () => {
      const req = makeRequest("/api/sessions/backend-3/message", {
        method: "POST",
        body: JSON.stringify({ message: "Hi" }),
        headers: { "Content-Type": "application/json" },
      });
      await messagePOST(req, { params: Promise.resolve({ id: "backend-3" }) });

      expect(recorded).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "api",
          kind: "api.session_message_sent",
          sessionId: "backend-3",
          data: expect.objectContaining({ messageLength: 2 }),
        }),
      );
    });

    it("POST /api/sessions/:id/restore emits api.session_restore_requested on success", async () => {
      const req = makeRequest("/api/sessions/frontend-1/restore", { method: "POST" });
      await restorePOST(req, { params: Promise.resolve({ id: "frontend-1" }) });

      expect(recorded).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "api",
          kind: "api.session_restore_requested",
          sessionId: "frontend-1",
        }),
      );
    });
  });

  describe("MUST emits — orchestrator + PR mutations", () => {
    it("POST /api/orchestrators emits api.orchestrator_spawn_requested on success", async () => {
      const req = makeRequest("/api/orchestrators", {
        method: "POST",
        body: JSON.stringify({ projectId: "my-app" }),
        headers: { "Content-Type": "application/json" },
      });
      await orchestratorsPOST(req);

      expect(recorded).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "api",
          kind: "api.orchestrator_spawn_requested",
          projectId: "my-app",
        }),
      );
    });

    it("POST /api/prs/:id/merge emits api.pr_merge_requested on success", async () => {
      const req = makeRequest("/api/prs/432/merge", { method: "POST" });
      await mergePOST(req, { params: Promise.resolve({ id: "432" }) });

      expect(recorded).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "api",
          kind: "api.pr_merge_requested",
          data: expect.objectContaining({ prNumber: 432 }),
        }),
      );
    });
  });

  describe("SHOULD emits — failure paths", () => {
    it("POST /api/spawn emits api.session_spawn_rejected for unknown project", async () => {
      const req = makeRequest("/api/spawn", {
        method: "POST",
        body: JSON.stringify({ projectId: "unknown-app" }),
        headers: { "Content-Type": "application/json" },
      });
      await spawnPOST(req);

      expect(recorded).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "api",
          kind: "api.session_spawn_rejected",
          projectId: "unknown-app",
        }),
      );
    });

    it("POST /api/spawn does not emit api.session_spawn_failed when core spawn throws", async () => {
      (mockSessionManager.spawn as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("runtime failed"),
      );
      const req = makeRequest("/api/spawn", {
        method: "POST",
        body: JSON.stringify({ projectId: "my-app", issueId: "INT-101" }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await spawnPOST(req);

      expect(res.status).toBe(500);
      expect(
        recorded.mock.calls.some(
          ([event]) => (event as { kind: string }).kind === "api.session_spawn_failed",
        ),
      ).toBe(false);
    });

    it.each([
      ["spawn", false, mockSessionManager.spawnOrchestrator],
      ["clean relaunch", true, mockSessionManager.relaunchOrchestrator],
    ])(
      "POST /api/orchestrators does not emit api.orchestrator_spawn_failed when core %s throws",
      async (_name, clean, method) => {
        (method as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("runtime failed"));
        const req = makeRequest("/api/orchestrators", {
          method: "POST",
          body: JSON.stringify({ projectId: "my-app", clean }),
          headers: { "Content-Type": "application/json" },
        });
        const res = await orchestratorsPOST(req);

        expect(res.status).toBe(500);
        expect(
          recorded.mock.calls.some(
            ([event]) => (event as { kind: string }).kind === "api.orchestrator_spawn_failed",
          ),
        ).toBe(false);
      },
    );

    it("POST /api/sessions/:id/send emits api.session_message_failed on unexpected error", async () => {
      (mockSessionManager.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("write failed"),
      );
      const req = makeRequest("/api/sessions/backend-3/send", {
        method: "POST",
        body: JSON.stringify({ message: "hi" }),
        headers: { "Content-Type": "application/json" },
      });
      await sendPOST(req, { params: Promise.resolve({ id: "backend-3" }) });

      expect(recorded).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "api",
          kind: "api.session_message_failed",
          sessionId: "backend-3",
          data: expect.objectContaining({ messageLength: 2 }),
        }),
      );
    });

    it.each([
      ["non-restorable session", new SessionNotRestorableError("my-app-123", "still working"), 409],
      ["missing workspace", new WorkspaceMissingError("/tmp/missing-workspace"), 422],
      ["unexpected restore error", new Error("restore failed"), 500],
    ])(
      "POST /api/sessions/:id/restore emits attributed api.session_restore_failed for %s",
      async (_name, error, statusCode) => {
        (mockSessionManager.restore as ReturnType<typeof vi.fn>).mockRejectedValueOnce(error);
        const req = makeRequest("/api/sessions/my-app-123/restore", { method: "POST" });
        const res = await restorePOST(req, { params: Promise.resolve({ id: "my-app-123" }) });

        expect(res.status).toBe(statusCode);
        expect(vi.mocked(getServices)).toHaveBeenCalledTimes(1);
        expect(recorded).toHaveBeenCalledWith(
          expect.objectContaining({
            source: "api",
            kind: "api.session_restore_failed",
            projectId: "my-app",
            sessionId: "my-app-123",
            data: expect.objectContaining({ statusCode }),
          }),
        );
      },
    );

    it("POST /api/prs/:id/merge emits api.pr_merge_rejected for non-mergeable PR", async () => {
      (mockSCM.getMergeability as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        mergeable: false,
        ciPassing: false,
        approved: false,
        noConflicts: true,
        blockers: ["CI checks failing"],
      });
      const req = makeRequest("/api/prs/432/merge", { method: "POST" });
      await mergePOST(req, { params: Promise.resolve({ id: "432" }) });

      expect(recorded).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "api",
          kind: "api.pr_merge_rejected",
          data: expect.objectContaining({ prNumber: 432 }),
        }),
      );
    });

    it("POST /api/prs/:id/merge emits api.pr_merge_failed when mergePR throws", async () => {
      (mockSCM.mergePR as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("github 500"));
      const req = makeRequest("/api/prs/432/merge", { method: "POST" });
      await mergePOST(req, { params: Promise.resolve({ id: "432" }) });

      expect(recorded).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "api",
          kind: "api.pr_merge_failed",
          projectId: "my-app",
          sessionId: "backend-7",
          data: expect.objectContaining({ prNumber: 432, reason: "github 500" }),
        }),
      );
      expect(recordApiObservation).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: "failure",
          statusCode: 500,
          projectId: "my-app",
          sessionId: "backend-7",
          data: expect.objectContaining({ prNumber: 432 }),
        }),
      );
    });
  });
});
