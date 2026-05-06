import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, findConfigFile, validateConfig } from "../src/config.js";
import { ConfigNotFoundError } from "../src/types.js";

describe("Config Loading", () => {
  let testDir: string;
  let originalCwd: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Create temp test directory
    testDir = join(tmpdir(), `ao-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    // Save original state
    originalCwd = process.cwd();
    originalEnv = { ...process.env };

    // Clear AO_CONFIG_PATH to ensure test isolation
    delete process.env.AO_CONFIG_PATH;
    delete process.env.AO_GLOBAL_CONFIG;
    process.env.HOME = testDir;
    process.env.XDG_CONFIG_HOME = join(testDir, ".config");

    // Change to test directory
    process.chdir(testDir);
  });

  afterEach(() => {
    // Restore original state
    process.chdir(originalCwd);
    process.env = originalEnv;

    // Cleanup test directory
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  });

  describe("findConfigFile", () => {
    it("should find config in current directory", () => {
      const configPath = join(testDir, "agent-orchestrator.yaml");
      writeFileSync(configPath, "projects: {}");

      const found = findConfigFile();
      // Use realpathSync to handle macOS /var -> /private/var symlink
      expect(realpathSync(found!)).toBe(realpathSync(configPath));
    });

    it("should prioritize AO_CONFIG_PATH env var", () => {
      // Create config in a different location
      const customDir = join(testDir, "custom");
      mkdirSync(customDir);
      const customConfig = join(customDir, "custom-config.yaml");
      writeFileSync(customConfig, "projects: {}");

      // Create config in current directory too
      const localConfig = join(testDir, "agent-orchestrator.yaml");
      writeFileSync(localConfig, "projects: {}");

      // Set env var to point to custom location
      process.env["AO_CONFIG_PATH"] = customConfig;

      const found = findConfigFile();
      expect(found).toBe(customConfig);
    });

    it("should return null if no config found", () => {
      const found = findConfigFile();
      expect(found).toBeNull();
    });
  });

  describe("loadConfig", () => {
    it("should accept and preserve a top-level $schema property", () => {
      const configPath = join(testDir, "schema-config.yaml");
      writeFileSync(
        configPath,
        `
$schema: https://raw.githubusercontent.com/ComposioHQ/agent-orchestrator/main/schema/config.schema.json
projects:
  test-project:
    repo: test/repo
    path: ${testDir}
    defaultBranch: main
`,
      );

      const config = loadConfig(configPath);
      expect(config["$schema"]).toBe(
        "https://raw.githubusercontent.com/ComposioHQ/agent-orchestrator/main/schema/config.schema.json",
      );
    });

    it("should load config from AO_CONFIG_PATH env var", () => {
      const configPath = join(testDir, "test-config.yaml");
      writeFileSync(
        configPath,
        `
port: 4000
projects:
  test-project:
    repo: test/repo
    path: ${testDir}
    defaultBranch: main
`,
      );

      process.env["AO_CONFIG_PATH"] = configPath;

      const config = loadConfig();
      expect(config.port).toBe(4000);
      expect(config.projects["test-project"]).toBeDefined();
    });

    it("should load config from explicit path parameter", () => {
      const configPath = join(testDir, "explicit-config.yaml");
      writeFileSync(
        configPath,
        `
port: 5000
projects:
  explicit-project:
    repo: test/repo
    path: ${testDir}
    defaultBranch: main
`,
      );

      const config = loadConfig(configPath);
      expect(config.port).toBe(5000);
    });

    it("should throw error if config not found", () => {
      expect(() => loadConfig()).toThrow(ConfigNotFoundError);
    });

    it("partitions degraded projects when loading the canonical global config", () => {
      const globalConfigPath = join(testDir, ".config", "agent-orchestrator", "config.yaml");
      const cleanPath = join(testDir, "clean-project");
      const brokenPath = join(testDir, "broken-project");
      mkdirSync(join(testDir, ".config", "agent-orchestrator"), { recursive: true });
      mkdirSync(cleanPath, { recursive: true });
      mkdirSync(brokenPath, { recursive: true });
      writeFileSync(
        join(cleanPath, "agent-orchestrator.yaml"),
        "agent: codex\nruntime: tmux\nworkspace: worktree\n",
      );
      writeFileSync(join(brokenPath, "agent-orchestrator.yaml"), "tracker: [\n");

      writeFileSync(
        globalConfigPath,
        [
          "port: 4000",
          "defaults:",
          "  runtime: tmux",
          "  agent: claude-code",
          "  workspace: worktree",
          "  notifiers: []",
          "projects:",
          "  clean-project:",
          "    projectId: clean-project",
          `    path: ${cleanPath}`,
          "    storageKey: abcabcabcabc",
          "    displayName: Clean Project",
          "    defaultBranch: main",
          "    sessionPrefix: clean",
          "  broken-project:",
          "    projectId: broken-project",
          `    path: ${brokenPath}`,
          "    storageKey: defdefdefdef",
          "    displayName: Broken Project",
          "    defaultBranch: main",
          "    sessionPrefix: broken",
          "notifiers: {}",
          "notificationRouting: {}",
          "reactions: {}",
          "",
        ].join("\n"),
      );

      const config = loadConfig(globalConfigPath);
      expect(Object.keys(config.projects)).toEqual(["clean-project"]);
      expect(config.projects["clean-project"]).toBeDefined();
      expect(config.degradedProjects["broken-project"]).toMatchObject({
        projectId: "broken-project",
        path: brokenPath,
        resolveError: expect.any(String),
      });
    });

    it("keeps config.projects safe to iterate when degraded projects exist", () => {
      const globalConfigPath = join(testDir, ".config", "agent-orchestrator", "config.yaml");
      const brokenPath = join(testDir, "broken-project");
      mkdirSync(join(testDir, ".config", "agent-orchestrator"), { recursive: true });
      mkdirSync(brokenPath, { recursive: true });
      writeFileSync(join(brokenPath, "agent-orchestrator.yaml"), "tracker: [\n");

      writeFileSync(
        globalConfigPath,
        [
          "port: 3000",
          "defaults:",
          "  runtime: tmux",
          "  agent: claude-code",
          "  workspace: worktree",
          "  notifiers: []",
          "projects:",
          "  broken-project:",
          "    projectId: broken-project",
          `    path: ${brokenPath}`,
          "    storageKey: deadbeefcafe",
          "    displayName: Broken Project",
          "    defaultBranch: main",
          "    sessionPrefix: broken",
          "notifiers: {}",
          "notificationRouting: {}",
          "reactions: {}",
          "",
        ].join("\n"),
      );

      const config = loadConfig(globalConfigPath);
      expect(Object.values(config.projects)).toEqual([]);
      expect(Object.values(config.degradedProjects)).toHaveLength(1);
    });
  });

  describe("Config Discovery Priority", () => {
    it("should use explicit path over env var", () => {
      const envConfig = join(testDir, "env-config.yaml");
      const explicitConfig = join(testDir, "explicit-config.yaml");

      writeFileSync(envConfig, "port: 3001\nprojects: {}");
      writeFileSync(explicitConfig, "port: 3002\nprojects: {}");

      process.env["AO_CONFIG_PATH"] = envConfig;

      const config = loadConfig(explicitConfig);
      expect(config.port).toBe(3002); // Should use explicit, not env
    });

    it("should use env var over default search", () => {
      const envConfig = join(testDir, "env-config.yaml");
      const localConfig = join(testDir, "agent-orchestrator.yaml");

      writeFileSync(envConfig, "port: 3001\nprojects: {}");
      writeFileSync(localConfig, "port: 3002\nprojects: {}");

      process.env["AO_CONFIG_PATH"] = envConfig;

      const config = loadConfig();
      expect(config.port).toBe(3001); // Should use env, not local
    });
  });

  describe("validateProjectUniqueness", () => {
    it("allows same path basename when projectIds differ", () => {
      expect(() =>
        validateConfig({
          projects: {
            alpha: {
              path: "/a/foo",
              defaultBranch: "main",
              sessionPrefix: "alpha",
              storageKey: "storage-alpha",
            },
            beta: {
              path: "/b/foo",
              defaultBranch: "main",
              sessionPrefix: "beta",
              storageKey: "storage-beta",
            },
          },
        }),
      ).not.toThrow();
    });

    it("fails when the config repeats the same projectId", () => {
      const configPath = join(testDir, "duplicate-project-id.yaml");
      writeFileSync(
        configPath,
        [
          "projects:",
          "  foo:",
          "    path: /a/foo",
          "    defaultBranch: main",
          "    sessionPrefix: alpha",
          "    storageKey: storage-alpha",
          "  foo:",
          "    path: /b/foo",
          "    defaultBranch: main",
          "    sessionPrefix: beta",
          "    storageKey: storage-beta",
          "",
        ].join("\n"),
      );

      expect(() => loadConfig(configPath)).toThrow(/Map keys must be unique|Duplicate project ID/);
    });

  });
});
