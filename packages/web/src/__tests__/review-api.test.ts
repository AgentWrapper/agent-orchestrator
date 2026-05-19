import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createActivitySignal,
  createInitialCanonicalLifecycle,
  createCodeReviewStore,
  type OrchestratorConfig,
  type Session,
  type SessionManager,
} from "@aoagents/ao-core";

const { mockConfig, mockSessionManager } = vi.hoisted(() => ({
  mockConfig: {
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
  } satisfies OrchestratorConfig,
  mockSessionManager: {
    get: vi.fn(),
    list: vi.fn(),
    spawn: vi.fn(),
    spawnOrchestrator: vi.fn(),
    ensureOrchestrator: vi.fn(),
    relaunchOrchestrator: vi.fn(),
    restore: vi.fn(),
    kill: vi.fn(),
    cleanup: vi.fn(),
    send: vi.fn(),
    claimPR: vi.fn(),
  } satisfies SessionManager,
}));

vi.mock("@/lib/services", () => ({
  getServices: vi.fn(async () => ({
    config: mockConfig,
    sessionManager: mockSessionManager,
  })),
}));

function makeRequest(url: string, init?: RequestInit): NextRequest {
  return new NextRequest(
    new URL(url, "http://localhost:3000"),
    init as ConstructorParameters<typeof NextRequest>[1],
  );
}

function makeSession(overrides: Partial<Session> = {}): Session {
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
    workspacePath: null,
    runtimeHandle: { id: "tmux-app-1", runtimeName: "tmux", data: {} },
    agentInfo: null,
    createdAt: new Date("2026-05-10T09:00:00.000Z"),
    lastActivityAt: new Date("2026-05-10T10:00:00.000Z"),
    metadata: {},
    ...overrides,
  };
}

import { POST } from "@/app/api/reviews/route";
import { POST as POST_EXECUTE } from "@/app/api/reviews/execute/route";
import { GET as GET_FINDINGS } from "@/app/api/reviews/findings/route";
import { POST as POST_SEND } from "@/app/api/reviews/send/route";

let tmpHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "ao-web-review-api-"));
  originalHome = process.env["HOME"];
  process.env["HOME"] = tmpHome;
  createCodeReviewStore("app").deleteAll();
  mockSessionManager.get.mockReset();
  mockSessionManager.get.mockResolvedValue(makeSession());
});

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env["HOME"];
  } else {
    process.env["HOME"] = originalHome;
  }
  rmSync(tmpHome, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("POST /api/reviews", () => {
  it("requests a review run for a worker session", async () => {
    const response = await POST(
      makeRequest("/api/reviews", {
        method: "POST",
        body: JSON.stringify({ sessionId: "app-1" }),
      }),
    );

    expect(response.status).toBe(201);
    const payload = (await response.json()) as {
      run: { linkedSessionId: string; reviewerSessionId: string; status: string };
    };
    expect(payload.run).toMatchObject({
      linkedSessionId: "app-1",
      reviewerSessionId: "app-rev-1",
      status: "queued",
    });
    expect(createCodeReviewStore("app").listRuns()).toHaveLength(1);
  });

  it("returns 400 when a session belongs to an unknown project", async () => {
    mockSessionManager.get.mockResolvedValueOnce(makeSession({ projectId: "missing-project" }));

    const response = await POST(
      makeRequest("/api/reviews", {
        method: "POST",
        body: JSON.stringify({ sessionId: "app-1" }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Unknown project for session app-1: missing-project",
    });
  });

  it("returns 400 when a review is requested for an orchestrator session", async () => {
    mockSessionManager.get.mockResolvedValueOnce(
      makeSession({ id: "app-orchestrator", metadata: { role: "orchestrator" } }),
    );

    const response = await POST(
      makeRequest("/api/reviews", {
        method: "POST",
        body: JSON.stringify({ sessionId: "app-orchestrator" }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Cannot request code review for orchestrator session: app-orchestrator",
    });
  });
});

describe("GET /api/reviews/findings", () => {
  it("returns stored findings for a review run", async () => {
    const store = createCodeReviewStore("app");
    const run = store.createRun({
      linkedSessionId: "app-1",
      reviewerSessionId: "app-rev-1",
    });
    store.createFinding({
      runId: run.id,
      linkedSessionId: "app-1",
      severity: "warning",
      title: "Missing empty state",
      body: "The todo list should render a clear empty state.",
      filePath: "src/App.tsx",
      startLine: 12,
    });

    const response = await GET_FINDINGS(
      makeRequest(`/api/reviews/findings?projectId=app&runId=${run.id}`),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      run: { id: string };
      findings: Array<{ title: string; filePath: string }>;
    };
    expect(payload.run.id).toBe(run.id);
    expect(payload.findings).toEqual([
      expect.objectContaining({
        title: "Missing empty state",
        filePath: "src/App.tsx",
      }),
    ]);
  });
});

describe("POST /api/reviews/send", () => {
  it("sends open findings to the linked worker session", async () => {
    const store = createCodeReviewStore("app");
    const run = store.createRun({
      linkedSessionId: "app-1",
      reviewerSessionId: "app-rev-1",
      status: "needs_triage",
      prNumber: 7,
    });
    const finding = store.createFinding({
      runId: run.id,
      linkedSessionId: "app-1",
      severity: "warning",
      title: "Missing empty state",
      body: "The todo list should render a clear empty state.",
      filePath: "src/App.tsx",
      startLine: 12,
    });

    const response = await POST_SEND(
      makeRequest("/api/reviews/send", {
        method: "POST",
        body: JSON.stringify({ projectId: "app", runId: run.id }),
      }),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      run: { status: string; sentFindingCount: number; openFindingCount: number };
      sentFindingCount: number;
      message: string;
    };
    expect(payload.sentFindingCount).toBe(1);
    expect(payload.run).toMatchObject({
      status: "waiting_update",
      sentFindingCount: 1,
      openFindingCount: 0,
    });
    expect(payload.message).toContain("Missing empty state");
    expect(mockSessionManager.send).toHaveBeenCalledWith(
      "app-1",
      expect.stringContaining("Missing empty state"),
    );
    expect(store.getFinding(finding.id)).toMatchObject({ status: "sent_to_agent" });
  });

  it("returns 409 when there are no open findings to send", async () => {
    const store = createCodeReviewStore("app");
    const run = store.createRun({
      linkedSessionId: "app-1",
      reviewerSessionId: "app-rev-1",
      status: "clean",
    });

    const response = await POST_SEND(
      makeRequest("/api/reviews/send", {
        method: "POST",
        body: JSON.stringify({ projectId: "app", runId: run.id }),
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "No open review findings to send for app-rev-1.",
    });
    expect(mockSessionManager.send).not.toHaveBeenCalled();
  });
});

describe("POST /api/reviews/execute", () => {
  it("returns 404 when the review run does not exist", async () => {
    const response = await POST_EXECUTE(
      makeRequest("/api/reviews/execute", {
        method: "POST",
        body: JSON.stringify({ projectId: "app", runId: "review-run-missing" }),
      }),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: "Code review run not found: review-run-missing",
    });
  });

  it("returns 409 when the review run is not executable", async () => {
    const store = createCodeReviewStore("app");
    const run = store.createRun({
      linkedSessionId: "app-1",
      reviewerSessionId: "app-rev-1",
      status: "running",
    });

    const response = await POST_EXECUTE(
      makeRequest("/api/reviews/execute", {
        method: "POST",
        body: JSON.stringify({ projectId: "app", runId: run.id }),
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "Code review run app-rev-1 is running, not queued",
    });
  });
});
