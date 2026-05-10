import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const {
  mockRunRepoScript,
} = vi.hoisted(() => ({
  mockRunRepoScript: vi.fn(),
}));

vi.mock("../../src/lib/script-runner.js", () => ({
  runRepoScript: (...args: unknown[]) => mockRunRepoScript(...args),
}));

const {
  mockDetectInstallMethod,
  mockCheckForUpdate,
  mockInvalidateCache,
  mockGetCurrentVersion,
  mockGetUpdateCommand,
} = vi.hoisted(() => ({
  mockDetectInstallMethod: vi.fn(() => "git" as const),
  mockCheckForUpdate: vi.fn(async () => ({
    currentVersion: "0.2.2",
    latestVersion: "0.3.0",
    isOutdated: true,
    installMethod: "git" as const,
    recommendedCommand: "ao update",
    checkedAt: new Date().toISOString(),
  })),
  mockInvalidateCache: vi.fn(),
  mockGetCurrentVersion: vi.fn(() => "0.2.2"),
  mockGetUpdateCommand: vi.fn((method: string) => {
    if (method === "git") return "ao update";
    return "npm install -g @aoagents/ao@latest";
  }),
}));

const { mockResolveUpdateChannel } = vi.hoisted(() => ({
  mockResolveUpdateChannel: vi.fn(() => "manual" as "stable" | "nightly" | "manual"),
}));

vi.mock("../../src/lib/update-check.js", () => ({
  detectInstallMethod: () => mockDetectInstallMethod(),
  checkForUpdate: (...args: unknown[]) => mockCheckForUpdate(...args),
  invalidateCache: () => mockInvalidateCache(),
  getCurrentVersion: () => mockGetCurrentVersion(),
  getUpdateCommand: (...args: unknown[]) => mockGetUpdateCommand(...args),
  resolveUpdateChannel: () => mockResolveUpdateChannel(),
  isManualOnlyInstall: (m: string) => m === "homebrew",
}));

// Stub the active-session guard's dependencies so handlers don't try to load
// real config / spawn plugins. Default: no sessions, so the guard passes.
const { mockSessions } = vi.hoisted(() => ({
  mockSessions: { value: [] as Array<{ id: string; status: string }> },
}));

vi.mock("../../src/lib/create-session-manager.js", () => ({
  getSessionManager: vi.fn(async () => ({
    list: async () => mockSessions.value,
  })),
}));

import type * as AoCoreType from "@aoagents/ao-core";
import type * as FsType from "node:fs";

const { mockIsWindows, mockLoadConfig, mockLoadGlobalConfig, mockExistsSync } = vi.hoisted(() => ({
  mockIsWindows: vi.fn(() => false),
  mockLoadConfig: vi.fn(),
  mockLoadGlobalConfig: vi.fn(),
  mockExistsSync: vi.fn(() => false),
}));

vi.mock("@aoagents/ao-core", async () => {
  const actual = (await vi.importActual("@aoagents/ao-core")) as typeof AoCoreType;
  return {
    ...actual,
    loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
    loadGlobalConfig: (...args: unknown[]) => mockLoadGlobalConfig(...args),
    getGlobalConfigPath: () => "/tmp/test-global-config.yaml",
    isCanonicalGlobalConfigPath: (p: string | undefined) =>
      p === "/tmp/test-global-config.yaml",
    isWindows: () => mockIsWindows(),
  };
});

vi.mock("node:fs", async () => {
  const actual = (await vi.importActual("node:fs")) as typeof FsType;
  return {
    ...actual,
    existsSync: (path: string) => mockExistsSync(path),
  };
});

const { mockPromptConfirm } = vi.hoisted(() => ({
  mockPromptConfirm: vi.fn(async () => false),
}));

vi.mock("../../src/lib/prompts.js", () => ({
  promptConfirm: (...args: unknown[]) => mockPromptConfirm(...args),
}));

// Mock child_process.spawn for npm install tests
const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual("node:child_process");
  return {
    ...actual,
    spawn: (...args: unknown[]) => mockSpawn(...args),
  };
});

import { registerUpdate } from "../../src/commands/update.js";
import type { InstallMethod } from "../../src/lib/update-check.js";
import { EventEmitter } from "node:events";

function makeNpmUpdateInfo(overrides = {}) {
  return {
    currentVersion: "0.2.2",
    latestVersion: "0.3.0",
    isOutdated: true,
    installMethod: "npm-global" as const,
    recommendedCommand: "npm install -g @aoagents/ao@latest",
    checkedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMockChild(exitCode: number | null, signal?: NodeJS.Signals) {
  const child = new EventEmitter();
  setTimeout(() => child.emit("exit", exitCode, signal ?? null), 0);
  return child;
}

describe("update command", () => {
  let program: Command;
  let origStdinTTY: boolean | undefined;
  let origStdoutTTY: boolean | undefined;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerUpdate(program);
    mockRunRepoScript.mockReset();
    mockRunRepoScript.mockResolvedValue(0);
    mockDetectInstallMethod.mockReturnValue("git");
    mockCheckForUpdate.mockReset();
    mockCheckForUpdate.mockResolvedValue(makeNpmUpdateInfo({ installMethod: "git", recommendedCommand: "ao update" }));
    mockInvalidateCache.mockReset();
    mockPromptConfirm.mockReset();
    mockPromptConfirm.mockResolvedValue(false);
    mockSpawn.mockReset();
    mockResolveUpdateChannel.mockReset();
    mockResolveUpdateChannel.mockReturnValue("manual");
    mockIsWindows.mockReset();
    mockIsWindows.mockReturnValue(false);
    // Default: project-local loadConfig succeeds with no projects, and no
    // global-config file exists. Tests opt into the global-config code path
    // by making mockLoadConfig throw and mockExistsSync return true.
    mockLoadConfig.mockReset();
    mockLoadConfig.mockReturnValue({ projects: {}, configPath: "/tmp/test-config.yaml" });
    mockLoadGlobalConfig.mockReset();
    mockLoadGlobalConfig.mockReturnValue(null);
    mockExistsSync.mockReset();
    mockExistsSync.mockReturnValue(false);
    mockSessions.value = [];
    origStdinTTY = process.stdin.isTTY;
    origStdoutTTY = process.stdout.isTTY;
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process.stdin, "isTTY", { value: origStdinTTY, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: origStdoutTTY, configurable: true });
  });

  // -----------------------------------------------------------------------
  // Conflicting flags
  // -----------------------------------------------------------------------

  it("rejects conflicting smoke flags", async () => {
    await expect(
      program.parseAsync(["node", "test", "update", "--skip-smoke", "--smoke-only"]),
    ).rejects.toThrow("process.exit(1)");
    expect(mockRunRepoScript).not.toHaveBeenCalled();
  });

  describe("git-only flags rejected on non-git installs", () => {
    it.each(["npm-global", "pnpm-global", "bun-global", "homebrew", "unknown"])(
      "rejects --skip-smoke on %s installs with an actionable message",
      async (method) => {
        mockDetectInstallMethod.mockReturnValue(method as InstallMethod);
        const errSpy = vi.mocked(console.error);
        await expect(
          program.parseAsync(["node", "test", "update", "--skip-smoke"]),
        ).rejects.toThrow("process.exit(1)");
        const messages = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
        expect(messages).toMatch(/--skip-smoke only applies to git installs/);
        expect(mockRunRepoScript).not.toHaveBeenCalled();
        expect(mockSpawn).not.toHaveBeenCalled();
      },
    );

    it("rejects --smoke-only on npm installs with an actionable message", async () => {
      mockDetectInstallMethod.mockReturnValue("npm-global");
      const errSpy = vi.mocked(console.error);
      await expect(
        program.parseAsync(["node", "test", "update", "--smoke-only"]),
      ).rejects.toThrow("process.exit(1)");
      const messages = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(messages).toMatch(/--smoke-only only applies to git installs/);
    });

    it("still accepts --skip-smoke on git installs", async () => {
      mockDetectInstallMethod.mockReturnValue("git");
      mockRunRepoScript.mockResolvedValue(0);
      await program.parseAsync(["node", "test", "update", "--skip-smoke"]);
      expect(mockRunRepoScript).toHaveBeenCalledWith(
        "ao-update.sh",
        expect.arrayContaining(["--skip-smoke"]),
      );
    });
  });

  // -----------------------------------------------------------------------
  // --check
  // -----------------------------------------------------------------------

  describe("--check", () => {
    it("outputs valid JSON with all expected keys", async () => {
      const logSpy = vi.mocked(console.log);
      await program.parseAsync(["node", "test", "update", "--check"]);

      const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
      expect(parsed).toHaveProperty("currentVersion");
      expect(parsed).toHaveProperty("latestVersion");
      expect(parsed).toHaveProperty("isOutdated");
      expect(parsed).toHaveProperty("installMethod");
      expect(parsed).toHaveProperty("recommendedCommand");
      expect(parsed).toHaveProperty("checkedAt");
    });

    it("forces a fresh registry fetch", async () => {
      await program.parseAsync(["node", "test", "update", "--check"]);
      expect(mockCheckForUpdate).toHaveBeenCalledWith({ force: true });
    });

    it("outputs valid JSON even when registry is unreachable", async () => {
      mockCheckForUpdate.mockResolvedValue(
        makeNpmUpdateInfo({ latestVersion: null, isOutdated: false, checkedAt: null }),
      );
      const logSpy = vi.mocked(console.log);
      await program.parseAsync(["node", "test", "update", "--check"]);

      const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
      expect(parsed.latestVersion).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Git install
  // -----------------------------------------------------------------------

  describe("git install", () => {
    beforeEach(() => {
      mockDetectInstallMethod.mockReturnValue("git");
    });

    it("runs the update script with default args", async () => {
      await program.parseAsync(["node", "test", "update"]);
      expect(mockRunRepoScript).toHaveBeenCalledWith("ao-update.sh", []);
    });

    it("shows an actionable error when the bundled update script is missing", async () => {
      mockRunRepoScript.mockRejectedValue(
        new Error("Script not found: ao-update.sh. Expected at: /tmp/ao-update.sh"),
      );

      await expect(
        program.parseAsync(["node", "test", "update"]),
      ).rejects.toThrow("process.exit(1)");

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(mockCheckForUpdate).not.toHaveBeenCalled();
      expect(mockInvalidateCache).not.toHaveBeenCalled();
      expect(vi.mocked(console.error)).toHaveBeenCalledWith(
        expect.stringContaining("ao-update.sh is missing from the bundled assets"),
      );
    });

    it("passes through --skip-smoke", async () => {
      await program.parseAsync(["node", "test", "update", "--skip-smoke"]);
      expect(mockRunRepoScript).toHaveBeenCalledWith("ao-update.sh", ["--skip-smoke"]);
    });

    it("passes through --smoke-only", async () => {
      await program.parseAsync(["node", "test", "update", "--smoke-only"]);
      expect(mockRunRepoScript).toHaveBeenCalledWith("ao-update.sh", ["--smoke-only"]);
    });

    it("invalidates cache after successful update", async () => {
      await program.parseAsync(["node", "test", "update"]);
      expect(mockInvalidateCache).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // npm-global install
  // -----------------------------------------------------------------------

  describe("npm-global install", () => {
    beforeEach(() => {
      mockDetectInstallMethod.mockReturnValue("npm-global");
      mockCheckForUpdate.mockResolvedValue(makeNpmUpdateInfo());
      // Default: TTY mode (user is at a terminal)
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    });

    it("does not run script-runner", async () => {
      await program.parseAsync(["node", "test", "update"]);
      expect(mockRunRepoScript).not.toHaveBeenCalled();
    });

    it("prints already up to date when not outdated", async () => {
      mockCheckForUpdate.mockResolvedValue(makeNpmUpdateInfo({ isOutdated: false, latestVersion: "0.2.2", currentVersion: "0.2.2" }));

      const logSpy = vi.mocked(console.log);
      await program.parseAsync(["node", "test", "update"]);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Already on latest version"));
    });

    it("exits non-zero when registry is unreachable", async () => {
      mockCheckForUpdate.mockResolvedValue(
        makeNpmUpdateInfo({ latestVersion: null, isOutdated: false }),
      );

      await expect(
        program.parseAsync(["node", "test", "update"]),
      ).rejects.toThrow("process.exit(1)");
      expect(vi.mocked(console.error)).toHaveBeenCalledWith(
        expect.stringContaining("Could not reach npm registry"),
      );
    });

    it("forces a fresh registry fetch", async () => {
      await program.parseAsync(["node", "test", "update"]);
      expect(mockCheckForUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ force: true }),
      );
    });

    it("prints command and exits cleanly in non-TTY mode without prompting", async () => {
      Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });

      const logSpy = vi.mocked(console.log);
      await program.parseAsync(["node", "test", "update"]);

      expect(mockPromptConfirm).not.toHaveBeenCalled();
      const allOutput = logSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(allOutput).toContain("npm install -g @aoagents/ao@latest");
    });

    it("runs npm install when user confirms", async () => {
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
      mockPromptConfirm.mockResolvedValue(true);
      mockSpawn.mockReturnValue(createMockChild(0));

      await program.parseAsync(["node", "test", "update"]);

      expect(mockSpawn).toHaveBeenCalledWith("npm", expect.arrayContaining(["install"]), expect.anything());
      expect(mockInvalidateCache).toHaveBeenCalled();
    });

    it("exits non-zero when npm install fails", async () => {
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
      mockPromptConfirm.mockResolvedValue(true);
      mockSpawn.mockReturnValue(createMockChild(1));

      await expect(
        program.parseAsync(["node", "test", "update"]),
      ).rejects.toThrow("process.exit(1)");
      expect(mockInvalidateCache).not.toHaveBeenCalled();
    });

    it("prints exit code when npm install fails", async () => {
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
      mockPromptConfirm.mockResolvedValue(true);
      mockSpawn.mockReturnValue(createMockChild(1));

      try {
        await program.parseAsync(["node", "test", "update"]);
      } catch {
        // process.exit throws
      }
      expect(vi.mocked(console.error)).toHaveBeenCalledWith(
        expect.stringContaining("exited with code 1"),
      );
    });

    it("does not print a null exit code when npm install is killed by a signal", async () => {
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
      mockPromptConfirm.mockResolvedValue(true);
      mockSpawn.mockReturnValue(createMockChild(null, "SIGTERM"));

      await expect(
        program.parseAsync(["node", "test", "update"]),
      ).rejects.toThrow("process.exit(1)");

      expect(vi.mocked(console.error)).not.toHaveBeenCalledWith(
        expect.stringContaining("exited with code null"),
      );
      expect(mockInvalidateCache).not.toHaveBeenCalled();
    });

    it("handles spawn error (e.g. npm not found)", async () => {
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
      mockPromptConfirm.mockResolvedValue(true);

      const child = new EventEmitter();
      mockSpawn.mockReturnValue(child);
      setTimeout(() => child.emit("error", new Error("ENOENT: npm not found")), 0);

      await expect(
        program.parseAsync(["node", "test", "update"]),
      ).rejects.toThrow("ENOENT");
    });

    it("does nothing when user declines prompt", async () => {
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
      mockPromptConfirm.mockResolvedValue(false);

      await program.parseAsync(["node", "test", "update"]);

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(mockInvalidateCache).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // unknown install
  // -----------------------------------------------------------------------

  describe("unknown install", () => {
    beforeEach(() => {
      mockDetectInstallMethod.mockReturnValue("unknown");
    });

    it("prints help message with install method unknown", async () => {
      mockCheckForUpdate.mockResolvedValue(makeNpmUpdateInfo({ installMethod: "unknown" }));
      const logSpy = vi.mocked(console.log);

      await program.parseAsync(["node", "test", "update"]);

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Could not detect install method"));
      expect(mockRunRepoScript).not.toHaveBeenCalled();
    });

    it("shows latest version when available", async () => {
      mockCheckForUpdate.mockResolvedValue(makeNpmUpdateInfo({ installMethod: "unknown" }));
      const logSpy = vi.mocked(console.log);

      await program.parseAsync(["node", "test", "update"]);

      const allOutput = logSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(allOutput).toContain("0.3.0");
    });

    it("handles registry unreachable gracefully", async () => {
      mockCheckForUpdate.mockResolvedValue(
        makeNpmUpdateInfo({ installMethod: "unknown", latestVersion: null, isOutdated: false }),
      );

      // Should not throw
      await program.parseAsync(["node", "test", "update"]);
    });

    it("suggests npm install command", async () => {
      mockCheckForUpdate.mockResolvedValue(makeNpmUpdateInfo({ installMethod: "unknown" }));
      await program.parseAsync(["node", "test", "update"]);
      // Channel passed alongside method (manual is the default in this test).
      expect(mockGetUpdateCommand).toHaveBeenCalledWith("npm-global", "manual");
    });
  });

  // -----------------------------------------------------------------------
  // Active-session guard (Section C)
  // -----------------------------------------------------------------------

  describe("active-session guard", () => {
    beforeEach(() => {
      mockDetectInstallMethod.mockReturnValue("npm-global");
      mockCheckForUpdate.mockResolvedValue(makeNpmUpdateInfo({ installMethod: "npm-global" }));
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    });

    it("refuses to install when a session is in 'working'", async () => {
      mockSessions.value = [{ id: "feat-1", status: "working" }];
      const errSpy = vi.mocked(console.error);
      await expect(
        program.parseAsync(["node", "test", "update"]),
      ).rejects.toThrow("process.exit(1)");
      const messages = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(messages).toMatch(/1 session active/);
      expect(messages).toMatch(/ao stop/);
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it.each(["working", "idle", "needs_input", "stuck"])(
      "refuses for status %s",
      async (status) => {
        mockSessions.value = [{ id: "feat-1", status }];
        await expect(
          program.parseAsync(["node", "test", "update"]),
        ).rejects.toThrow("process.exit(1)");
      },
    );

    it("does NOT refuse for terminal statuses (done, terminated, killed)", async () => {
      mockSessions.value = [
        { id: "old-1", status: "done" },
        { id: "old-2", status: "terminated" },
      ];
      mockPromptConfirm.mockResolvedValue(false); // decline, no install
      await program.parseAsync(["node", "test", "update"]);
      // Reaches the prompt step since the guard passed.
      expect(mockPromptConfirm).toHaveBeenCalled();
    });

    // ---------------------------------------------------------------------
    // Global-config layout (review #3)
    // ---------------------------------------------------------------------

    it("falls back to the global registry when running outside any project", async () => {
      // Simulate `ao update` invoked from /tmp with no project-local config.
      mockLoadConfig.mockImplementation((path?: string) => {
        if (!path) throw new Error("no config found");
        return { projects: { "my-app": { path: "/tmp/foo" } }, configPath: path };
      });
      mockLoadGlobalConfig.mockReturnValue({
        projects: { "my-app": { path: "/tmp/foo" } },
      });
      mockExistsSync.mockReturnValue(true);
      mockSessions.value = [{ id: "feat-1", status: "working" }];

      await expect(
        program.parseAsync(["node", "test", "update"]),
      ).rejects.toThrow("process.exit(1)");

      // Saw the global-projects map → built SessionManager → guard fired.
      expect(mockLoadGlobalConfig).toHaveBeenCalled();
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("returns early without building SessionManager when global registry is empty", async () => {
      mockLoadConfig.mockImplementation((path?: string) => {
        if (!path) throw new Error("no config found");
        return { projects: {}, configPath: path };
      });
      mockLoadGlobalConfig.mockReturnValue({ projects: {} });
      mockExistsSync.mockReturnValue(true);

      // Guard returns true (allow update) without ever calling sm.list().
      // No mockSessions configured, no spawn → confirms we never reached
      // SessionManager construction.
      mockPromptConfirm.mockResolvedValue(false); // decline soft-install
      await program.parseAsync(["node", "test", "update"]);
      expect(mockLoadGlobalConfig).toHaveBeenCalled();
      // The decline-prompt path means the guard let us through.
      expect(mockPromptConfirm).toHaveBeenCalled();
    });

    it("returns early without building SessionManager when global config file is missing", async () => {
      mockLoadConfig.mockImplementation((path?: string) => {
        if (!path) throw new Error("no config found");
        return { projects: {}, configPath: path };
      });
      mockExistsSync.mockReturnValue(false); // no ~/.agent-orchestrator/config.yaml

      mockPromptConfirm.mockResolvedValue(false);
      await program.parseAsync(["node", "test", "update"]);
      // We didn't even consult loadGlobalConfig — existsSync(globalPath) was false.
      expect(mockLoadGlobalConfig).not.toHaveBeenCalled();
      expect(mockPromptConfirm).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Soft auto-install (Section B)
  // -----------------------------------------------------------------------

  describe("soft auto-install", () => {
    beforeEach(() => {
      mockDetectInstallMethod.mockReturnValue("npm-global");
      mockCheckForUpdate.mockResolvedValue(makeNpmUpdateInfo({ installMethod: "npm-global" }));
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    });

    it("skips the confirm prompt on stable channel", async () => {
      mockResolveUpdateChannel.mockReturnValue("stable");
      mockSpawn.mockReturnValue(createMockChild(0));
      await program.parseAsync(["node", "test", "update"]);
      expect(mockPromptConfirm).not.toHaveBeenCalled();
      expect(mockSpawn).toHaveBeenCalled();
    });

    it("skips the confirm prompt on nightly channel", async () => {
      mockResolveUpdateChannel.mockReturnValue("nightly");
      mockSpawn.mockReturnValue(createMockChild(0));
      await program.parseAsync(["node", "test", "update"]);
      expect(mockPromptConfirm).not.toHaveBeenCalled();
      expect(mockSpawn).toHaveBeenCalled();
    });

    it("still prompts on manual channel", async () => {
      mockResolveUpdateChannel.mockReturnValue("manual");
      mockPromptConfirm.mockResolvedValue(false);
      await program.parseAsync(["node", "test", "update"]);
      expect(mockPromptConfirm).toHaveBeenCalled();
      expect(mockSpawn).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Homebrew (Section F)
  // -----------------------------------------------------------------------

  describe("homebrew install", () => {
    it("does not auto-install — surfaces the brew upgrade notice", async () => {
      mockDetectInstallMethod.mockReturnValue("homebrew");
      mockCheckForUpdate.mockResolvedValue(makeNpmUpdateInfo({ installMethod: "homebrew" }));
      const logSpy = vi.mocked(console.log);

      await program.parseAsync(["node", "test", "update"]);

      const all = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(all).toMatch(/brew upgrade ao/);
      expect(mockSpawn).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // runNpmInstall — Windows PATHEXT / shell handling
  // -----------------------------------------------------------------------

  describe("runNpmInstall — cross-platform spawn options", () => {
    beforeEach(() => {
      mockDetectInstallMethod.mockReturnValue("npm-global");
      mockCheckForUpdate.mockResolvedValue(makeNpmUpdateInfo({ installMethod: "npm-global" }));
      mockResolveUpdateChannel.mockReturnValue("stable"); // soft-install path skips prompt
      mockSpawn.mockReturnValue(createMockChild(0));
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    });

    it("passes shell:true and windowsHide:true on Windows so PATHEXT resolves npm.cmd", async () => {
      mockIsWindows.mockReturnValue(true);
      await program.parseAsync(["node", "test", "update"]);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const opts = mockSpawn.mock.calls[0][2] as Record<string, unknown>;
      expect(opts.shell).toBe(true);
      expect(opts.windowsHide).toBe(true);
      expect(opts.stdio).toBe("inherit");
    });

    it("passes shell:false on macOS / Linux (no shell wrap needed)", async () => {
      mockIsWindows.mockReturnValue(false);
      await program.parseAsync(["node", "test", "update"]);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const opts = mockSpawn.mock.calls[0][2] as Record<string, unknown>;
      expect(opts.shell).toBe(false);
    });

    it.each([
      ["pnpm-global" as const, "pnpm add -g @aoagents/ao@latest"],
      ["bun-global" as const, "bun add -g @aoagents/ao@latest"],
    ])("applies the same shell:true on Windows for %s installs", async (method, command) => {
      mockIsWindows.mockReturnValue(true);
      mockDetectInstallMethod.mockReturnValue(method);
      mockCheckForUpdate.mockResolvedValue(
        makeNpmUpdateInfo({
          installMethod: method,
          recommendedCommand: command,
        }),
      );
      await program.parseAsync(["node", "test", "update"]);
      const opts = mockSpawn.mock.calls[0][2] as Record<string, unknown>;
      expect(opts.shell).toBe(true);
    });
  });
});
