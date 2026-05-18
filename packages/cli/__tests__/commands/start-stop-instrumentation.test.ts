/**
 * Tests for start.ts activity-event instrumentation (issue #1654).
 *
 * Covers MUST emits in registerStop and the start action that don't
 * require running the full startup pipeline:
 *   - cli.stop_invoked         (start of ao stop action)
 *   - cli.stop_failed          (outer catch of ao stop action)
 *   - cli.stop_session_failed  (per-session kill failure during ao stop)
 *   - cli.last_stop_write_failed (last-stop persistence failure during ao stop)
 *   - cli.daemon_killed        (SIGTERM sent to parent ao start)
 *   - cli.start_invoked        (true start action entry)
 *   - cli.start_failed (outer) (outer catch of ao start action)
 *   - cli.restore_session_failed (per-session restore failure)
 *
 * cli.start_failed (orchestrator_setup / supervisor_start) is exercised by
 * the existing start.test.ts infrastructure; this file
 * focuses on emits that are reachable with a small deps surface.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockSessionManager,
  mockGetRunning,
  mockUnregister,
  mockWriteLastStop,
  mockReadLastStop,
  mockClearLastStop,
  mockAcquireStartupLock,
  mockIsAlreadyRunning,
  mockFindPidByPort,
  mockKillProcessTree,
  mockIsWindows,
} = vi.hoisted(() => ({
  mockSessionManager: {
    list: vi.fn(),
    kill: vi.fn(),
    restore: vi.fn(),
    ensureOrchestrator: vi.fn(),
    get: vi.fn(),
  },
  mockGetRunning: vi.fn(),
  mockUnregister: vi.fn(),
  mockWriteLastStop: vi.fn(),
  mockReadLastStop: vi.fn(),
  mockClearLastStop: vi.fn(),
  mockAcquireStartupLock: vi.fn(),
  mockIsAlreadyRunning: vi.fn(),
  mockFindPidByPort: vi.fn(),
  mockKillProcessTree: vi.fn(),
  mockIsWindows: vi.fn(),
}));

vi.mock("@aoagents/ao-core", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("@aoagents/ao-core")>();
  return {
    ...actual,
    findPidByPort: (...args: unknown[]) => mockFindPidByPort(...args),
    isWindows: (...args: unknown[]) => mockIsWindows(...args),
    killProcessTree: (...args: unknown[]) => mockKillProcessTree(...args),
    recordActivityEvent: vi.fn(),
  };
});

vi.mock("../../src/lib/create-session-manager.js", () => ({
  getSessionManager: async () => mockSessionManager,
  getPluginRegistry: async () => ({ register: vi.fn(), get: () => null }),
}));

vi.mock("../../src/lib/running-state.js", () => ({
  acquireStartupLock: (...args: unknown[]) => mockAcquireStartupLock(...args),
  isAlreadyRunning: (...args: unknown[]) => mockIsAlreadyRunning(...args),
  getRunning: (...args: unknown[]) => mockGetRunning(...args),
  register: vi.fn(),
  unregister: (...args: unknown[]) => mockUnregister(...args),
  removeProjectFromRunning: vi.fn(),
  addProjectToRunning: vi.fn(),
  writeLastStop: (...args: unknown[]) => mockWriteLastStop(...args),
  readLastStop: (...args: unknown[]) => mockReadLastStop(...args),
  clearLastStop: (...args: unknown[]) => mockClearLastStop(...args),
}));

vi.mock("../../src/lib/lifecycle-service.js", () => ({
  stopAllLifecycleWorkers: vi.fn(),
  listLifecycleWorkers: () => [],
}));

vi.mock("../../src/lib/project-supervisor.js", () => ({
  startProjectSupervisor: vi.fn(),
  stopProjectSupervisor: vi.fn(),
}));

vi.mock("../../src/lib/preflight.js", () => ({
  preflight: { checkPort: vi.fn(), checkBuilt: vi.fn() },
}));

vi.mock("../../src/lib/web-dir.js", () => ({
  findWebDir: vi.fn().mockReturnValue("/fake/web"),
  buildDashboardEnv: vi.fn().mockResolvedValue({}),
  waitForPortAndOpen: vi.fn(),
  openUrl: vi.fn(),
  isPortAvailable: vi.fn().mockResolvedValue(true),
  findFreePort: vi.fn().mockResolvedValue(3000),
  MAX_PORT_SCAN: 100,
}));

vi.mock("../../src/lib/dashboard-rebuild.js", () => ({
  clearStaleCacheIfNeeded: vi.fn(),
  rebuildDashboardProductionArtifacts: vi.fn(),
}));

vi.mock("../../src/lib/shell.js", () => ({
  exec: vi.fn().mockResolvedValue({ stdout: "" }),
  execSilent: vi.fn().mockResolvedValue({ stdout: "" }),
  git: vi.fn(),
}));

vi.mock("../../src/lib/bun-tmp-janitor.js", () => ({
  startBunTmpJanitor: vi.fn(),
}));

vi.mock("../../src/lib/daemon.js", () => ({
  attachToDaemon: vi.fn(),
  killExistingDaemon: vi.fn(),
}));

vi.mock("../../src/lib/caller-context.js", () => ({
  isHumanCaller: () => false,
  getCallerType: () => "automation",
}));

vi.mock("../../src/lib/detect-env.js", () => ({
  detectEnvironment: vi.fn().mockResolvedValue({}),
}));

vi.mock("../../src/lib/detect-agent.js", () => ({
  detectAgentRuntime: vi.fn(),
  detectAvailableAgents: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../src/lib/git-utils.js", () => ({
  detectDefaultBranch: vi.fn().mockResolvedValue("main"),
}));

vi.mock("../../src/lib/prompts.js", () => ({
  promptConfirm: vi.fn().mockResolvedValue(false),
  promptSelect: vi.fn(),
  promptText: vi.fn(),
}));

vi.mock("../../src/lib/install-helpers.js", () => ({
  canPromptForInstall: vi.fn().mockReturnValue(false),
  genericInstallHints: vi.fn().mockReturnValue([]),
  askYesNo: vi.fn().mockResolvedValue(false),
  runInteractiveCommand: vi.fn(),
  tryInstallWithAttempts: vi.fn(),
}));

vi.mock("../../src/lib/startup-preflight.js", () => ({
  ensureGit: vi.fn(),
  runtimePreflight: vi.fn(),
}));

vi.mock("../../src/lib/shutdown.js", () => ({
  installShutdownHandlers: vi.fn(),
}));

vi.mock("../../src/lib/resolve-project.js", () => ({
  resolveOrCreateProject: vi.fn(),
}));

vi.mock("../../src/lib/project-resolution.js", () => ({
  findProjectForDirectory: vi.fn(),
}));

vi.mock("../../src/lib/repo-utils.js", () => ({
  extractOwnerRepo: vi.fn(),
  isValidRepoString: vi.fn(),
}));

vi.mock("../../src/lib/project-detection.js", () => ({
  detectProjectType: vi.fn(),
  generateRulesFromTemplates: vi.fn(),
  formatProjectTypeForDisplay: vi.fn(),
}));

vi.mock("../../src/lib/cli-errors.js", () => ({
  formatCommandError: vi.fn((err: unknown) => String(err)),
}));

import { recordActivityEvent } from "@aoagents/ao-core";
import { registerStart, registerStop } from "../../src/commands/start.js";

const recordedEvents = (): Array<Record<string, unknown>> =>
  vi.mocked(recordActivityEvent).mock.calls.map((c) => c[0] as Record<string, unknown>);

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerStart(program);
  registerStop(program);
  return program;
}

describe("ao stop — activity events", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(recordActivityEvent).mockClear();
    mockGetRunning.mockReset();
    mockSessionManager.list.mockReset();
    mockSessionManager.kill.mockReset();
    mockUnregister.mockReset();
    mockWriteLastStop.mockReset();
    mockGetRunning.mockResolvedValue(null);
    mockFindPidByPort.mockReset();
    mockFindPidByPort.mockResolvedValue(null);
    mockKillProcessTree.mockReset();
    mockKillProcessTree.mockResolvedValue(undefined);
    mockIsWindows.mockReset();
    mockIsWindows.mockReturnValue(false);

    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("emits cli.stop_invoked at the start of the action", async () => {
    const projectArg = "https://token@example.com/org/repo.git";
    // Force a fast failure so the action exits quickly after emitting stop_invoked.
    mockGetRunning.mockResolvedValue(null);
    // Make loadConfig throw so we hit the outer catch
    vi.doMock("@aoagents/ao-core", async (importOriginal) => {
      // eslint-disable-next-line @typescript-eslint/consistent-type-imports
      const actual = await importOriginal<typeof import("@aoagents/ao-core")>();
      return {
        ...actual,
        findPidByPort: (...args: unknown[]) => mockFindPidByPort(...args),
        isWindows: (...args: unknown[]) => mockIsWindows(...args),
        killProcessTree: (...args: unknown[]) => mockKillProcessTree(...args),
        recordActivityEvent: vi.mocked(recordActivityEvent),
        loadConfig: () => {
          throw new Error("config not found");
        },
      };
    });

    vi.resetModules();
    const reloaded = await import("../../src/commands/start.js");
    const program = new Command();
    program.exitOverride();
    reloaded.registerStop(program);

    await expect(program.parseAsync(["node", "ao", "stop", projectArg])).rejects.toThrow();

    const events = recordedEvents();
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "cli.stop_invoked",
        source: "cli",
        summary: "ao stop invoked",
        data: expect.objectContaining({
          projectArg,
        }),
      }),
    );

    vi.doUnmock("@aoagents/ao-core");
  });

  it("emits cli.stop_failed when loadConfig throws", async () => {
    vi.doMock("@aoagents/ao-core", async (importOriginal) => {
      // eslint-disable-next-line @typescript-eslint/consistent-type-imports
      const actual = await importOriginal<typeof import("@aoagents/ao-core")>();
      return {
        ...actual,
        findPidByPort: (...args: unknown[]) => mockFindPidByPort(...args),
        isWindows: (...args: unknown[]) => mockIsWindows(...args),
        killProcessTree: (...args: unknown[]) => mockKillProcessTree(...args),
        recordActivityEvent: vi.mocked(recordActivityEvent),
        loadConfig: () => {
          throw new Error("config blew up");
        },
      };
    });

    vi.resetModules();
    const reloaded = await import("../../src/commands/start.js");
    const program = new Command();
    program.exitOverride();
    reloaded.registerStop(program);

    await expect(program.parseAsync(["node", "ao", "stop"])).rejects.toThrow();

    const events = recordedEvents();
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "cli.stop_failed",
        source: "cli",
        level: "error",
        data: expect.objectContaining({ errorMessage: "config blew up" }),
      }),
    );

    vi.doUnmock("@aoagents/ao-core");
  });

  it("emits cli.daemon_killed when SIGTERM is sent to a running daemon", async () => {
    mockGetRunning.mockResolvedValue({
      pid: 99999,
      configPath: "/tmp/x.yaml",
      port: 3000,
      startedAt: new Date().toISOString(),
      projects: ["my-app"],
    });
    mockSessionManager.list.mockResolvedValue([]);

    vi.doMock("@aoagents/ao-core", async (importOriginal) => {
      // eslint-disable-next-line @typescript-eslint/consistent-type-imports
      const actual = await importOriginal<typeof import("@aoagents/ao-core")>();
      return {
        ...actual,
        findPidByPort: (...args: unknown[]) => mockFindPidByPort(...args),
        isWindows: (...args: unknown[]) => mockIsWindows(...args),
        killProcessTree: (...args: unknown[]) => mockKillProcessTree(...args),
        recordActivityEvent: vi.mocked(recordActivityEvent),
        loadConfig: () => ({
          configPath: "/tmp/x.yaml",
          port: 3000,
          projects: { "my-app": { name: "my-app", path: "/tmp/my-app" } },
          defaults: {},
        }),
      };
    });

    vi.resetModules();
    const reloaded = await import("../../src/commands/start.js");
    const program = new Command();
    program.exitOverride();
    reloaded.registerStop(program);

    try {
      await program.parseAsync(["node", "ao", "stop"]);
    } catch {
      // ao stop may exit; we just want the events
    }

    const events = recordedEvents();
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "cli.daemon_killed",
        source: "cli",
        data: expect.objectContaining({ pid: 99999 }),
      }),
    );
    expect(mockKillProcessTree).toHaveBeenCalledWith(99999, "SIGTERM");

    vi.doUnmock("@aoagents/ao-core");
  });

  it("emits cli.stop_session_failed when sm.kill throws during ao stop", async () => {
    mockGetRunning.mockResolvedValue({
      pid: 99999,
      configPath: "/tmp/x.yaml",
      port: 3000,
      startedAt: new Date().toISOString(),
      projects: ["my-app"],
    });
    mockSessionManager.list.mockResolvedValue([
      {
        id: "sess-1",
        projectId: "my-app",
        status: "working",
      },
    ]);
    mockSessionManager.kill.mockRejectedValue(new Error("kill timeout"));
    vi.spyOn(process, "kill").mockImplementation(() => true);

    vi.doMock("@aoagents/ao-core", async (importOriginal) => {
      // eslint-disable-next-line @typescript-eslint/consistent-type-imports
      const actual = await importOriginal<typeof import("@aoagents/ao-core")>();
      return {
        ...actual,
        findPidByPort: (...args: unknown[]) => mockFindPidByPort(...args),
        isWindows: (...args: unknown[]) => mockIsWindows(...args),
        killProcessTree: (...args: unknown[]) => mockKillProcessTree(...args),
        recordActivityEvent: vi.mocked(recordActivityEvent),
        loadConfig: () => ({
          configPath: "/tmp/x.yaml",
          port: 3000,
          projects: { "my-app": { name: "my-app", path: "/tmp/my-app" } },
          defaults: {},
        }),
        // isTerminalSession returns false so the session is treated as active
        isTerminalSession: () => false,
      };
    });

    vi.resetModules();
    const reloaded = await import("../../src/commands/start.js");
    const program = new Command();
    program.exitOverride();
    reloaded.registerStop(program);

    try {
      await program.parseAsync(["node", "ao", "stop"]);
    } catch {
      // ignored
    }

    const events = recordedEvents();
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "cli.stop_session_failed",
        source: "cli",
        level: "warn",
        sessionId: "sess-1",
        data: expect.objectContaining({ errorMessage: "kill timeout" }),
      }),
    );

    vi.doUnmock("@aoagents/ao-core");
  });

  it("emits cli.last_stop_write_failed when ao stop cannot persist restore state", async () => {
    mockGetRunning.mockResolvedValue(null);
    mockSessionManager.list.mockResolvedValue([
      {
        id: "sess-1",
        projectId: "my-app",
        status: "working",
      },
    ]);
    mockSessionManager.kill.mockResolvedValue({ cleaned: true, alreadyTerminated: false });
    mockWriteLastStop.mockRejectedValue(new Error("last-stop lock busy"));

    vi.doMock("@aoagents/ao-core", async (importOriginal) => {
      // eslint-disable-next-line @typescript-eslint/consistent-type-imports
      const actual = await importOriginal<typeof import("@aoagents/ao-core")>();
      return {
        ...actual,
        findPidByPort: (...args: unknown[]) => mockFindPidByPort(...args),
        isWindows: (...args: unknown[]) => mockIsWindows(...args),
        killProcessTree: (...args: unknown[]) => mockKillProcessTree(...args),
        recordActivityEvent: vi.mocked(recordActivityEvent),
        loadConfig: () => ({
          configPath: "/tmp/x.yaml",
          port: 3000,
          projects: { "my-app": { name: "my-app", path: "/tmp/my-app" } },
          defaults: {},
        }),
        // isTerminalSession returns false so the session is treated as active
        isTerminalSession: () => false,
      };
    });

    vi.resetModules();
    const reloaded = await import("../../src/commands/start.js");
    const program = new Command();
    program.exitOverride();
    reloaded.registerStop(program);

    await program.parseAsync(["node", "ao", "stop", "my-app"]);

    const events = recordedEvents();
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "cli.last_stop_write_failed",
        source: "cli",
        level: "error",
        projectId: "my-app",
        data: expect.objectContaining({
          targetSessionCount: 1,
          totalKilled: 1,
          errorMessage: "last-stop lock busy",
        }),
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        kind: "cli.last_stop_written",
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        kind: "cli.stop_failed",
      }),
    );
    const logs = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
    expect(logs.some((line) => line.includes("Could not list sessions"))).toBe(false);
    expect(logs.some((line) => line.includes("Could not write last-stop state"))).toBe(true);

    vi.doUnmock("@aoagents/ao-core");
  });
});

describe("ao start — activity events (failure paths)", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(recordActivityEvent).mockClear();
    mockAcquireStartupLock.mockReset();
    mockIsAlreadyRunning.mockReset();
    mockAcquireStartupLock.mockResolvedValue(() => undefined);
    mockIsAlreadyRunning.mockResolvedValue(null);

    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("emits cli.start_failed with reason 'outer' when resolveOrCreateProject throws", async () => {
    const projectArg = "https://token@example.com/org/repo.git";
    const resolveProjectMod = await import("../../src/lib/resolve-project.js");
    vi.mocked(resolveProjectMod.resolveOrCreateProject).mockRejectedValue(
      new Error("project resolution exploded"),
    );

    const program = buildProgram();

    try {
      await program.parseAsync(["node", "ao", "start", projectArg]);
    } catch {
      // process.exit(1) throws in the spy
    }

    const events = recordedEvents();
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "cli.start_invoked",
        source: "cli",
        level: "info",
        summary: "ao start invoked",
        data: expect.objectContaining({
          projectArg,
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "cli.start_failed",
        source: "cli",
        level: "error",
        data: expect.objectContaining({
          reason: "outer",
          errorMessage: "project resolution exploded",
        }),
      }),
    );
  });
});
