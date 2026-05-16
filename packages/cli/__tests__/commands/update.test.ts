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

const { mockResolveUpdateChannel, mockReadCachedUpdateInfo } = vi.hoisted(() => ({
  mockResolveUpdateChannel: vi.fn(() => "manual" as "stable" | "nightly" | "manual"),
  mockReadCachedUpdateInfo: vi.fn<() => { channel?: string } | null>(() => null),
}));

vi.mock("../../src/lib/update-check.js", () => ({
  detectInstallMethod: () => mockDetectInstallMethod(),
  checkForUpdate: (...args: unknown[]) => mockCheckForUpdate(...args),
  invalidateCache: () => mockInvalidateCache(),
  getCurrentVersion: () => mockGetCurrentVersion(),
  getUpdateCommand: (...args: unknown[]) => mockGetUpdateCommand(...args),
  resolveUpdateChannel: () => mockResolveUpdateChannel(),
  readCachedUpdateInfo: (...args: unknown[]) => mockReadCachedUpdateInfo(...args),
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

// running.json is the live signal: ensureNoActiveSessions now consults
// `getRunning()` before falling back to the global registry. Default to
// "no daemon running" so the existing global-config-driven tests keep
// exercising the fallback path. Per-test overrides simulate a live daemon.
const { mockGetRunning } = vi.hoisted(() => ({
  mockGetRunning: vi.fn<() => Promise<unknown>>(async () => null),
}));

vi.mock("../../src/lib/running-state.js", () => ({
  getRunning: () => mockGetRunning(),
}));

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
    mockReadCachedUpdateInfo.mockReset();
    mockReadCachedUpdateInfo.mockReturnValue(null);
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
    mockGetRunning.mockReset();
    mockGetRunning.mockResolvedValue(null); // default: no live daemon
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
      // The guard now ALWAYS loads from global config. Stage a registered
      // project so the early-return ("no registry → allow") doesn't fire.
      mockExistsSync.mockReturnValue(true);
      mockLoadGlobalConfig.mockReturnValue({
        projects: { "my-app": { path: "/tmp/foo" } },
      });
      mockLoadConfig.mockImplementation((path?: string) =>
        path
          ? { projects: { "my-app": { path: "/tmp/foo" } }, configPath: path }
          : { projects: { "my-app": { path: "/tmp/foo" } }, configPath: "/cwd/agent-orchestrator.yaml" },
      );
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
    // Global-config layout (review #3 / scope-gap follow-up)
    // ---------------------------------------------------------------------

    it("the refusal message lists active sessions from EVERY registered project, not just one (Dhruv proof)", async () => {
      // Reviewer challenge: prove loadConfig(globalPath) actually enumerates
      // sessions across all registered projects, not just the cwd's project.
      // We register proj-a + proj-b in the global config, seed one active
      // session in each, and assert BOTH ids appear in the stderr output.
      mockLoadConfig.mockImplementation((path?: string) => {
        // Mimic buildEffectiveConfigFromGlobalConfigPath: the global path
        // returns BOTH projects; project-local would only return one.
        if (!path) {
          return { projects: { "proj-a": {} }, configPath: "/cwd/agent-orchestrator.yaml" };
        }
        return {
          projects: {
            "proj-a": { path: "/repos/a" },
            "proj-b": { path: "/repos/b" },
          },
          configPath: path,
        };
      });
      mockLoadGlobalConfig.mockReturnValue({
        projects: {
          "proj-a": { path: "/repos/a" },
          "proj-b": { path: "/repos/b" },
        },
      });
      mockExistsSync.mockReturnValue(true);
      // One active session per project. sm.list() is single-call (the SM
      // implementation enumerates across all projectIds), so we return both
      // sessions in one shot — matching real behavior. `projectId` is
      // included so it's visible to anyone reading the refusal output.
      mockSessions.value = [
        { id: "proj-a-feat-1", status: "working", projectId: "proj-a" },
        { id: "proj-b-feat-2", status: "needs_input", projectId: "proj-b" },
      ];

      const errSpy = vi.mocked(console.error);
      await expect(
        program.parseAsync(["node", "test", "update"]),
      ).rejects.toThrow("process.exit(1)");

      const stderr = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
      // Refusal message reports the correct total count (2, not 1).
      expect(stderr).toMatch(/2 sessions active/);
      // Both project's session ids appear in the listing.
      expect(stderr).toMatch(/proj-a-feat-1/);
      expect(stderr).toMatch(/proj-b-feat-2/);
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("always loads global config (never project-local), so sessions in OTHER projects fire the guard", async () => {
      // Simulate running inside a project: project-local loadConfig() would
      // succeed and return only THIS project's sessions. The guard must
      // ignore it and still consult the global registry, otherwise active
      // sessions in other projects get missed and the install would proceed.
      mockLoadConfig.mockImplementation((path?: string) => {
        if (!path) {
          // Project-local: would return only "this-project"'s sessions.
          return { projects: { "this-project": {} }, configPath: "/cwd/agent-orchestrator.yaml" };
        }
        return {
          projects: {
            "this-project": { path: "/cwd" },
            "other-project": { path: "/other" },
          },
          configPath: path,
        };
      });
      mockLoadGlobalConfig.mockReturnValue({
        projects: {
          "this-project": { path: "/cwd" },
          "other-project": { path: "/other" },
        },
      });
      mockExistsSync.mockReturnValue(true);
      // Active session lives in the OTHER project — only visible via global.
      mockSessions.value = [
        { id: "other-1", status: "working" },
      ];

      await expect(
        program.parseAsync(["node", "test", "update"]),
      ).rejects.toThrow("process.exit(1)");

      expect(mockLoadGlobalConfig).toHaveBeenCalled();
      // Critical: we did NOT call the project-local (no-arg) loadConfig path.
      const noArgCalls = mockLoadConfig.mock.calls.filter((c) => c.length === 0);
      expect(noArgCalls).toHaveLength(0);
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("uses the global registry when running outside any project", async () => {
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

    it("refuses when sessions exist in a locally-registered project not in global config (Dhruv edge-case)", async () => {
      // The bypass: user ran `ao start` from a repo with a local
      // agent-orchestrator.yaml and no global registration. running.json
      // says that project is being polled, sessions live on disk, but the
      // global registry is empty. Before this fix, the guard hit the
      // "global has no projects → allow" branch and let `ao update`
      // clobber the running daemon.
      //
      // Fix: consult running.json BEFORE falling back to global. When
      // running.json has projects, build the SessionManager from
      // running.configPath (which is the local project's yaml in this case)
      // and enumerate from there.
      mockGetRunning.mockResolvedValue({
        pid: 12345,
        configPath: "/repos/local-only/agent-orchestrator.yaml",
        port: 3000,
        startedAt: new Date().toISOString(),
        projects: ["local-only"],
      });
      // Global registry has no record of `local-only` — this is the bypass
      // condition. With the old code, we'd return true here.
      mockLoadGlobalConfig.mockReturnValue({ projects: {} });
      // loadConfig with the local configPath returns the local project's
      // OrchestratorConfig (project-local schema is auto-wrapped).
      mockLoadConfig.mockImplementation((path?: string) => {
        if (path === "/repos/local-only/agent-orchestrator.yaml") {
          return {
            projects: { "local-only": { path: "/repos/local-only" } },
            configPath: path,
          };
        }
        return { projects: {}, configPath: path ?? "/cwd/agent-orchestrator.yaml" };
      });
      mockSessions.value = [
        { id: "local-feat-1", status: "working", projectId: "local-only" },
      ];

      const errSpy = vi.mocked(console.error);
      await expect(
        program.parseAsync(["node", "test", "update"]),
      ).rejects.toThrow("process.exit(1)");

      const stderr = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(stderr).toMatch(/1 session active/);
      expect(stderr).toMatch(/local-feat-1/);
      // We must have routed through running.configPath, NOT the global path.
      expect(mockLoadConfig).toHaveBeenCalledWith("/repos/local-only/agent-orchestrator.yaml");
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("returns true (allows update) when running.json is gone and global is empty", async () => {
      // No daemon running, no global projects. Genuinely safe to update.
      mockGetRunning.mockResolvedValue(null);
      mockExistsSync.mockReturnValue(false);
      mockPromptConfirm.mockResolvedValue(false);
      await program.parseAsync(["node", "test", "update"]);
      expect(mockPromptConfirm).toHaveBeenCalled(); // guard passed → reached prompt
    });

    it("trusts running.json over an inconsistent global config", async () => {
      // running.json says project P is being polled. Global config also
      // lists P. We should use running.configPath (the live signal), and
      // any active session in P fires the guard.
      mockGetRunning.mockResolvedValue({
        pid: 12345,
        configPath: "/tmp/test-global-config.yaml",
        port: 3000,
        startedAt: new Date().toISOString(),
        projects: ["my-app"],
      });
      mockLoadConfig.mockImplementation((path?: string) => ({
        projects: { "my-app": { path: "/tmp/foo" } },
        configPath: path ?? "/cwd/agent-orchestrator.yaml",
      }));
      mockLoadGlobalConfig.mockReturnValue({
        projects: { "my-app": { path: "/tmp/foo" } },
      });
      mockSessions.value = [{ id: "feat-1", status: "working" }];

      await expect(
        program.parseAsync(["node", "test", "update"]),
      ).rejects.toThrow("process.exit(1)");

      // Because getRunning() returned a daemon, we went straight to its
      // configPath — we should NOT have fallen back to loadGlobalConfig.
      expect(mockLoadGlobalConfig).not.toHaveBeenCalled();
      expect(mockSpawn).not.toHaveBeenCalled();
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
  // Channel-switch detection (review #2)
  // -----------------------------------------------------------------------

  describe("channel-switch detection", () => {
    beforeEach(() => {
      mockDetectInstallMethod.mockReturnValue("npm-global");
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    });

    it("forces an explicit prompt when active channel differs from cached.channel and !isOutdated", async () => {
      // Stable→nightly transition: numeric base equal so isOutdated=false,
      // but the user clearly wants the nightly build.
      mockResolveUpdateChannel.mockReturnValue("nightly");
      mockReadCachedUpdateInfo.mockReturnValue({ channel: "stable" });
      mockCheckForUpdate.mockResolvedValue(
        makeNpmUpdateInfo({
          installMethod: "npm-global",
          currentVersion: "0.5.0",
          latestVersion: "0.5.0-nightly-abc",
          isOutdated: false,
          recommendedCommand: "npm install -g @aoagents/ao@nightly",
        }),
      );
      mockPromptConfirm.mockResolvedValue(true);
      mockSpawn.mockReturnValue(createMockChild(0));

      await program.parseAsync(["node", "test", "update"]);

      // Prompt was forced (default=false for safety) and user confirmed → install ran.
      expect(mockPromptConfirm).toHaveBeenCalledWith(
        expect.stringMatching(/Switch to nightly/),
        false,
      );
      expect(mockSpawn).toHaveBeenCalled();
    });

    it("declines the channel-switch prompt → no install", async () => {
      mockResolveUpdateChannel.mockReturnValue("nightly");
      mockReadCachedUpdateInfo.mockReturnValue({ channel: "stable" });
      mockCheckForUpdate.mockResolvedValue(
        makeNpmUpdateInfo({
          installMethod: "npm-global",
          currentVersion: "0.5.0",
          latestVersion: "0.5.0-nightly-abc",
          isOutdated: false,
        }),
      );
      mockPromptConfirm.mockResolvedValue(false);

      await program.parseAsync(["node", "test", "update"]);
      expect(mockPromptConfirm).toHaveBeenCalled();
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("does NOT force a prompt when channel matches cached.channel (no switch)", async () => {
      mockResolveUpdateChannel.mockReturnValue("nightly");
      mockReadCachedUpdateInfo.mockReturnValue({ channel: "nightly" });
      mockCheckForUpdate.mockResolvedValue(
        makeNpmUpdateInfo({
          installMethod: "npm-global",
          currentVersion: "0.5.0-nightly-abc",
          latestVersion: "0.5.0-nightly-abc",
          isOutdated: false,
        }),
      );
      const logSpy = vi.mocked(console.log);

      await program.parseAsync(["node", "test", "update"]);

      const all = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(all).toMatch(/Already on latest nightly/);
      expect(mockPromptConfirm).not.toHaveBeenCalled();
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("does NOT force a channel-switch prompt when versions match (no prior cache, same channel build)", async () => {
      // Prior behavior was "no previous cache → no prompt regardless of
      // version mismatch", which silently dropped the first-opt-in install
      // (Ashish P2). The first-opt-in branch is now covered by a dedicated
      // describe block above; this test guards the OTHER case — no prior
      // cache but versions actually match — which should still say
      // "Already on latest" and not prompt.
      mockResolveUpdateChannel.mockReturnValue("nightly");
      mockReadCachedUpdateInfo.mockReturnValue(null);
      mockCheckForUpdate.mockResolvedValue(
        makeNpmUpdateInfo({
          installMethod: "npm-global",
          currentVersion: "0.5.0-nightly-abc",
          latestVersion: "0.5.0-nightly-abc",
          isOutdated: false,
        }),
      );
      const logSpy = vi.mocked(console.log);

      await program.parseAsync(["node", "test", "update"]);
      const all = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(all).toMatch(/Already on latest nightly/);
      expect(mockSpawn).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // First-channel opt-in (Ashish P2 — `ao config set updateChannel nightly`
  // followed by `ao update` with no prior auto-update cache)
  // -----------------------------------------------------------------------

  describe("first-channel opt-in", () => {
    beforeEach(() => {
      mockDetectInstallMethod.mockReturnValue("npm-global");
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
      // Active-session guard happy path.
      mockExistsSync.mockReturnValue(true);
      mockLoadGlobalConfig.mockReturnValue({
        projects: { "my-app": { path: "/tmp/foo" } },
      });
      mockLoadConfig.mockImplementation((path?: string) => ({
        projects: { "my-app": { path: "/tmp/foo" } },
        configPath: path ?? "/cwd/agent-orchestrator.yaml",
      }));
    });

    it("triggers install when stable user opts into nightly and there's no prior cache (Ashish proof)", async () => {
      // Repro of Ashish P2: stable user on 0.5.0, runs `ao config set
      // updateChannel nightly`, runs `ao update`. Previously got
      // "Already on latest nightly" because semver says prerelease < stable.
      // With the first-opt-in branch, we recognise the version mismatch and
      // prompt; on confirm, install runs.
      mockResolveUpdateChannel.mockReturnValue("nightly");
      mockReadCachedUpdateInfo.mockReturnValue(null); // no prior cache
      mockCheckForUpdate.mockResolvedValue(
        makeNpmUpdateInfo({
          installMethod: "npm-global",
          currentVersion: "0.5.0",
          latestVersion: "0.5.0-nightly-abc",
          isOutdated: false,
          recommendedCommand: "npm install -g @aoagents/ao@nightly",
        }),
      );
      mockPromptConfirm.mockResolvedValue(true);
      mockSpawn.mockReturnValue(createMockChild(0));

      await program.parseAsync(["node", "test", "update"]);

      // Prompt should be forced (default=false) because this is a first-time
      // opt-in into a different channel, even with no prior cache.
      expect(mockPromptConfirm).toHaveBeenCalledWith(
        expect.stringMatching(/Switch to nightly/),
        false,
      );
      expect(mockSpawn).toHaveBeenCalled();
    });

    it("still says 'already on latest' when versions actually match", async () => {
      // Sanity check: don't false-positive for users who genuinely are up to date.
      mockResolveUpdateChannel.mockReturnValue("nightly");
      mockReadCachedUpdateInfo.mockReturnValue(null);
      mockCheckForUpdate.mockResolvedValue(
        makeNpmUpdateInfo({
          installMethod: "npm-global",
          currentVersion: "0.5.0-nightly-abc",
          latestVersion: "0.5.0-nightly-abc",
          isOutdated: false,
        }),
      );
      const logSpy = vi.mocked(console.log);

      await program.parseAsync(["node", "test", "update"]);

      const all = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(all).toMatch(/Already on latest nightly/);
      expect(mockPromptConfirm).not.toHaveBeenCalled();
      expect(mockSpawn).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // API-invoked (non-interactive) install — Ashish P1 merge blocker
  // -----------------------------------------------------------------------

  describe("API-invoked install (AO_NON_INTERACTIVE_INSTALL=1)", () => {
    let origNonInteractive: string | undefined;
    beforeEach(() => {
      mockDetectInstallMethod.mockReturnValue("npm-global");
      mockResolveUpdateChannel.mockReturnValue("stable");
      mockCheckForUpdate.mockResolvedValue(
        makeNpmUpdateInfo({ installMethod: "npm-global" }),
      );
      mockExistsSync.mockReturnValue(true);
      mockLoadGlobalConfig.mockReturnValue({
        projects: { "my-app": { path: "/tmp/foo" } },
      });
      mockLoadConfig.mockImplementation((path?: string) => ({
        projects: { "my-app": { path: "/tmp/foo" } },
        configPath: path ?? "/cwd/agent-orchestrator.yaml",
      }));
      // stdio: "ignore" makes isTTY() return false, simulating the spawn
      // context POST /api/update creates.
      Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
      origNonInteractive = process.env["AO_NON_INTERACTIVE_INSTALL"];
      process.env["AO_NON_INTERACTIVE_INSTALL"] = "1";
      mockSpawn.mockReturnValue(createMockChild(0));
    });

    afterEach(() => {
      if (origNonInteractive === undefined) {
        delete process.env["AO_NON_INTERACTIVE_INSTALL"];
      } else {
        process.env["AO_NON_INTERACTIVE_INSTALL"] = origNonInteractive;
      }
    });

    it("actually invokes runNpmInstall when AO_NON_INTERACTIVE_INSTALL=1 even though isTTY is false", async () => {
      // The P1 bug: before this fix, the !isTTY() branch printed "Run: ..."
      // and returned. The dashboard's banner click would 202 but no install
      // would run. Asserting spawn was called proves the install actually
      // happens in the API-invoked path.
      await program.parseAsync(["node", "test", "update"]);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      // And without a TTY, we MUST NOT have prompted — that would hang the
      // detached child forever.
      expect(mockPromptConfirm).not.toHaveBeenCalled();
    });

    it("preserves the old 'print Run:' behavior for non-API non-TTY (piped output)", async () => {
      delete process.env["AO_NON_INTERACTIVE_INSTALL"];
      const logSpy = vi.mocked(console.log);
      await program.parseAsync(["node", "test", "update"]);
      const all = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(all).toMatch(/Run: npm install -g @aoagents\/ao@latest/);
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("still refuses on active sessions even when API-invoked (the API's own guard isn't a single point of trust)", async () => {
      mockSessions.value = [{ id: "feat-1", status: "working" }];
      await expect(
        program.parseAsync(["node", "test", "update"]),
      ).rejects.toThrow("process.exit(1)");
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
