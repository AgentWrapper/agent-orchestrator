import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadConfig } from "../config.js";
import { ProjectResolveError } from "../types.js";
import { iterateAllProjects, loadEffectiveProjectConfig } from "../project-resolver.js";
import {
  saveGlobalConfig,
  type GlobalConfig,
} from "../global-config.js";

function makeGlobalConfig(projects: GlobalConfig["projects"] = {}): GlobalConfig {
  return {
    port: 3000,
    readyThresholdMs: 300_000,
    defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
    projects,
    notifiers: {},
    notificationRouting: {},
    reactions: {},
  };
}

describe("project resolver", () => {
  let tempRoot: string;
  let configPath: string;
  let originalHome: string | undefined;
  let originalGlobalConfig: string | undefined;

  beforeEach(() => {
    tempRoot = join(tmpdir(), `ao-project-resolver-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    configPath = join(tempRoot, ".agent-orchestrator", "config.yaml");
    mkdirSync(tempRoot, { recursive: true });
    originalHome = process.env["HOME"];
    originalGlobalConfig = process.env["AO_GLOBAL_CONFIG"];
    process.env["HOME"] = tempRoot;
    process.env["AO_GLOBAL_CONFIG"] = configPath;
  });

  afterEach(() => {
    process.env["HOME"] = originalHome;
    if (originalGlobalConfig === undefined) {
      delete process.env["AO_GLOBAL_CONFIG"];
    } else {
      process.env["AO_GLOBAL_CONFIG"] = originalGlobalConfig;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("resolves registry-only projects with shared defaults", () => {
    const projectPath = join(tempRoot, "demo");
    mkdirSync(projectPath, { recursive: true });

    saveGlobalConfig(
      {
        ...makeGlobalConfig({
          demo: {
            projectId: "demo",
            path: projectPath,
            displayName: "Demo",
            defaultBranch: "main",
            sessionPrefix: "demo",
          },
        }),
        defaults: {
          runtime: "docker",
          agent: "codex",
          workspace: "clone",
          notifiers: [],
        },
      },
      configPath,
    );

    const loaded = loadConfig(configPath);
    expect(loaded.projects.demo).toMatchObject({
      name: "Demo",
      path: projectPath,
      runtime: "docker",
      agent: "codex",
      workspace: "clone",
    });
    expect(loaded.projects.demo.resolveError).toBeUndefined();
  });

  it("throws ProjectResolveError when required defaults are missing in registry-only mode", () => {
    const projectPath = join(tempRoot, "demo");
    mkdirSync(projectPath, { recursive: true });

    const globalConfig = {
      port: 3000,
      readyThresholdMs: 300_000,
      defaults: { notifiers: [] },
      projects: {
        demo: {
          projectId: "demo",
          path: projectPath,
          displayName: "Demo",
          defaultBranch: "main",
          sessionPrefix: "demo",
        },
      },
      notifiers: {},
      notificationRouting: {},
      reactions: {},
    } as unknown as GlobalConfig;

    expect(() => loadEffectiveProjectConfig("demo", globalConfig)).toThrow(ProjectResolveError);
  });

  it("throws ProjectResolveError for broken local yaml", () => {
    const projectPath = join(tempRoot, "broken");
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(projectPath, "agent-orchestrator.yaml"), "tracker: [\n");

    const globalConfig = makeGlobalConfig({
      broken: {
        projectId: "broken",
        path: projectPath,
        displayName: "Broken",
        defaultBranch: "main",
        sessionPrefix: "broken",
      },
    });

    expect(() => loadEffectiveProjectConfig("broken", globalConfig, configPath)).toThrow(
      ProjectResolveError,
    );
  });

  it("loadConfig keeps project entries out of the registry when local yaml exists", () => {
    const projectPath = join(tempRoot, "app");
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(
      join(projectPath, "agent-orchestrator.yaml"),
      ["agent: codex", "runtime: docker", "workspace: clone", "tracker:", "  plugin: github", ""].join("\n"),
    );

    saveGlobalConfig(
      makeGlobalConfig({
        app: {
          projectId: "app",
          path: projectPath,
          displayName: "App",
          defaultBranch: "main",
          sessionPrefix: "app",
        },
      }),
      configPath,
    );

    const loaded = loadConfig(configPath);
    expect(loaded.projects.app).toMatchObject({
      agent: "codex",
      runtime: "docker",
      workspace: "clone",
    });

    const raw = parseYaml(readFileSync(configPath, "utf-8")) as { projects: Record<string, Record<string, unknown>> };
    expect(raw.projects.app).not.toHaveProperty("agent");
    expect(raw.projects.app).not.toHaveProperty("runtime");
    expect(raw.projects.app).not.toHaveProperty("workspace");
    expect(raw.projects.app).not.toHaveProperty("tracker");
  });

  it("iterateAllProjects yields clean entries first and degraded entries second", () => {
    const cleanPath = join(tempRoot, "clean");
    const brokenPath = join(tempRoot, "broken");
    mkdirSync(cleanPath, { recursive: true });
    mkdirSync(brokenPath, { recursive: true });
    writeFileSync(join(cleanPath, "agent-orchestrator.yaml"), "agent: codex\nruntime: tmux\nworkspace: worktree\n");
    writeFileSync(join(brokenPath, "agent-orchestrator.yaml"), "tracker: [\n");

    saveGlobalConfig(
      makeGlobalConfig({
        clean: {
          projectId: "clean",
          path: cleanPath,
          displayName: "Clean",
          defaultBranch: "main",
          sessionPrefix: "clean",
        },
        broken: {
          projectId: "broken",
          path: brokenPath,
          displayName: "Broken",
          defaultBranch: "main",
          sessionPrefix: "broken",
        },
      }),
      configPath,
    );

    const loaded = loadConfig(configPath);
    const entries = [...iterateAllProjects(loaded)];

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ name: "Clean", path: cleanPath });
    expect(entries[1]).toMatchObject({
      projectId: "broken",
      path: brokenPath,
      resolveError: expect.any(String),
    });
  });

  it("matches a flat local config launched from a symlinked checkout", () => {
    const realProjectPath = join(tempRoot, "real-app");
    const symlinkParent = join(tempRoot, "links");
    const symlinkProjectPath = join(symlinkParent, "app-link");
    mkdirSync(realProjectPath, { recursive: true });
    mkdirSync(symlinkParent, { recursive: true });
    symlinkSync(realProjectPath, symlinkProjectPath);
    writeFileSync(
      join(realProjectPath, "agent-orchestrator.yaml"),
      ["agent: codex", "runtime: docker", "workspace: clone", ""].join("\n"),
    );

    saveGlobalConfig(
      makeGlobalConfig({
        app: {
          projectId: "app",
          path: realProjectPath,
          displayName: "App",
          defaultBranch: "main",
          sessionPrefix: "app",
        },
      }),
      configPath,
    );

    const loaded = loadConfig(join(symlinkProjectPath, "agent-orchestrator.yaml"));
    expect(loaded.projects.app).toMatchObject({
      name: "App",
      path: realProjectPath,
      agent: "codex",
      runtime: "docker",
      workspace: "clone",
    });
  });
});
