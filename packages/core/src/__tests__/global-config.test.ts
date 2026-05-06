import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  generateExternalId,
  loadGlobalConfig,
  migrateToGlobalConfig,
  repairWrappedLocalProjectConfig,
  registerProjectInGlobalConfig,
  resolveProjectIdentity,
} from "../global-config.js";

describe("global-config storage identity", () => {
  let tempRoot: string;
  let configPath: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempRoot = join(
      tmpdir(),
      `ao-global-config-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(tempRoot, { recursive: true });
    configPath = join(tempRoot, "config.yaml");
    originalHome = process.env["HOME"];
    process.env["HOME"] = tempRoot;
  });

  afterEach(() => {
    process.env["HOME"] = originalHome;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function createRepo(repoName: string, originUrl?: string): string {
    const repoPath = join(tempRoot, repoName);
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    const remoteBlock = originUrl ? `\n[remote "origin"]\n  url = ${originUrl}\n` : "\n";
    writeFileSync(
      join(repoPath, ".git", "config"),
      `[core]\n  repositoryformatversion = 0${remoteBlock}`,
    );
    return realpathSync(repoPath);
  }

  it("registers identity fields without persisting behavior fields", () => {
    const repoPath = createRepo("demo", "git@github.com:OpenAI/demo.git");

    registerProjectInGlobalConfig(
      "demo",
      "Demo",
      repoPath,
      { agent: "codex", runtime: "tmux" },
      configPath,
    );

    const config = loadGlobalConfig(configPath);
    const projectId = generateExternalId(repoPath, "git@github.com:OpenAI/demo.git");

    expect(config?.projects[projectId]).toMatchObject({
      projectId,
      displayName: "Demo",
      path: repoPath,
      defaultBranch: "main",
      sessionPrefix: "demo",
      source: "ao-project-add",
      repo: {
        owner: "OpenAI",
        name: "demo",
        platform: "github",
        originUrl: "https://github.com/OpenAI/demo",
      },
    });
    expect(config?.projects[projectId]).not.toHaveProperty("agent");
    expect(config?.projects[projectId]).not.toHaveProperty("runtime");
  });

  it("rejects registration when another project already owns the generated session prefix", () => {
    const repoPath = join(tempRoot, "apps", "web");
    mkdirSync(join(repoPath, ".git"), { recursive: true });
    writeFileSync(
      join(repoPath, ".git", "config"),
      '[core]\n  repositoryformatversion = 0\n[remote "origin"]\n  url = https://github.com/OpenAI/web.git\n',
    );
    const clonePath = join(tempRoot, "fixtures", "web");
    mkdirSync(join(clonePath, ".git"), { recursive: true });
    writeFileSync(
      join(clonePath, ".git", "config"),
      '[core]\n  repositoryformatversion = 0\n[remote "origin"]\n  url = https://github.com/OpenAI/web-fixtures.git\n',
    );

    registerProjectInGlobalConfig("web", "Web", repoPath, undefined, configPath);

    expect(() =>
      registerProjectInGlobalConfig(
        "web-fixtures",
        "Web Fixtures",
        clonePath,
        { sessionPrefix: "web" },
        configPath,
      ),
    ).toThrow(/Duplicate session prefix detected: "web"/);
  });

  it("generates deterministic external IDs from path and origin", () => {
    const repoPath = createRepo(
      "agent-orchestrator",
      "https://github.com/OpenAI/agent-orchestrator.git",
    );

    expect(generateExternalId(repoPath, "https://github.com/OpenAI/agent-orchestrator.git")).toBe(
      generateExternalId(repoPath, "https://github.com/OpenAI/agent-orchestrator.git"),
    );
    expect(generateExternalId(repoPath, null)).toMatch(/^agent-orchestrator_[0-9a-f]{10}$/);
  });

  it("generates different external IDs for same-basename projects at different paths", () => {
    const repoA = createRepo(join("company-a", "agent-orchestrator"));
    const repoB = createRepo(join("company-b", "agent-orchestrator"));

    expect(generateExternalId(repoA)).toMatch(/^agent-orchestrator_[0-9a-f]{10}$/);
    expect(generateExternalId(repoA)).not.toBe(generateExternalId(repoB));
  });

  it("sanitizes generated external ID basenames", () => {
    const repoPath = createRepo(join("company", ".My Project!"));

    expect(generateExternalId(repoPath)).toMatch(/^xmy-project-_[0-9a-f]{10}$/);
  });

  it("caps generated external ID basenames at 30 characters", () => {
    const repoPath = createRepo("this-project-name-is-way-too-long-for-readable-storage");

    expect(generateExternalId(repoPath)).toMatch(/^this-project-name-is-way-too-l_[0-9a-f]{10}$/);
  });

  it("registers same-basename projects with hashed external IDs", () => {
    const repoA = createRepo(join("company-a", "agent-orchestrator"));
    const repoB = createRepo(join("company-b", "agent-orchestrator"));

    const idA = registerProjectInGlobalConfig(
      "agent-orchestrator",
      "AO A",
      repoA,
      { sessionPrefix: "aoa" },
      configPath,
    );
    const idB = registerProjectInGlobalConfig(
      "agent-orchestrator",
      "AO B",
      repoB,
      { sessionPrefix: "aob" },
      configPath,
    );

    expect(idA).toMatch(/^agent-orchestrator_[0-9a-f]{10}$/);
    expect(idB).toMatch(/^agent-orchestrator_[0-9a-f]{10}$/);
    expect(idA).not.toBe(idB);
  });

  it("throws if a generated external ID is already registered for a different path", () => {
    const repoA = createRepo("collision-source", "https://github.com/OpenAI/collision-source.git");
    const repoB = createRepo("collision-target", "https://github.com/OpenAI/collision-target.git");
    const collisionId = generateExternalId(repoA, "https://github.com/OpenAI/collision-source.git");
    writeFileSync(
      configPath,
      [
        "projects:",
        `  ${collisionId}:`,
        `    projectId: ${collisionId}`,
        `    path: ${repoB}`,
        "notifiers: {}",
        "notificationRouting: {}",
        "reactions: {}",
        "",
      ].join("\n"),
    );

    expect(() =>
      registerProjectInGlobalConfig("collision-source", "Collision", repoA, undefined, configPath),
    ).toThrow(/Project ID collision/);
  });

  it("allocates a suffixed generated session prefix for same-basename projects", () => {
    const repoA = createRepo(join("company-a", "agent-orchestrator"));
    const repoB = createRepo(join("company-b", "agent-orchestrator"));

    const idA = registerProjectInGlobalConfig(
      "agent-orchestrator",
      "AO A",
      repoA,
      undefined,
      configPath,
    );
    const idB = registerProjectInGlobalConfig(
      "agent-orchestrator",
      "AO B",
      repoB,
      undefined,
      configPath,
    );

    const config = loadGlobalConfig(configPath);
    expect(config?.projects[idA]?.sessionPrefix).toBe("ao");
    expect(config?.projects[idB]?.sessionPrefix).toBe("ao-1");
  });

  it("strips stale shadow fields from legacy entries and rewrites the config", () => {
    const repoPath = createRepo("legacy", "https://github.com/OpenAI/demo.git");
    writeFileSync(
      configPath,
      [
        "port: 3000",
        "readyThresholdMs: 300000",
        "defaults:",
        "  runtime: tmux",
        "  agent: claude-code",
        "  workspace: worktree",
        "  notifiers: []",
        "projects:",
        "  legacy:",
        `    path: ${repoPath}`,
        "    name: Legacy",
        "    agent: codex",
        "    runtime: docker",
        "    _shadowSyncedAt: 123",
        "notifiers: {}",
        "notificationRouting: {}",
        "reactions: {}",
        "",
      ].join("\n"),
    );

    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const config = loadGlobalConfig(configPath);
      expect(config?.projects["legacy"]).toMatchObject({
        projectId: "legacy",
        displayName: "Legacy",
        path: repoPath,
      });
      expect(config?.projects["legacy"]).not.toHaveProperty("agent");
      expect(config?.projects["legacy"]).not.toHaveProperty("runtime");

      const rewritten = parseYaml(readFileSync(configPath, "utf-8")) as {
        projects: Record<string, Record<string, unknown>>;
      };
      expect(rewritten.projects.legacy).not.toHaveProperty("agent");
      expect(rewritten.projects.legacy).not.toHaveProperty("runtime");
      expect(rewritten.projects.legacy).not.toHaveProperty("_shadowSyncedAt");
      expect(consoleInfo).toHaveBeenCalledWith(
        "[ao] stripped 3 legacy project registry fields from 1 project: legacy (3)",
      );
    } finally {
      consoleInfo.mockRestore();
    }
  });

  it("migrates legacy string repo fields into repo identity objects on load", () => {
    const repoPath = createRepo("legacy-repo", "https://github.com/OpenAI/demo.git");
    writeFileSync(
      configPath,
      [
        "port: 3000",
        "readyThresholdMs: 300000",
        "defaults:",
        "  runtime: tmux",
        "  agent: claude-code",
        "  workspace: worktree",
        "  notifiers: []",
        "projects:",
        "  legacy:",
        `    path: ${repoPath}`,
        "    repo: OpenAI/demo",
        "notifiers: {}",
        "notificationRouting: {}",
        "reactions: {}",
        "",
      ].join("\n"),
    );

    const config = loadGlobalConfig(configPath);
    expect(config?.projects["legacy"]?.repo).toEqual({
      owner: "OpenAI",
      name: "demo",
      platform: "github",
      originUrl: "https://github.com/OpenAI/demo",
    });

    const rewritten = parseYaml(readFileSync(configPath, "utf-8")) as {
      projects: Record<string, Record<string, unknown>>;
    };
    expect(rewritten.projects.legacy.repo).toEqual({
      owner: "OpenAI",
      name: "demo",
      platform: "github",
      originUrl: "https://github.com/OpenAI/demo",
    });
  });

  it("rejects tilde-expanded project paths that escape the home directory", () => {
    writeFileSync(
      configPath,
      [
        "port: 3000",
        "readyThresholdMs: 300000",
        "defaults:",
        "  runtime: tmux",
        "  agent: claude-code",
        "  workspace: worktree",
        "  notifiers: []",
        "projects:",
        "  escaped:",
        "    path: ~/../../../etc",
        "notifiers: {}",
        "notificationRouting: {}",
        "reactions: {}",
        "",
      ].join("\n"),
    );

    expect(() => loadGlobalConfig(configPath)).toThrow(/escapes the home directory/);
  });

  it("repairs a wrapped local project config into flat behavior-only config", () => {
    const repoPath = createRepo("wrapped-local", "https://github.com/OpenAI/demo.git");
    writeFileSync(
      join(repoPath, "agent-orchestrator.yaml"),
      [
        "projects:",
        "  wrapped-local:",
        `    path: ${repoPath}`,
        "    name: Wrapped Local",
        "    agent: codex",
        "    runtime: tmux",
        "",
      ].join("\n"),
    );

    repairWrappedLocalProjectConfig("wrapped-local", repoPath);

    const repaired = parseYaml(readFileSync(join(repoPath, "agent-orchestrator.yaml"), "utf-8"));
    expect(repaired).toEqual({
      agent: "codex",
      runtime: "tmux",
    });
  });

  it("repairs wrapped local .yml configs without creating a .yaml sibling", () => {
    const repoPath = createRepo("wrapped-local-yml", "https://github.com/OpenAI/demo.git");
    const configPathYml = join(repoPath, "agent-orchestrator.yml");
    writeFileSync(
      configPathYml,
      [
        "projects:",
        "  wrapped-local-yml:",
        `    path: ${repoPath}`,
        "    agent: codex",
        "    runtime: tmux",
        "",
      ].join("\n"),
    );

    repairWrappedLocalProjectConfig("wrapped-local-yml", repoPath);

    const repaired = parseYaml(readFileSync(configPathYml, "utf-8"));
    expect(repaired).toEqual({
      agent: "codex",
      runtime: "tmux",
    });
    expect(existsSync(join(repoPath, "agent-orchestrator.yaml"))).toBe(false);
  });

  it("registers a project successfully even when the existing config needs shadow-field cleanup", () => {
    const legacyRepoPath = createRepo("legacy", "https://github.com/OpenAI/legacy.git");
    const freshRepoPath = createRepo("fresh", "https://github.com/OpenAI/fresh.git");

    writeFileSync(
      configPath,
      [
        "port: 3000",
        "readyThresholdMs: 300000",
        "defaults:",
        "  runtime: tmux",
        "  agent: claude-code",
        "  workspace: worktree",
        "  notifiers: []",
        "projects:",
        "  legacy:",
        `    path: ${legacyRepoPath}`,
        "    name: Legacy",
        "    agent: codex",
        "    runtime: docker",
        "notifiers: {}",
        "notificationRouting: {}",
        "reactions: {}",
        "",
      ].join("\n"),
    );

    registerProjectInGlobalConfig("fresh", "Fresh", freshRepoPath, undefined, configPath);

    const config = loadGlobalConfig(configPath);
    const freshId = generateExternalId(freshRepoPath, "https://github.com/OpenAI/fresh.git");
    expect(config?.projects[freshId]).toMatchObject({
      projectId: freshId,
      displayName: "Fresh",
      path: freshRepoPath,
    });
    expect(config?.projects["legacy"]).not.toHaveProperty("agent");
    expect(config?.projects["legacy"]).not.toHaveProperty("runtime");
  });

  it("keeps registry-owned identity fields authoritative over local config overrides", () => {
    const repoPath = createRepo(
      "identity-authority",
      "https://github.com/OpenAI/identity-authority.git",
    );
    const projectId = registerProjectInGlobalConfig(
      "identity-authority",
      "Identity Authority",
      repoPath,
      undefined,
      configPath,
    );
    writeFileSync(
      join(repoPath, "agent-orchestrator.yaml"),
      [
        "repo: evil/override",
        "defaultBranch: develop",
        "agent: codex",
        "runtime: tmux",
        "workspace: worktree",
        "",
      ].join("\n"),
    );

    const resolved = resolveProjectIdentity(projectId, loadGlobalConfig(configPath)!, configPath);

    expect(resolved).toMatchObject({
      repo: "OpenAI/identity-authority",
      defaultBranch: "main",
      agent: "codex",
      runtime: "tmux",
    });
  });

  it("migrates central old-format configs into local behavior files for every project", () => {
    const repoA = createRepo("frontend", "https://github.com/OpenAI/frontend.git");
    const repoB = createRepo("backend", "https://github.com/OpenAI/backend.git");
    const oldConfigPath = join(tempRoot, "legacy-multi.yaml");

    writeFileSync(
      oldConfigPath,
      [
        "port: 3000",
        "readyThresholdMs: 300000",
        "projects:",
        "  frontend:",
        "    name: Frontend",
        `    path: ${repoA}`,
        "    agent: codex",
        "    tracker:",
        "      plugin: github",
        "  backend:",
        "    name: Backend",
        `    path: ${repoB}`,
        "    runtime: tmux",
        "    postCreate:",
        "      - pnpm install",
        "",
      ].join("\n"),
    );

    migrateToGlobalConfig(oldConfigPath, configPath);

    const frontendLocal = parseYaml(readFileSync(join(repoA, "legacy-multi.yaml"), "utf-8"));
    const backendLocal = parseYaml(readFileSync(join(repoB, "legacy-multi.yaml"), "utf-8"));

    expect(frontendLocal).toEqual({
      agent: "codex",
      tracker: { plugin: "github" },
    });
    expect(backendLocal).toEqual({
      runtime: "tmux",
      postCreate: ["pnpm install"],
    });
  });
});
