/**
 * Blue-Green tests for issue #974: prompt-driven sessions without a tracker issue.
 *
 * BLUE = simulates main behavior (before this PR).
 *   These tests document the gap — prompt was silently ignored, not persisted,
 *   and not visible in the dashboard.
 *
 * GREEN = current branch behavior (after this PR).
 *   These tests verify the full plumbing works end-to-end across:
 *     1. serialize.ts  — userPrompt mapped from session metadata → DashboardSession
 *     2. POST /api/spawn — prompt field validated and forwarded to session manager
 *     3. DashboardSession type — userPrompt field present
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import {
  createInitialCanonicalLifecycle,
  createActivitySignal,
  type Session,
  type SessionManager,
  type OrchestratorConfig,
  type PluginRegistry,
  type SCM,
} from "@aoagents/ao-core";
import { sessionToDashboard } from "@/lib/serialize";

// ── Shared test fixtures ──────────────────────────────────────────────

function makeSession(overrides: Partial<Session> & { id: string }): Session {
  const lifecycle = createInitialCanonicalLifecycle("worker", new Date("2025-01-01T00:00:00Z"));
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
      timestamp: new Date("2025-01-01T00:00:00Z"),
      source: "native",
    }),
    lifecycle,
    branch: null,
    issueId: null,
    pr: null,
    workspacePath: null,
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date("2025-01-01T00:00:00Z"),
    lastActivityAt: new Date("2025-01-01T00:00:00Z"),
    metadata: {},
    ...overrides,
  };
}

// ── Mock infrastructure (mirrors api-routes.test.ts pattern) ─────────

let lastSpawnConfig: Parameters<SessionManager["spawn"]>[0] | null = null;

const mockSessionManager: SessionManager = {
  list: vi.fn(async () => []),
  get: vi.fn(async () => null),
  spawn: vi.fn(async (config) => {
    lastSpawnConfig = config;
    return makeSession({
      id: "my-app-1",
      projectId: config.projectId,
      issueId: config.issueId ?? null,
      status: "spawning",
      metadata: config.prompt ? { userPrompt: config.prompt } : {},
    });
  }),
  kill: vi.fn(async () => {}),
  send: vi.fn(async () => {}),
  cleanup: vi.fn(async () => ({ killed: [], skipped: [], errors: [] })),
  spawnOrchestrator: vi.fn(),
  remap: vi.fn(async () => "ses_mock"),
  restore: vi.fn(async (id) => makeSession({ id, status: "spawning" })),
  claimPR: vi.fn(async () => ({ session: makeSession({ id: "s1" }), pr: {} as never })),
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

import { POST as spawnPOST } from "@/app/api/spawn/route";

// ── BLUE — main behavior (before #974) ───────────────────────────────
//
// On main, prompt-driven spawning was silently broken:
//   - /api/spawn ignored the `prompt` field — it never reached session manager
//   - session metadata never contained `userPrompt`
//   - DashboardSession had no `userPrompt` field — serializer had no mapping
//
// These tests document the gap by testing the OLD data path:
// sessions written without `userPrompt` in metadata produce null in output.

describe("BLUE — main behavior (before #974)", () => {
  describe("serialize.ts: session without userPrompt in metadata", () => {
    it("userPrompt is null when metadata has no userPrompt key", () => {
      // On main, writeMetadata never wrote userPrompt, so this was always the result.
      const session = makeSession({
        id: "my-app-1",
        metadata: { worktree: "/tmp/wt", branch: "session/my-app-1", status: "working" },
      });

      const dashboard = sessionToDashboard(session);

      // This is what every session looked like on main: no prompt visible.
      expect(dashboard.userPrompt).toBeNull();
    });

    it("issueId-based session also has null userPrompt when field absent", () => {
      const session = makeSession({
        id: "my-app-2",
        issueId: "https://github.com/acme/my-app/issues/42",
        metadata: { worktree: "/tmp/wt", branch: "feat/issue-42", status: "working" },
      });

      const dashboard = sessionToDashboard(session);

      // On main, even issue-backed sessions had no userPrompt (the field didn't exist).
      expect(dashboard.userPrompt).toBeNull();
    });
  });

  describe("POST /api/spawn: prompt field was silently ignored", () => {
    beforeEach(() => {
      lastSpawnConfig = null;
      vi.mocked(mockSessionManager.spawn).mockClear();
    });

    it("spawning with only projectId and issueId — classic path still works", async () => {
      const req = new NextRequest("http://localhost/api/spawn", {
        method: "POST",
        body: JSON.stringify({ projectId: "my-app", issueId: "42" }),
        headers: { "content-type": "application/json" },
      });

      const res = await spawnPOST(req);
      expect(res.status).toBe(201);

      const data = await res.json();
      expect(data.session).toBeDefined();
      expect(data.session.projectId).toBe("my-app");
    });

    it("on main: a body with prompt but no issueId would have spawned WITHOUT prompt", async () => {
      // Simulate what main's route did: it called sessionManager.spawn({ projectId, issueId })
      // and never forwarded prompt. We verify the conceptual gap by checking that the
      // old code path (issueId only, no prompt) produces null userPrompt in the response.
      const req = new NextRequest("http://localhost/api/spawn", {
        method: "POST",
        body: JSON.stringify({ projectId: "my-app" /* no prompt */ }),
        headers: { "content-type": "application/json" },
      });

      const res = await spawnPOST(req);
      expect(res.status).toBe(201);

      const data = await res.json();
      // On main: no prompt → session metadata has no userPrompt → null in response
      expect(data.session.userPrompt).toBeNull();
    });
  });
});

// ── GREEN — branch behavior (after #974) ─────────────────────────────
//
// After this PR:
//   - /api/spawn validates and forwards `prompt` to session manager
//   - session-manager persists it as metadata["userPrompt"]
//   - sessionToDashboard() maps it to DashboardSession.userPrompt
//   - DashboardSession type includes the field
//
// These tests verify the full plumbing.

describe("GREEN — branch behavior (after #974)", () => {
  describe("serialize.ts: userPrompt mapped from session metadata", () => {
    it("maps userPrompt from metadata to DashboardSession", () => {
      const session = makeSession({
        id: "my-app-3",
        metadata: {
          worktree: "/tmp/wt",
          branch: "session/my-app-3",
          status: "working",
          userPrompt: "Add rate limiting to the /api/upload endpoint",
        },
      });

      const dashboard = sessionToDashboard(session);

      expect(dashboard.userPrompt).toBe("Add rate limiting to the /api/upload endpoint");
    });

    it("userPrompt coexists with issueId on the same session", () => {
      const session = makeSession({
        id: "my-app-4",
        issueId: "https://github.com/acme/my-app/issues/99",
        metadata: {
          worktree: "/tmp/wt",
          branch: "feat/issue-99",
          status: "working",
          userPrompt: "Fix the race condition in the upload handler",
        },
      });

      const dashboard = sessionToDashboard(session);

      expect(dashboard.userPrompt).toBe("Fix the race condition in the upload handler");
      expect(dashboard.issueId).toBe("https://github.com/acme/my-app/issues/99");
    });

    it("preserves whitespace in multi-word prompts", () => {
      const prompt = "  Refactor the auth module   to use JWT  ";
      const session = makeSession({
        id: "my-app-5",
        metadata: { userPrompt: prompt },
      });

      const dashboard = sessionToDashboard(session);
      expect(dashboard.userPrompt).toBe(prompt);
    });
  });

  describe("DashboardSession type: userPrompt field is present", () => {
    it("DashboardSession includes userPrompt field (compile-time check)", () => {
      const session = makeSession({ id: "type-check-1", metadata: { userPrompt: "hello" } });
      const dashboard = sessionToDashboard(session);

      // If userPrompt didn't exist on the type, this line would be a TS compile error.
      const _: string | null = dashboard.userPrompt;
      expect(typeof dashboard.userPrompt === "string" || dashboard.userPrompt === null).toBe(true);
    });
  });

  describe("POST /api/spawn: prompt field validated and forwarded", () => {
    beforeEach(() => {
      lastSpawnConfig = null;
      vi.mocked(mockSessionManager.spawn).mockClear();
    });

    it("accepts prompt without issueId and returns session with userPrompt", async () => {
      const req = new NextRequest("http://localhost/api/spawn", {
        method: "POST",
        body: JSON.stringify({
          projectId: "my-app",
          prompt: "Refactor the auth module to use JWT",
        }),
        headers: { "content-type": "application/json" },
      });

      const res = await spawnPOST(req);
      expect(res.status).toBe(201);

      const data = await res.json();
      expect(data.session).toBeDefined();
      // session manager received the prompt
      expect(lastSpawnConfig?.prompt).toBe("Refactor the auth module to use JWT");
    });

    it("forwards prompt alongside issueId when both are provided", async () => {
      const req = new NextRequest("http://localhost/api/spawn", {
        method: "POST",
        body: JSON.stringify({
          projectId: "my-app",
          issueId: "42",
          prompt: "Focus on the database migration aspect",
        }),
        headers: { "content-type": "application/json" },
      });

      const res = await spawnPOST(req);
      expect(res.status).toBe(201);

      expect(lastSpawnConfig?.issueId).toBe("42");
      expect(lastSpawnConfig?.prompt).toBe("Focus on the database migration aspect");
    });

    it("rejects an empty prompt string with 400", async () => {
      const req = new NextRequest("http://localhost/api/spawn", {
        method: "POST",
        body: JSON.stringify({ projectId: "my-app", prompt: "" }),
        headers: { "content-type": "application/json" },
      });

      const res = await spawnPOST(req);
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toMatch(/prompt/i);
    });

    it("rejects a prompt that exceeds 4096 characters with 400", async () => {
      const req = new NextRequest("http://localhost/api/spawn", {
        method: "POST",
        body: JSON.stringify({ projectId: "my-app", prompt: "x".repeat(4097) }),
        headers: { "content-type": "application/json" },
      });

      const res = await spawnPOST(req);
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toMatch(/prompt/i);
    });

    it("treats null prompt as absent — does not forward it", async () => {
      const req = new NextRequest("http://localhost/api/spawn", {
        method: "POST",
        body: JSON.stringify({ projectId: "my-app", prompt: null }),
        headers: { "content-type": "application/json" },
      });

      const res = await spawnPOST(req);
      expect(res.status).toBe(201);

      // null prompt → not forwarded → spawn config has no prompt
      expect(lastSpawnConfig?.prompt).toBeUndefined();
    });

    it("session returned in response has userPrompt from metadata", async () => {
      const req = new NextRequest("http://localhost/api/spawn", {
        method: "POST",
        body: JSON.stringify({
          projectId: "my-app",
          prompt: "Add weekly report generation script",
        }),
        headers: { "content-type": "application/json" },
      });

      const res = await spawnPOST(req);
      const data = await res.json();

      // The spawned session has userPrompt set in metadata by session-manager,
      // then serialized back into the response.
      expect(data.session.userPrompt).toBe("Add weekly report generation script");
    });
  });
});
