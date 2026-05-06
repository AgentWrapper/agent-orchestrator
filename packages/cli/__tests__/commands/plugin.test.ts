import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { parse as parseYaml } from "yaml";
import type { PluginManifest, PluginModule } from "@aoagents/ao-core";

const {
  mockFindConfigFile,
  mockGetLatestPublishedPackageVersion,
  mockImportPluginModuleFromSource,
  mockInstallPackageIntoStore,
  mockReadInstalledPackageVersion,
  mockRunSetupAction,
  mockUninstallPackageFromStore,
} = vi.hoisted(() => ({
  mockFindConfigFile: vi.fn(),
  mockGetLatestPublishedPackageVersion: vi.fn(),
  mockImportPluginModuleFromSource: vi.fn(),
  mockInstallPackageIntoStore: vi.fn(),
  mockReadInstalledPackageVersion: vi.fn(),
  mockRunSetupAction: vi.fn(),
  mockUninstallPackageFromStore: vi.fn(),
}));

vi.mock("@aoagents/ao-core", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    findConfigFile: (...args: unknown[]) => mockFindConfigFile(...args),
    isCanonicalGlobalConfigPath: (configPath: string | undefined) =>
      configPath?.endsWith("global-config.yaml") ?? false,
  };
});

vi.mock("../../src/lib/plugin-store.js", () => ({
  getLatestPublishedPackageVersion: (...args: unknown[]) =>
    mockGetLatestPublishedPackageVersion(...args),
  importPluginModuleFromSource: (...args: unknown[]) => mockImportPluginModuleFromSource(...args),
  installPackageIntoStore: (...args: unknown[]) => mockInstallPackageIntoStore(...args),
  readInstalledPackageVersion: (...args: unknown[]) => mockReadInstalledPackageVersion(...args),
  uninstallPackageFromStore: (...args: unknown[]) => mockUninstallPackageFromStore(...args),
}));

vi.mock("../../src/commands/setup.js", () => ({
  runSetupAction: (...args: unknown[]) => mockRunSetupAction(...args),
}));

import { registerPlugin } from "../../src/commands/plugin.js";

const OPENCLAW_PACKAGE = "@aoagents/ao-plugin-notifier-openclaw";
const GOOSE_PACKAGE = "@example/ao-plugin-agent-goose";

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

function createProgram(): Command {
  const program = new Command();
  registerPlugin(program);
  return program;
}

function writeConfig(configPath: string, extra: string[] = []): void {
  writeFileSync(
    configPath,
    [
      "port: 3000",
      "defaults:",
      "  runtime: tmux",
      "  agent: claude-code",
      "  workspace: worktree",
      "  notifiers: [desktop]",
      ...extra,
      "projects:",
      "  my-app:",
      "    name: my-app",
      "    repo: owner/repo",
      `    path: ${join(tmpdir(), "my-app")}`,
    ].join("\n"),
  );
}

describe("plugin command", () => {
  let tempDir: string;
  let configPath: string;
  let registryCachePath: string;
  const storeVersions = new Map<string, string>();

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ao-plugin-command-test-"));
    configPath = join(tempDir, "agent-orchestrator.yaml");
    registryCachePath = join(tempDir, "plugin-registry-cache.json");
    writeConfig(configPath);
    process.env["AO_PLUGIN_REGISTRY_CACHE_PATH"] = registryCachePath;

    mockFindConfigFile.mockReturnValue(configPath);
    mockRunSetupAction.mockReset();
    mockGetLatestPublishedPackageVersion.mockReset();
    mockImportPluginModuleFromSource.mockReset();
    mockInstallPackageIntoStore.mockReset();
    mockReadInstalledPackageVersion.mockReset();
    mockUninstallPackageFromStore.mockReset();
    storeVersions.clear();

    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    vi.spyOn(console, "log").mockImplementation(() => {});

    mockReadInstalledPackageVersion.mockImplementation((packageName: string) => {
      return storeVersions.get(packageName) ?? null;
    });

    mockInstallPackageIntoStore.mockImplementation(
      async (packageName: string, version?: string) => {
        const resolved = version ?? "0.0.1";
        storeVersions.set(packageName, resolved);
        return resolved;
      },
    );

    mockUninstallPackageFromStore.mockImplementation(async (packageName: string) => {
      return storeVersions.delete(packageName);
    });

    mockGetLatestPublishedPackageVersion.mockImplementation(async (packageName: string) => {
      if (packageName === GOOSE_PACKAGE) return "1.1.0";
      return "0.0.1";
    });

    mockImportPluginModuleFromSource.mockImplementation(async (specifier: string) => {
      if (specifier === OPENCLAW_PACKAGE) return { default: makePlugin("notifier", "openclaw") };
      if (specifier === GOOSE_PACKAGE) return { default: makePlugin("agent", "goose") };
      throw new Error(`Not found: ${specifier}`);
    });
  });

  afterEach(() => {
    delete process.env["AO_PLUGIN_REGISTRY_CACHE_PATH"];
    delete process.env["AO_PLUGIN_REGISTRY_URL"];
    rmSync(tempDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("refreshes the marketplace registry cache and uses it for list/search", async () => {
    const program = createProgram();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [
        {
          id: "tracker-jira",
          package: "@example/ao-plugin-tracker-jira",
          slot: "tracker",
          description: "Tracker plugin: Jira issues",
          source: "registry",
          latestVersion: "0.3.0",
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    await program.parseAsync(["node", "test", "plugin", "list", "--refresh"]);

    let output = vi
      .mocked(console.log)
      .mock.calls.map((call) => call.join(" "))
      .join("\n");
    expect(output).toContain("tracker-jira");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.mocked(console.log).mockClear();

    const searchProgram = createProgram();
    await searchProgram.parseAsync(["node", "test", "plugin", "search", "jira"]);

    output = vi
      .mocked(console.log)
      .mock.calls.map((call) => call.join(" "))
      .join("\n");
    expect(output).toContain("tracker-jira");
  });

  it("creates a plugin scaffold in non-interactive mode", async () => {
    const targetDir = join(tempDir, "acme-alerts");
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "plugin",
      "create",
      targetDir,
      "--name",
      "Acme Alerts",
      "--slot",
      "notifier",
      "--description",
      "Notifier plugin for Acme alerts",
      "--author",
      "Alice",
      "--package-name",
      "@alice/ao-plugin-notifier-acme-alerts",
      "--non-interactive",
    ]);

    expect(existsSync(join(targetDir, "package.json"))).toBe(true);
    expect(existsSync(join(targetDir, "src", "index.ts"))).toBe(true);
    expect(existsSync(join(targetDir, "README.md"))).toBe(true);

    const packageJson = JSON.parse(readFileSync(join(targetDir, "package.json"), "utf-8")) as {
      name: string;
      author?: string;
      dependencies?: Record<string, string>;
    };
    expect(packageJson.name).toBe("@alice/ao-plugin-notifier-acme-alerts");
    expect(packageJson.author).toBe("Alice");
    expect(packageJson.dependencies?.["@aoagents/ao-core"]).toBe("^0.2.0");

    const entrypoint = readFileSync(join(targetDir, "src", "index.ts"), "utf-8");
    expect(entrypoint).toContain('slot: "notifier" as const');
    expect(entrypoint).toContain('name: "acme-alerts"');
  });

  it("installs a marketplace plugin through the AO-managed store before writing config", async () => {
    const program = createProgram();

    await program.parseAsync(["node", "test", "plugin", "install", "notifier-openclaw"]);

    const parsed = parseYaml(readFileSync(configPath, "utf-8")) as {
      plugins?: Array<Record<string, string>>;
    };
    expect(parsed.plugins).toHaveLength(1);
    expect(parsed.plugins?.[0]).toMatchObject({
      name: "openclaw",
      source: "registry",
      package: OPENCLAW_PACKAGE,
      version: "0.1.1",
    });
    expect(mockInstallPackageIntoStore).toHaveBeenCalledWith(OPENCLAW_PACKAGE, "0.1.1");

    // Install now always runs setup (auto-detect in non-TTY instead of deferring)
    expect(mockRunSetupAction).toHaveBeenCalled();
  });

  it("does not stamp wrapped config schema onto the canonical global config", async () => {
    configPath = join(tempDir, "global-config.yaml");
    writeConfig(configPath);
    mockFindConfigFile.mockReturnValue(configPath);

    const program = createProgram();

    await program.parseAsync(["node", "test", "plugin", "install", "notifier-openclaw"]);

    const writtenYaml = readFileSync(configPath, "utf-8");
    expect(writtenYaml).not.toContain("$schema:");
    expect(parseYaml(writtenYaml)).toMatchObject({
      plugins: [
        {
          name: "openclaw",
          source: "registry",
          package: OPENCLAW_PACKAGE,
        },
      ],
    });
  });

  it("updates an npm plugin and persists the resolved store version", async () => {
    writeConfig(configPath, [
      "plugins:",
      "  - name: goose",
      "    source: npm",
      `    package: "${GOOSE_PACKAGE}"`,
      "    version: 1.0.0",
    ]);
    storeVersions.set(GOOSE_PACKAGE, "1.0.0");

    const program = createProgram();
    await program.parseAsync(["node", "test", "plugin", "update", "goose"]);

    const parsed = parseYaml(readFileSync(configPath, "utf-8")) as {
      plugins?: Array<Record<string, string>>;
    };
    expect(parsed.plugins?.[0]).toMatchObject({
      name: "goose",
      source: "npm",
      package: GOOSE_PACKAGE,
      version: "1.1.0",
    });
    expect(storeVersions.get(GOOSE_PACKAGE)).toBe("1.1.0");
    expect(mockInstallPackageIntoStore).toHaveBeenCalledWith(GOOSE_PACKAGE, "1.1.0");
  });

  it("rolls back the store version when an update fails verification", async () => {
    writeConfig(configPath, [
      "plugins:",
      "  - name: goose",
      "    source: npm",
      `    package: "${GOOSE_PACKAGE}"`,
      "    version: 1.0.0",
    ]);
    storeVersions.set(GOOSE_PACKAGE, "1.0.0");
    mockImportPluginModuleFromSource.mockImplementation(async (specifier: string) => {
      if (specifier === GOOSE_PACKAGE) return {};
      throw new Error(`Not found: ${specifier}`);
    });

    const program = createProgram();

    await expect(program.parseAsync(["node", "test", "plugin", "update", "goose"])).rejects.toThrow(
      "Failed to update plugin",
    );

    const parsed = parseYaml(readFileSync(configPath, "utf-8")) as {
      plugins?: Array<Record<string, string>>;
    };
    expect(parsed.plugins?.[0]?.["version"]).toBe("1.0.0");
    expect(storeVersions.get(GOOSE_PACKAGE)).toBe("1.0.0");
    expect(mockInstallPackageIntoStore).toHaveBeenLastCalledWith(GOOSE_PACKAGE, "1.0.0");
  });
});
