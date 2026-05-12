import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCreatePluginRegistry = vi.hoisted(() => vi.fn());
const mockCreateSessionManager = vi.hoisted(() => vi.fn());
const mockCreateLifecycleManager = vi.hoisted(() => vi.fn());
const mockImportPluginModuleFromSource = vi.hoisted(() => vi.fn());

vi.mock("@aoagents/ao-core", () => ({
  createPluginRegistry: (...args: unknown[]) => mockCreatePluginRegistry(...args),
  createSessionManager: (...args: unknown[]) => mockCreateSessionManager(...args),
  createLifecycleManager: (...args: unknown[]) => mockCreateLifecycleManager(...args),
}));

vi.mock("../../src/lib/plugin-store.js", () => ({
  importPluginModuleFromSource: (...args: unknown[]) => mockImportPluginModuleFromSource(...args),
}));

function makeRegistry() {
  return {
    loadFromConfig: vi.fn().mockResolvedValue(undefined),
    get: vi.fn(),
    list: vi.fn(),
    register: vi.fn(),
  };
}

function makeConfig(withExternalEntries = false) {
  return {
    configPath: "/repo/agent-orchestrator.yaml",
    defaults: {
      runtime: "process",
      agent: "codex",
      workspace: "worktree",
      notifiers: [],
    },
    readyThresholdMs: 300000,
    plugins: withExternalEntries
      ? [{ name: "custom-tracker", source: "local", path: "./plugins/tracker" }]
      : [],
    notifiers: {},
    notificationRouting: {},
    reactions: {},
    projects: {
      app: {
        name: "App",
        path: "/repo/app",
        defaultBranch: "main",
        sessionPrefix: "app",
        ...(withExternalEntries
          ? { tracker: { plugin: "tracker", path: "./plugins/tracker" } }
          : {}),
      },
    },
    ...(withExternalEntries
      ? {
          _externalPluginEntries: [
            {
              source: "projects.app.tracker",
              location: { kind: "project", projectId: "app", configType: "tracker" },
              slot: "tracker",
              path: "./plugins/tracker",
            },
          ],
        }
      : {}),
  };
}

describe("getPluginRegistry", () => {
  beforeEach(() => {
    vi.resetModules();
    mockCreatePluginRegistry.mockReset();
    mockCreateSessionManager.mockReset();
    mockCreateLifecycleManager.mockReset();
    mockImportPluginModuleFromSource.mockReset();
    mockCreatePluginRegistry.mockImplementation(makeRegistry);
  });

  it("shares registry initialization across equivalent configs without inline external plugins", async () => {
    const { getPluginRegistry } = await import("../../src/lib/create-session-manager.js");

    const first = await getPluginRegistry(makeConfig());
    const second = await getPluginRegistry(makeConfig());

    expect(first).toBe(second);
    expect(mockCreatePluginRegistry).toHaveBeenCalledTimes(1);
    expect(first.loadFromConfig).toHaveBeenCalledTimes(1);
  });

  it("does not share registry initialization across fresh configs that need manifest-name mutation", async () => {
    const { getPluginRegistry } = await import("../../src/lib/create-session-manager.js");
    const firstConfig = makeConfig(true);
    const secondConfig = makeConfig(true);

    const first = await getPluginRegistry(firstConfig);
    const second = await getPluginRegistry(secondConfig);

    expect(first).not.toBe(second);
    expect(mockCreatePluginRegistry).toHaveBeenCalledTimes(2);
    expect(first.loadFromConfig).toHaveBeenCalledWith(firstConfig, expect.any(Function));
    expect(second.loadFromConfig).toHaveBeenCalledWith(secondConfig, expect.any(Function));
  });

  it("still deduplicates concurrent registry initialization for the same mutable config object", async () => {
    const { getPluginRegistry } = await import("../../src/lib/create-session-manager.js");
    const config = makeConfig(true);

    const [first, second] = await Promise.all([
      getPluginRegistry(config),
      getPluginRegistry(config),
    ]);

    expect(first).toBe(second);
    expect(mockCreatePluginRegistry).toHaveBeenCalledTimes(1);
    expect(first.loadFromConfig).toHaveBeenCalledTimes(1);
  });
});
