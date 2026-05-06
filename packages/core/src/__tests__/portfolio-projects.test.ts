import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveGlobalConfig, type GlobalConfig } from "../global-config.js";
import { clearConfigCache, resolveProjectConfig } from "../portfolio-projects.js";
import type { PortfolioProject } from "../types.js";

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

describe("portfolio-projects", () => {
  let tempRoot: string;
  let oldGlobalConfig: string | undefined;
  let oldConfigPath: string | undefined;
  let oldHome: string | undefined;

  beforeEach(() => {
    tempRoot = join(tmpdir(), `ao-portfolio-projects-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(tempRoot, { recursive: true });
    oldGlobalConfig = process.env["AO_GLOBAL_CONFIG"];
    oldConfigPath = process.env["AO_CONFIG_PATH"];
    oldHome = process.env["HOME"];
    process.env["HOME"] = tempRoot;
    clearConfigCache();
  });

  afterEach(() => {
    if (oldGlobalConfig === undefined) delete process.env["AO_GLOBAL_CONFIG"];
    else process.env["AO_GLOBAL_CONFIG"] = oldGlobalConfig;
    if (oldConfigPath === undefined) delete process.env["AO_CONFIG_PATH"];
    else process.env["AO_CONFIG_PATH"] = oldConfigPath;
    if (oldHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = oldHome;
    clearConfigCache();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("resolves effective project config from the canonical global registry", () => {
    const globalConfigPath = join(tempRoot, "global-config.yaml");
    const docsRepo = join(tempRoot, "docs");
    mkdirSync(docsRepo, { recursive: true });
    process.env["AO_GLOBAL_CONFIG"] = globalConfigPath;

    saveGlobalConfig(
      makeGlobalConfig({
        docs: {
          projectId: "docs",
          path: docsRepo,
          displayName: "Docs",
          defaultBranch: "develop",
          sessionPrefix: "docs",
        },
      }),
      globalConfigPath,
    );

    const entry: PortfolioProject = {
      id: "docs",
      name: "Docs",
      configPath: globalConfigPath,
      configProjectKey: "docs",
      repoPath: docsRepo,
      defaultBranch: "develop",
      sessionPrefix: "docs",
      source: "config",
      enabled: true,
      pinned: false,
      lastSeenAt: new Date().toISOString(),
    };

    const resolved = resolveProjectConfig(entry);

    expect(resolved?.project.path).toBe(docsRepo);
    expect(resolved?.project.defaultBranch).toBe("develop");
    expect(resolved?.config.projects.docs?.path).toBe(docsRepo);
  });

  it("uses the cache for local config resolution until cleared", () => {
    const repoPath = join(tempRoot, "repo");
    const configPath = join(tempRoot, "agent-orchestrator.yaml");
    mkdirSync(repoPath, { recursive: true });

    const writeWrappedConfig = (defaultBranch: string) => {
      writeFileSync(
        configPath,
        [
          "projects:",
          "  docs:",
          `    path: ${repoPath}`,
          `    defaultBranch: ${defaultBranch}`,
          "    runtime: tmux",
          "    agent: claude-code",
          "    workspace: worktree",
          "",
        ].join("\n"),
        "utf-8",
      );
    };

    writeWrappedConfig("main");

    const entry: PortfolioProject = {
      id: "docs",
      name: "Docs",
      configPath,
      configProjectKey: "docs",
      repoPath,
      sessionPrefix: "docs",
      source: "config",
      enabled: true,
      pinned: false,
      lastSeenAt: new Date().toISOString(),
    };

    expect(resolveProjectConfig(entry)?.project.defaultBranch).toBe("main");

    writeWrappedConfig("develop");
    expect(resolveProjectConfig(entry)?.project.defaultBranch).toBe("main");

    clearConfigCache();
    expect(resolveProjectConfig(entry)?.project.defaultBranch).toBe("develop");
  });
});
