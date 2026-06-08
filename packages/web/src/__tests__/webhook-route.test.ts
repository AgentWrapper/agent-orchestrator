import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createInitialCanonicalLifecycle,
  createActivitySignal,
  type Session,
  type SessionManager,
  type OrchestratorConfig,
  type PluginRegistry,
  type SCM,
  type LifecycleManager,
} from "@aoagents/ao-core";

// Activity event recording is mocked so we can assert what fires without
// touching the real SQLite layer.
const recordActivityEvent = vi.fn();
vi.mock("@aoagents/ao-core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    recordActivityEvent: (event: unknown) => recordActivityEvent(event),
  };
});

// ── Mock services + plugin registry ───────────────────────────────────

function makeSession(id: string, overrides: Partial<Session> = {}): Session {
  const lifecycle = createInitialCanonicalLifecycle("worker", new Date());
  lifecycle.session.state = "working";
  lifecycle.session.reason = "task_in_progress";
  lifecycle.session.startedAt = lifecycle.session.lastTransitionAt;
  lifecycle.runtime.state = "alive";
  lifecycle.runtime.reason = "process_running";
  return {
    id,
    projectId: "my-app",
    status: "working",
    activity: "active",
    activitySignal: createActivitySignal("valid", {
      activity: "active",
      timestamp: new Date(),
      source: "native",
    }),
    lifecycle,
    branch: "feat/x",
    issueId: null,
    pr: {
      number: 42,
      url: "u",
      title: "t",
      owner: "acme",
      repo: "my-app",
      branch: "feat/x",
      baseBranch: "main",
      isDraft: false,
    },
    workspacePath: null,
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

const verifyWebhook = vi.fn();
const parseWebhook = vi.fn();
const mockSCM: SCM = {
  name: "github",
  detectPR: vi.fn(),
  getPRState: vi.fn(),
  mergePR: vi.fn(),
  closePR: vi.fn(),
  getCIChecks: vi.fn(),
  getCISummary: vi.fn(),
  getReviews: vi.fn(),
  getReviewDecision: vi.fn(),
  getPendingComments: vi.fn(),
  getAutomatedComments: vi.fn(),
  getMergeability: vi.fn(),
  verifyWebhook,
  parseWebhook,
} as unknown as SCM;

const mockRegistry: PluginRegistry = {
  register: vi.fn(),
  get: vi.fn(() => mockSCM) as PluginRegistry["get"],
  list: vi.fn(() => []),
  loadBuiltins: vi.fn(),
  loadFromConfig: vi.fn(),
};

const mockConfig: OrchestratorConfig = {
  configPath: "/tmp/agent-orchestrator.yaml",
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
      scm: {
        plugin: "github",
        webhook: { enabled: true, path: "/api/webhooks/github", maxBodyBytes: 1024 },
      },
    },
  },
  notifiers: {},
  notificationRouting: { urgent: [], action: [], warning: [], info: [] },
  reactions: {},
};

const mockSessionManager = {
  list: vi.fn(async () => [makeSession("s1")]),
} as unknown as SessionManager;

const mockLifecycle = {
  check: vi.fn(async () => {}),
} as unknown as LifecycleManager;

vi.mock("@/lib/services", () => ({
  getServices: vi.fn(async () => ({
    config: mockConfig,
    registry: mockRegistry,
    sessionManager: mockSessionManager,
    lifecycleManager: mockLifecycle,
  })),
}));

import { POST as webhookPOST } from "@/app/api/webhooks/[...slug]/route";

function makeWebhookRequest(opts?: {
  body?: string;
  contentLength?: number;
  headers?: Record<string, string>;
}): Request {
  const body = opts?.body ?? JSON.stringify({ action: "synchronize", number: 42 });
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...opts?.headers,
  };
  if (opts?.contentLength !== undefined) {
    headers["content-length"] = String(opts.contentLength);
  }
  return new Request("http://localhost:3000/api/webhooks/github", {
    method: "POST",
    headers,
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  recordActivityEvent.mockClear();
  verifyWebhook.mockResolvedValue({ ok: true });
  parseWebhook.mockResolvedValue({
    provider: "github",
    kind: "pull_request",
    action: "synchronize",
    rawEventType: "pull_request",
    repository: { owner: "acme", name: "my-app" },
    prNumber: 42,
    branch: "feat/x",
    data: {},
  });
});

// ── Tests ─────────────────────────────────────────────────────────────

describe("POST /api/webhooks/[...slug] — activity events", () => {
  it("rejects unverified webhook with 401 and emits api.webhook_unverified", async () => {
    verifyWebhook.mockResolvedValueOnce({ ok: false, reason: "bad signature" });
    const req = makeWebhookRequest({
      headers: { "x-hub-signature-256": "sha256=bogus", "x-forwarded-for": "203.0.113.7" },
    });

    const res = await webhookPOST(req);
    expect(res.status).toBe(401);

    expect(recordActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "api",
        kind: "api.webhook_unverified",
        level: "warn",
      }),
    );
    const call = recordActivityEvent.mock.calls[0]![0] as {
      summary: string;
      data: Record<string, unknown>;
    };
    // Critical: signature value must NOT be in data (or anywhere)
    expect(JSON.stringify(call)).not.toContain("bogus");
    expect(call.data["slug"]).toBe("github");
    expect(call.data["remoteAddr"]).toBe("203.0.113.7");
    expect(call.data["verificationSupported"]).toBe(true);
    expect(call.data["reason"]).toBe("bad signature");
  });

  it("keeps unsupported webhook verification as 404 while recording audit context", async () => {
    vi.mocked(mockRegistry.get).mockReturnValueOnce({
      ...mockSCM,
      verifyWebhook: undefined,
    } as unknown as SCM);

    const res = await webhookPOST(makeWebhookRequest());
    expect(res.status).toBe(404);

    expect(verifyWebhook).not.toHaveBeenCalled();
    expect(parseWebhook).not.toHaveBeenCalled();
    expect(recordActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "api",
        kind: "api.webhook_unverified",
        level: "warn",
        summary: expect.stringContaining("verification unsupported"),
      }),
    );
    const call = recordActivityEvent.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(call.data["slug"]).toBe("github");
    expect(call.data["verificationSupported"]).toBe(false);
    expect(call.data["unsupportedVerificationCount"]).toBe(1);
    expect(call.data["reason"]).toBe("verification_unsupported");
  });

  it("emits api.webhook_rejected when content-length exceeds maxBodyBytes (413)", async () => {
    const req = makeWebhookRequest({ contentLength: 2048 }); // > 1024 max

    const res = await webhookPOST(req);
    expect(res.status).toBe(413);

    expect(recordActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "api",
        kind: "api.webhook_rejected",
        level: "warn",
      }),
    );
    const call = recordActivityEvent.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(call.data["slug"]).toBe("github");
    expect(call.data["contentLength"]).toBe(2048);
    expect(call.data["maxBodyBytes"]).toBe(1024);
    // No body content captured
    expect(JSON.stringify(call)).not.toContain("synchronize");
  });

  it("emits api.webhook_received with counts (not body) on 202 success", async () => {
    const req = makeWebhookRequest({
      headers: { "x-forwarded-for": "192.0.2.1" },
    });

    const res = await webhookPOST(req);
    expect(res.status).toBe(202);

    expect(recordActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "api",
        kind: "api.webhook_received",
      }),
    );
    const call = recordActivityEvent.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(call.data["slug"]).toBe("github");
    expect(call.data["remoteAddr"]).toBe("192.0.2.1");
    expect(call.data["matchedSessions"]).toBe(1);
    expect(call.data["parseErrorCount"]).toBe(0);
    expect(call.data["lifecycleErrorCount"]).toBe(0);
    expect(call.data["projectIds"]).toEqual(["my-app"]);
    // Critical: payload body is NOT included
    expect(JSON.stringify(call)).not.toContain("synchronize");
  });

  it("emits api.webhook_received with elevated level when parse/lifecycle errors occurred", async () => {
    parseWebhook.mockRejectedValueOnce(new Error("boom"));
    // Verification passes so we get into the parse path
    verifyWebhook.mockResolvedValueOnce({ ok: true });

    const res = await webhookPOST(makeWebhookRequest());
    expect(res.status).toBe(202);

    const received = recordActivityEvent.mock.calls.find(
      ([e]) => (e as { kind: string }).kind === "api.webhook_received",
    );
    expect(received).toBeDefined();
    expect((received![0] as { level: string }).level).toBe("warn");
    expect((received![0] as { data: Record<string, unknown> }).data["parseErrorCount"]).toBe(1);
  });

  it("emits api.webhook_failed on 500 outer crash", async () => {
    // Force the list() call inside POST to throw, hitting the outer catch.
    (mockSessionManager.list as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("session manager exploded"),
    );

    const res = await webhookPOST(makeWebhookRequest());
    expect(res.status).toBe(500);

    expect(recordActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "api",
        kind: "api.webhook_failed",
        level: "error",
      }),
    );
    const call = recordActivityEvent.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(call.data["slug"]).toBe("github");
    expect(call.data["errorMessage"]).toContain("session manager exploded");
  });

  it("does not emit any event for 404 (unknown path)", async () => {
    // Empty config so no candidates match
    vi.mocked(mockRegistry.get).mockReturnValueOnce(undefined as unknown as SCM);
    const req = new Request("http://localhost:3000/api/webhooks/unknown", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    const res = await webhookPOST(req);
    expect(res.status).toBe(404);
    // No webhook events for 404 — it's a config issue, not an external signal
    const kinds = recordActivityEvent.mock.calls.map(([e]) => (e as { kind: string }).kind);
    expect(kinds.filter((k) => k.startsWith("api.webhook_"))).toEqual([]);
  });
});
