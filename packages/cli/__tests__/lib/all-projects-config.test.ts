import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExistsSync = vi.hoisted(() => vi.fn());
const mockLoadConfig = vi.hoisted(() => vi.fn());
const MockConfigNotFoundError = vi.hoisted(
  () =>
    class MockConfigNotFoundError extends Error {
      constructor() {
        super("No agent-orchestrator.yaml found.");
        this.name = "ConfigNotFoundError";
      }
    },
);

vi.mock("node:fs", () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));

vi.mock("@aoagents/ao-core", () => ({
  ConfigNotFoundError: MockConfigNotFoundError,
  getGlobalConfigPath: () => "/global/agent-orchestrator.yaml",
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

import { loadAllProjectsConfig } from "../../src/lib/all-projects-config.js";

function makeConfig(configPath: string, projectIds: string[]) {
  return {
    configPath,
    defaults: {
      agent: "codex",
      runtime: "tmux",
      workspace: "worktree",
    },
    plugins: [],
    notifiers: {},
    notificationRouting: {},
    reactions: {},
    projects: Object.fromEntries(
      projectIds.map((projectId) => [
        projectId,
        {
          name: projectId,
          path: `/tmp/${projectId}`,
        },
      ]),
    ),
  };
}

describe("loadAllProjectsConfig", () => {
  beforeEach(() => {
    mockExistsSync.mockReset();
    mockLoadConfig.mockReset();
  });

  it("merges local-only projects into the global config", () => {
    mockExistsSync.mockReturnValue(true);
    mockLoadConfig.mockImplementation((path: string) => {
      if (path === "/global/agent-orchestrator.yaml") return makeConfig(path, ["global-app"]);
      if (path === "/local/agent-orchestrator.yaml") return makeConfig(path, ["local-app"]);
      throw new Error(`unexpected path ${path}`);
    });

    const config = loadAllProjectsConfig("/local/agent-orchestrator.yaml");

    expect(Object.keys(config.projects)).toEqual(["global-app", "local-app"]);
    expect(config.configPath).toBe("/global/agent-orchestrator.yaml");
  });

  it("does not hide malformed existing global configs", () => {
    mockExistsSync.mockReturnValue(true);
    mockLoadConfig.mockImplementation((path: string) => {
      if (path === "/global/agent-orchestrator.yaml") throw new Error("invalid global config");
      if (path === "/local/agent-orchestrator.yaml") return makeConfig(path, ["local-app"]);
      throw new Error(`unexpected path ${path}`);
    });

    expect(() => loadAllProjectsConfig("/local/agent-orchestrator.yaml")).toThrow(
      "invalid global config",
    );
  });

  it("ignores optional config paths that disappear before loading", () => {
    mockExistsSync.mockReturnValue(true);
    mockLoadConfig.mockImplementation((path?: string) => {
      if (path === "/global/agent-orchestrator.yaml")
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      if (path === "/local/agent-orchestrator.yaml") return makeConfig(path, ["local-app"]);
      return makeConfig("/fallback/agent-orchestrator.yaml", ["fallback-app"]);
    });

    const config = loadAllProjectsConfig("/local/agent-orchestrator.yaml");

    expect(Object.keys(config.projects)).toEqual(["local-app"]);
  });
});
