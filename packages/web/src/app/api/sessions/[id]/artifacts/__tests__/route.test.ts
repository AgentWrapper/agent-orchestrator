import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hoisted mock for the services singleton so the route can resolve a session
// without spinning up the real plugin registry or session manager.
const { mockSessionManager, mockConfig } = vi.hoisted(() => ({
  mockSessionManager: { get: vi.fn() },
  mockConfig: {
    defaults: { runtime: "tmux", agent: "claude-code", scm: "github", tracker: "github" },
    projects: {
      "my-app": { defaultBranch: "main", path: "/tmp/repo", runtime: "tmux", agent: "claude-code" },
    },
    notifiers: {},
    notificationRouting: { urgent: [], action: [], warning: [], info: [] },
    reactions: {},
  },
}));

vi.mock("@/lib/services", () => ({
  getServices: vi.fn(async () => ({
    config: mockConfig,
    sessionManager: mockSessionManager,
  })),
}));

let testHome: string;
let originalHome: string | undefined;

beforeEach(async () => {
  testHome = await mkdtemp(join(tmpdir(), "ao-route-artifacts-"));
  originalHome = process.env.HOME;
  process.env.HOME = testHome;
  mockSessionManager.get.mockReset();
});

afterEach(async () => {
  process.env.HOME = originalHome;
  await rm(testHome, { recursive: true, force: true });
  vi.clearAllMocks();
});

function makeSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "s",
    projectId: "my-app",
    status: "working",
    workspacePath: null,
    runtimeHandle: null,
    activity: "active",
    activitySignal: {
      activity: "active",
      timestamp: new Date(),
      source: "native",
      confidence: "high",
    },
    lifecycle: undefined,
    branch: null,
    issueId: null,
    pr: null,
    agentInfo: null,
    createdAt: new Date(),
    lastActivityAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

describe("GET /api/sessions/[id]/artifacts", () => {
  it("returns empty array when session does not exist", async () => {
    mockSessionManager.get.mockResolvedValue(null);
    const { GET } = await import("../route.js");
    const response = await GET(new Request("http://x/api/sessions/s/artifacts"), {
      params: Promise.resolve({ id: "s" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ artifacts: [] });
  });

  it("returns empty array when project is missing from config", async () => {
    mockSessionManager.get.mockResolvedValue(makeSession({ projectId: "unknown-project" }));
    const { GET } = await import("../route.js");
    const response = await GET(new Request("http://x/api/sessions/s/artifacts"), {
      params: Promise.resolve({ id: "s" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ artifacts: [] });
  });

  it("returns empty array when no artifacts exist on disk", async () => {
    mockSessionManager.get.mockResolvedValue(makeSession());
    const { GET } = await import("../route.js");
    const response = await GET(new Request("http://x/api/sessions/s/artifacts"), {
      params: Promise.resolve({ id: "s" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ artifacts: [] });
  });

  it("returns artifacts sorted by updatedAt desc", async () => {
    mockSessionManager.get.mockResolvedValue(makeSession());
    const { writeCanonicalArtifact } = await import("@aoagents/ao-core");
    await writeCanonicalArtifact("my-app", "s", {
      version: 1,
      id: "a",
      type: "markdown",
      title: "A",
      createdAt: "2026-05-13T10:00:00.000Z",
      updatedAt: "2026-05-13T10:00:00.000Z",
      source: "agent",
      payload: { markdown: "a" },
    });
    await writeCanonicalArtifact("my-app", "s", {
      version: 1,
      id: "b",
      type: "markdown",
      title: "B",
      createdAt: "2026-05-13T11:00:00.000Z",
      updatedAt: "2026-05-13T11:00:00.000Z",
      source: "agent",
      payload: { markdown: "b" },
    });

    const { GET } = await import("../route.js");
    const response = await GET(new Request("http://x/api/sessions/s/artifacts"), {
      params: Promise.resolve({ id: "s" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { artifacts: Array<{ id: string }> };
    expect(body.artifacts.map((c) => c.id)).toEqual(["b", "a"]);
  });
});
