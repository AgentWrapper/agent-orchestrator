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

import {
  loadAllProjectsConfig,
  loadAllProjectsConfigWithFallback,
} from "../../src/lib/all-projects-config.js";

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

  it("prefers the running config when project IDs collide", () => {
    mockExistsSync.mockReturnValue(true);
    mockLoadConfig.mockImplementation((path: string) => {
      if (path === "/global/agent-orchestrator.yaml") {
        return {
          ...makeConfig(path, ["shared-app", "global-app"]),
          projects: {
            "shared-app": { name: "Global Shared", path: "/global/shared" },
            "global-app": { name: "Global App", path: "/global/app" },
          },
        };
      }
      if (path === "/local/agent-orchestrator.yaml") {
        return {
          ...makeConfig(path, ["shared-app"]),
          projects: {
            "shared-app": { name: "Running Shared", path: "/local/shared" },
          },
        };
      }
      throw new Error(`unexpected path ${path}`);
    });

    const config = loadAllProjectsConfig("/local/agent-orchestrator.yaml");

    expect(Object.keys(config.projects)).toEqual(["shared-app", "global-app"]);
    expect(config.projects["shared-app"]).toMatchObject({
      name: "Running Shared",
      path: "/local/shared",
    });
  });

  it("uses running plugin definitions and preserves running-relative plugin paths", () => {
    mockExistsSync.mockReturnValue(true);
    mockLoadConfig.mockImplementation((path: string) => {
      if (path === "/global/agent-orchestrator.yaml") {
        return {
          ...makeConfig(path, ["shared-app"]),
          plugins: [{ name: "tracker-custom", source: "local", path: "./global-plugin" }],
          projects: {
            "shared-app": {
              name: "Global Shared",
              path: "/global/shared",
              tracker: { plugin: "tracker-custom", path: "./global-tracker" },
            },
          },
          _externalPluginEntries: [
            {
              source: "projects.shared-app.tracker",
              location: { kind: "project", projectId: "shared-app", configType: "tracker" },
              slot: "tracker",
              path: "./global-tracker",
            },
          ],
        };
      }
      if (path === "/local/app/agent-orchestrator.yaml") {
        return {
          ...makeConfig(path, ["shared-app", "local-app"]),
          plugins: [{ name: "tracker-custom", source: "local", path: "./local-plugin" }],
          projects: {
            "shared-app": {
              name: "Running Shared",
              path: "/local/app/shared",
              tracker: { plugin: "tracker-custom", path: "./local-tracker" },
            },
            "local-app": {
              name: "Local App",
              path: "/local/app/local",
              scm: { plugin: "scm-custom", path: "./local-scm" },
            },
          },
          _externalPluginEntries: [
            {
              source: "projects.shared-app.tracker",
              location: { kind: "project", projectId: "shared-app", configType: "tracker" },
              slot: "tracker",
              path: "./local-tracker",
            },
            {
              source: "projects.local-app.scm",
              location: { kind: "project", projectId: "local-app", configType: "scm" },
              slot: "scm",
              path: "./local-scm",
            },
          ],
        };
      }
      throw new Error(`unexpected path ${path}`);
    });

    const config = loadAllProjectsConfig("/local/app/agent-orchestrator.yaml");

    expect(config.configPath).toBe("/global/agent-orchestrator.yaml");
    expect(config.plugins).toEqual([
      { name: "tracker-custom", source: "local", path: "/local/app/local-plugin" },
    ]);
    expect(config.projects["shared-app"]).toMatchObject({
      name: "Running Shared",
      tracker: { path: "/local/app/local-tracker" },
    });
    expect(config.projects["local-app"]).toMatchObject({
      scm: { path: "/local/app/local-scm" },
    });
    expect(config._externalPluginEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "projects.shared-app.tracker",
          path: "/local/app/local-tracker",
        }),
        expect.objectContaining({ source: "projects.local-app.scm", path: "/local/app/local-scm" }),
      ]),
    );
    expect(config._externalPluginEntries).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "projects.shared-app.tracker",
          path: "./global-tracker",
        }),
      ]),
    );
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

  it("fallback loading stays scoped to running and global config paths", () => {
    mockExistsSync.mockReturnValue(true);
    mockLoadConfig.mockImplementation((path?: string) => {
      if (path === "/global/agent-orchestrator.yaml") throw new Error("invalid global config");
      if (path === "/local/agent-orchestrator.yaml") throw new Error("invalid local config");
      if (path === undefined) return makeConfig("/cwd/agent-orchestrator.yaml", ["cwd-app"]);
      throw new Error(`unexpected path ${path}`);
    });

    expect(() => loadAllProjectsConfigWithFallback("/local/agent-orchestrator.yaml")).toThrow(
      "invalid global config",
    );
    expect(mockLoadConfig).not.toHaveBeenCalledWith(undefined);
  });

  it("fallback loading can explicitly opt into default config discovery", () => {
    mockExistsSync.mockReturnValue(true);
    mockLoadConfig.mockImplementation((path?: string) => {
      if (path === "/global/agent-orchestrator.yaml") throw new Error("invalid global config");
      if (path === "/local/agent-orchestrator.yaml") throw new Error("invalid local config");
      if (path === undefined) return makeConfig("/cwd/agent-orchestrator.yaml", ["cwd-app"]);
      throw new Error(`unexpected path ${path}`);
    });

    const result = loadAllProjectsConfigWithFallback("/local/agent-orchestrator.yaml", {
      includeDefaultFallback: true,
    });

    expect(Object.keys(result.config.projects)).toEqual(["cwd-app"]);
    expect(result.warning).toContain("default config discovery");
    expect(mockLoadConfig).toHaveBeenCalledWith();
  });
});
