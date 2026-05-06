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

vi.mock("../../src/lib/update-check.js", () => ({
  detectInstallMethod: () => mockDetectInstallMethod(),
  checkForUpdate: (...args: unknown[]) => mockCheckForUpdate(...args),
  invalidateCache: () => mockInvalidateCache(),
  getCurrentVersion: () => mockGetCurrentVersion(),
  getUpdateCommand: (...args: unknown[]) => mockGetUpdateCommand(...args),
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

    it("warns when --skip-smoke is used", async () => {
      mockCheckForUpdate.mockResolvedValue(makeNpmUpdateInfo({ isOutdated: false }));
      const logSpy = vi.mocked(console.log);

      await program.parseAsync(["node", "test", "update", "--skip-smoke"]);
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("only apply to git source installs"),
      );
    });

    it("forces a fresh registry fetch", async () => {
      await program.parseAsync(["node", "test", "update"]);
      expect(mockCheckForUpdate).toHaveBeenCalledWith({ force: true });
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
      expect(mockGetUpdateCommand).toHaveBeenCalledWith("npm-global");
    });
  });
});
