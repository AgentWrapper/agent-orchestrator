import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

const {
  mockRunRepoScript,
  mockFindConfigFile,
  mockLoadConfig,
  mockCreatePluginRegistry,
  mockDetectOpenClawInstallation,
  mockValidateToken,
  mockRegistry,
  mockGetCurrentVersion,
  mockReadCachedUpdateInfo,
} = vi.hoisted(() => ({
  mockRunRepoScript: vi.fn(),
  mockFindConfigFile: vi.fn(),
  mockLoadConfig: vi.fn(),
  mockCreatePluginRegistry: vi.fn(),
  mockDetectOpenClawInstallation: vi.fn(),
  mockValidateToken: vi.fn(),
  mockRegistry: {
    loadFromConfig: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
  },
  mockGetCurrentVersion: vi.fn(() => "0.2.2"),
  mockReadCachedUpdateInfo: vi.fn(() => null),
}));

vi.mock("../../src/lib/script-runner.js", () => ({
  runRepoScript: (...args: unknown[]) => mockRunRepoScript(...args),
}));

vi.mock("@aoagents/ao-core", () => ({
  createPluginRegistry: (...args: unknown[]) => mockCreatePluginRegistry(...args),
  findConfigFile: (...args: unknown[]) => mockFindConfigFile(...args),
  getObservabilityBaseDir: () => "/tmp/.agent-orchestrator/observability",
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
  resolveNotifierTarget: (config: { notifiers?: Record<string, { plugin?: string }> }, reference: string) => {
    const configured = config.notifiers?.[reference];
    return {
      reference,
      pluginName: configured?.plugin ?? reference,
    };
  },
}));

vi.mock("../../src/lib/openclaw-probe.js", () => ({
  detectOpenClawInstallation: (...args: unknown[]) => mockDetectOpenClawInstallation(...args),
  validateToken: (...args: unknown[]) => mockValidateToken(...args),
}));

vi.mock("../../src/lib/update-check.js", () => ({
  getCurrentVersion: () => mockGetCurrentVersion(),
  readCachedUpdateInfo: () => mockReadCachedUpdateInfo(),
  isVersionOutdated: (current: string, latest: string) => {
    const parseVersion = (version: string) => {
      const [base, prerelease] = version.split("-", 2);
      return {
        parts: (base ?? "").split(".").map(Number),
        hasPrerelease: Boolean(prerelease),
      };
    };

    const currentVersion = parseVersion(current);
    const latestVersion = parseVersion(latest);

    for (let i = 0; i < 3; i++) {
      if ((currentVersion.parts[i] ?? 0) < (latestVersion.parts[i] ?? 0)) return true;
      if ((currentVersion.parts[i] ?? 0) > (latestVersion.parts[i] ?? 0)) return false;
    }

    return currentVersion.hasPrerelease && !latestVersion.hasPrerelease;
  },
}));

import { registerDoctor } from "../../src/commands/doctor.js";

function manifest(slot: string, name: string) {
  return { slot, name, description: `${name} plugin`, version: "1.0.0" };
}

function makeConfig() {
  return {
    configPath: "/tmp/agent-orchestrator.yaml",
    port: 3000,
    readyThresholdMs: 300_000,
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: ["alerts"],
      orchestrator: { agent: "codex" },
      worker: { agent: "claude-code" },
    },
    projects: {
      "my-app": {
        name: "My App",
        repo: "org/my-app",
        path: "/tmp/my-app",
        defaultBranch: "main",
        sessionPrefix: "app",
        runtime: "tmux",
        agent: "claude-code",
        workspace: "worktree",
        tracker: { plugin: "github" },
        scm: { plugin: "github" },
        orchestrator: { agent: "codex" },
        worker: { agent: "claude-code" },
      },
    },
    notifiers: {
      alerts: { plugin: "slack" },
    },
    notificationRouting: {
      urgent: ["alerts"],
      action: ["alerts"],
      warning: ["alerts"],
      info: ["alerts"],
    },
    reactions: {},
  };
}

describe("doctor command", () => {
  let program: Command;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerDoctor(program);

    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    processExitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });

    mockRunRepoScript.mockReset();
    mockRunRepoScript.mockResolvedValue(0);

    mockFindConfigFile.mockReset();
    mockFindConfigFile.mockReturnValue(null);

    mockLoadConfig.mockReset();

    mockCreatePluginRegistry.mockReset();
    mockCreatePluginRegistry.mockReturnValue(mockRegistry);

    mockRegistry.loadFromConfig.mockReset();
    mockRegistry.loadFromConfig.mockResolvedValue(undefined);
    mockRegistry.list.mockReset();
    mockRegistry.list.mockReturnValue([]);
    mockRegistry.get.mockReset();
    mockRegistry.get.mockReturnValue(null);

    mockDetectOpenClawInstallation.mockReset();
    mockDetectOpenClawInstallation.mockResolvedValue({
      state: "running",
      gatewayUrl: "http://127.0.0.1:18789",
      probe: { httpStatus: 200 },
    });
    mockValidateToken.mockReset();
    mockValidateToken.mockResolvedValue({ valid: true });

    mockGetCurrentVersion.mockReset();
    mockGetCurrentVersion.mockReturnValue("0.2.2");
    mockReadCachedUpdateInfo.mockReset();
    mockReadCachedUpdateInfo.mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs the doctor script with no extra args by default", async () => {
    await program.parseAsync(["node", "test", "doctor"]);

    expect(mockRunRepoScript).toHaveBeenCalledWith("ao-doctor.sh", []);
  });

  it("passes through --fix", async () => {
    await program.parseAsync(["node", "test", "doctor", "--fix"]);

    expect(mockRunRepoScript).toHaveBeenCalledWith("ao-doctor.sh", ["--fix"]);
  });

  it("checks configured plugin references when config is present", async () => {
    const config = makeConfig();
    mockFindConfigFile.mockReturnValue(config.configPath);
    mockLoadConfig.mockReturnValue(config);

    mockRegistry.list.mockImplementation((slot: string) => {
      switch (slot) {
        case "runtime":
          return [manifest("runtime", "tmux")];
        case "agent":
          return [manifest("agent", "claude-code"), manifest("agent", "codex")];
        case "workspace":
          return [manifest("workspace", "worktree")];
        case "tracker":
          return [manifest("tracker", "github")];
        case "scm":
          return [manifest("scm", "github")];
        case "notifier":
          return [manifest("notifier", "slack")];
        default:
          return [];
      }
    });

    await program.parseAsync(["node", "test", "doctor"]);

    expect(mockCreatePluginRegistry).toHaveBeenCalledTimes(1);
    expect(mockRegistry.loadFromConfig).toHaveBeenCalledWith(config, expect.any(Function));

    const output = consoleLogSpy.mock.calls.map((call) => call[0]).join("\n");
    expect(output).toContain('defaults.runtime -> runtime plugin "tmux"');
    expect(output).toContain('projects.my-app.scm.plugin -> scm plugin "github"');
    expect(output).toContain('defaults.notifiers: alerts (plugin: slack) -> notifier plugin "slack"');
  });

  it("fails when a referenced plugin cannot be loaded", async () => {
    const config = makeConfig();
    config.projects["my-app"].scm = { plugin: "gitlab" };
    mockFindConfigFile.mockReturnValue(config.configPath);
    mockLoadConfig.mockReturnValue(config);

    mockRegistry.list.mockImplementation((slot: string) => {
      switch (slot) {
        case "runtime":
          return [manifest("runtime", "tmux")];
        case "agent":
          return [manifest("agent", "claude-code"), manifest("agent", "codex")];
        case "workspace":
          return [manifest("workspace", "worktree")];
        case "tracker":
          return [manifest("tracker", "github")];
        case "scm":
          return [manifest("scm", "github")];
        case "notifier":
          return [manifest("notifier", "slack")];
        default:
          return [];
      }
    });

    await expect(program.parseAsync(["node", "test", "doctor"])).rejects.toThrow("process.exit(1)");

    const output = consoleLogSpy.mock.calls.map((call) => call[0]).join("\n");
    expect(output).toContain('projects.my-app.scm.plugin references scm plugin "gitlab"');
  });

  it("resolves notifier aliases when sending test notifications", async () => {
    const config = makeConfig();
    const mockNotifier = { notify: vi.fn().mockResolvedValue(undefined) };
    mockFindConfigFile.mockReturnValue(config.configPath);
    mockLoadConfig.mockReturnValue(config);

    mockRegistry.list.mockImplementation((slot: string) => {
      switch (slot) {
        case "runtime":
          return [manifest("runtime", "tmux")];
        case "agent":
          return [manifest("agent", "claude-code"), manifest("agent", "codex")];
        case "workspace":
          return [manifest("workspace", "worktree")];
        case "tracker":
          return [manifest("tracker", "github")];
        case "scm":
          return [manifest("scm", "github")];
        case "notifier":
          return [manifest("notifier", "slack")];
        default:
          return [];
      }
    });
    mockRegistry.get.mockImplementation((slot: string, name: string) => {
      if (slot === "notifier" && name === "slack") {
        return mockNotifier;
      }
      return null;
    });

    await program.parseAsync(["node", "test", "doctor", "--test-notify"]);

    expect(mockRegistry.get).toHaveBeenCalledWith("notifier", "slack");
    expect(mockNotifier.notify).toHaveBeenCalledTimes(1);
    expect(processExitSpy).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Version freshness
  // -----------------------------------------------------------------------

  it("shows PASS when cached version is current", async () => {
    mockReadCachedUpdateInfo.mockReturnValue({
      latestVersion: "0.2.2",
      checkedAt: new Date().toISOString(),
      currentVersionAtCheck: "0.2.2",
    });

    await program.parseAsync(["node", "test", "doctor"]);

    const output = consoleLogSpy.mock.calls.map((call) => call[0]).join("\n");
    expect(output).toContain("PASS");
    expect(output).toContain("latest version");
  });

  it("shows WARN when cached version is outdated", async () => {
    mockReadCachedUpdateInfo.mockReturnValue({
      latestVersion: "0.3.0",
      checkedAt: new Date().toISOString(),
      currentVersionAtCheck: "0.2.2",
    });

    await program.parseAsync(["node", "test", "doctor"]);

    const output = consoleLogSpy.mock.calls.map((call) => call[0]).join("\n");
    expect(output).toContain("WARN");
    expect(output).toContain("outdated");
    expect(output).toContain("0.3.0");
  });

  it("shows WARN when a prerelease build is behind the matching stable release", async () => {
    mockGetCurrentVersion.mockReturnValue("0.2.2-beta.1");
    mockReadCachedUpdateInfo.mockReturnValue({
      latestVersion: "0.2.2",
      checkedAt: new Date().toISOString(),
      currentVersionAtCheck: "0.2.2-beta.1",
    });

    await program.parseAsync(["node", "test", "doctor"]);

    const output = consoleLogSpy.mock.calls.map((call) => call[0]).join("\n");
    expect(output).toContain("WARN");
    expect(output).toContain("0.2.2-beta.1");
    expect(output).toContain("0.2.2");
  });

  it("shows informational PASS when no cache exists", async () => {
    mockReadCachedUpdateInfo.mockReturnValue(null);

    await program.parseAsync(["node", "test", "doctor"]);

    const output = consoleLogSpy.mock.calls.map((call) => call[0]).join("\n");
    expect(output).toContain("PASS");
    expect(output).toContain("installed");
  });

  it("tests shared-plugin notifier aliases independently", async () => {
    const config = makeConfig();
    config.notifiers = {
      alerts: { plugin: "slack" },
      ops: { plugin: "slack" },
    };
    config.defaults.notifiers = ["alerts", "ops"];

    const alertsNotifier = { notify: vi.fn().mockResolvedValue(undefined) };
    const opsNotifier = { notify: vi.fn().mockResolvedValue(undefined) };

    mockFindConfigFile.mockReturnValue(config.configPath);
    mockLoadConfig.mockReturnValue(config);

    mockRegistry.list.mockImplementation((slot: string) => {
      switch (slot) {
        case "runtime":
          return [manifest("runtime", "tmux")];
        case "agent":
          return [manifest("agent", "claude-code"), manifest("agent", "codex")];
        case "workspace":
          return [manifest("workspace", "worktree")];
        case "tracker":
          return [manifest("tracker", "github")];
        case "scm":
          return [manifest("scm", "github")];
        case "notifier":
          return [manifest("notifier", "slack")];
        default:
          return [];
      }
    });
    mockRegistry.get.mockImplementation((slot: string, name: string) => {
      if (slot === "notifier" && name === "alerts") {
        return alertsNotifier;
      }
      if (slot === "notifier" && name === "ops") {
        return opsNotifier;
      }
      return null;
    });

    await program.parseAsync(["node", "test", "doctor", "--test-notify"]);

    expect(mockRegistry.get).toHaveBeenCalledWith("notifier", "alerts");
    expect(mockRegistry.get).toHaveBeenCalledWith("notifier", "ops");
    expect(alertsNotifier.notify).toHaveBeenCalledTimes(1);
    expect(opsNotifier.notify).toHaveBeenCalledTimes(1);
    expect(processExitSpy).not.toHaveBeenCalled();
  });
});
