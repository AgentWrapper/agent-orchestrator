import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPluginRegistry } from "../plugin-registry.js";
import type { PluginModule, PluginManifest, OrchestratorConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlugin(slot: PluginManifest["slot"], name: string): PluginModule {
  return {
    manifest: {
      name,
      slot,
      description: `Test ${slot} plugin: ${name}`,
      version: "0.0.1",
    },
    create: vi.fn((config?: Record<string, unknown>) => ({
      name,
      _config: config,
    })),
  };
}

function makeOrchestratorConfig(overrides?: Partial<OrchestratorConfig>): OrchestratorConfig {
  return {
    projects: {},
    ...overrides,
  } as OrchestratorConfig;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createPluginRegistry", () => {
  it("returns a registry object", () => {
    const registry = createPluginRegistry();
    expect(registry).toHaveProperty("register");
    expect(registry).toHaveProperty("get");
    expect(registry).toHaveProperty("list");
    expect(registry).toHaveProperty("loadBuiltins");
    expect(registry).toHaveProperty("loadFromConfig");
  });
});

describe("register + get", () => {
  it("registers and retrieves a plugin", () => {
    const registry = createPluginRegistry();
    const plugin = makePlugin("runtime", "tmux");

    registry.register(plugin);

    const instance = registry.get<{ name: string }>("runtime", "tmux");
    expect(instance).not.toBeNull();
    expect(instance!.name).toBe("tmux");
  });

  it("returns null for unregistered plugin", () => {
    const registry = createPluginRegistry();
    expect(registry.get("runtime", "nonexistent")).toBeNull();
  });

  it("passes config to plugin create()", () => {
    const registry = createPluginRegistry();
    const plugin = makePlugin("workspace", "worktree");

    registry.register(plugin, { worktreeDir: "/custom/path" });

    expect(plugin.create).toHaveBeenCalledWith({ worktreeDir: "/custom/path" });
    const instance = registry.get<{ _config: Record<string, unknown> }>("workspace", "worktree");
    expect(instance!._config).toEqual({ worktreeDir: "/custom/path" });
  });

  it("overwrites previously registered plugin with same slot:name", () => {
    const registry = createPluginRegistry();
    const plugin1 = makePlugin("runtime", "tmux");
    const plugin2 = makePlugin("runtime", "tmux");

    registry.register(plugin1);
    registry.register(plugin2);

    // Should call create on both
    expect(plugin1.create).toHaveBeenCalledTimes(1);
    expect(plugin2.create).toHaveBeenCalledTimes(1);

    // get() returns the latest
    const instance = registry.get<{ name: string }>("runtime", "tmux");
    expect(instance).not.toBeNull();
  });

  it("registers plugins in different slots independently", () => {
    const registry = createPluginRegistry();
    const runtimePlugin = makePlugin("runtime", "tmux");
    const workspacePlugin = makePlugin("workspace", "worktree");

    registry.register(runtimePlugin);
    registry.register(workspacePlugin);

    expect(registry.get("runtime", "tmux")).not.toBeNull();
    expect(registry.get("workspace", "worktree")).not.toBeNull();
    expect(registry.get("runtime", "worktree")).toBeNull();
    expect(registry.get("workspace", "tmux")).toBeNull();
  });
});

describe("list", () => {
  it("lists plugins in a given slot", () => {
    const registry = createPluginRegistry();
    registry.register(makePlugin("runtime", "tmux"));
    registry.register(makePlugin("runtime", "process"));
    registry.register(makePlugin("workspace", "worktree"));

    const runtimes = registry.list("runtime");
    expect(runtimes).toHaveLength(2);
    expect(runtimes.map((m) => m.name)).toContain("tmux");
    expect(runtimes.map((m) => m.name)).toContain("process");
  });

  it("returns empty array for slot with no plugins", () => {
    const registry = createPluginRegistry();
    expect(registry.list("notifier")).toEqual([]);
  });

  it("does not return plugins from other slots", () => {
    const registry = createPluginRegistry();
    registry.register(makePlugin("runtime", "tmux"));

    expect(registry.list("workspace")).toEqual([]);
  });
});

describe("loadBuiltins", () => {
  it("silently skips unavailable packages", async () => {
    const registry = createPluginRegistry();
    const importUnavailable = async (pkg: string): Promise<unknown> => {
      throw new Error(`Not found: ${pkg}`);
    };

    await expect(registry.loadBuiltins(undefined, importUnavailable)).resolves.toBeUndefined();
  });

  it("registers multiple agent plugins from importFn", async () => {
    const registry = createPluginRegistry();

    const fakeClaudeCode = makePlugin("agent", "claude-code");
    const fakeCodex = makePlugin("agent", "codex");
    const fakeOpenCode = makePlugin("agent", "opencode");
    const fakeHermes = makePlugin("agent", "hermes");

    await registry.loadBuiltins(undefined, async (pkg: string) => {
      if (pkg === "@aoagents/ao-plugin-agent-claude-code") return fakeClaudeCode;
      if (pkg === "@aoagents/ao-plugin-agent-codex") return fakeCodex;
      if (pkg === "@aoagents/ao-plugin-agent-opencode") return fakeOpenCode;
      if (pkg === "@aoagents/ao-plugin-agent-hermes") return fakeHermes;
      throw new Error(`Not found: ${pkg}`);
    });

    const agents = registry.list("agent");
    expect(agents).toContainEqual(expect.objectContaining({ name: "claude-code", slot: "agent" }));
    expect(agents).toContainEqual(expect.objectContaining({ name: "codex", slot: "agent" }));
    expect(agents).toContainEqual(expect.objectContaining({ name: "opencode", slot: "agent" }));
    expect(agents).toContainEqual(expect.objectContaining({ name: "hermes", slot: "agent" }));

    expect(registry.get("agent", "codex")).not.toBeNull();
    expect(registry.get("agent", "claude-code")).not.toBeNull();
    expect(registry.get("agent", "opencode")).not.toBeNull();
    expect(registry.get("agent", "hermes")).not.toBeNull();
  });

  it("registers gitlab tracker and scm plugins from importFn", async () => {
    const registry = createPluginRegistry();

    const fakeTracker = makePlugin("tracker", "gitlab");
    const fakeScm = makePlugin("scm", "gitlab");

    await registry.loadBuiltins(undefined, async (pkg: string) => {
      if (pkg === "@aoagents/ao-plugin-tracker-gitlab") return fakeTracker;
      if (pkg === "@aoagents/ao-plugin-scm-gitlab") return fakeScm;
      throw new Error(`Not found: ${pkg}`);
    });

    expect(registry.list("tracker")).toContainEqual(
      expect.objectContaining({ name: "gitlab", slot: "tracker" }),
    );
    expect(registry.list("scm")).toContainEqual(
      expect.objectContaining({ name: "gitlab", slot: "scm" }),
    );
  });

  it("passes configured notifier plugin config to create()", async () => {
    const registry = createPluginRegistry();
    const fakeWebhookNotifier = makePlugin("notifier", "webhook");
    const config = makeOrchestratorConfig({
      notifiers: {
        webhook: {
          plugin: "webhook",
          url: "http://127.0.0.1:8787/hook",
          retries: 2,
          retryDelayMs: 500,
        },
      },
    });

    await registry.loadBuiltins(config, async (pkg: string) => {
      if (pkg === "@aoagents/ao-plugin-notifier-webhook") return fakeWebhookNotifier;
      throw new Error(`Not found: ${pkg}`);
    });

    expect(fakeWebhookNotifier.create).toHaveBeenCalledWith({
      url: "http://127.0.0.1:8787/hook",
      retries: 2,
      retryDelayMs: 500,
    });
  });

  it("matches notifier config by plugin name instead of instance key", async () => {
    const registry = createPluginRegistry();
    const fakeWebhookNotifier = makePlugin("notifier", "webhook");
    const config = makeOrchestratorConfig({
      notifiers: {
        "my-webhook": {
          plugin: "webhook",
          url: "http://127.0.0.1:8787/custom-hook",
          retries: 4,
        },
      },
    });

    await registry.loadBuiltins(config, async (pkg: string) => {
      if (pkg === "@aoagents/ao-plugin-notifier-webhook") return fakeWebhookNotifier;
      throw new Error(`Not found: ${pkg}`);
    });

    expect(fakeWebhookNotifier.create).toHaveBeenCalledWith({
      url: "http://127.0.0.1:8787/custom-hook",
      retries: 4,
    });
  });

  it("registers alias-specific notifier instances for the same plugin", async () => {
    const registry = createPluginRegistry();
    const fakeSlackNotifier = makePlugin("notifier", "slack");
    const config = makeOrchestratorConfig({
      configPath: "/test/config.yaml",
      notifiers: {
        alerts: {
          plugin: "slack",
          webhookUrl: "https://hooks.slack.com/services/alerts",
          channel: "#alerts",
        },
        ops: {
          plugin: "slack",
          webhookUrl: "https://hooks.slack.com/services/ops",
          channel: "#ops",
        },
      },
    });

    await registry.loadBuiltins(config, async (pkg: string) => {
      if (pkg === "@aoagents/ao-plugin-notifier-slack") return fakeSlackNotifier;
      throw new Error(`Not found: ${pkg}`);
    });

    expect(fakeSlackNotifier.create).toHaveBeenCalledTimes(2);
    expect(
      registry.get<{ _config: Record<string, unknown> }>("notifier", "alerts")?._config,
    ).toEqual({
      webhookUrl: "https://hooks.slack.com/services/alerts",
      channel: "#alerts",
      configPath: "/test/config.yaml",
    });
    expect(registry.get<{ _config: Record<string, unknown> }>("notifier", "ops")?._config).toEqual({
      webhookUrl: "https://hooks.slack.com/services/ops",
      channel: "#ops",
      configPath: "/test/config.yaml",
    });
    expect(registry.get("notifier", "slack")).not.toBeNull();
    expect(registry.list("notifier")).toContainEqual(
      expect.objectContaining({ name: "slack", slot: "notifier" }),
    );
    expect(registry.list("notifier")).toHaveLength(1);
  });

  it("prefers the notifier id matching the plugin name for direct plugin lookups", async () => {
    const registry = createPluginRegistry();
    const fakeSlackNotifier = makePlugin("notifier", "slack");
    const config = makeOrchestratorConfig({
      configPath: "/test/config.yaml",
      notifiers: {
        slack: {
          plugin: "slack",
          webhookUrl: "https://hooks.slack.com/services/default",
          channel: "#general",
        },
        alerts: {
          plugin: "slack",
          webhookUrl: "https://hooks.slack.com/services/alerts",
          channel: "#alerts",
        },
      },
    });

    await registry.loadBuiltins(config, async (pkg: string) => {
      if (pkg === "@aoagents/ao-plugin-notifier-slack") return fakeSlackNotifier;
      throw new Error(`Not found: ${pkg}`);
    });

    expect(
      registry.get<{ _config: Record<string, unknown> }>("notifier", "slack")?._config,
    ).toEqual({
      webhookUrl: "https://hooks.slack.com/services/default",
      channel: "#general",
      configPath: "/test/config.yaml",
    });
    expect(
      registry.get<{ _config: Record<string, unknown> }>("notifier", "alerts")?._config,
    ).toEqual({
      webhookUrl: "https://hooks.slack.com/services/alerts",
      channel: "#alerts",
      configPath: "/test/config.yaml",
    });
  });

  it("passes notifier config from config.notifiers when loading builtins", async () => {
    const registry = createPluginRegistry();
    const fakeOpenClaw = makePlugin("notifier", "openclaw");
    const cfg = makeOrchestratorConfig({
      notifiers: {
        openclaw: {
          plugin: "openclaw",
          url: "http://127.0.0.1:18789/hooks/agent",
          token: "tok",
        },
      },
    });

    await registry.loadBuiltins(cfg, async (pkg: string) => {
      if (pkg === "@aoagents/ao-plugin-notifier-openclaw") return fakeOpenClaw;
      throw new Error(`Not found: ${pkg}`);
    });

    expect(fakeOpenClaw.create).toHaveBeenCalledWith({
      url: "http://127.0.0.1:18789/hooks/agent",
      token: "tok",
    });
  });

  it("strips package loading metadata from notifier config", async () => {
    const registry = createPluginRegistry();
    const fakeWebhook = makePlugin("notifier", "webhook");
    const cfg = makeOrchestratorConfig({
      configPath: "/test/config.yaml",
      notifiers: {
        mywebhook: {
          plugin: "webhook",
          // package field is allowed for resolution but should be stripped:
          package: "@aoagents/ao-plugin-notifier-webhook",
          // These are plugin-specific fields that should be passed through:
          url: "https://webhook.example.com/notify",
          retries: 3,
        },
      },
    });

    await registry.loadBuiltins(cfg, async (pkg: string) => {
      if (pkg === "@aoagents/ao-plugin-notifier-webhook") return fakeWebhook;
      throw new Error(`Not found: ${pkg}`);
    });

    // Loading metadata (package) should be stripped to prevent leakage
    // Plugin-specific fields (url, retries) should be passed through
    expect(fakeWebhook.create).toHaveBeenCalledWith({
      url: "https://webhook.example.com/notify",
      retries: 3,
      configPath: "/test/config.yaml",
    });
  });

  it("warns and skips when path is used alongside plugin name in notifier config", async () => {
    const registry = createPluginRegistry();
    const fakeWebhook = makePlugin("notifier", "webhook");
    const cfg = makeOrchestratorConfig({
      notifiers: {
        mywebhook: {
          plugin: "webhook",
          path: "./some/path", // This triggers the collision check
        },
      },
    });

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await registry.loadBuiltins(cfg, async (pkg: string) => {
      if (pkg === "@aoagents/ao-plugin-notifier-webhook") return fakeWebhook;
      return null;
    });

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('"path" field conflicts with reserved'),
    );
    stderrSpy.mockRestore();

    // Plugin should not be registered due to config error
    expect(registry.get("notifier", "webhook")).toBeNull();
  });

  it("does not match notifier key when explicit plugin points to another notifier", async () => {
    const registry = createPluginRegistry();
    const fakeOpenClaw = makePlugin("notifier", "openclaw");
    const fakeWebhook = makePlugin("notifier", "webhook");
    const cfg = makeOrchestratorConfig({
      notifiers: {
        openclaw: {
          plugin: "webhook",
          url: "http://127.0.0.1:8787/hook",
          retries: 3,
        },
      },
    });

    await registry.loadBuiltins(cfg, async (pkg: string) => {
      if (pkg === "@aoagents/ao-plugin-notifier-openclaw") return fakeOpenClaw;
      if (pkg === "@aoagents/ao-plugin-notifier-webhook") return fakeWebhook;
      throw new Error(`Not found: ${pkg}`);
    });

    expect(fakeOpenClaw.create).toHaveBeenCalledWith(undefined);
    expect(fakeWebhook.create).toHaveBeenCalledWith({
      url: "http://127.0.0.1:8787/hook",
      retries: 3,
    });
  });

  it("should use provided importFn instead of built-in import", async () => {
    const registry = createPluginRegistry();
    const importedPackages: string[] = [];

    const fakeImportFn = async (pkg: string): Promise<unknown> => {
      importedPackages.push(pkg);
      // Return a valid plugin module for runtime-tmux
      if (pkg === "@aoagents/ao-plugin-runtime-tmux") {
        return {
          manifest: { name: "tmux", slot: "runtime", description: "test", version: "0.0.0" },
          create: () => ({ name: "tmux" }),
        };
      }
      // Throw for everything else to simulate not-installed
      throw new Error(`Module not found: ${pkg}`);
    };

    await registry.loadBuiltins(undefined, fakeImportFn);

    // importFn should have been called for all builtin plugins
    expect(importedPackages.length).toBeGreaterThan(0);
    expect(importedPackages).toContain("@aoagents/ao-plugin-runtime-tmux");

    // The tmux plugin should be registered
    const tmux = registry.get("runtime", "tmux");
    expect(tmux).not.toBeNull();
  });
});

describe("extractPluginConfig (via register with config)", () => {
  // extractPluginConfig is tested indirectly: we verify that register()
  // correctly passes config through, and that loadBuiltins() would call
  // extractPluginConfig for known slot:name pairs. The actual config
  // forwarding logic is validated in workspace plugin unit tests.

  it("register passes config to plugin create()", () => {
    const registry = createPluginRegistry();
    const plugin = makePlugin("workspace", "worktree");

    registry.register(plugin, { worktreeDir: "/custom/path" });

    expect(plugin.create).toHaveBeenCalledWith({ worktreeDir: "/custom/path" });
  });

  it("register passes undefined config when none provided", () => {
    const registry = createPluginRegistry();
    const plugin = makePlugin("workspace", "clone");

    registry.register(plugin);

    expect(plugin.create).toHaveBeenCalledWith(undefined);
  });
});

describe("loadFromConfig", () => {
  it("does not throw when no plugins are importable", async () => {
    const registry = createPluginRegistry();
    const config = makeOrchestratorConfig({});
    const importUnavailable = async (pkg: string): Promise<unknown> => {
      throw new Error(`Not found: ${pkg}`);
    };

    await expect(registry.loadFromConfig(config, importUnavailable)).resolves.toBeUndefined();
  });

  it("should pass importFn through loadFromConfig to loadBuiltins", async () => {
    const registry = createPluginRegistry();
    const config = makeOrchestratorConfig({});
    const importedPackages: string[] = [];

    const fakeImportFn = async (pkg: string): Promise<unknown> => {
      importedPackages.push(pkg);
      throw new Error(`Not found: ${pkg}`);
    };

    await registry.loadFromConfig(config, fakeImportFn);

    // Should have attempted to import builtin plugins via the provided importFn
    expect(importedPackages.length).toBeGreaterThan(0);
    expect(importedPackages).toContain("@aoagents/ao-plugin-runtime-tmux");
  });

  it("loads external package plugins from config.plugins", async () => {
    const registry = createPluginRegistry();
    const agentPlugin = makePlugin("agent", "goose");
    const config = makeOrchestratorConfig({
      configPath: "/tmp/agent-orchestrator.yaml",
      plugins: [
        {
          name: "goose",
          source: "npm",
          package: "@example/ao-plugin-agent-goose",
        },
      ],
    });

    await registry.loadFromConfig(config, async (specifier: string) => {
      if (specifier === "@example/ao-plugin-agent-goose") {
        return { default: agentPlugin };
      }
      throw new Error(`Not found: ${specifier}`);
    });

    expect(registry.list("agent")).toContainEqual(
      expect.objectContaining({ name: "goose", slot: "agent" }),
    );
    expect(registry.get("agent", "goose")).not.toBeNull();
  });

  it("loads local plugins relative to the config file", async () => {
    const registry = createPluginRegistry();
    const tmpConfigDir = mkdtempSync(join(tmpdir(), "ao-plugin-registry-"));
    const localPluginDir = join(tmpConfigDir, "plugins", "role-qa");
    mkdirSync(join(localPluginDir, "dist"), { recursive: true });
    writeFileSync(join(localPluginDir, "dist", "index.js"), "export default {};\n");
    writeFileSync(
      join(localPluginDir, "package.json"),
      JSON.stringify({ name: "role-qa", main: "dist/index.js" }),
    );

    const config = makeOrchestratorConfig({
      configPath: join(tmpConfigDir, "agent-orchestrator.yaml"),
      plugins: [
        {
          name: "gitlab-plus",
          source: "local",
          path: "./plugins/role-qa",
        },
      ],
    });

    let importedSpecifier = "";
    await registry.loadFromConfig(config, async (specifier: string) => {
      if (specifier.startsWith("file:")) {
        importedSpecifier = specifier;
        return makePlugin("tracker", "gitlab-plus");
      }
      throw new Error(`Not found: ${specifier}`);
    });

    expect(importedSpecifier).toContain("/plugins/role-qa/dist/index.js");
    expect(registry.get("tracker", "gitlab-plus")).not.toBeNull();
  });

  it("skips disabled external plugins", async () => {
    const registry = createPluginRegistry();
    const config = makeOrchestratorConfig({
      configPath: "/tmp/agent-orchestrator.yaml",
      plugins: [
        {
          name: "goose",
          source: "npm",
          package: "@example/ao-plugin-agent-goose",
          enabled: false,
        },
      ],
    });
    const importFn = vi.fn(async (_specifier: string) => {
      throw new Error("should not import disabled plugin");
    });

    await registry.loadFromConfig(config, importFn);

    expect(importFn).not.toHaveBeenCalledWith("@example/ao-plugin-agent-goose");
    expect(registry.get("agent", "goose")).toBeNull();
  });
});

describe("External plugin manifest validation", () => {
  it("accepts matching manifest.name and expectedPluginName", async () => {
    const registry = createPluginRegistry();

    const mockPlugin = {
      manifest: {
        name: "jira",
        slot: "tracker" as const,
        version: "1.0.0",
        description: "Jira tracker",
      },
      create: vi.fn(() => ({})),
    };

    const importFn = vi.fn(async () => mockPlugin);

    const config = makeOrchestratorConfig({
      configPath: "/test/config.yaml",
      plugins: [
        { name: "jira", source: "npm", package: "@acme/ao-plugin-tracker-jira", enabled: true },
      ],
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          name: "proj1",
          defaultBranch: "main",
          sessionPrefix: "test",
          tracker: { plugin: "jira", package: "@acme/ao-plugin-tracker-jira" },
        },
      },
      _externalPluginEntries: [
        {
          source: "projects.proj1.tracker",
          location: { kind: "project", projectId: "proj1", configType: "tracker" },
          slot: "tracker",
          package: "@acme/ao-plugin-tracker-jira",
          expectedPluginName: "jira",
        },
      ],
    });

    // Should not throw
    await registry.loadFromConfig(config, importFn);
    expect(registry.get("tracker", "jira")).not.toBeNull();
  });

  it("warns when manifest.name does not match expectedPluginName but still registers plugin", async () => {
    const registry = createPluginRegistry();

    const mockPlugin = {
      manifest: {
        name: "jira-enterprise",
        slot: "tracker" as const,
        version: "1.0.0",
        description: "Jira Enterprise",
      },
      create: vi.fn(() => ({})),
    };

    const importFn = vi.fn(async () => mockPlugin);

    const config = makeOrchestratorConfig({
      configPath: "/test/config.yaml",
      plugins: [
        { name: "jira", source: "npm", package: "@acme/ao-plugin-tracker-jira", enabled: true },
      ],
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          name: "proj1",
          defaultBranch: "main",
          sessionPrefix: "test",
          tracker: { plugin: "jira", package: "@acme/ao-plugin-tracker-jira" },
        },
      },
      _externalPluginEntries: [
        {
          source: "projects.proj1.tracker",
          location: { kind: "project", projectId: "proj1", configType: "tracker" },
          slot: "tracker",
          package: "@acme/ao-plugin-tracker-jira",
          expectedPluginName: "jira",
        },
      ],
    });

    // Should warn about validation failure but still register the plugin
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await registry.loadFromConfig(config, importFn);

    // Plugin should still be registered under its manifest.name
    expect(registry.get("tracker", "jira-enterprise")).not.toBeNull();

    // Should have logged a validation warning
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("Config validation failed for projects.proj1.tracker"),
    );
    stderrSpy.mockRestore();
  });

  it("infers plugin name when expectedPluginName is not specified", async () => {
    const registry = createPluginRegistry();

    const mockPlugin = {
      manifest: {
        name: "jira",
        slot: "tracker" as const,
        version: "1.0.0",
        description: "Jira tracker",
      },
      create: vi.fn(() => ({})),
    };

    const importFn = vi.fn(async () => mockPlugin);

    const config = makeOrchestratorConfig({
      configPath: "/test/config.yaml",
      plugins: [
        { name: "jira", source: "npm", package: "@acme/ao-plugin-tracker-jira", enabled: true },
      ],
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          name: "proj1",
          defaultBranch: "main",
          sessionPrefix: "test",
          // Plugin field will be updated with manifest.name
          tracker: { plugin: "jira", package: "@acme/ao-plugin-tracker-jira" },
        },
      },
      _externalPluginEntries: [
        {
          source: "projects.proj1.tracker",
          location: { kind: "project", projectId: "proj1", configType: "tracker" },
          slot: "tracker",
          package: "@acme/ao-plugin-tracker-jira",
          // No expectedPluginName - should accept any manifest.name
        },
      ],
    });

    await registry.loadFromConfig(config, importFn);

    // Plugin should be registered under manifest.name
    expect(registry.get("tracker", "jira")).not.toBeNull();
    // Config should be updated with actual manifest.name
    expect(config.projects.proj1.tracker?.plugin).toBe("jira");
  });

  it("updates config with actual manifest.name for notifiers", async () => {
    const registry = createPluginRegistry();

    const mockPlugin = {
      manifest: {
        name: "ms-teams",
        slot: "notifier" as const,
        version: "1.0.0",
        description: "Teams notifier",
      },
      create: vi.fn(() => ({})),
    };

    const importFn = vi.fn(async () => mockPlugin);

    const config = makeOrchestratorConfig({
      configPath: "/test/config.yaml",
      plugins: [
        { name: "teams", source: "npm", package: "@acme/ao-plugin-notifier-teams", enabled: true },
      ],
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          name: "proj1",
          defaultBranch: "main",
          sessionPrefix: "test",
        },
      },
      notifiers: {
        myteams: { plugin: "teams", package: "@acme/ao-plugin-notifier-teams" },
      },
      _externalPluginEntries: [
        {
          source: "notifiers.myteams",
          location: { kind: "notifier", notifierId: "myteams" },
          slot: "notifier",
          package: "@acme/ao-plugin-notifier-teams",
          // No expectedPluginName - will accept any manifest.name
        },
      ],
    });

    await registry.loadFromConfig(config, importFn);

    // Config should be updated with actual manifest.name
    expect(config.notifiers?.myteams?.plugin).toBe("ms-teams");
    // Plugin should be registered under manifest.name
    expect(registry.get("notifier", "ms-teams")).not.toBeNull();
  });

  it("passes notifier config to plugin even when manifest name differs from temp name", async () => {
    const registry = createPluginRegistry();

    const mockPlugin = {
      manifest: {
        name: "ms-teams",
        slot: "notifier" as const,
        version: "1.0.0",
        description: "Teams notifier",
      },
      create: vi.fn(() => ({})),
    };

    const importFn = vi.fn(async () => mockPlugin);

    const config = makeOrchestratorConfig({
      configPath: "/test/config.yaml",
      plugins: [
        // Temp name is "teams" (from package name), but manifest.name is "ms-teams"
        { name: "teams", source: "npm", package: "@acme/ao-plugin-notifier-teams", enabled: true },
      ],
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          name: "proj1",
          defaultBranch: "main",
          sessionPrefix: "test",
        },
      },
      notifiers: {
        myteams: {
          plugin: "teams", // Temp name - will be updated to "ms-teams"
          package: "@acme/ao-plugin-notifier-teams",
          webhookUrl: "https://teams.webhook.url/abc123",
          channel: "#alerts",
        },
      },
      _externalPluginEntries: [
        {
          source: "notifiers.myteams",
          location: { kind: "notifier", notifierId: "myteams" },
          slot: "notifier",
          package: "@acme/ao-plugin-notifier-teams",
          // No expectedPluginName - config.plugin will be updated to manifest.name
        },
      ],
    });

    await registry.loadFromConfig(config, importFn);

    // Config should be updated BEFORE extractPluginConfig is called
    expect(config.notifiers?.myteams?.plugin).toBe("ms-teams");

    // Plugin should receive its config (webhookUrl, channel) despite name mismatch
    expect(mockPlugin.create).toHaveBeenCalledWith({
      webhookUrl: "https://teams.webhook.url/abc123",
      channel: "#alerts",
      configPath: "/test/config.yaml",
    });

    // Plugin should be registered
    expect(registry.get("notifier", "ms-teams")).not.toBeNull();
  });

  it("registers external notifier aliases separately after manifest name resolution", async () => {
    const registry = createPluginRegistry();

    const mockPlugin = {
      manifest: {
        name: "ms-teams",
        slot: "notifier" as const,
        version: "1.0.0",
        description: "Teams notifier",
      },
      create: vi.fn((pluginConfig?: Record<string, unknown>) => ({
        name: "ms-teams",
        _config: pluginConfig,
      })),
    };

    const importFn = vi.fn(async () => mockPlugin);

    const config = makeOrchestratorConfig({
      configPath: "/test/config.yaml",
      plugins: [
        { name: "teams", source: "npm", package: "@acme/ao-plugin-notifier-teams", enabled: true },
      ],
      projects: {},
      notifiers: {
        alerts: {
          plugin: "teams",
          package: "@acme/ao-plugin-notifier-teams",
          webhookUrl: "https://teams.example/alerts",
        },
        ops: {
          plugin: "teams",
          package: "@acme/ao-plugin-notifier-teams",
          webhookUrl: "https://teams.example/ops",
        },
      },
      _externalPluginEntries: [
        {
          source: "notifiers.alerts",
          location: { kind: "notifier", notifierId: "alerts" },
          slot: "notifier",
          package: "@acme/ao-plugin-notifier-teams",
        },
        {
          source: "notifiers.ops",
          location: { kind: "notifier", notifierId: "ops" },
          slot: "notifier",
          package: "@acme/ao-plugin-notifier-teams",
        },
      ],
    });

    await registry.loadFromConfig(config, importFn);

    expect(config.notifiers?.alerts?.plugin).toBe("ms-teams");
    expect(config.notifiers?.ops?.plugin).toBe("ms-teams");
    expect(
      registry.get<{ _config: Record<string, unknown> }>("notifier", "alerts")?._config,
    ).toEqual({
      webhookUrl: "https://teams.example/alerts",
      configPath: "/test/config.yaml",
    });
    expect(registry.get<{ _config: Record<string, unknown> }>("notifier", "ops")?._config).toEqual({
      webhookUrl: "https://teams.example/ops",
      configPath: "/test/config.yaml",
    });
    expect(registry.get("notifier", "ms-teams")).not.toBeNull();
  });

  it("warns when plugin slot does not match config slot", async () => {
    const registry = createPluginRegistry();

    const mockPlugin = {
      manifest: {
        name: "jira",
        slot: "notifier" as const,
        version: "1.0.0",
        description: "Wrong slot!",
      },
      create: vi.fn(() => ({})),
    };

    const importFn = vi.fn(async () => mockPlugin);

    const config = makeOrchestratorConfig({
      configPath: "/test/config.yaml",
      plugins: [
        { name: "jira", source: "npm", package: "@acme/ao-plugin-tracker-jira", enabled: true },
      ],
      projects: {
        proj1: {
          path: "/repos/test",
          repo: "org/test",
          name: "proj1",
          defaultBranch: "main",
          sessionPrefix: "test",
          tracker: { plugin: "jira", package: "@acme/ao-plugin-tracker-jira" },
        },
      },
      _externalPluginEntries: [
        {
          source: "projects.proj1.tracker",
          location: { kind: "project", projectId: "proj1", configType: "tracker" },
          slot: "tracker", // Expected tracker
          package: "@acme/ao-plugin-tracker-jira",
        },
      ],
    });

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await registry.loadFromConfig(config, importFn);

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('has slot "notifier" but was configured as "tracker"'),
    );
    stderrSpy.mockRestore();
  });

  it("updates all projects sharing same external plugin with manifest.name", async () => {
    const registry = createPluginRegistry();

    const mockPlugin = {
      manifest: {
        name: "jira-cloud",
        slot: "tracker" as const,
        version: "1.0.0",
        description: "Jira Cloud",
      },
      create: vi.fn(() => ({})),
    };

    const importFn = vi.fn(async () => mockPlugin);

    const config = makeOrchestratorConfig({
      configPath: "/test/config.yaml",
      plugins: [
        { name: "jira", source: "npm", package: "@acme/ao-plugin-tracker-jira", enabled: true },
      ],
      projects: {
        proj1: {
          path: "/repos/test1",
          repo: "org/test1",
          name: "proj1",
          defaultBranch: "main",
          sessionPrefix: "test1",
          tracker: { plugin: "jira", package: "@acme/ao-plugin-tracker-jira" },
        },
        proj2: {
          path: "/repos/test2",
          repo: "org/test2",
          name: "proj2",
          defaultBranch: "main",
          sessionPrefix: "test2",
          // Same external plugin as proj1
          tracker: { plugin: "jira", package: "@acme/ao-plugin-tracker-jira" },
        },
      },
      _externalPluginEntries: [
        {
          source: "projects.proj1.tracker",
          location: { kind: "project", projectId: "proj1", configType: "tracker" },
          slot: "tracker",
          package: "@acme/ao-plugin-tracker-jira",
          // No expectedPluginName - will accept any manifest.name
        },
        {
          source: "projects.proj2.tracker",
          location: { kind: "project", projectId: "proj2", configType: "tracker" },
          slot: "tracker",
          package: "@acme/ao-plugin-tracker-jira",
          // No expectedPluginName - will accept any manifest.name
        },
      ],
    });

    await registry.loadFromConfig(config, importFn);

    // Both projects should be updated with the actual manifest.name
    expect(config.projects.proj1.tracker?.plugin).toBe("jira-cloud");
    expect(config.projects.proj2.tracker?.plugin).toBe("jira-cloud");
    // Plugin should be registered under manifest.name
    expect(registry.get("tracker", "jira-cloud")).not.toBeNull();
  });

  it("registers plugin even when one project has misconfigured expectedPluginName", async () => {
    const registry = createPluginRegistry();

    const mockPlugin = {
      manifest: {
        name: "jira-cloud",
        slot: "tracker" as const,
        version: "1.0.0",
        description: "Jira Cloud",
      },
      create: vi.fn(() => ({})),
    };

    const importFn = vi.fn(async () => mockPlugin);

    const config = makeOrchestratorConfig({
      configPath: "/test/config.yaml",
      plugins: [
        { name: "jira", source: "npm", package: "@acme/ao-plugin-tracker-jira", enabled: true },
      ],
      projects: {
        proj1: {
          path: "/repos/test1",
          repo: "org/test1",
          name: "proj1",
          defaultBranch: "main",
          sessionPrefix: "test1",
          tracker: { plugin: "jira", package: "@acme/ao-plugin-tracker-jira" },
        },
        proj2: {
          path: "/repos/test2",
          repo: "org/test2",
          name: "proj2",
          defaultBranch: "main",
          sessionPrefix: "test2",
          // Same external plugin but with WRONG explicit plugin name
          tracker: { plugin: "wrong-name", package: "@acme/ao-plugin-tracker-jira" },
        },
      },
      _externalPluginEntries: [
        {
          source: "projects.proj1.tracker",
          location: { kind: "project", projectId: "proj1", configType: "tracker" },
          slot: "tracker",
          package: "@acme/ao-plugin-tracker-jira",
          // No expectedPluginName - will accept any manifest.name
        },
        {
          source: "projects.proj2.tracker",
          location: { kind: "project", projectId: "proj2", configType: "tracker" },
          slot: "tracker",
          package: "@acme/ao-plugin-tracker-jira",
          expectedPluginName: "wrong-name", // Mismatches manifest.name "jira-cloud"
        },
      ],
    });

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await registry.loadFromConfig(config, importFn);

    // Plugin should STILL be registered despite proj2's misconfiguration
    expect(registry.get("tracker", "jira-cloud")).not.toBeNull();

    // proj1 should be updated correctly (no expectedPluginName = accepts any)
    expect(config.projects.proj1.tracker?.plugin).toBe("jira-cloud");

    // proj2's config should NOT be updated (validation failed)
    expect(config.projects.proj2.tracker?.plugin).toBe("wrong-name");

    // Should have logged a warning about proj2's validation failure
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("Config validation failed for projects.proj2.tracker"),
    );

    stderrSpy.mockRestore();
  });
});
