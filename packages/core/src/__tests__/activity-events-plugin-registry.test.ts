import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginRegistry } from "../plugin-registry.js";
import { recordActivityEvent } from "../activity-events.js";
import type { OrchestratorConfig, PluginManifest, PluginModule } from "../types.js";

vi.mock("../activity-events.js", () => ({
  recordActivityEvent: vi.fn(),
}));

function makePlugin(slot: PluginManifest["slot"], name: string): PluginModule {
  return {
    manifest: {
      name,
      slot,
      description: `Test ${slot} plugin: ${name}`,
      version: "0.0.1",
    },
    create: vi.fn(() => ({ name })),
  };
}

function makeOrchestratorConfig(overrides?: Partial<OrchestratorConfig>): OrchestratorConfig {
  return {
    projects: {},
    ...overrides,
  } as OrchestratorConfig;
}

beforeEach(() => {
  vi.mocked(recordActivityEvent).mockClear();
});

describe("activity events: plugin-registry", () => {
  it("emits plugin-registry.load_failed when a configured external plugin fails to import", async () => {
    const registry = createPluginRegistry();
    const config = makeOrchestratorConfig({
      plugins: [
        {
          name: "broken-plugin",
          source: "npm",
          package: "@example/broken",
          enabled: true,
        },
      ],
    });

    await registry.loadFromConfig(config, async (pkg: string) => {
      // Built-ins all silently skip; external import throws
      if (pkg === "@example/broken") {
        throw new Error("module not found");
      }
      throw new Error(`builtin not installed: ${pkg}`);
    });

    const calls = vi.mocked(recordActivityEvent).mock.calls.map((c) => c[0]);
    const loadFailed = calls.find(
      (c) =>
        c.kind === "plugin-registry.load_failed" &&
        c.source === "plugin-registry" &&
        (c.data as Record<string, unknown> | undefined)?.["builtin"] === false,
    );
    expect(loadFailed).toBeDefined();
  });

  it("emits plugin-registry.specifier_failed when a plugin specifier cannot be resolved", async () => {
    const registry = createPluginRegistry();
    const config = makeOrchestratorConfig({
      plugins: [
        {
          name: "no-specifier",
          source: "local",
          // No path — resolvePluginSpecifier returns null
          enabled: true,
        },
      ],
    });

    await registry.loadFromConfig(config, async (pkg: string) => {
      throw new Error(`builtin not installed: ${pkg}`);
    });

    const calls = vi.mocked(recordActivityEvent).mock.calls.map((c) => c[0]);
    const specifierFailed = calls.find((c) => c.kind === "plugin-registry.specifier_failed");
    expect(specifierFailed).toBeDefined();
  });

  it("emits plugin-registry.load_failed when a built-in plugin's register() throws", async () => {
    const registry = createPluginRegistry();
    // Make a plugin whose create() throws to force registration failure
    const fakeRuntime: PluginModule = {
      manifest: {
        name: "tmux",
        slot: "runtime",
        description: "throwing test plugin",
        version: "0.0.1",
      },
      create: () => {
        throw new Error("boom");
      },
    };

    await registry.loadBuiltins(undefined, async (pkg: string) => {
      if (pkg === "@aoagents/ao-plugin-runtime-tmux") return fakeRuntime;
      throw new Error(`Not found: ${pkg}`);
    });

    const calls = vi.mocked(recordActivityEvent).mock.calls.map((c) => c[0]);
    const loadFailed = calls.find((c) => c.kind === "plugin-registry.load_failed");
    expect(loadFailed).toBeDefined();
  });

  it("does not emit any failure events when plugins load cleanly", async () => {
    const registry = createPluginRegistry();
    const fakePlugin = makePlugin("runtime", "tmux");

    await registry.loadBuiltins(undefined, async (pkg: string) => {
      if (pkg === "@aoagents/ao-plugin-runtime-tmux") return fakePlugin;
      throw new Error(`Not found: ${pkg}`);
    });

    const calls = vi.mocked(recordActivityEvent).mock.calls.map((c) => c[0]);
    const failures = calls.filter(
      (c) => typeof c.kind === "string" && c.kind.startsWith("plugin-registry."),
    );
    expect(failures).toEqual([]);
  });
});
