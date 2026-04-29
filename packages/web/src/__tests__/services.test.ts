import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockLoadConfig,
  mockGetGlobalConfigPath,
  MockConfigNotFoundError,
  mockRegister,
  mockCreateSessionManager,
  mockRegistry,
  tmuxPlugin,
  processPlugin,
  aiderPlugin,
  claudePlugin,
  codexPlugin,
  cursorPlugin,
  opencodePlugin,
  worktreePlugin,
  clonePlugin,
  scmPlugin,
  scmGitlabPlugin,
  terminalIterm2Plugin,
  terminalWebPlugin,
  trackerGithubPlugin,
  trackerGitlabPlugin,
  trackerLinearPlugin,
  notifierComposioPlugin,
  notifierDesktopPlugin,
  notifierDiscordPlugin,
  notifierOpenClawPlugin,
  notifierSlackPlugin,
  notifierWebhookPlugin,
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
    tmuxPlugin: { manifest: { name: "tmux" } },
    processPlugin: { manifest: { name: "process" } },
    aiderPlugin: { manifest: { name: "aider" } },
    claudePlugin: { manifest: { name: "claude-code" } },
    codexPlugin: { manifest: { name: "codex" } },
    cursorPlugin: { manifest: { name: "cursor" } },
    opencodePlugin: { manifest: { name: "opencode" } },
    worktreePlugin: { manifest: { name: "worktree" } },
    clonePlugin: { manifest: { name: "clone" } },
    scmPlugin: { manifest: { name: "github" } },
    scmGitlabPlugin: { manifest: { name: "gitlab" } },
    terminalIterm2Plugin: { manifest: { name: "iterm2" } },
    terminalWebPlugin: { manifest: { name: "web" } },
    trackerGithubPlugin: { manifest: { name: "github" } },
    trackerGitlabPlugin: { manifest: { name: "gitlab" } },
    trackerLinearPlugin: { manifest: { name: "linear" } },
    notifierComposioPlugin: { manifest: { name: "composio" } },
    notifierDesktopPlugin: { manifest: { name: "desktop" } },
    notifierDiscordPlugin: { manifest: { name: "discord" } },
    notifierOpenClawPlugin: { manifest: { name: "openclaw" } },
    notifierSlackPlugin: { manifest: { name: "slack" } },
    notifierWebhookPlugin: { manifest: { name: "webhook" } },
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
  TERMINAL_STATUSES: new Set(["merged", "killed"]) as ReadonlySet<string>,
}));

vi.mock("@aoagents/ao-plugin-runtime-tmux", () => ({ default: tmuxPlugin }));
vi.mock("@aoagents/ao-plugin-runtime-process", () => ({ default: processPlugin }));
vi.mock("@aoagents/ao-plugin-agent-aider", () => ({ default: aiderPlugin }));
vi.mock("@aoagents/ao-plugin-agent-claude-code", () => ({ default: claudePlugin }));
vi.mock("@aoagents/ao-plugin-agent-codex", () => ({ default: codexPlugin }));
vi.mock("@aoagents/ao-plugin-agent-cursor", () => ({ default: cursorPlugin }));
vi.mock("@aoagents/ao-plugin-agent-opencode", () => ({ default: opencodePlugin }));
vi.mock("@aoagents/ao-plugin-workspace-worktree", () => ({ default: worktreePlugin }));
vi.mock("@aoagents/ao-plugin-workspace-clone", () => ({ default: clonePlugin }));
vi.mock("@aoagents/ao-plugin-scm-github", () => ({ default: scmPlugin }));
vi.mock("@aoagents/ao-plugin-scm-gitlab", () => ({ default: scmGitlabPlugin }));
vi.mock("@aoagents/ao-plugin-terminal-iterm2", () => ({ default: terminalIterm2Plugin }));
vi.mock("@aoagents/ao-plugin-terminal-web", () => ({ default: terminalWebPlugin }));
vi.mock("@aoagents/ao-plugin-tracker-github", () => ({ default: trackerGithubPlugin }));
vi.mock("@aoagents/ao-plugin-tracker-gitlab", () => ({ default: trackerGitlabPlugin }));
vi.mock("@aoagents/ao-plugin-tracker-linear", () => ({ default: trackerLinearPlugin }));
vi.mock("@aoagents/ao-plugin-notifier-composio", () => ({ default: notifierComposioPlugin }));
vi.mock("@aoagents/ao-plugin-notifier-desktop", () => ({ default: notifierDesktopPlugin }));
vi.mock("@aoagents/ao-plugin-notifier-discord", () => ({ default: notifierDiscordPlugin }));
vi.mock("@aoagents/ao-plugin-notifier-openclaw", () => ({ default: notifierOpenClawPlugin }));
vi.mock("@aoagents/ao-plugin-notifier-slack", () => ({ default: notifierSlackPlugin }));
vi.mock("@aoagents/ao-plugin-notifier-webhook", () => ({ default: notifierWebhookPlugin }));

describe("services", () => {
  beforeEach(() => {
    vi.resetModules();
    mockRegister.mockClear();
    mockCreateSessionManager.mockReset();
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
    delete (globalThis as typeof globalThis & { _aoServices?: unknown })._aoServices;
    delete (globalThis as typeof globalThis & { _aoServicesInit?: unknown })._aoServicesInit;
  });

  afterEach(() => {
    delete (globalThis as typeof globalThis & { _aoServices?: unknown })._aoServices;
    delete (globalThis as typeof globalThis & { _aoServicesInit?: unknown })._aoServicesInit;
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

  it("registers built-in plugins that the web server must bundle statically", async () => {
    const { getServices } = await import("../lib/services");

    await getServices();

    expect(mockRegister).toHaveBeenCalledWith(processPlugin);
    expect(mockRegister).toHaveBeenCalledWith(aiderPlugin);
    expect(mockRegister).toHaveBeenCalledWith(clonePlugin);
    expect(mockRegister).toHaveBeenCalledWith(scmGitlabPlugin);
    expect(mockRegister).toHaveBeenCalledWith(trackerGitlabPlugin);
    expect(mockRegister).toHaveBeenCalledWith(notifierComposioPlugin);
    expect(mockRegister).toHaveBeenCalledWith(notifierDesktopPlugin);
    expect(mockRegister).toHaveBeenCalledWith(notifierDiscordPlugin);
    expect(mockRegister).toHaveBeenCalledWith(notifierOpenClawPlugin);
    expect(mockRegister).toHaveBeenCalledWith(notifierSlackPlugin);
    expect(mockRegister).toHaveBeenCalledWith(notifierWebhookPlugin);
    expect(mockRegister).toHaveBeenCalledWith(terminalIterm2Plugin);
    expect(mockRegister).toHaveBeenCalledWith(terminalWebPlugin);
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
  const mockSpawn = vi.fn();

  beforeEach(async () => {
    vi.resetModules();
    mockRegister.mockClear();
    mockCreateSessionManager.mockReset();
    mockLoadConfig.mockReset();
    mockUpdateIssue.mockClear();
    mockListIssues.mockClear();
    mockSpawn.mockClear();

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
      list: vi.fn().mockResolvedValue([]),
    });

    delete (globalThis as typeof globalThis & { _aoServices?: unknown })._aoServices;
    delete (globalThis as typeof globalThis & { _aoServicesInit?: unknown })._aoServicesInit;
  });

  afterEach(() => {
    delete (globalThis as typeof globalThis & { _aoServices?: unknown })._aoServices;
    delete (globalThis as typeof globalThis & { _aoServicesInit?: unknown })._aoServicesInit;
  });

  it("removes agent:backlog label when claiming an issue", async () => {
    mockListIssues.mockResolvedValue([
      {
        id: "123",
        title: "Test Issue",
        description: "Test description",
        url: "https://github.com/test/test/issues/123",
        state: "open",
        labels: ["agent:backlog"],
      },
    ]);

    mockRegistry.get.mockImplementation((slot: string) => {
      if (slot === "tracker") {
        return {
          name: "github",
          listIssues: mockListIssues,
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
});
