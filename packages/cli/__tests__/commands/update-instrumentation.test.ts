/**
 * Tests for update.ts activity-event instrumentation (issue #1654).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { EventEmitter } from "node:events";
import * as AoCore from "@aoagents/ao-core";

const { mockRunRepoScript } = vi.hoisted(() => ({
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
  mockCheckForUpdate: vi.fn(),
  mockInvalidateCache: vi.fn(),
  mockGetCurrentVersion: vi.fn(() => "0.2.2"),
  mockGetUpdateCommand: vi.fn(() => "npm install -g @aoagents/ao@latest"),
}));

vi.mock("../../src/lib/update-check.js", () => ({
  detectInstallMethod: () => mockDetectInstallMethod(),
  checkForUpdate: (...args: unknown[]) => mockCheckForUpdate(...args),
  invalidateCache: () => mockInvalidateCache(),
  getCurrentVersion: () => mockGetCurrentVersion(),
  getUpdateCommand: (...args: unknown[]) => mockGetUpdateCommand(...args),
  readCachedUpdateInfo: vi.fn(() => undefined),
  resolveUpdateChannel: vi.fn(() => "stable"),
}));

const { mockPromptConfirm } = vi.hoisted(() => ({
  mockPromptConfirm: vi.fn(async () => true),
}));

vi.mock("../../src/lib/prompts.js", () => ({
  promptConfirm: (...args: unknown[]) => mockPromptConfirm(...args),
}));

vi.mock("../../src/lib/running-state.js", () => ({
  getRunning: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../src/lib/create-session-manager.js", () => ({
  getSessionManager: vi.fn(),
}));

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual("node:child_process");
  return { ...actual, spawn: (...args: unknown[]) => mockSpawn(...args) };
});

vi.mock("@aoagents/ao-core", async (importOriginal) => {
  const actual = await importOriginal<typeof AoCore>();
  return {
    ...actual,
    getGlobalConfigPath: () => "/tmp/__ao_update_instrumentation_no_global_config__",
    recordActivityEvent: vi.fn(),
  };
});

import { registerUpdate } from "../../src/commands/update.js";

const recordedEvents = (): Array<Record<string, unknown>> =>
  vi.mocked(AoCore.recordActivityEvent).mock.calls.map((c) => c[0] as Record<string, unknown>);

function createMockChild(exitCode: number | null, signal?: NodeJS.Signals): EventEmitter {
  const child = new EventEmitter();
  setTimeout(() => child.emit("exit", exitCode, signal ?? null), 0);
  return child;
}

describe("ao update — activity events", () => {
  let program: Command;
  let origStdinTTY: boolean | undefined;
  let origStdoutTTY: boolean | undefined;

  beforeEach(() => {
    vi.mocked(AoCore.recordActivityEvent).mockClear();
    program = new Command();
    program.exitOverride();
    registerUpdate(program);
    mockRunRepoScript.mockReset();
    mockDetectInstallMethod.mockReturnValue("git");
    mockCheckForUpdate.mockReset();
    mockInvalidateCache.mockReset();
    mockPromptConfirm.mockReset();
    mockPromptConfirm.mockResolvedValue(true);
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

  it("emits cli.update_failed when ao-update.sh exits non-zero (git path)", async () => {
    mockDetectInstallMethod.mockReturnValue("git");
    mockRunRepoScript.mockResolvedValue(2);

    // process.exit is mocked to throw — the first `process.exit(2)` triggers
    // the throw, which is then re-caught and emits a second event before the
    // final exit. The instrumentation event for the non-zero exit is what
    // matters; whichever final exit code propagates is incidental.
    await expect(program.parseAsync(["node", "ao", "update"])).rejects.toThrow(/process\.exit/);

    const events = recordedEvents();
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "cli.update_failed",
        source: "cli",
        level: "error",
        data: expect.objectContaining({ method: "git", exitCode: 2 }),
      }),
    );
  });

  it("emits cli.update_failed when ao-update.sh script is missing (git path)", async () => {
    mockDetectInstallMethod.mockReturnValue("git");
    mockRunRepoScript.mockRejectedValue(new Error("Script not found: ao-update.sh"));

    await expect(program.parseAsync(["node", "ao", "update"])).rejects.toThrow("process.exit(1)");

    const events = recordedEvents();
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "cli.update_failed",
        source: "cli",
        level: "error",
        data: expect.objectContaining({ method: "git", reason: "script_missing" }),
      }),
    );
  });

  it("emits cli.update_failed when npm install exits non-zero (npm path)", async () => {
    mockDetectInstallMethod.mockReturnValue("npm-global");
    mockCheckForUpdate.mockResolvedValue({
      currentVersion: "0.2.2",
      latestVersion: "0.3.0",
      isOutdated: true,
      installMethod: "npm-global" as const,
      recommendedCommand: "npm install -g @aoagents/ao@latest",
      checkedAt: new Date().toISOString(),
    });
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    mockSpawn.mockReturnValue(createMockChild(1));

    await expect(program.parseAsync(["node", "ao", "update"])).rejects.toThrow("process.exit(1)");

    const events = recordedEvents();
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "cli.update_failed",
        source: "cli",
        level: "error",
        data: expect.objectContaining({ method: "npm-global", exitCode: 1 }),
      }),
    );
  });

  it("emits cli.update_failed when npm registry lookup returns no version", async () => {
    mockDetectInstallMethod.mockReturnValue("npm-global");
    mockCheckForUpdate.mockResolvedValue({
      currentVersion: "0.2.2",
      latestVersion: null,
      isOutdated: false,
      installMethod: "npm-global" as const,
      recommendedCommand: "npm install -g @aoagents/ao@latest",
      checkedAt: null,
    });

    await expect(program.parseAsync(["node", "ao", "update"])).rejects.toThrow(
      "process.exit(1)",
    );

    const events = recordedEvents();
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "cli.update_failed",
        source: "cli",
        level: "error",
        data: expect.objectContaining({
          method: "npm-global",
          reason: "registry_unreachable",
        }),
      }),
    );
  });

  it("emits cli.update_failed when npm registry lookup throws", async () => {
    mockDetectInstallMethod.mockReturnValue("npm-global");
    mockCheckForUpdate.mockRejectedValue(new Error("registry timeout"));

    await expect(program.parseAsync(["node", "ao", "update"])).rejects.toThrow(
      "process.exit(1)",
    );

    const events = recordedEvents();
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "cli.update_failed",
        source: "cli",
        level: "error",
        data: expect.objectContaining({
          method: "npm-global",
          reason: "registry_lookup_threw",
          errorMessage: "registry timeout",
        }),
      }),
    );
  });
});
