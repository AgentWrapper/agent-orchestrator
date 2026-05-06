import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

// ---------------------------------------------------------------------------
// Hoisted mocks — must be defined before any imports that use them
// ---------------------------------------------------------------------------

const { mockFindConfigFile } = vi.hoisted(() => ({
  mockFindConfigFile: vi.fn(),
}));

const { mockReadFileSync, mockWriteFileSync, mockExistsSync, mockMkdirSync } = vi.hoisted(() => ({
  mockReadFileSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockExistsSync: vi.fn(),
  mockMkdirSync: vi.fn(),
}));

const { mockProbeGateway, mockValidateToken, mockDetectOpenClawInstallation } = vi.hoisted(() => ({
  mockProbeGateway: vi.fn(),
  mockValidateToken: vi.fn(),
  mockDetectOpenClawInstallation: vi.fn(),
}));

vi.mock("@aoagents/ao-core", () => ({
  CONFIG_SCHEMA_URL:
    "https://raw.githubusercontent.com/ComposioHQ/agent-orchestrator/main/schema/config.schema.json",
  findConfigFile: (...args: unknown[]) => mockFindConfigFile(...args),
  isCanonicalGlobalConfigPath: (configPath: string | undefined) =>
    configPath === join(homedir(), ".agent-orchestrator", "config.yaml"),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  };
});

vi.mock("../../src/lib/openclaw-probe.js", () => ({
  probeGateway: (...args: unknown[]) => mockProbeGateway(...args),
  validateToken: (...args: unknown[]) => mockValidateToken(...args),
  detectOpenClawInstallation: (...args: unknown[]) => mockDetectOpenClawInstallation(...args),
  DEFAULT_OPENCLAW_URL: "http://127.0.0.1:18789",
  HOOKS_PATH: "/hooks/agent",
}));

import { registerSetup } from "../../src/commands/setup.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MINIMAL_CONFIG = `
port: 3000
defaults: {}
projects:
  my-app:
    name: my-app
    repo: owner/repo
    path: ~/code/my-app
`;

const CONFIG_WITH_OPENCLAW = `
port: 3000
defaults:
  notifiers:
    - openclaw
notifiers:
  openclaw:
    plugin: openclaw
    url: http://127.0.0.1:18789/hooks/agent
    token: "\${OPENCLAW_HOOKS_TOKEN}"
projects:
  my-app:
    name: my-app
`;

function createProgram(): Command {
  const program = new Command();
  program.exitOverride(); // throw instead of process.exit
  registerSetup(program);
  return program;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("setup openclaw command", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    mockFindConfigFile.mockReturnValue("/tmp/agent-orchestrator.yaml");
    mockReadFileSync.mockReturnValue(MINIMAL_CONFIG);
    mockWriteFileSync.mockImplementation(() => {});
    mockExistsSync.mockReturnValue(false);
    mockMkdirSync.mockImplementation(() => undefined);
    mockValidateToken.mockResolvedValue({ valid: true });
    mockProbeGateway.mockResolvedValue({ reachable: false });

    // Force non-interactive (no TTY in test environment)
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("non-interactive mode", () => {
    it("writes config when --url and --token provided", async () => {
      const program = createProgram();

      await program.parseAsync([
        "node",
        "test",
        "setup",
        "openclaw",
        "--url",
        "http://127.0.0.1:18789/hooks/agent",
        "--token",
        "test-token",
        "--non-interactive",
      ]);

      // Code writes YAML config + shell profile export — at least one write
      expect(mockWriteFileSync).toHaveBeenCalled();
      const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
      expect(writtenYaml).toContain("openclaw");
      expect(writtenYaml).toContain("plugin: openclaw");
      expect(writtenYaml).toContain("http://127.0.0.1:18789/hooks/agent");
    });

    it("reads token from OPENCLAW_HOOKS_TOKEN env var and skips validation", async () => {
      process.env["OPENCLAW_HOOKS_TOKEN"] = "env-token";
      const program = createProgram();

      await program.parseAsync([
        "node",
        "test",
        "setup",
        "openclaw",
        "--url",
        "http://127.0.0.1:18789/hooks/agent",
        "--non-interactive",
      ]);

      // Non-interactive mode skips pre-write validation
      expect(mockValidateToken).not.toHaveBeenCalled();
      expect(mockWriteFileSync).toHaveBeenCalled();
    });

    it("reads URL from OPENCLAW_GATEWAY_URL env var and skips validation", async () => {
      process.env["OPENCLAW_GATEWAY_URL"] = "http://remote:18789";
      const program = createProgram();

      await program.parseAsync([
        "node",
        "test",
        "setup",
        "openclaw",
        "--token",
        "tok",
        "--non-interactive",
      ]);

      // Non-interactive mode skips pre-write validation
      expect(mockValidateToken).not.toHaveBeenCalled();
      expect(mockWriteFileSync).toHaveBeenCalled();
    });

    it("normalizes OPENCLAW_GATEWAY_URL without double-appending hooks path", async () => {
      process.env["OPENCLAW_GATEWAY_URL"] = "http://remote:18789/hooks/agent";
      const program = createProgram();

      await program.parseAsync([
        "node",
        "test",
        "setup",
        "openclaw",
        "--token",
        "tok",
        "--non-interactive",
      ]);

      const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
      expect(writtenYaml).toContain("url: http://remote:18789/hooks/agent");
      expect(writtenYaml).not.toContain("/hooks/agent/hooks/agent");
    });

    it("skips token validation and writes config in non-interactive mode", async () => {
      const program = createProgram();

      await program.parseAsync([
        "node",
        "test",
        "setup",
        "openclaw",
        "--url",
        "http://127.0.0.1:18789/hooks/agent",
        "--token",
        "good-token",
        "--non-interactive",
      ]);

      // Non-interactive setup skips pre-write validation (gateway may not have
      // the token yet on a fresh install — user restarts gateway after setup)
      expect(mockValidateToken).not.toHaveBeenCalled();
      expect(mockWriteFileSync).toHaveBeenCalled();
    });
  });

  describe("config writing", () => {
    it("adds openclaw to defaults.notifiers", async () => {
      const program = createProgram();

      await program.parseAsync([
        "node",
        "test",
        "setup",
        "openclaw",
        "--url",
        "http://127.0.0.1:18789/hooks/agent",
        "--token",
        "tok",
        "--non-interactive",
      ]);

      const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
      expect(writtenYaml).toContain("openclaw");
      expect(writtenYaml).not.toContain("desktop");
    });

    it("does not stamp wrapped config schema onto the canonical global config", async () => {
      mockFindConfigFile.mockReturnValue(join(homedir(), ".agent-orchestrator", "config.yaml"));
      const program = createProgram();

      await program.parseAsync([
        "node",
        "test",
        "setup",
        "openclaw",
        "--url",
        "http://127.0.0.1:18789/hooks/agent",
        "--token",
        "tok",
        "--non-interactive",
      ]);

      const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
      expect(writtenYaml).not.toContain("$schema:");
      expect(writtenYaml).toContain("openclaw");
    });

    it("does not add desktop to defaults.notifiers when initializing notifiers", async () => {
      // Config with no notifiers at all
      mockReadFileSync.mockReturnValue(`
port: 3000
defaults: {}
projects:
  my-app:
    name: my-app
`);
      const program = createProgram();

      await program.parseAsync([
        "node",
        "test",
        "setup",
        "openclaw",
        "--url",
        "http://127.0.0.1:18789/hooks/agent",
        "--token",
        "tok",
        "--non-interactive",
      ]);

      const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
      const parsed = parseYaml(writtenYaml) as { defaults?: { notifiers?: string[] } };
      expect(parsed.defaults?.notifiers).not.toContain("desktop");
      expect(parsed.defaults?.notifiers).toContain("openclaw");
    });

    it("does not duplicate openclaw in defaults.notifiers", async () => {
      mockReadFileSync.mockReturnValue(CONFIG_WITH_OPENCLAW);
      const program = createProgram();

      await program.parseAsync([
        "node",
        "test",
        "setup",
        "openclaw",
        "--url",
        "http://127.0.0.1:18789/hooks/agent",
        "--token",
        "tok",
        "--non-interactive",
      ]);

      const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
      const parsed = parseYaml(writtenYaml) as { defaults?: { notifiers?: string[] } };
      expect(parsed.defaults?.notifiers?.filter((name) => name === "openclaw")).toHaveLength(1);
    });

    it("writes correct notifier block structure", async () => {
      const program = createProgram();

      await program.parseAsync([
        "node",
        "test",
        "setup",
        "openclaw",
        "--url",
        "http://custom:9999/hooks/agent",
        "--token",
        "tok",
        "--non-interactive",
      ]);

      const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
      expect(writtenYaml).toContain("plugin: openclaw");
      expect(writtenYaml).toContain("http://custom:9999/hooks/agent");
      expect(writtenYaml).toContain("${OPENCLAW_HOOKS_TOKEN}");
      expect(writtenYaml).toContain("retries: 3");
      expect(writtenYaml).toContain("retryDelayMs: 1000");
      expect(writtenYaml).toContain("wakeMode: now");
    });

    it("defaults OpenClaw routing to urgent + action only", async () => {
      const program = createProgram();

      await program.parseAsync([
        "node",
        "test",
        "setup",
        "openclaw",
        "--url",
        "http://127.0.0.1:18789/hooks/agent",
        "--token",
        "tok",
        "--non-interactive",
      ]);

      const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
      const parsed = parseYaml(writtenYaml) as {
        notificationRouting?: Record<string, string[]>;
      };

      expect(parsed.notificationRouting?.["urgent"]).toContain("openclaw");
      expect(parsed.notificationRouting?.["action"]).toContain("openclaw");
      expect(parsed.notificationRouting?.["warning"]).not.toContain("openclaw");
      expect(parsed.notificationRouting?.["info"]).not.toContain("openclaw");
    });

    it("supports overriding the routing preset in non-interactive mode", async () => {
      const program = createProgram();

      await program.parseAsync([
        "node",
        "test",
        "setup",
        "openclaw",
        "--url",
        "http://127.0.0.1:18789/hooks/agent",
        "--token",
        "tok",
        "--routing-preset",
        "all",
        "--non-interactive",
      ]);

      const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
      const parsed = parseYaml(writtenYaml) as {
        notificationRouting?: Record<string, string[]>;
      };

      expect(parsed.notificationRouting?.["urgent"]).toContain("openclaw");
      expect(parsed.notificationRouting?.["action"]).toContain("openclaw");
      expect(parsed.notificationRouting?.["warning"]).toContain("openclaw");
      expect(parsed.notificationRouting?.["info"]).toContain("openclaw");
    });

    it("merges existing allowedSessionKeyPrefixes in openclaw.json", async () => {
      const openclawConfigPath = join(homedir(), ".openclaw", "openclaw.json");

      mockExistsSync.mockImplementation((path: string) => path === openclawConfigPath);
      mockReadFileSync.mockImplementation((path: string) => {
        if (path === "/tmp/agent-orchestrator.yaml") {
          return MINIMAL_CONFIG;
        }
        if (path === openclawConfigPath) {
          return JSON.stringify({
            hooks: {
              enabled: false,
              token: "old-token",
              allowRequestSessionKey: false,
              allowedSessionKeyPrefixes: ["legacy:", "hook:"],
            },
            otherConfig: true,
          });
        }
        return "";
      });

      const program = createProgram();

      await program.parseAsync([
        "node",
        "test",
        "setup",
        "openclaw",
        "--url",
        "http://127.0.0.1:18789/hooks/agent",
        "--token",
        "new-token",
        "--non-interactive",
      ]);

      const openclawWrite = mockWriteFileSync.mock.calls.find(
        ([path]) => path === openclawConfigPath,
      );
      expect(openclawWrite).toBeDefined();

      const writtenJson = JSON.parse(openclawWrite![1] as string) as {
        hooks: {
          token: string;
          enabled: boolean;
          allowRequestSessionKey: boolean;
          allowedSessionKeyPrefixes: string[];
        };
        otherConfig: boolean;
      };

      expect(writtenJson.otherConfig).toBe(true);
      expect(writtenJson.hooks.token).toBe("new-token");
      expect(writtenJson.hooks.enabled).toBe(true);
      expect(writtenJson.hooks.allowRequestSessionKey).toBe(true);
      expect(writtenJson.hooks.allowedSessionKeyPrefixes).toEqual(["legacy:", "hook:"]);
    });

    it("preserves existing projects in config", async () => {
      const program = createProgram();

      await program.parseAsync([
        "node",
        "test",
        "setup",
        "openclaw",
        "--url",
        "http://127.0.0.1:18789/hooks/agent",
        "--token",
        "tok",
        "--non-interactive",
      ]);

      const writtenYaml = mockWriteFileSync.mock.calls[0][1] as string;
      expect(writtenYaml).toContain("my-app");
      expect(writtenYaml).toContain("owner/repo");
    });

    it("writes to the correct config path", async () => {
      mockFindConfigFile.mockReturnValue("/custom/path/agent-orchestrator.yaml");
      const program = createProgram();

      await program.parseAsync([
        "node",
        "test",
        "setup",
        "openclaw",
        "--url",
        "http://127.0.0.1:18789/hooks/agent",
        "--token",
        "tok",
        "--non-interactive",
      ]);

      expect(mockWriteFileSync.mock.calls[0][0]).toBe("/custom/path/agent-orchestrator.yaml");
    });
  });

  describe("error handling", () => {
    it("exits when no config file found", async () => {
      mockFindConfigFile.mockReturnValue(null);
      const program = createProgram();

      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });

      await expect(
        program.parseAsync([
          "node",
          "test",
          "setup",
          "openclaw",
          "--url",
          "http://127.0.0.1:18789/hooks/agent",
          "--token",
          "tok",
          "--non-interactive",
        ]),
      ).rejects.toThrow("process.exit");

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it("skips validation and writes config even with bad token in non-interactive mode", async () => {
      mockValidateToken.mockResolvedValue({ valid: false, error: "Token rejected" });
      const program = createProgram();

      await program.parseAsync([
        "node",
        "test",
        "setup",
        "openclaw",
        "--url",
        "http://127.0.0.1:18789/hooks/agent",
        "--token",
        "bad-token",
        "--non-interactive",
      ]);

      // nonInteractiveSetup skips pre-write validation, so config should still be written
      expect(mockWriteFileSync).toHaveBeenCalled();
    });

    it("exits when --url missing and gateway unreachable in non-interactive mode", async () => {
      mockDetectOpenClawInstallation.mockResolvedValue({
        state: "missing",
        gatewayUrl: "http://127.0.0.1:18789",
        probe: { reachable: false, error: "ECONNREFUSED" },
      });
      const program = createProgram();

      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit");
      });

      await expect(
        program.parseAsync([
          "node",
          "test",
          "setup",
          "openclaw",
          "--token",
          "tok",
          "--non-interactive",
        ]),
      ).rejects.toThrow("process.exit");

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("auto-generates token when --token missing in non-interactive mode", async () => {
      delete process.env["OPENCLAW_HOOKS_TOKEN"];
      const program = createProgram();

      await program.parseAsync([
        "node",
        "test",
        "setup",
        "openclaw",
        "--url",
        "http://127.0.0.1:18789/hooks/agent",
        "--non-interactive",
      ]);

      // nonInteractiveSetup auto-generates a token when none is provided
      expect(mockWriteFileSync).toHaveBeenCalled();
    });
  });
});
