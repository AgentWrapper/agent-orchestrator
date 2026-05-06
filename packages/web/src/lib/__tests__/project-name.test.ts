import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { mockLoadConfig, mockGetGlobalConfigPath, MockConfigNotFoundError } = vi.hoisted(() => {
  const mockLoadConfig = vi.fn();
  const mockGetGlobalConfigPath = vi.fn(() => "/tmp/global-config.yaml");
  class MockConfigNotFoundError extends Error {
    constructor(message?: string) {
      super(message ?? "Config not found");
      this.name = "ConfigNotFoundError";
    }
  }

  return { mockLoadConfig, mockGetGlobalConfigPath, MockConfigNotFoundError };
});

vi.mock("@aoagents/ao-core", () => ({
  loadConfig: mockLoadConfig,
  getGlobalConfigPath: mockGetGlobalConfigPath,
  ConfigNotFoundError: MockConfigNotFoundError,
}));

describe("project-name fallback discovery", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    mockLoadConfig.mockReset();
    mockGetGlobalConfigPath.mockClear();
    mockGetGlobalConfigPath.mockReturnValue("/tmp/global-config.yaml");
    delete process.env["AO_CONFIG_PATH"];
  });

  it("falls back to discovered local config when the canonical global config is missing", async () => {
    const fallbackConfig = {
      projects: {
        mono: { name: "Mono", sessionPrefix: "mono" },
      },
      degradedProjects: {},
    };

    mockLoadConfig
      .mockImplementationOnce(() => {
        const error = new Error("ENOENT: no such file or directory");
        (error as Error & { code?: string }).code = "ENOENT";
        throw error;
      })
      .mockReturnValueOnce(fallbackConfig)
      .mockReturnValue(fallbackConfig);

    const { getAllProjects, getPrimaryProjectId, getProjectName } = await import("../project-name");

    expect(getAllProjects()).toEqual([{ id: "mono", name: "Mono", sessionPrefix: "mono" }]);
    expect(getPrimaryProjectId()).toBe("mono");
    expect(getProjectName()).toBe("Mono");
    expect(mockLoadConfig).toHaveBeenNthCalledWith(1, "/tmp/global-config.yaml");
    expect(mockLoadConfig).toHaveBeenNthCalledWith(2);
  });

  it("prefers the current repo project over the first configured project", async () => {
    const config = {
      configPath: "/tmp/global-config.yaml",
      projects: {
        "vinesight-web": {
          name: "vinesight-web",
          path: "/Users/ashishhuddar/vinesight",
          sessionPrefix: "vw",
        },
        "agent-orchestrator": {
          name: "Agent Orchestrator",
          path: "/Users/ashishhuddar/agent-orchestrator",
          sessionPrefix: "ao",
        },
      },
      degradedProjects: {},
    };

    mockLoadConfig.mockReturnValue(config);
    vi.spyOn(process, "cwd").mockReturnValue("/Users/ashishhuddar/agent-orchestrator");

    const { getPrimaryProjectId, getProjectName } = await import("../project-name");

    expect(getPrimaryProjectId()).toBe("agent-orchestrator");
    expect(getProjectName()).toBe("Agent Orchestrator");
  });

  it("does not infer the current project from an ambiguous path basename", async () => {
    const config = {
      configPath: "/tmp/global-config.yaml",
      projects: {
        first: {
          name: "First",
          path: "/repos/client-a/integrator",
          sessionPrefix: "first",
        },
        second: {
          name: "Second",
          path: "/repos/client-b/integrator",
          sessionPrefix: "second",
        },
      },
      degradedProjects: {},
    };

    mockLoadConfig.mockReturnValue(config);
    vi.spyOn(process, "cwd").mockReturnValue("/tmp/checkout/integrator");

    const { getPrimaryProjectId, getProjectName } = await import("../project-name");

    expect(getPrimaryProjectId()).toBe("first");
    expect(getProjectName()).toBe("First");
  });

  it("prefers the repo discovered from local config when the dashboard is running from packages/web", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-project-name-web-"));
    const repoRoot = join(tempRoot, "agent-orchestrator");
    const webDir = join(repoRoot, "packages", "web");
    mkdirSync(webDir, { recursive: true });
    const localConfigPath = join(repoRoot, "agent-orchestrator.yaml");
    writeFileSync(localConfigPath, "projects: {}\n");

    const globalConfig = {
      configPath: "/tmp/global-config.yaml",
      projects: {
        "vinesight-web": {
          name: "vinesight-web",
          path: join(tempRoot, "vinesight"),
          sessionPrefix: "vw",
        },
        "agent-orchestrator": {
          name: "Agent Orchestrator",
          path: repoRoot,
          sessionPrefix: "ao",
        },
      },
      degradedProjects: {},
    };
    const localConfig = {
      configPath: localConfigPath,
      projects: {
        "agent-orchestrator": {
          name: "Agent Orchestrator",
          path: repoRoot,
          sessionPrefix: "ao",
        },
      },
      degradedProjects: {},
    };

    mockLoadConfig.mockImplementation((configPath?: string) => {
      if (configPath === "/tmp/global-config.yaml") {
        return globalConfig;
      }
      if (configPath === localConfigPath) {
        return localConfig;
      }
      throw new Error(`unexpected config path: ${String(configPath)}`);
    });
    vi.spyOn(process, "cwd").mockReturnValue(webDir);

    const { getPrimaryProjectId, getProjectName } = await import("../project-name");

    expect(getPrimaryProjectId()).toBe("agent-orchestrator");
    expect(getProjectName()).toBe("Agent Orchestrator");
  });

  it("ignores ambient AO_CONFIG_PATH when discovering the local repo project", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "ao-project-name-"));
    const repoRoot = join(tempRoot, "agent-orchestrator");
    const webDir = join(repoRoot, "packages", "web");
    mkdirSync(webDir, { recursive: true });
    const localConfigPath = join(repoRoot, "agent-orchestrator.yaml");
    writeFileSync(localConfigPath, "projects: {}\n");

    const globalConfig = {
      configPath: "/tmp/global-config.yaml",
      projects: {
        healthy: {
          name: "Healthy",
          path: repoRoot,
          sessionPrefix: "healthy",
        },
      },
      degradedProjects: {},
    };
    const localConfig = {
      configPath: localConfigPath,
      projects: {
        healthy: {
          name: "Healthy",
          path: repoRoot,
          sessionPrefix: "healthy",
        },
      },
      degradedProjects: {},
    };

    process.env["AO_CONFIG_PATH"] = "/tmp/ambient-config.yaml";
    mockLoadConfig.mockImplementation((configPath?: string) => {
      if (configPath === "/tmp/global-config.yaml") {
        return globalConfig;
      }
      if (configPath === localConfigPath) {
        return localConfig;
      }
      throw new Error(`unexpected config path: ${String(configPath)}`);
    });
    vi.spyOn(process, "cwd").mockReturnValue(webDir);

    const { getPrimaryProjectId, getProjectName } = await import("../project-name");

    expect(getPrimaryProjectId()).toBe("healthy");
    expect(getProjectName()).toBe("Healthy");
  });
});
