import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockLoadConfig,
  mockGetGlobalConfigPath,
  MockConfigNotFoundError,
  mockRegister,
  mockCreateSessionManager,
  mockRegistry,
  mockIsOrchestratorSession,
  tmuxPlugin,
  claudePlugin,
  codexPlugin,
  opencodePlugin,
  worktreePlugin,
  scmPlugin,
  trackerGithubPlugin,
  trackerLinearPlugin,
} = vi.hoisted(() => {
  const mockLoadConfig = vi.fn();
  const mockGetGlobalConfigPath = vi.fn();
  class MockConfigNotFoundError extends Error {
    constructor(message?: string) {
      super(message ?? "Config not found");
      this.name = "ConfigNotFoundError";
    }
  }
  const mockRegister = vi.fn();
  const mockCreateSessionManager = vi.fn();
  const mockIsOrchestratorSession = vi.fn();
  const mockRegistry = {
    register: mockRegister,
    get: vi.fn(),
    list: vi.fn(),
    loadBuiltins: vi.fn(),
    loadFromConfig: vi.fn(),
  };

  return {
    mockLoadConfig,
    mockGetGlobalConfigPath,
    MockConfigNotFoundError,
    mockRegister,
    mockCreateSessionManager,
    mockRegistry,
    mockIsOrchestratorSession,
    tmuxPlugin: { manifest: { name: "tmux" } },
    claudePlugin: { manifest: { name: "claude-code" } },
    codexPlugin: { manifest: { name: "codex" } },
    opencodePlugin: { manifest: { name: "opencode" } },
    worktreePlugin: { manifest: { name: "worktree" } },
    scmPlugin: { manifest: { name: "github" } },
    trackerGithubPlugin: { manifest: { name: "github" } },
    trackerLinearPlugin: { manifest: { name: "linear" } },
  };
});

vi.mock("@aoagents/ao-core", () => ({
  loadConfig: mockLoadConfig,
  getGlobalConfigPath: mockGetGlobalConfigPath,
  ConfigNotFoundError: MockConfigNotFoundError,
  createPluginRegistry: () => mockRegistry,
  createSessionManager: mockCreateSessionManager,
  createLifecycleManager: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    getStates: vi.fn(),
    check: vi.fn(),
  }),
  isOrchestratorSession: mockIsOrchestratorSession,
  TERMINAL_STATUSES: new Set([
    "merged",
    "killed",
    "terminated",
    "done",
    "cleanup",
    "errored",
  ]) as ReadonlySet<string>,
}));

vi.mock("@aoagents/ao-plugin-runtime-tmux", () => ({ default: tmuxPlugin }));
vi.mock("@aoagents/ao-plugin-agent-claude-code", () => ({ default: claudePlugin }));
vi.mock("@aoagents/ao-plugin-agent-codex", () => ({ default: codexPlugin }));
vi.mock("@aoagents/ao-plugin-agent-opencode", () => ({ default: opencodePlugin }));
vi.mock("@aoagents/ao-plugin-workspace-worktree", () => ({ default: worktreePlugin }));
vi.mock("@aoagents/ao-plugin-scm-github", () => ({ default: scmPlugin }));
vi.mock("@aoagents/ao-plugin-tracker-github", () => ({ default: trackerGithubPlugin }));
vi.mock("@aoagents/ao-plugin-tracker-linear", () => ({ default: trackerLinearPlugin }));

type ServicesGlobal = typeof globalThis & {
  _aoServices?: unknown;
  _aoServicesInit?: unknown;
  _aoBacklogStarted?: boolean;
  _aoBacklogTimer?: ReturnType<typeof setInterval>;
  _aoBacklogPollInFlight?: Promise<void>;
  _aoBacklogClaimingIssues?: Set<string>;
};

function clearServiceGlobals(): void {
  const globalForServices = globalThis as ServicesGlobal;
  if (globalForServices._aoBacklogTimer) {
    clearInterval(globalForServices._aoBacklogTimer);
  }
  delete globalForServices._aoServices;
  delete globalForServices._aoServicesInit;
  delete globalForServices._aoBacklogStarted;
  delete globalForServices._aoBacklogTimer;
  delete globalForServices._aoBacklogPollInFlight;
  delete globalForServices._aoBacklogClaimingIssues;
}

describe("services", () => {
  beforeEach(() => {
    vi.resetModules();
    mockRegister.mockClear();
    mockRegistry.get.mockReset();
    mockCreateSessionManager.mockReset();
    mockIsOrchestratorSession.mockReset();
    mockIsOrchestratorSession.mockReturnValue(false);
    mockLoadConfig.mockReset();
    mockGetGlobalConfigPath.mockReset();
    mockGetGlobalConfigPath.mockReturnValue("/tmp/global-config.yaml");
    mockLoadConfig.mockReturnValue({
      configPath: "/tmp/agent-orchestrator.yaml",
      port: 3000,
      readyThresholdMs: 300_000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: {},
      notifiers: {},
      notificationRouting: { urgent: [], action: [], warning: [], info: [] },
      reactions: {},
    });
    mockCreateSessionManager.mockReturnValue({});
    clearServiceGlobals();
  });

  afterEach(() => {
    clearServiceGlobals();
  });

  it("registers the OpenCode agent plugin with web services", async () => {
    const { getServices } = await import("../lib/services");

    await getServices();

    expect(mockRegister).toHaveBeenCalledWith(opencodePlugin);
  });

  it("registers the Codex agent plugin with web services", async () => {
    const { getServices } = await import("../lib/services");

    await getServices();

    expect(mockRegister).toHaveBeenCalledWith(codexPlugin);
  });

  it("caches initialized services across repeated calls", async () => {
    const { getServices } = await import("../lib/services");

    const first = await getServices();
    const second = await getServices();

    expect(first).toBe(second);
    expect(mockCreateSessionManager).toHaveBeenCalledTimes(1);
  });

  it("loads config from the canonical global config path", async () => {
    const { getServices } = await import("../lib/services");

    await getServices();

    expect(mockGetGlobalConfigPath).toHaveBeenCalledTimes(1);
    expect(mockLoadConfig).toHaveBeenCalledWith("/tmp/global-config.yaml");
  });

  it("falls back to discovered config when the canonical global config is missing", async () => {
    mockLoadConfig
      .mockImplementationOnce(() => {
        const error = new Error("ENOENT: no such file or directory");
        (error as Error & { code?: string }).code = "ENOENT";
        throw error;
      })
      .mockReturnValueOnce({
        configPath: "/tmp/local/agent-orchestrator.yaml",
        port: 3000,
        readyThresholdMs: 300_000,
        defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
        projects: {},
        notifiers: {},
        notificationRouting: { urgent: [], action: [], warning: [], info: [] },
        reactions: {},
      });

    const { getServices } = await import("../lib/services");

    await getServices();

    expect(mockLoadConfig).toHaveBeenNthCalledWith(1, "/tmp/global-config.yaml");
    expect(mockLoadConfig).toHaveBeenNthCalledWith(2);
  });
});

describe("pollBacklog", () => {
  const mockUpdateIssue = vi.fn();
  const mockListIssues = vi.fn();
  const mockListReopenedIssues = vi.fn();
  const mockListSessions = vi.fn();
  const mockSpawn = vi.fn();

  function backlogIssue(id: string) {
    return {
      id,
      title: `Test Issue ${id}`,
      description: "Test description",
      url: `https://github.com/test/test/issues/${id}`,
      state: "open",
      labels: ["agent:backlog"],
    };
  }

  function configureBacklogRegistry(): void {
    mockRegistry.get.mockImplementation((slot: string) => {
      if (slot === "tracker") {
        return {
          name: "github",
          listIssues: vi.fn((query, project) => {
            if (query?.labels?.includes("agent:done")) {
              return mockListReopenedIssues(query, project);
            }
            return mockListIssues(query, project);
          }),
          updateIssue: mockUpdateIssue,
        };
      }
      if (slot === "agent") {
        return { name: "claude-code" };
      }
      if (slot === "runtime") {
        return { name: "tmux" };
      }
      if (slot === "workspace") {
        return { name: "worktree" };
      }
      return null;
    });
  }

  beforeEach(async () => {
    vi.resetModules();
    mockRegister.mockClear();
    mockRegistry.get.mockReset();
    mockCreateSessionManager.mockReset();
    mockIsOrchestratorSession.mockReset();
    mockIsOrchestratorSession.mockReturnValue(false);
    mockLoadConfig.mockReset();
    mockUpdateIssue.mockClear();
    mockListIssues.mockClear();
    mockListReopenedIssues.mockClear();
    mockListSessions.mockClear();
    mockSpawn.mockClear();
    mockListSessions.mockResolvedValue([]);
    mockListIssues.mockResolvedValue([]);
    mockListReopenedIssues.mockResolvedValue([]);
    mockUpdateIssue.mockResolvedValue(undefined);
    mockSpawn.mockResolvedValue(undefined);

    mockLoadConfig.mockReturnValue({
      configPath: "/tmp/agent-orchestrator.yaml",
      port: 3000,
      readyThresholdMs: 300_000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: {
        "test-project": {
          path: "/tmp/test-project",
          tracker: { plugin: "github" },
          backlog: { label: "agent:backlog", maxConcurrent: 5 },
        },
      },
      notifiers: {},
      notificationRouting: { urgent: [], action: [], warning: [], info: [] },
      reactions: {},
    });

    mockCreateSessionManager.mockReturnValue({
      spawn: mockSpawn,
      list: mockListSessions,
    });

    clearServiceGlobals();
  });

  afterEach(() => {
    clearServiceGlobals();
  });

  it("removes agent:backlog label when claiming an issue", async () => {
    mockListIssues.mockResolvedValue([backlogIssue("123")]);
    configureBacklogRegistry();

    const { pollBacklog } = await import("../lib/services");
    await pollBacklog();

    expect(mockUpdateIssue).toHaveBeenCalledWith(
      "123",
      {
        labels: ["agent:in-progress"],
        removeLabels: ["agent:backlog"],
        comment: "Claimed by agent orchestrator — session spawned.",
      },
      expect.objectContaining({ tracker: { plugin: "github" } }),
    );
  });

  it("deduplicates concurrent backlog polls", async () => {
    mockListIssues.mockResolvedValue([backlogIssue("123")]);
    mockSpawn.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 10)));
    configureBacklogRegistry();

    const { pollBacklog } = await import("../lib/services");
    await Promise.all([pollBacklog(), pollBacklog()]);

    expect(mockListIssues).toHaveBeenCalledTimes(1);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockUpdateIssue).toHaveBeenCalledTimes(1);
  });

  it("does not spawn more sessions than available capacity", async () => {
    mockListSessions.mockResolvedValue([
      {
        id: "s1",
        projectId: "test-project",
        issueId: "900",
        status: "working",
        lifecycle: { pr: { state: "none" } },
      },
      {
        id: "s2",
        projectId: "test-project",
        issueId: "901",
        status: "ci_failed",
        lifecycle: { pr: { state: "none" } },
      },
      {
        id: "s3",
        projectId: "test-project",
        issueId: "902",
        status: "mergeable",
        lifecycle: { pr: { state: "none" } },
      },
    ]);
    mockListIssues.mockResolvedValue([
      backlogIssue("100"),
      backlogIssue("101"),
      backlogIssue("102"),
    ]);
    configureBacklogRegistry();

    const { pollBacklog } = await import("../lib/services");
    await pollBacklog();

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(mockSpawn).toHaveBeenNthCalledWith(1, {
      projectId: "test-project",
      issueId: "100",
    });
    expect(mockSpawn).toHaveBeenNthCalledWith(2, {
      projectId: "test-project",
      issueId: "101",
    });
    expect(mockUpdateIssue).toHaveBeenCalledTimes(2);
  });

  it("deduplicates active backlog issues per project", async () => {
    mockLoadConfig.mockReturnValue({
      configPath: "/tmp/agent-orchestrator.yaml",
      port: 3000,
      readyThresholdMs: 300_000,
      defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
      projects: {
        "test-project": {
          path: "/tmp/test-project",
          tracker: { plugin: "github" },
          backlog: { label: "agent:backlog", maxConcurrent: 5 },
        },
        "other-project": {
          path: "/tmp/other-project",
          tracker: { plugin: "github" },
          backlog: { label: "agent:backlog", maxConcurrent: 5 },
        },
      },
      notifiers: {},
      notificationRouting: { urgent: [], action: [], warning: [], info: [] },
      reactions: {},
    });
    mockListSessions.mockResolvedValue([
      {
        id: "other-1",
        projectId: "other-project",
        issueId: "123",
        status: "working",
        lifecycle: { pr: { state: "none" } },
      },
    ]);
    mockListIssues.mockImplementation((_query, project) =>
      project.path === "/tmp/test-project" ? [backlogIssue("123")] : [],
    );
    configureBacklogRegistry();

    const { pollBacklog } = await import("../lib/services");
    await pollBacklog();

    expect(mockSpawn).toHaveBeenCalledWith({
      projectId: "test-project",
      issueId: "123",
    });
    expect(mockUpdateIssue).toHaveBeenCalledWith(
      "123",
      expect.objectContaining({ removeLabels: ["agent:backlog"] }),
      expect.objectContaining({ path: "/tmp/test-project" }),
    );
  });

  it("releases transient issue claims when a spawn fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockListIssues.mockResolvedValue([backlogIssue("123")]);
    mockSpawn
      .mockRejectedValueOnce(new Error("worktree already exists"))
      .mockResolvedValueOnce(undefined);
    configureBacklogRegistry();

    try {
      const { pollBacklog } = await import("../lib/services");
      await pollBacklog();
      await pollBacklog();

      expect(mockSpawn).toHaveBeenCalledTimes(2);
      expect(mockUpdateIssue).toHaveBeenCalledTimes(1);
    } finally {
      consoleError.mockRestore();
    }
  });
});
