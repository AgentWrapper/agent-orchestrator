import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionManager } from "@aoagents/ao-core";
import type { AgentSession, AgentStatus } from "@aoagents/agentmesh-core";
import {
  AdapterRegistry,
  AiderAdapter,
  ClaudeCodeAdapter,
  CodexAdapter,
  CursorAdapter,
  DevinAdapter,
  GeminiAdapter,
  KimiCodeAdapter,
  OpenCodeAdapter,
} from "./index.js";

function createSessionManagerMock() {
  return {
    spawn: vi.fn(),
    send: vi.fn(),
    get: vi.fn(),
    kill: vi.fn(),
  };
}

function asSessionManager(mock: ReturnType<typeof createSessionManagerMock>): SessionManager {
  return mock as unknown as SessionManager;
}

describe("AdapterRegistry", () => {
  it("registers all built-in adapters", () => {
    const registry = new AdapterRegistry();

    expect(new Set(registry.list())).toEqual(
      new Set([
        "claude-code",
        "codex",
        "devin",
        "cursor",
        "aider",
        "gemini",
        "opencode",
        "kimicode",
      ]),
    );
  });

  it("instantiates each built-in adapter", () => {
    const registry = new AdapterRegistry();
    const sessionManager = asSessionManager(createSessionManagerMock());

    expect(registry.get("claude-code", sessionManager)).toBeInstanceOf(ClaudeCodeAdapter);
    expect(registry.get("codex", sessionManager)).toBeInstanceOf(CodexAdapter);
    expect(registry.get("devin", sessionManager)).toBeInstanceOf(DevinAdapter);
    expect(registry.get("cursor", sessionManager)).toBeInstanceOf(CursorAdapter);
    expect(registry.get("aider", sessionManager)).toBeInstanceOf(AiderAdapter);
    expect(registry.get("gemini", sessionManager)).toBeInstanceOf(GeminiAdapter);
    expect(registry.get("opencode", sessionManager)).toBeInstanceOf(OpenCodeAdapter);
    expect(registry.get("kimicode", sessionManager)).toBeInstanceOf(KimiCodeAdapter);
    expect(registry.get("missing", sessionManager)).toBeNull();
  });
});

describe("ClaudeCodeAdapter", () => {
  it("spawns an AgentMesh session and sends the role prompt", async () => {
    const sessionManager = createSessionManagerMock();
    sessionManager.spawn.mockResolvedValue({ id: "ao-claude-1" });
    const adapter = new ClaudeCodeAdapter(asSessionManager(sessionManager));

    const session = await adapter.start({
      taskId: "TASK-101",
      role: "builder",
      prompt: "Implement the regression fix",
      workspacePath: "C:/repo",
      branch: "feat/regression-fix",
    });

    expect(sessionManager.spawn).toHaveBeenCalledWith({
      projectId: "agentmesh",
      issueId: "TASK-101",
      branch: "feat/regression-fix",
    });
    expect(sessionManager.send).toHaveBeenCalledTimes(1);
    expect(sessionManager.send).toHaveBeenCalledWith(
      "ao-claude-1",
      expect.stringContaining("You are a Builder agent."),
    );
    expect(sessionManager.send).toHaveBeenCalledWith(
      "ao-claude-1",
      expect.stringContaining("TASK:\nImplement the regression fix"),
    );
    expect(session).toMatchObject({
      aoSessionId: "ao-claude-1",
      taskId: "TASK-101",
      role: "builder",
    });
    expect(session.startedAt).toBeInstanceOf(Date);
  });
});

describe("CodexAdapter", () => {
  it("formats attachments when sending follow-up messages", async () => {
    const sessionManager = createSessionManagerMock();
    const adapter = new CodexAdapter(asSessionManager(sessionManager));

    await adapter.sendMessage(
      {
        aoSessionId: "ao-codex-1",
        taskId: "TASK-202",
        role: "qa",
        startedAt: new Date(),
      },
      {
        type: "qa_request",
        body: "Please re-run the QA pass",
        attachments: {
          pr: "#42",
          commit: "abc123",
        },
      },
    );

    expect(sessionManager.send).toHaveBeenCalledWith(
      "ao-codex-1",
      "Please re-run the QA pass\n\nAttachments:\npr: #42\ncommit: abc123\n",
    );
  });

  it.each<[string | null, AgentStatus]>([
    ["working", "active"],
    ["idle", "idle"],
    ["needs_input", "waiting_input"],
    ["stuck", "blocked"],
    ["done", "exited"],
    ["terminated", "exited"],
    ["spawning", "ready"],
    [null, "exited"],
  ])("maps AO status %s to %s", async (aoStatus, expected) => {
    const sessionManager = createSessionManagerMock();
    sessionManager.get.mockResolvedValue(aoStatus ? { status: aoStatus } : null);
    const adapter = new CodexAdapter(asSessionManager(sessionManager));

    const status = await adapter.getStatus({
      aoSessionId: "ao-codex-2",
      taskId: "TASK-203",
      role: "qa",
      startedAt: new Date(),
    });

    expect(status).toBe(expected);
  });
});

describe("DevinAdapter", () => {
  const originalGithubToken = process.env.GITHUB_TOKEN;

  beforeEach(() => {
    delete process.env.GITHUB_TOKEN;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalGithubToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = originalGithubToken;
    }
  });

  it("fails preflight when no GitHub token is configured", async () => {
    const adapter = new DevinAdapter(asSessionManager(createSessionManagerMock()));

    await expect(
      adapter.preflight({ role: "external_reviewer", workspacePath: "C:/repo" }),
    ).resolves.toEqual({
      ok: false,
      warnings: ["GitHub token not found. Set GITHUB_TOKEN environment variable."],
    });
  });

  it("creates a tracking AO session after opening a GitHub issue", async () => {
    const sessionManager = createSessionManagerMock();
    sessionManager.spawn.mockResolvedValue({ id: "ao-devin-1" });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ number: 42 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new DevinAdapter(asSessionManager(sessionManager), "gh-test-token");

    const session = await adapter.start({
      taskId: "TASK-204",
      role: "async_builder",
      prompt: "Build the async workflow integration",
      workspacePath: "C:/repo",
      branch: "feat/devin-workflow",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/issues",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer gh-test-token",
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
        }),
      }),
    );

    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(requestInit.body))).toMatchObject({
      labels: ["async_builder", "devin", "agentmesh"],
      assignee: "devin",
    });

    expect(sessionManager.spawn).toHaveBeenCalledWith({
      projectId: "agentmesh",
      issueId: "GH-42",
      branch: "feat/devin-workflow",
    });
    expect(session).toMatchObject({
      aoSessionId: "ao-devin-1",
      taskId: "TASK-204",
      role: "async_builder",
    });
    expect(session.startedAt).toBeInstanceOf(Date);
  });

  it("summarizes the backing GitHub issue from the AO session", async () => {
    const sessionManager = createSessionManagerMock();
    sessionManager.get.mockResolvedValue({ issueId: "GH-42" });
    const adapter = new DevinAdapter(asSessionManager(sessionManager), "gh-test-token");
    const session: AgentSession = {
      aoSessionId: "ao-devin-2",
      taskId: "TASK-205",
      role: "pr_fixer",
      startedAt: new Date(),
    };

    await expect(adapter.getSessionInfo(session)).resolves.toEqual({
      summary: "GitHub Issue GH-42",
      costUsd: undefined,
      tokensUsed: undefined,
      turnsCompleted: undefined,
    });
  });
});
