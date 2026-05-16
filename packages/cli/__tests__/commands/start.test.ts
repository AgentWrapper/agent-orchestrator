/**
 * Tests for `ao start` and `ao stop` commands.
 *
 * Uses --no-dashboard --no-orchestrator flags to isolate project resolution
 * and URL handling logic from dashboard/session infrastructure.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import { EventEmitter } from "node:events";
import type { SessionManager } from "@aoagents/ao-core";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockExec,
  mockExecSilent,
  mockConfigRef,
  mockSessionManager,
  mockWaitForPortAndOpen,
  mockSpawn,
  mockFindPidByPort,
  mockKillProcessTree,
  mockSweepDaemonChildren,
  mockScanAoOrphans,
  mockReapAoOrphans,
  mockStartProjectSupervisor,
} = vi.hoisted(() => ({
  mockExec: vi.fn(),
  mockExecSilent: vi.fn(),
  mockConfigRef: { current: null as Record<string, unknown> | null },
  mockSessionManager: {
    list: vi.fn(),
    restore: vi.fn(),
    kill: vi.fn(),
    cleanup: vi.fn(),
    remap: vi.fn(),
    get: vi.fn(),
    spawn: vi.fn(),
    spawnOrchestrator: vi.fn(),
    ensureOrchestrator: vi.fn(),
    send: vi.fn(),
    claimPR: vi.fn(),
  },
  mockWaitForPortAndOpen: vi.fn().mockResolvedValue(undefined),
  mockSpawn: vi.fn(),
  mockFindPidByPort: vi.fn(),
  mockKillProcessTree: vi.fn(),
  mockSweepDaemonChildren: vi.fn(),
  mockScanAoOrphans: vi.fn(),
  mockReapAoOrphans: vi.fn(),
  mockStartProjectSupervisor: vi.fn(),
}));

const { mockDetectOpenClawInstallation } = vi.hoisted(() => ({
  mockDetectOpenClawInstallation: vi.fn(),
}));

const { mockProcessCwd } = vi.hoisted(() => ({
  mockProcessCwd: vi.fn<() => string | undefined>(),
}));

const { mockPromptSelect, mockPromptConfirm } = vi.hoisted(() => ({
  mockPromptSelect: vi.fn(),
  mockPromptConfirm: vi.fn().mockResolvedValue(true),
}));

const {
  mockAcquireStartupLock,
  mockIsAlreadyRunning,
  mockGetRunning,
  mockRegister,
  mockUnregister,
  mockRemoveProjectFromRunning,
  mockAddProjectToRunning,
  mockWaitForExit,
  mockReadLastStop,
  mockWriteLastStop,
  mockClearLastStop,
} = vi.hoisted(() => ({
  mockAcquireStartupLock: vi.fn().mockResolvedValue(() => {}),
  mockIsAlreadyRunning: vi.fn().mockReturnValue(null),
  mockGetRunning: vi.fn().mockResolvedValue(null),
  mockRegister: vi.fn(),
  mockRemoveProjectFromRunning: vi.fn(),
  mockAddProjectToRunning: vi.fn(),
  mockUnregister: vi.fn(),
  mockWaitForExit: vi.fn().mockReturnValue(true),
  mockReadLastStop: vi.fn().mockResolvedValue(null),
  mockWriteLastStop: vi.fn().mockResolvedValue(undefined),
  mockClearLastStop: vi.fn().mockResolvedValue(undefined),
}));

const { mockIsHumanCaller } = vi.hoisted(() => ({
  mockIsHumanCaller: vi.fn().mockReturnValue(true),
}));

vi.mock("../../src/lib/shell.js", () => ({
  tmux: vi.fn(),
  exec: mockExec,
  execSilent: mockExecSilent,
  git: vi.fn(),
  gh: vi.fn(),
  getTmuxSessions: vi.fn().mockResolvedValue([]),
  getTmuxActivity: vi.fn().mockResolvedValue(null),
}));

vi.mock("ora", () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
    info: vi.fn().mockReturnThis(),
    text: "",
  }),
}));

vi.mock("@aoagents/ao-core", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("@aoagents/ao-core")>();
  const normalizeOrchestratorSessionStrategy =
    actual.normalizeOrchestratorSessionStrategy ??
    ((strategy: string | undefined) => {
      if (strategy === "kill-previous" || strategy === "delete-new") return "delete";
      if (strategy === "ignore-new") return "ignore";
      return strategy ?? "reuse";
    });

  return {
    ...actual,
    normalizeOrchestratorSessionStrategy,
    loadConfig: (path?: string) => {
      if (path) return actual.loadConfig(path);
      return mockConfigRef.current;
    },
    findPidByPort: mockFindPidByPort,
    killProcessTree: mockKillProcessTree,
    sweepDaemonChildren: mockSweepDaemonChildren,
    scanAoOrphans: mockScanAoOrphans,
    reapAoOrphans: mockReapAoOrphans,
  };
});

vi.mock("../../src/lib/create-session-manager.js", () => ({
  getSessionManager: async (): Promise<SessionManager> => mockSessionManager as SessionManager,
}));

vi.mock("../../src/lib/lifecycle-service.js", () => ({
  stopAllLifecycleWorkers: vi.fn(),
  listLifecycleWorkers: () => ["my-app"],
}));

vi.mock("../../src/lib/project-supervisor.js", () => ({
  startProjectSupervisor: (...args: unknown[]) => mockStartProjectSupervisor(...args),
  stopProjectSupervisor: vi.fn(),
}));

vi.mock("../../src/lib/web-dir.js", () => ({
  findWebDir: vi.fn().mockReturnValue("/fake/web"),
  buildDashboardEnv: vi.fn().mockResolvedValue({}),
  waitForPortAndOpen: (...args: unknown[]) => mockWaitForPortAndOpen(...args),
  isPortAvailable: vi.fn().mockResolvedValue(true),
  findFreePort: vi.fn().mockResolvedValue(3000),
  MAX_PORT_SCAN: 100,
}));

vi.mock("../../src/lib/dashboard-rebuild.js", () => ({
  clearStaleCacheIfNeeded: vi.fn().mockResolvedValue(undefined),
  findRunningDashboardPid: vi.fn().mockResolvedValue(null),
  rebuildDashboardProductionArtifacts: vi.fn().mockResolvedValue(undefined),
  waitForPortFree: vi.fn(),
}));

vi.mock("../../src/lib/preflight.js", () => ({
  preflight: {
    checkPort: vi.fn(),
    checkBuilt: vi.fn(),
  },
}));

vi.mock("../../src/lib/running-state.js", () => ({
  acquireStartupLock: (...args: unknown[]) => mockAcquireStartupLock(...args),
  register: (...args: unknown[]) => mockRegister(...args),
  unregister: (...args: unknown[]) => mockUnregister(...args),
  removeProjectFromRunning: (...args: unknown[]) => mockRemoveProjectFromRunning(...args),
  addProjectToRunning: (...args: unknown[]) => mockAddProjectToRunning(...args),
  isAlreadyRunning: (...args: unknown[]) => mockIsAlreadyRunning(...args),
  getRunning: (...args: unknown[]) => mockGetRunning(...args),
  waitForExit: (...args: unknown[]) => mockWaitForExit(...args),
  writeLastStop: (...args: unknown[]) => mockWriteLastStop(...args),
  readLastStop: (...args: unknown[]) => mockReadLastStop(...args),
  clearLastStop: (...args: unknown[]) => mockClearLastStop(...args),
}));

vi.mock("../../src/lib/caller-context.js", () => ({
  isHumanCaller: (...args: unknown[]) => mockIsHumanCaller(...args),
  getCallerType: vi.fn().mockReturnValue("human"),
}));

vi.mock("../../src/lib/detect-env.js", () => ({
  detectEnvironment: vi.fn().mockResolvedValue({
    git: {
      isRepo: true,
      remoteUrl: null,
      ownerRepo: null,
      currentBranch: "main",
      defaultBranch: "main",
    },
    tools: { hasTmux: true, hasGh: false, ghAuthed: false },
    apiKeys: { hasLinear: false, hasSlack: false },
  }),
}));

vi.mock("../../src/lib/detect-agent.js", () => ({
  detectAgentRuntime: vi.fn().mockResolvedValue("claude-code"),
  detectAvailableAgents: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../src/lib/project-detection.js", () => ({
  detectProjectType: vi.fn().mockReturnValue({ languages: [], frameworks: [] }),
  generateRulesFromTemplates: vi.fn().mockReturnValue(null),
  formatProjectTypeForDisplay: vi.fn().mockReturnValue(""),
}));

vi.mock("../../src/lib/openclaw-probe.js", () => ({
  detectOpenClawInstallation: (...args: unknown[]) => mockDetectOpenClawInstallation(...args),
}));

vi.mock("../../src/lib/prompts.js", () => ({
  promptSelect: (...args: unknown[]) => mockPromptSelect(...args),
  promptConfirm: (...args: unknown[]) => mockPromptConfirm(...args),
}));

// Stub the update-channel onboarding so `runStartup` doesn't touch the real
// global config file under ~/.agent-orchestrator. Without this, a test that
// reaches runStartup writes `updateChannel` to disk, which makes subsequent
// tests load that config and report wrong errors (e.g. "No projects
// configured" instead of the expected "project not found").
vi.mock("../../src/lib/update-channel-onboarding.js", () => ({
  maybePromptForUpdateChannel: vi.fn(async () => {}),
  hasChosenUpdateChannel: vi.fn(() => true),
  persistUpdateChannel: vi.fn(),
}));

// Mock node:child_process — start.ts imports spawn for dashboard + browser open
vi.mock("node:child_process", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => mockSpawn(...args),
  };
});

// Mock node:process so that `import { cwd } from "node:process"` in start.ts
// can be intercepted per-test via mockProcessCwd.
vi.mock("node:process", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("node:process")>();
  return {
    ...actual,
    cwd: () => {
      const override = mockProcessCwd();
      return override ?? actual.cwd();
    },
  };
});

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

import { Command } from "commander";
import { registerStart, registerStop, autoCreateConfig } from "../../src/commands/start.js";

let tmpDir: string;
let program: Command;
let cwdSpy: ReturnType<typeof vi.spyOn>;
let originalAoGlobalConfig: string | undefined;

function createSpawnChild(options?: {
  /** Emit `error` instead of `close`. */
  error?: Error;
  /** Exit code emitted via `close` (0 = success). */
  closeCode?: number;
}): {
  on: EventEmitter["on"];
  once: EventEmitter["once"];
  kill: () => void;
  emit: EventEmitter["emit"];
  stdout: null;
  stderr: null;
} {
  const emitter = new EventEmitter();
  const closeCode = options?.closeCode ?? 0;

  queueMicrotask(() => {
    if (options?.error) {
      emitter.emit("error", options.error);
      return;
    }
    emitter.emit("close", closeCode);
  });

  return {
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    kill: vi.fn(),
    emit: emitter.emit.bind(emitter),
    stdout: null,
    stderr: null,
  };
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "ao-start-test-"));
  originalAoGlobalConfig = process.env["AO_GLOBAL_CONFIG"];
  process.env["AO_GLOBAL_CONFIG"] = join(tmpDir, "global-agent-orchestrator.yaml");

  program = new Command();
  program.exitOverride();
  registerStart(program);
  registerStop(program);

  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });

  // Default: mock spawn to "succeed" quickly.
  mockSpawn.mockReturnValue(createSpawnChild({ closeCode: 0 }));

  // Re-prime web-dir mocks defeated by afterEach's vi.restoreAllMocks().
  // Without this, findFreePort/isPortAvailable return `undefined`, which makes
  // dashboard-enabled tests print `http://localhost:undefined` and fail in
  // confusing ways.
  const webDir = await import("../../src/lib/web-dir.js");
  vi.mocked(webDir.findWebDir).mockReturnValue("/fake/web");
  vi.mocked(webDir.isPortAvailable).mockResolvedValue(true);
  vi.mocked(webDir.findFreePort).mockResolvedValue(3000);
  vi.mocked(webDir.buildDashboardEnv).mockResolvedValue({});
  const projectDetection = await import("../../src/lib/project-detection.js");
  vi.mocked(projectDetection.detectProjectType).mockReturnValue({
    languages: [],
    frameworks: [],
    tools: [],
  });
  vi.mocked(projectDetection.generateRulesFromTemplates).mockReturnValue(null);
  vi.mocked(projectDetection.formatProjectTypeForDisplay).mockReturnValue("");

  mockSessionManager.list.mockReset();
  mockSessionManager.list.mockResolvedValue([]);
  mockSessionManager.restore.mockReset();
  mockSessionManager.restore.mockResolvedValue({ id: "app-orchestrator-restored" });
  mockSessionManager.get.mockReset();
  mockSessionManager.get.mockImplementation(async (id: string) => {
    const sessions = await mockSessionManager.list("my-app");
    return sessions.find((session: { id: string }) => session.id === id) ?? null;
  });
  mockSessionManager.spawnOrchestrator.mockReset();
  mockSessionManager.spawnOrchestrator.mockResolvedValue({ id: "app-orchestrator" });
  mockSessionManager.ensureOrchestrator.mockReset();
  mockSessionManager.ensureOrchestrator.mockImplementation(async (args) => {
    const existing = await mockSessionManager.get("app-orchestrator");
    if (existing) {
      if (
        existing.status === "killed" ||
        existing.status === "done" ||
        existing.status === "terminated" ||
        existing.activity === "exited"
      ) {
        return mockSessionManager.restore(existing.id);
      }
      return existing;
    }
    return mockSessionManager.spawnOrchestrator(args);
  });
  mockSessionManager.kill.mockReset();
  mockExec.mockReset();
  mockExecSilent.mockReset();
  // Default command availability:
  // - git and tmux are installed
  // - gh auth is unavailable (clone falls through to git SSH/HTTPS)
  mockExecSilent.mockImplementation(async (cmd: string, args: string[] = []) => {
    if (cmd === "git" && args[0] === "--version") return "git version 2.43.0";
    if (cmd === "tmux" && args[0] === "-V") return "tmux 3.4";
    if (cmd === "gh" && args[0] === "--version") return null;
    if (cmd === "gh" && args[0] === "auth" && args[1] === "status") return null;
    return null;
  });
  mockWaitForPortAndOpen.mockReset();
  mockWaitForPortAndOpen.mockResolvedValue(undefined);
  mockFindPidByPort.mockReset();
  mockFindPidByPort.mockResolvedValue(null);
  mockKillProcessTree.mockReset();
  mockKillProcessTree.mockResolvedValue(undefined);
  mockSweepDaemonChildren.mockReset();
  mockSweepDaemonChildren.mockResolvedValue({
    attempted: 0,
    terminated: 0,
    forceKilled: 0,
    failed: 0,
  });
  mockScanAoOrphans.mockReset();
  mockScanAoOrphans.mockResolvedValue([]);
  mockReapAoOrphans.mockReset();
  mockReapAoOrphans.mockResolvedValue({
    attempted: 0,
    terminated: 0,
    forceKilled: 0,
    failed: 0,
  });
  mockStartProjectSupervisor.mockReset();
  mockStartProjectSupervisor.mockResolvedValue({ stop: vi.fn(), reconcileNow: vi.fn() });
  mockDetectOpenClawInstallation.mockReset();
  mockDetectOpenClawInstallation.mockResolvedValue({
    state: "missing",
    gatewayUrl: "http://127.0.0.1:18789",
    probe: { reachable: false, error: "not running" },
  });
  mockSpawn.mockClear();
  mockProcessCwd.mockReset();
  mockPromptSelect.mockReset();
  mockPromptConfirm.mockReset();
  mockPromptConfirm.mockResolvedValue(true);
  mockAcquireStartupLock.mockReset();
  mockAcquireStartupLock.mockResolvedValue(() => {});
  mockIsAlreadyRunning.mockReset();
  mockIsAlreadyRunning.mockResolvedValue(null);
  mockGetRunning.mockReset();
  mockGetRunning.mockResolvedValue(null);
  mockRegister.mockReset();
  mockRegister.mockResolvedValue(undefined);
  mockUnregister.mockReset();
  mockRemoveProjectFromRunning.mockReset();
  mockAddProjectToRunning.mockReset();
  mockWaitForExit.mockReset();
  mockWaitForExit.mockResolvedValue(true);
  mockReadLastStop.mockReset();
  mockReadLastStop.mockResolvedValue(null);
  mockWriteLastStop.mockReset();
  mockWriteLastStop.mockResolvedValue(undefined);
  mockClearLastStop.mockReset();
  mockClearLastStop.mockResolvedValue(undefined);
  mockIsHumanCaller.mockReset();
  mockIsHumanCaller.mockReturnValue(true);
});

afterEach(() => {
  if (cwdSpy) cwdSpy.mockRestore();
  if (originalAoGlobalConfig === undefined) delete process.env["AO_GLOBAL_CONFIG"];
  else process.env["AO_GLOBAL_CONFIG"] = originalAoGlobalConfig;
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(projects: Record<string, Record<string, unknown>>): Record<string, unknown> {
  return {
    configPath: join(tmpDir, "agent-orchestrator.yaml"),
    port: 3000,
    defaults: {
      // Use "process" so the test runs on every platform without
      // tripping ensureTmux. Tests that exercise the tmux preflight
      // path set runtime explicitly.
      runtime: "process",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: [],
    },
    projects,
    notifiers: {},
    notificationRouting: {},
    reactions: {},
  };
}

function makeProject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "My App",
    repo: "org/my-app",
    path: join(tmpDir, "main-repo"),
    defaultBranch: "main",
    sessionPrefix: "app",
    ...overrides,
  };
}

/** Mock process.cwd() to return a specific directory (avoids process.chdir in workers). */
function mockCwd(dir: string): void {
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);
}

/** Create a fake git repo directory with an origin remote URL. */
function createFakeRepo(dir: string, remoteUrl: string, files?: Record<string, string>): void {
  mkdirSync(join(dir, ".git", "refs", "remotes", "origin"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(dir, ".git", "refs", "remotes", "origin", "main"), "abc\n");
  writeFileSync(join(dir, ".git", "config"), `[remote "origin"]\n\turl = ${remoteUrl}\n`);
  if (files) {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content);
    }
  }
}

// ---------------------------------------------------------------------------
// resolveProject (tested through `ao start` with --no-dashboard --no-orchestrator)
// ---------------------------------------------------------------------------

describe("start command — project resolution", () => {
  it("uses single project when no arg given", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });

    await program.parseAsync(["node", "test", "start", "--no-dashboard", "--no-orchestrator"]);

    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("My App");
    expect(output).toContain("Startup complete");
  });

  it("uses explicit project arg when given", async () => {
    mockConfigRef.current = makeConfig({
      frontend: makeProject({ name: "Frontend", sessionPrefix: "fe" }),
      backend: makeProject({ name: "Backend", sessionPrefix: "api" }),
    });

    await program.parseAsync([
      "node",
      "test",
      "start",
      "backend",
      "--no-dashboard",
      "--no-orchestrator",
    ]);

    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("Backend");
  });

  it("errors when explicit project not found", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });

    await expect(
      program.parseAsync([
        "node",
        "test",
        "start",
        "nonexistent",
        "--no-dashboard",
        "--no-orchestrator",
      ]),
    ).rejects.toThrow("process.exit(1)");

    const errors = vi
      .mocked(console.error)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(errors).toContain("not found");
  });

  it("errors when multiple projects and no arg", async () => {
    // Non-interactive callers get an error instead of a prompt
    mockIsHumanCaller.mockReturnValue(false);

    mockConfigRef.current = makeConfig({
      frontend: makeProject({ name: "Frontend" }),
      backend: makeProject({ name: "Backend" }),
    });

    await expect(
      program.parseAsync(["node", "test", "start", "--no-dashboard", "--no-orchestrator"]),
    ).rejects.toThrow("process.exit(1)");

    const errors = vi
      .mocked(console.error)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(errors).toContain("Multiple projects");
  });

  it("errors when no projects configured", async () => {
    mockConfigRef.current = makeConfig({});

    await expect(
      program.parseAsync(["node", "test", "start", "--no-dashboard", "--no-orchestrator"]),
    ).rejects.toThrow("process.exit(1)");

    const errors = vi
      .mocked(console.error)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(errors).toContain("No projects configured");
  });
});

describe("start command — OpenClaw preflight", () => {
  it("warns when OpenClaw is configured but offline", async () => {
    mockConfigRef.current = {
      ...makeConfig({ "my-app": makeProject() }),
      notifiers: {
        openclaw: {
          plugin: "openclaw",
          url: "http://127.0.0.1:18789/hooks/agent",
        },
      },
    };
    mockDetectOpenClawInstallation.mockResolvedValue({
      state: "installed-but-stopped",
      gatewayUrl: "http://127.0.0.1:18789",
      probe: { reachable: false, error: "not running" },
    });

    await program.parseAsync(["node", "test", "start", "--no-dashboard", "--no-orchestrator"]);

    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("OpenClaw is configured but the gateway is not reachable");
  });

  it("suggests setup when OpenClaw is running but not configured", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });
    mockDetectOpenClawInstallation.mockResolvedValue({
      state: "running",
      gatewayUrl: "http://127.0.0.1:18789",
      probe: { reachable: true, httpStatus: 200 },
    });

    await program.parseAsync(["node", "test", "start", "--no-dashboard", "--no-orchestrator"]);

    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("ao setup openclaw");
  });
});

// ---------------------------------------------------------------------------
// URL detection — `ao start <url>` triggers handleUrlStart
// ---------------------------------------------------------------------------

describe("start command — URL argument", () => {
  it("reuses existing clone and generates config", async () => {
    const repoDir = join(tmpDir, "DevOS");
    createFakeRepo(repoDir, "https://github.com/ComposioHQ/DevOS.git", {
      "package.json": "{}",
      "pnpm-lock.yaml": "",
    });
    mockCwd(tmpDir);

    await program.parseAsync([
      "node",
      "test",
      "start",
      "https://github.com/ComposioHQ/DevOS",
      "--no-dashboard",
      "--no-orchestrator",
    ]);

    // Config should have been generated
    expect(existsSync(join(repoDir, "agent-orchestrator.yaml"))).toBe(true);

    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("Reusing existing clone");
    expect(output).toContain("Startup complete");
  });

  it("clones repo via gh when gh auth is available", async () => {
    const repoDir = join(tmpDir, "my-app");
    mockCwd(tmpDir);

    // gh auth status succeeds
    mockExecSilent.mockResolvedValue("Logged in");

    mockSpawn.mockImplementation(
      (cmd: string, args: string[], _opts?: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
        if (cmd === "gh" && args[0] === "repo" && args[1] === "clone") {
          createFakeRepo(repoDir, "https://github.com/owner/my-app.git", {
            "Cargo.toml": "",
          });
        }
        return createSpawnChild({ closeCode: 0 });
      },
    );

    await program.parseAsync([
      "node",
      "test",
      "start",
      "https://github.com/owner/my-app",
      "--no-dashboard",
      "--no-orchestrator",
    ]);

    expect(mockSpawn).toHaveBeenCalledWith(
      "gh",
      ["repo", "clone", "owner/my-app", repoDir, "--", "--depth", "1"],
      expect.anything(),
    );

    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("Startup complete");
  });

  it("falls back to git clone when gh is unavailable", async () => {
    const repoDir = join(tmpDir, "my-app");
    mockCwd(tmpDir);

    // gh auth status fails (not installed or not logged in)
    mockExecSilent.mockImplementation(async (cmd: string, args: string[] = []) => {
      if (cmd === "git" && args[0] === "--version") return "git version 2.43.0";
      if (cmd === "tmux" && args[0] === "-V") return "tmux 3.4";
      if (cmd === "gh" && args[0] === "auth" && args[1] === "status") return null;
      return null;
    });

    mockSpawn.mockImplementation(
      (cmd: string, args: string[], _opts?: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
        if (cmd === "git" && args[0] === "clone") {
          const url = String(args[3] ?? "");
          // SSH attempt fails (simulate non-zero exit)
          if (url.startsWith("git@")) {
            return createSpawnChild({ closeCode: 1 });
          }

          // HTTPS fallback succeeds
          createFakeRepo(repoDir, "https://github.com/owner/my-app.git", {
            "Cargo.toml": "",
          });
        }

        return createSpawnChild({ closeCode: 0 });
      },
    );

    await program.parseAsync([
      "node",
      "test",
      "start",
      "https://github.com/owner/my-app",
      "--no-dashboard",
      "--no-orchestrator",
    ]);

    // Should have tried SSH first, then HTTPS
    expect(mockSpawn).toHaveBeenCalledWith(
      "git",
      ["clone", "--depth", "1", "git@github.com:owner/my-app.git", repoDir],
      expect.anything(),
    );
    expect(mockSpawn).toHaveBeenCalledWith(
      "git",
      ["clone", "--depth", "1", "https://github.com/owner/my-app.git", repoDir],
      expect.anything(),
    );

    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("Startup complete");
  });

  it("uses existing config when repo already has agent-orchestrator.yaml", async () => {
    const repoDir = join(tmpDir, "configured-app");
    createFakeRepo(repoDir, "https://github.com/owner/configured-app.git");
    mockCwd(tmpDir);

    writeFileSync(
      join(repoDir, "agent-orchestrator.yaml"),
      [
        "port: 4000",
        "defaults:",
        "  runtime: process",
        "  agent: claude-code",
        "  workspace: worktree",
        "  notifiers: [desktop]",
        "projects:",
        "  configured-app:",
        "    name: Configured App",
        "    repo: owner/configured-app",
        `    path: ${repoDir}`,
        "    defaultBranch: main",
        "    sessionPrefix: ca",
      ].join("\n"),
    );

    await program.parseAsync([
      "node",
      "test",
      "start",
      "https://github.com/owner/configured-app",
      "--no-dashboard",
      "--no-orchestrator",
    ]);

    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("Using existing config");
    expect(output).toContain("Configured App");
  });

  it("resolves correct project when existing config has multiple projects", async () => {
    const repoDir = join(tmpDir, "multi-proj");
    createFakeRepo(repoDir, "https://github.com/org/multi-proj.git");
    mockCwd(tmpDir);

    writeFileSync(
      join(repoDir, "agent-orchestrator.yaml"),
      [
        "port: 4000",
        "defaults:",
        "  runtime: process",
        "  agent: claude-code",
        "  workspace: worktree",
        "  notifiers: [desktop]",
        "projects:",
        "  frontend:",
        "    name: Frontend",
        "    repo: org/other-repo",
        `    path: ${repoDir}/frontend`,
        "    defaultBranch: main",
        "    sessionPrefix: fe",
        "  multi-proj:",
        "    name: Multi Proj",
        "    repo: org/multi-proj",
        `    path: ${repoDir}`,
        "    defaultBranch: main",
        "    sessionPrefix: mp",
      ].join("\n"),
    );

    await program.parseAsync([
      "node",
      "test",
      "start",
      "https://github.com/org/multi-proj",
      "--no-dashboard",
      "--no-orchestrator",
    ]);

    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    // Should pick "Multi Proj" by matching repo field, not error with "Multiple projects"
    expect(output).toContain("Multi Proj");
    expect(output).toContain("Startup complete");
  });

  it("fails on clone error with descriptive message", async () => {
    mockCwd(tmpDir);
    mockSpawn.mockImplementation(() =>
      createSpawnChild({ error: new Error("fatal: repository not found") }),
    );

    await expect(
      program.parseAsync([
        "node",
        "test",
        "start",
        "https://github.com/owner/nonexistent",
        "--no-dashboard",
        "--no-orchestrator",
      ]),
    ).rejects.toThrow("process.exit(1)");

    const errors = vi
      .mocked(console.error)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(errors).toContain("Failed to clone");
  });
});

describe("start command — non-interactive install safety", () => {
  function hasPrivilegedInstallAttempt(): boolean {
    return mockExec.mock.calls.some((call) => {
      const cmd = String(call[0]);
      const args = Array.isArray(call[1]) ? (call[1] as string[]) : [];
      const joined = `${cmd} ${args.join(" ")}`;
      return joined.includes(" install ") && (cmd === "sudo" || cmd === "brew" || cmd === "winget");
    });
  }

  it("does not auto-install tmux when missing in non-interactive mode", async () => {
    mockIsHumanCaller.mockReturnValue(false);

    // This test exercises the tmux preflight path, so the config must
    // explicitly select runtime: tmux (makeConfig defaults to process).
    // Pin the platform to linux so the Windows branch (which exits before
    // calling execSilent) doesn't short-circuit the tmux -V check we're
    // asserting on.
    const tmuxConfig = makeConfig({ "my-app": makeProject() }) as {
      defaults: Record<string, unknown>;
    };
    tmuxConfig.defaults.runtime = "tmux";
    mockConfigRef.current = tmuxConfig;

    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });

    mockExecSilent.mockImplementation(async (cmd: string, args: string[] = []) => {
      if (cmd === "git" && args[0] === "--version") return "git version 2.43.0";
      if (cmd === "tmux" && args[0] === "-V") return null;
      if (cmd === "gh" && args[0] === "--version") return null;
      if (cmd === "gh" && args[0] === "auth" && args[1] === "status") return null;
      return null;
    });

    try {
      await expect(
        program.parseAsync(["node", "test", "start", "--no-dashboard", "--no-orchestrator"]),
      ).rejects.toThrow("process.exit(1)");
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, "platform", originalPlatform);
      }
    }

    expect(hasPrivilegedInstallAttempt()).toBe(false);
    expect(mockExec.mock.calls.some((call) => String(call[0]) === "tmux")).toBe(false);
  });

  it("does not auto-install git when missing in non-interactive URL start", async () => {
    mockIsHumanCaller.mockReturnValue(false);

    mockCwd(tmpDir);
    mockExecSilent.mockImplementation(async (cmd: string, args: string[] = []) => {
      if (cmd === "git" && args[0] === "--version") return null;
      if (cmd === "tmux" && args[0] === "-V") return "tmux 3.4";
      if (cmd === "gh" && args[0] === "--version") return null;
      if (cmd === "gh" && args[0] === "auth" && args[1] === "status") return null;
      return null;
    });

    await expect(
      program.parseAsync([
        "node",
        "test",
        "start",
        "https://github.com/owner/nonexistent",
        "--no-dashboard",
        "--no-orchestrator",
      ]),
    ).rejects.toThrow("process.exit(1)");

    expect(hasPrivilegedInstallAttempt()).toBe(false);
    expect(
      mockExec.mock.calls.some((call) => {
        const cmd = String(call[0]);
        const args = Array.isArray(call[1]) ? (call[1] as string[]) : [];
        return cmd === "git" && args[0] === "clone";
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// waitForPortAndOpen — port polling logic
// ---------------------------------------------------------------------------

describe("start command — browser open waits for port", () => {
  it("calls waitForPortAndOpen with orchestrator URL and AbortSignal", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });

    // Mock findWebDir to return tmpDir and create package.json for existsSync
    const { findWebDir } = await import("../../src/lib/web-dir.js");
    vi.mocked(findWebDir).mockReturnValue(tmpDir);
    writeFileSync(join(tmpDir, "package.json"), "{}");

    // No existing orchestrators on disk → spawnOrchestrator runs and returns
    // a numbered id which must end up in the auto-opened browser URL.
    mockSessionManager.list.mockResolvedValue([]);
    mockSessionManager.spawnOrchestrator.mockResolvedValue({
      id: "app-orchestrator",
      projectId: "my-app",
      status: "working",
      activity: "active",
      metadata: { role: "orchestrator" },
    });

    await program.parseAsync(["node", "test", "start"]);

    // waitForPortAndOpen should have been called with orchestrator URL and AbortSignal
    expect(mockWaitForPortAndOpen).toHaveBeenCalledTimes(1);
    const args = mockWaitForPortAndOpen.mock.calls[0];
    expect(args[1]).toContain("/projects/my-app/sessions/app-orchestrator");
    expect(args[2]).toBeInstanceOf(AbortSignal);
    expect(mockStartProjectSupervisor).toHaveBeenCalledTimes(1);
  });

  it("skips browser open and lifecycle with --no-dashboard --no-orchestrator", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });

    await program.parseAsync(["node", "test", "start", "--no-dashboard", "--no-orchestrator"]);

    expect(mockWaitForPortAndOpen).not.toHaveBeenCalled();
    expect(mockStartProjectSupervisor).not.toHaveBeenCalled();
  });

  it("skips browser open but still starts lifecycle with --no-dashboard alone", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });

    mockSessionManager.get.mockResolvedValue(null);
    mockSessionManager.spawnOrchestrator.mockResolvedValue({ id: "app-orchestrator" });

    await program.parseAsync(["node", "test", "start", "--no-dashboard"]);

    expect(mockWaitForPortAndOpen).not.toHaveBeenCalled();
    expect(mockStartProjectSupervisor).toHaveBeenCalledTimes(1);
  });
});

describe("start command — orchestrator session strategy display", () => {
  function getLoggedOutput(): string {
    return vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
  }

  it("shows reused messaging when strategy is reuse and metadata marks the session reused", async () => {
    mockConfigRef.current = makeConfig({
      "my-app": makeProject({ orchestratorSessionStrategy: "reuse" }),
    });

    mockSessionManager.get.mockResolvedValue({
      id: "app-orchestrator",
      runtimeHandle: { id: "tmux-session-1" },
    });
    mockSessionManager.spawnOrchestrator.mockResolvedValue({
      id: "app-orchestrator",
      runtimeHandle: { id: "tmux-session-1" },
      metadata: { orchestratorSessionReused: "true" },
    });

    await program.parseAsync(["node", "test", "start", "--no-dashboard"]);

    const output = getLoggedOutput();
    expect(output).toContain("ao session attach app-orchestrator");
    expect(output).not.toContain("tmux attach -t tmux-session-1");
  });

  it("falls back to attach messaging when strategy is reuse but metadata is missing", async () => {
    mockConfigRef.current = makeConfig({
      "my-app": makeProject({ orchestratorSessionStrategy: "reuse" }),
    });

    mockSessionManager.get.mockResolvedValue({
      id: "app-orchestrator",
      runtimeHandle: { id: "tmux-session-1" },
    });
    mockSessionManager.spawnOrchestrator.mockResolvedValue({
      id: "app-orchestrator",
      runtimeHandle: { id: "tmux-session-1" },
    });

    await program.parseAsync(["node", "test", "start", "--no-dashboard"]);

    const output = getLoggedOutput();
    expect(output).toContain("ao session attach app-orchestrator");
    expect(output).not.toContain("reused existing session");
  });

  it.each(["delete", "ignore", "delete-new", "ignore-new", "kill-previous"] as const)(
    "uses ao session attach when strategy is %s and --no-dashboard",
    async (orchestratorSessionStrategy) => {
      mockConfigRef.current = makeConfig({
        "my-app": makeProject({ orchestratorSessionStrategy }),
      });

      mockSessionManager.get.mockResolvedValue({
        id: "app-orchestrator",
        runtimeHandle: { id: "tmux-session-1" },
      });
      mockSessionManager.spawnOrchestrator.mockResolvedValue({
        id: "app-orchestrator",
        runtimeHandle: { id: "tmux-session-1" },
        metadata: { orchestratorSessionReused: "true" },
      });

      await program.parseAsync(["node", "test", "start", "--no-dashboard"]);

      const output = getLoggedOutput();
      expect(output).toContain("ao session attach app-orchestrator");
      expect(output).not.toContain("reused existing session");
    },
  );

  it("handles existing orchestrator sessions by auto-selecting when --no-dashboard", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });

    // Return an existing orchestrator session
    mockSessionManager.list.mockResolvedValue([
      {
        id: "app-orchestrator",
        projectId: "my-app",
        status: "working",
        activity: "active",
        metadata: { role: "orchestrator" },
        lastActivityAt: new Date(),
        runtimeHandle: { id: "tmux-session-existing" },
      },
    ]);
    mockSessionManager.spawnOrchestrator.mockResolvedValue({
      id: "app-orchestrator",
      runtimeHandle: { id: "tmux-session-new" },
    });

    await program.parseAsync(["node", "test", "start", "--no-dashboard"]);

    const output = getLoggedOutput();
    expect(mockSessionManager.kill).not.toHaveBeenCalled();
    expect(mockSessionManager.spawnOrchestrator).not.toHaveBeenCalled();
    expect(output).toContain("ao session attach app-orchestrator");
  });

  it("restores the latest restorable orchestrator when tmux is gone", async () => {
    mockConfigRef.current = makeConfig({
      "my-app": makeProject({ orchestratorSessionStrategy: "reuse" }),
    });

    const now = new Date();
    mockSessionManager.list.mockResolvedValue([
      {
        id: "app-orchestrator",
        projectId: "my-app",
        status: "killed",
        activity: "exited",
        metadata: { role: "orchestrator" },
        lastActivityAt: new Date(now.getTime() - 1000),
        lifecycle: {
          version: 2,
          session: {
            kind: "orchestrator",
            state: "working",
            reason: "task_in_progress",
            startedAt: now.toISOString(),
            completedAt: null,
            terminatedAt: null,
            lastTransitionAt: now.toISOString(),
          },
          pr: {
            state: "none",
            reason: "not_created",
            number: null,
            url: null,
            lastObservedAt: null,
          },
          runtime: {
            state: "missing",
            reason: "tmux_missing",
            lastObservedAt: now.toISOString(),
            handle: null,
            tmuxName: "tmux-old-1",
          },
        },
      },
      {
        id: "app-orchestrator",
        projectId: "my-app",
        status: "killed",
        activity: "exited",
        metadata: { role: "orchestrator" },
        lastActivityAt: now,
        lifecycle: {
          version: 2,
          session: {
            kind: "orchestrator",
            state: "working",
            reason: "task_in_progress",
            startedAt: now.toISOString(),
            completedAt: null,
            terminatedAt: null,
            lastTransitionAt: now.toISOString(),
          },
          pr: {
            state: "none",
            reason: "not_created",
            number: null,
            url: null,
            lastObservedAt: null,
          },
          runtime: {
            state: "missing",
            reason: "tmux_missing",
            lastObservedAt: now.toISOString(),
            handle: null,
            tmuxName: "tmux-old-2",
          },
        },
      },
    ]);
    mockSessionManager.restore.mockResolvedValue({
      id: "app-orchestrator",
      runtimeHandle: { id: "tmux-restored-2" },
    });

    await program.parseAsync(["node", "test", "start", "--no-dashboard"]);

    const output = getLoggedOutput();
    expect(output).toContain("ao session attach app-orchestrator");
    expect(mockSessionManager.restore).toHaveBeenCalledWith("app-orchestrator");
    expect(mockSessionManager.spawnOrchestrator).not.toHaveBeenCalled();
  });

  it("navigates directly to session page when one existing orchestrator found with dashboard enabled", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });

    // Mock findWebDir and port availability for dashboard-enabled test
    const webDir = await import("../../src/lib/web-dir.js");
    vi.mocked(webDir.findWebDir).mockReturnValue(tmpDir);
    vi.mocked(webDir.isPortAvailable).mockResolvedValue(true);
    writeFileSync(join(tmpDir, "package.json"), "{}");

    const fakeDashboard = {
      on: vi.fn(),
      kill: vi.fn(),
      emit: vi.fn(),
    };
    mockSpawn.mockReturnValue(fakeDashboard);

    // Return a single existing orchestrator session
    mockSessionManager.list.mockResolvedValue([
      {
        id: "app-orchestrator",
        projectId: "my-app",
        status: "working",
        activity: "active",
        metadata: { role: "orchestrator" },
        lastActivityAt: new Date(),
        runtimeHandle: { id: "tmux-session-existing" },
      },
    ]);
    mockSessionManager.spawnOrchestrator.mockResolvedValue({
      id: "app-orchestrator",
      runtimeHandle: { id: "tmux-session-new" },
    });

    await program.parseAsync(["node", "test", "start"]);

    const output = getLoggedOutput();
    expect(mockSessionManager.kill).not.toHaveBeenCalled();
    expect(mockSessionManager.spawnOrchestrator).not.toHaveBeenCalled();
    expect(output).toContain("http://localhost:3000/projects/my-app/sessions/app-orchestrator");
    expect(output).not.toContain("tmux attach");
  });

  it("passes the requested and reassigned dashboard ports to rebuild", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });

    const webDir = await import("../../src/lib/web-dir.js");
    vi.mocked(webDir.findWebDir).mockReturnValue(tmpDir);
    vi.mocked(webDir.isPortAvailable).mockResolvedValue(false);
    vi.mocked(webDir.findFreePort).mockResolvedValue(3001);
    mkdirSync(join(tmpDir, "server"), { recursive: true });
    writeFileSync(join(tmpDir, "package.json"), "{}");

    const dashboardRebuild = await import("../../src/lib/dashboard-rebuild.js");

    await program.parseAsync(["node", "test", "start", "--rebuild", "--no-orchestrator"]);

    expect(dashboardRebuild.rebuildDashboardProductionArtifacts).toHaveBeenCalledWith(
      tmpDir,
      [3000, 3001],
    );
  });

  it("opens the most recent orchestrator session page when multiple existing orchestrators found with dashboard enabled and reuse is explicit", async () => {
    mockConfigRef.current = makeConfig({
      "my-app": makeProject({ orchestratorSessionStrategy: "reuse" }),
    });

    // Mock findWebDir
    const { findWebDir } = await import("../../src/lib/web-dir.js");
    vi.mocked(findWebDir).mockReturnValue(tmpDir);
    writeFileSync(join(tmpDir, "package.json"), "{}");

    const fakeDashboard = {
      on: vi.fn(),
      kill: vi.fn(),
      emit: vi.fn(),
    };
    mockSpawn.mockReturnValue(fakeDashboard);

    const now = new Date();
    // Return two existing orchestrator sessions
    mockSessionManager.list.mockResolvedValue([
      {
        id: "app-orchestrator",
        projectId: "my-app",
        status: "working",
        activity: "active",
        metadata: { role: "orchestrator" },
        lastActivityAt: new Date(now.getTime() - 1000),
        runtimeHandle: { id: "tmux-session-1" },
      },
      {
        id: "app-orchestrator",
        projectId: "my-app",
        status: "working",
        activity: "active",
        metadata: { role: "orchestrator" },
        lastActivityAt: now,
        runtimeHandle: { id: "tmux-session-2" },
      },
    ]);

    await program.parseAsync(["node", "test", "start"]);

    const output = getLoggedOutput();
    expect(output).toContain("/projects/my-app/sessions/app-orchestrator");

    expect(mockWaitForPortAndOpen).toHaveBeenCalledTimes(1);
    const args = mockWaitForPortAndOpen.mock.calls[0];
    expect(args[1]).toContain("/projects/my-app/sessions/app-orchestrator");

    // Should NOT spawn a new orchestrator when existing ones exist
    expect(mockSessionManager.spawnOrchestrator).not.toHaveBeenCalled();
  });

  // ----- Issue #1048: stable orchestrator reuse -----------------------------
  // The next block of tests pins down the new lookup contract that runStartup
  // must follow when deciding whether to reuse, restore, or spawn fresh.

  it("creates the canonical orchestrator when only numbered legacy orchestrators exist", async () => {
    mockConfigRef.current = makeConfig({
      "my-app": makeProject({ orchestratorSessionStrategy: "reuse" }),
    });

    // Numbered orchestrators are legacy/stale and should not be restored as
    // the main orchestrator.
    mockSessionManager.list.mockResolvedValue([
      {
        id: "app-orchestrator-3",
        projectId: "my-app",
        status: "killed",
        activity: "exited",
        metadata: { role: "orchestrator" },
        lastActivityAt: new Date(),
        runtimeHandle: { id: "tmux-session-3" },
      },
    ]);
    mockSessionManager.restore.mockResolvedValue({
      id: "app-orchestrator",
      projectId: "my-app",
      status: "spawning",
      activity: "active",
      metadata: { role: "orchestrator" },
      lastActivityAt: new Date(),
      runtimeHandle: { id: "tmux-session-3" },
    });

    await program.parseAsync(["node", "test", "start", "--no-dashboard"]);

    expect(mockSessionManager.restore).not.toHaveBeenCalled();
    expect(mockSessionManager.spawnOrchestrator).toHaveBeenCalledTimes(1);

    const output = getLoggedOutput();
    expect(output).toContain("ao session attach app-orchestrator");
    expect(output).not.toContain("(restored)");
  });

  it("ignores stale bare {projectId}-orchestrator records that lack role metadata", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });

    // Legacy bare-named record from a pre-numbered AO version with no role
    // metadata — must NOT be treated as an orchestrator, so spawnOrchestrator
    // still gets called and the user gets a fresh numbered id.
    mockSessionManager.list.mockResolvedValue([
      {
        id: "my-app-orchestrator",
        projectId: "my-app",
        status: "working",
        activity: "active",
        metadata: {},
        lastActivityAt: new Date(),
        runtimeHandle: null,
      },
    ]);
    mockSessionManager.spawnOrchestrator.mockResolvedValue({
      id: "app-orchestrator",
      projectId: "my-app",
      status: "working",
      activity: "active",
      metadata: { role: "orchestrator" },
    });

    await program.parseAsync(["node", "test", "start", "--no-dashboard"]);

    expect(mockSessionManager.spawnOrchestrator).toHaveBeenCalledTimes(1);
    expect(mockSessionManager.restore).not.toHaveBeenCalled();

    const output = getLoggedOutput();
    expect(output).toContain("ao session attach app-orchestrator");
    expect(output).not.toContain("/sessions/my-app-orchestrator");
  });

  it("prefers a live orchestrator over a more-recently-active restorable one", async () => {
    // Regression guard for PR #1075 review comment: an earlier version of
    // runStartup merged live + restorable into one bucket and sorted by
    // lastActivityAt, which could pick a newer *killed* record over an older
    // but still-running one. sm.restore() would then spin up the killed
    // record while the live one kept running, leaving two orchestrators
    // alive. The fix prefers live unconditionally.
    mockConfigRef.current = makeConfig({
      "my-app": makeProject({ orchestratorSessionStrategy: "reuse" }),
    });

    const now = Date.now();
    mockSessionManager.list.mockResolvedValue([
      // Live but older — this is the one we must pick.
      {
        id: "app-orchestrator",
        projectId: "my-app",
        status: "working",
        activity: "active",
        metadata: { role: "orchestrator" },
        lastActivityAt: new Date(now - 60_000),
        runtimeHandle: { id: "tmux-2" },
      },
      // Killed but newer — the old buggy sort would have picked this one.
      {
        id: "app-orchestrator-3",
        projectId: "my-app",
        status: "killed",
        activity: "exited",
        metadata: { role: "orchestrator" },
        lastActivityAt: new Date(now),
        runtimeHandle: { id: "tmux-3" },
      },
    ]);

    await program.parseAsync(["node", "test", "start"]);

    // The live -2 is reused in place; the killed -3 is NOT restored.
    expect(mockSessionManager.restore).not.toHaveBeenCalled();
    expect(mockSessionManager.spawnOrchestrator).not.toHaveBeenCalled();

    const output = getLoggedOutput();
    expect(output).toContain("/projects/my-app/sessions/app-orchestrator");
    expect(output).not.toContain("/projects/my-app/sessions/app-orchestrator-3");
  });

  it("reuses the most-recently-active live orchestrator when multiple are running", async () => {
    mockConfigRef.current = makeConfig({
      "my-app": makeProject({ orchestratorSessionStrategy: "reuse" }),
    });

    const now = Date.now();
    mockSessionManager.list.mockResolvedValue([
      {
        id: "app-orchestrator",
        projectId: "my-app",
        status: "working",
        activity: "active",
        metadata: { role: "orchestrator" },
        lastActivityAt: new Date(now - 30_000),
        runtimeHandle: { id: "tmux-1" },
      },
      {
        id: "app-orchestrator",
        projectId: "my-app",
        status: "working",
        activity: "active",
        metadata: { role: "orchestrator" },
        lastActivityAt: new Date(now),
        runtimeHandle: { id: "tmux-2" },
      },
    ]);

    await program.parseAsync(["node", "test", "start", "--no-dashboard"]);

    expect(mockSessionManager.spawnOrchestrator).not.toHaveBeenCalled();
    expect(mockSessionManager.restore).not.toHaveBeenCalled();

    const output = getLoggedOutput();
    expect(output).toContain("ao session attach app-orchestrator");
  });

  it("fails and cleans up dashboard when orchestrator setup throws", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });

    // Mock findWebDir
    const { findWebDir } = await import("../../src/lib/web-dir.js");
    vi.mocked(findWebDir).mockReturnValue(tmpDir);
    writeFileSync(join(tmpDir, "package.json"), "{}");

    const fakeDashboard = {
      on: vi.fn(),
      kill: vi.fn(),
      emit: vi.fn(),
    };
    mockSpawn.mockReturnValue(fakeDashboard);

    mockSessionManager.list.mockResolvedValue([]);
    mockSessionManager.spawnOrchestrator.mockRejectedValue(new Error("Spawn failed"));

    await expect(program.parseAsync(["node", "test", "start"])).rejects.toThrow("process.exit(1)");

    const errors = vi
      .mocked(console.error)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(errors).toContain("Failed to setup orchestrator: Spawn failed");

    // Should have killed the dashboard
    expect(fakeDashboard.kill).toHaveBeenCalled();
  });

  it("reports startup lock acquisition failures through the normal CLI error path", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });
    mockAcquireStartupLock.mockRejectedValueOnce(
      new Error("Could not acquire startup lock (/tmp/startup.lock)"),
    );

    await expect(program.parseAsync(["node", "test", "start"])).rejects.toThrow("process.exit(1)");

    const errors = vi
      .mocked(console.error)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(errors).toContain("Could not acquire startup lock (/tmp/startup.lock)");
    expect(mockIsAlreadyRunning).not.toHaveBeenCalled();
  });

  it("releases the startup lock before exiting on startup failures", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });
    const releaseStartupLock = vi.fn();
    mockAcquireStartupLock.mockResolvedValueOnce(releaseStartupLock);
    mockSessionManager.list.mockResolvedValue([]);
    mockSessionManager.spawnOrchestrator.mockRejectedValue(new Error("Spawn failed"));

    await expect(program.parseAsync(["node", "test", "start"])).rejects.toThrow("process.exit(1)");

    expect(releaseStartupLock).toHaveBeenCalledTimes(1);
  });

  it("fails and cleans up dashboard when sm.restore throws on a killed orchestrator", async () => {
    mockConfigRef.current = makeConfig({
      "my-app": makeProject({ orchestratorSessionStrategy: "reuse" }),
    });

    const { findWebDir } = await import("../../src/lib/web-dir.js");
    vi.mocked(findWebDir).mockReturnValue(tmpDir);
    writeFileSync(join(tmpDir, "package.json"), "{}");

    const fakeDashboard = { on: vi.fn(), kill: vi.fn(), emit: vi.fn() };
    mockSpawn.mockReturnValue(fakeDashboard);

    // Only candidate is restorable. sm.restore throws — runStartup must
    // surface the error, kill the dashboard, and never fall through to
    // spawnOrchestrator (which would silently allocate a fresh -N).
    mockSessionManager.list.mockResolvedValue([
      {
        id: "app-orchestrator",
        projectId: "my-app",
        status: "killed",
        activity: "exited",
        metadata: { role: "orchestrator" },
        lastActivityAt: new Date(),
        runtimeHandle: { id: "tmux-3" },
      },
    ]);
    mockSessionManager.restore.mockRejectedValue(new Error("workspace gone"));

    await expect(program.parseAsync(["node", "test", "start"])).rejects.toThrow("process.exit(1)");

    const errors = vi
      .mocked(console.error)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(errors).toContain("Failed to setup orchestrator");
    expect(errors).toContain("workspace gone");

    expect(mockSessionManager.spawnOrchestrator).not.toHaveBeenCalled();
    expect(fakeDashboard.kill).toHaveBeenCalled();
  });

  // Regression for the boundary-bug-hunter Phase 3 finding on PR #1466:
  // partial restore failure used to call clearLastStop() unconditionally,
  // erasing the only persisted record of the sessions that failed to
  // restore. A transient workspace/runtime error therefore became
  // permanent. The fix rewrites last-stop.json with only the unrestored
  // sessions when at least one failed.
  it("preserves last-stop record for sessions that failed to restore (partial failure)", async () => {
    mockReadLastStop.mockResolvedValue({
      stoppedAt: "2026-04-28T10:00:00.000Z",
      projectId: "my-app",
      sessionIds: ["app-1", "app-2"],
    });

    mockConfigRef.current = makeConfig({ "my-app": makeProject() });
    const { findWebDir } = await import("../../src/lib/web-dir.js");
    vi.mocked(findWebDir).mockReturnValue(tmpDir);
    writeFileSync(join(tmpDir, "package.json"), "{}");

    const fakeDashboard = { on: vi.fn(), kill: vi.fn(), emit: vi.fn() };
    mockSpawn.mockReturnValue(fakeDashboard);

    // app-1 restores fine; app-2 fails (transient).
    mockSessionManager.restore.mockImplementation((id: string) => {
      if (id === "app-2") return Promise.reject(new Error("workspace gone"));
      return Promise.resolve(undefined);
    });

    await program.parseAsync(["node", "test", "start", "--no-orchestrator"]);

    expect(mockClearLastStop).not.toHaveBeenCalled();
    expect(mockWriteLastStop).toHaveBeenCalledTimes(1);
    const written = mockWriteLastStop.mock.calls[0][0];
    expect(written.sessionIds).toEqual(["app-2"]);
    expect(written.projectId).toBe("my-app");
    expect(written.stoppedAt).toBe("2026-04-28T10:00:00.000Z");
  });

  it("clears last-stop record when every session restored successfully", async () => {
    mockReadLastStop.mockResolvedValue({
      stoppedAt: "2026-04-28T10:00:00.000Z",
      projectId: "my-app",
      sessionIds: ["app-1"],
    });

    mockConfigRef.current = makeConfig({ "my-app": makeProject() });
    const { findWebDir } = await import("../../src/lib/web-dir.js");
    vi.mocked(findWebDir).mockReturnValue(tmpDir);
    writeFileSync(join(tmpDir, "package.json"), "{}");

    const fakeDashboard = { on: vi.fn(), kill: vi.fn(), emit: vi.fn() };
    mockSpawn.mockReturnValue(fakeDashboard);

    mockSessionManager.restore.mockResolvedValue(undefined);

    await program.parseAsync(["node", "test", "start", "--no-orchestrator"]);

    expect(mockWriteLastStop).not.toHaveBeenCalled();
    expect(mockClearLastStop).toHaveBeenCalled();
  });

  it("opens the bare dashboard URL when --no-orchestrator skips the orchestrator block", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });

    const { findWebDir } = await import("../../src/lib/web-dir.js");
    vi.mocked(findWebDir).mockReturnValue(tmpDir);
    writeFileSync(join(tmpDir, "package.json"), "{}");

    await program.parseAsync(["node", "test", "start", "--no-orchestrator"]);

    // Without an orchestrator id, the auto-open URL falls back to the dashboard
    // root rather than the legacy phantom `/sessions/${prefix}-orchestrator` path.
    expect(mockWaitForPortAndOpen).toHaveBeenCalledTimes(1);
    const args = mockWaitForPortAndOpen.mock.calls[0];
    expect(args[1]).toBe("http://localhost:3000");
    expect(args[1]).not.toContain("/sessions/");
    expect(mockSessionManager.spawnOrchestrator).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ao stop
// ---------------------------------------------------------------------------

describe("stop command", () => {
  /** Helper: mock exec to simulate a dashboard process on a given port. */
  function mockDashboardOnPort(dashboardPort: number, pid = "12345"): void {
    mockExec.mockImplementation(async (cmd: string, args: string[] = []) => {
      if (cmd === "kill") return { stdout: "", stderr: "" };
      if (cmd === "ps") return { stdout: "node /fake/web/dist-server/start-all.js", stderr: "" };
      if (cmd === "lsof") {
        const portArg = args.find((a) => a.startsWith(":"));
        if (portArg === `:${dashboardPort}`) return { stdout: pid, stderr: "" };
      }
      throw new Error("no process");
    });
  }

  it("stops the actual numbered orchestrator session and dashboard", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });
    // Issue #1048: ao stop must look up the real numbered orchestrator id
    // (e.g. app-orchestrator-3) via sm.list — never the phantom `${prefix}-orchestrator`.
    mockSessionManager.list.mockResolvedValue([
      {
        id: "app-orchestrator-3",
        projectId: "my-app",
        status: "working",
        activity: "active",
        metadata: { role: "orchestrator" },
        lastActivityAt: new Date(),
        runtimeHandle: { id: "tmux-3" },
      },
    ]);
    mockSessionManager.kill.mockResolvedValue({ cleaned: true, alreadyTerminated: false });
    mockDashboardOnPort(3000);

    await program.parseAsync(["node", "test", "stop"]);

    expect(mockSessionManager.kill).toHaveBeenCalledWith("app-orchestrator-3", {
      purgeOpenCode: false,
    });
    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("Orchestrator stopped");
    expect(output).toContain("app-orchestrator-3");
  });

  it("kills the most-recently-active orchestrator when multiple exist", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });
    const now = Date.now();
    mockSessionManager.list.mockResolvedValue([
      {
        id: "app-orchestrator",
        projectId: "my-app",
        status: "working",
        activity: "active",
        metadata: { role: "orchestrator" },
        lastActivityAt: new Date(now - 10_000),
        runtimeHandle: { id: "tmux-1" },
      },
      {
        id: "app-orchestrator",
        projectId: "my-app",
        status: "working",
        activity: "active",
        metadata: { role: "orchestrator" },
        lastActivityAt: new Date(now),
        runtimeHandle: { id: "tmux-2" },
      },
    ]);
    mockSessionManager.kill.mockResolvedValue({ cleaned: true, alreadyTerminated: false });

    await program.parseAsync(["node", "test", "stop"]);

    expect(mockSessionManager.kill).toHaveBeenCalledWith("app-orchestrator", {
      purgeOpenCode: false,
    });
  });

  it("handles missing orchestrator session gracefully", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });
    mockSessionManager.list.mockResolvedValue([]);
    mockExec.mockRejectedValue(new Error("no process"));

    await program.parseAsync(["node", "test", "stop"]);

    expect(mockSessionManager.kill).not.toHaveBeenCalled();
    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("No active sessions found");
  });

  it("passes purge flag when stopping orchestrator with --purge-session", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });
    mockSessionManager.list.mockResolvedValue([
      {
        id: "app-orchestrator",
        projectId: "my-app",
        status: "working",
        activity: "active",
        metadata: { role: "orchestrator" },
        lastActivityAt: new Date(),
        runtimeHandle: { id: "tmux-1" },
      },
    ]);
    mockSessionManager.kill.mockResolvedValue({ cleaned: true, alreadyTerminated: false });
    mockDashboardOnPort(3000);

    await program.parseAsync(["node", "test", "stop", "--purge-session"]);

    expect(mockSessionManager.kill).toHaveBeenCalledWith("app-orchestrator", {
      purgeOpenCode: true,
    });
  });

  it("calls killProcessTree with numeric PID when findPidByPort returns a PID", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });
    mockSessionManager.list.mockResolvedValue([]);
    mockFindPidByPort.mockResolvedValue("1234");
    // killDashboardOnPort verifies the PID is an AO dashboard via `ps` on Unix
    // before killing. Stub it to return a matching cmdline so we reach the kill.
    mockExec.mockImplementation(async (cmd: string) => {
      if (cmd === "ps") return { stdout: "node /fake/web/dist-server/start-all.js", stderr: "" };
      throw new Error("no process");
    });

    await program.parseAsync(["node", "test", "stop"]);

    expect(mockFindPidByPort).toHaveBeenCalledWith(3000);
    expect(mockKillProcessTree).toHaveBeenCalledWith(1234);
  });

  it("does not call killProcessTree when findPidByPort returns null", async () => {
    mockConfigRef.current = makeConfig({ "my-app": makeProject() });
    mockSessionManager.list.mockResolvedValue([]);
    mockFindPidByPort.mockResolvedValue(null);

    await program.parseAsync(["node", "test", "stop"]);

    expect(mockFindPidByPort).toHaveBeenCalledWith(3000);
    expect(mockKillProcessTree).not.toHaveBeenCalled();
  });

  // Recovers from issue #645: when the configured port was busy at start, the
  // dashboard auto-reassigned to port+N and `ao stop` couldn't find it. The
  // port-scan fallback in stopDashboard walks port+1..port+MAX_PORT_SCAN.
  // Skip on Windows: killDashboardOnPort skips the `ps` cmdline verification
  // there (uses netstat trust), so the assertions on `ps` output don't apply.
  it.skipIf(process.platform === "win32")(
    "finds orphaned dashboard on a reassigned port via port scan",
    async () => {
      mockConfigRef.current = makeConfig({ "my-app": makeProject() });
      mockSessionManager.list.mockResolvedValue([]);
      // Port 3000 has nothing; port 3001 has the orphaned dashboard
      mockFindPidByPort.mockImplementation(async (port: number) =>
        port === 3001 ? "99999" : null,
      );
      // ps cmdline check inside killDashboardOnPort must pass for the kill to fire
      mockExec.mockImplementation(async (cmd: string) => {
        if (cmd === "ps") return { stdout: "node /fake/web/dist-server/start-all.js", stderr: "" };
        throw new Error("no process");
      });

      await program.parseAsync(["node", "test", "stop"]);

      expect(mockKillProcessTree).toHaveBeenCalledWith(99999);
      const output = vi
        .mocked(console.log)
        .mock.calls.map((c) => c.join(" "))
        .join("\n");
      expect(output).toContain("was on port 3001");
    },
  );

  // Windows parallel: the port-scan fallback must still find the orphaned
  // dashboard, but killDashboardOnPort intentionally skips the `ps` cmdline
  // check (no `ps` on Windows; we trust netstat output via findPidByPort).
  // Ensures a developer who breaks the Windows port-scan path is caught.
  it.runIf(process.platform === "win32")(
    "finds orphaned dashboard on a reassigned port via port scan (Windows)",
    async () => {
      mockConfigRef.current = makeConfig({ "my-app": makeProject() });
      mockSessionManager.list.mockResolvedValue([]);
      mockFindPidByPort.mockImplementation(async (port: number) =>
        port === 3001 ? "99999" : null,
      );

      await program.parseAsync(["node", "test", "stop"]);

      expect(mockKillProcessTree).toHaveBeenCalledWith(99999);
      // `ps` must NOT be invoked on Windows — the cmdline verification is
      // skipped by design in killDashboardOnPort.
      const psCalls = mockExec.mock.calls.filter((c) => c[0] === "ps");
      expect(psCalls).toHaveLength(0);
      const output = vi
        .mocked(console.log)
        .mock.calls.map((c) => c.join(" "))
        .join("\n");
      expect(output).toContain("was on port 3001");
    },
  );
});

// ---------------------------------------------------------------------------
// runtime fallback — platform-aware default (B01/B02/B21)
// ---------------------------------------------------------------------------

describe("start command — platform-aware runtime fallback", () => {
  it("does not call ensureTmux when config has no runtime and platform is win32", async () => {
    // Config with no defaults.runtime — the fallback kicks in.
    const configWithoutRuntime: Record<string, unknown> = {
      configPath: join(tmpDir, "agent-orchestrator.yaml"),
      port: 3000,
      defaults: {
        // runtime intentionally absent
        agent: "claude-code",
        workspace: "worktree",
        notifiers: [],
      },
      projects: { "my-app": makeProject() },
      notifiers: {},
      notificationRouting: {},
      reactions: {},
    };
    mockConfigRef.current = configWithoutRuntime;

    // Simulate Windows — getDefaultRuntime() will return "process".
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    try {
      await program.parseAsync(["node", "test", "start", "--no-dashboard", "--no-orchestrator"]);
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, "platform", originalPlatform);
      }
    }

    // ensureTmux() calls execSilent("tmux", ["-V"]) — it must NOT have been called.
    const tmuxChecks = mockExecSilent.mock.calls.filter(
      (call) =>
        String(call[0]) === "tmux" && Array.isArray(call[1]) && (call[1] as string[])[0] === "-V",
    );
    expect(tmuxChecks).toHaveLength(0);
  });

  it("calls ensureTmux when config has no runtime and platform is linux", async () => {
    // Same config without runtime, but on a non-Windows platform.
    const configWithoutRuntime: Record<string, unknown> = {
      configPath: join(tmpDir, "agent-orchestrator.yaml"),
      port: 3000,
      defaults: {
        agent: "claude-code",
        workspace: "worktree",
        notifiers: [],
      },
      projects: { "my-app": makeProject() },
      notifiers: {},
      notificationRouting: {},
      reactions: {},
    };
    mockConfigRef.current = configWithoutRuntime;

    // Simulate Linux — getDefaultRuntime() returns "tmux", ensureTmux() must fire.
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });

    try {
      await program.parseAsync(["node", "test", "start", "--no-dashboard", "--no-orchestrator"]);
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, "platform", originalPlatform);
      }
    }

    // ensureTmux() must have checked for tmux availability.
    const tmuxChecks = mockExecSilent.mock.calls.filter(
      (call) =>
        String(call[0]) === "tmux" && Array.isArray(call[1]) && (call[1] as string[])[0] === "-V",
    );
    expect(tmuxChecks.length).toBeGreaterThan(0);
  });

  it("targeted stop does NOT kill parent process or dashboard", async () => {
    mockConfigRef.current = makeConfig({
      "project-1": makeProject({ name: "Project 1", sessionPrefix: "p1" }),
      "project-2": makeProject({ name: "Project 2", sessionPrefix: "p2" }),
    });
    mockGetRunning.mockResolvedValue({
      pid: 99999,
      configPath: "/fake/config.yaml",
      port: 3000,
      startedAt: new Date().toISOString(),
      projects: ["project-1", "project-2"],
    });
    mockSessionManager.list.mockResolvedValue([
      {
        id: "p2-1",
        projectId: "project-2",
        status: "working",
        activity: "active",
        metadata: {},
        lastActivityAt: new Date(),
        runtimeHandle: { id: "tmux-5" },
      },
    ]);
    mockSessionManager.kill.mockResolvedValue({ cleaned: true, alreadyTerminated: false });
    mockExec.mockRejectedValue(new Error("no process"));

    await program.parseAsync(["node", "test", "stop", "project-2"]);

    expect(mockSessionManager.kill).toHaveBeenCalledWith("p2-1", { purgeOpenCode: false });

    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("Stopped sessions for");
    expect(output).not.toContain("Dashboard stopped");
    expect(mockSweepDaemonChildren).not.toHaveBeenCalled();
  });

  it("targeted stop does NOT unregister running.json", async () => {
    mockConfigRef.current = makeConfig({
      "project-1": makeProject({ name: "Project 1", sessionPrefix: "p1" }),
      "project-2": makeProject({ name: "Project 2", sessionPrefix: "p2" }),
    });
    mockGetRunning.mockResolvedValue({
      pid: 99999,
      configPath: "/fake/config.yaml",
      port: 3000,
      startedAt: new Date().toISOString(),
      projects: ["project-1", "project-2"],
    });
    mockSessionManager.list.mockResolvedValue([
      {
        id: "p2-1",
        projectId: "project-2",
        status: "working",
        activity: "active",
        metadata: {},
        lastActivityAt: new Date(),
        runtimeHandle: { id: "tmux-5" },
      },
    ]);
    mockSessionManager.kill.mockResolvedValue({ cleaned: true, alreadyTerminated: false });
    mockExec.mockRejectedValue(new Error("no process"));

    await program.parseAsync(["node", "test", "stop", "project-2"]);

    expect(mockUnregister).not.toHaveBeenCalled();
  });

  // Regression for boundary-bug-hunter Phase 3 finding 2: targeted stop
  // used to call `removeProjectFromRunning` from a child CLI process, but
  // the parent ao-start process's in-memory lifecycle worker for that
  // project keeps polling. The state file then claimed "not polling"
  // while the live parent was still polling. Targeted stop must leave
  // `running.projects` intact so it remains a truthful signal.
  it("targeted stop leaves the project in running.json (parent is still polling)", async () => {
    mockConfigRef.current = makeConfig({
      "project-1": makeProject({ name: "Project 1", sessionPrefix: "p1" }),
      "project-2": makeProject({ name: "Project 2", sessionPrefix: "p2" }),
    });
    mockGetRunning.mockResolvedValue({
      pid: 99999,
      configPath: "/fake/config.yaml",
      port: 3000,
      startedAt: new Date().toISOString(),
      projects: ["project-1", "project-2"],
    });
    mockSessionManager.list.mockResolvedValue([]);
    mockSessionManager.kill.mockResolvedValue({ cleaned: true, alreadyTerminated: false });
    mockExec.mockRejectedValue(new Error("no process"));

    await program.parseAsync(["node", "test", "stop", "project-2"]);

    expect(mockRemoveProjectFromRunning).not.toHaveBeenCalled();
  });

  it("targeted stop only kills sessions for the named project", async () => {
    mockConfigRef.current = makeConfig({
      "project-1": makeProject({ name: "Project 1", sessionPrefix: "p1" }),
      "project-2": makeProject({ name: "Project 2", sessionPrefix: "p2" }),
    });
    mockGetRunning.mockResolvedValue({
      pid: 99999,
      configPath: "/fake/config.yaml",
      port: 3000,
      startedAt: new Date().toISOString(),
      projects: ["project-1", "project-2"],
    });
    mockSessionManager.list.mockResolvedValue([
      {
        id: "p1-1",
        projectId: "project-1",
        status: "working",
        activity: "active",
        metadata: {},
        lastActivityAt: new Date(),
        runtimeHandle: { id: "tmux-1" },
      },
      {
        id: "p2-1",
        projectId: "project-2",
        status: "working",
        activity: "active",
        metadata: {},
        lastActivityAt: new Date(),
        runtimeHandle: { id: "tmux-2" },
      },
    ]);
    mockSessionManager.kill.mockResolvedValue({ cleaned: true, alreadyTerminated: false });
    mockExec.mockRejectedValue(new Error("no process"));

    await program.parseAsync(["node", "test", "stop", "project-2"]);

    // Even if `sm.list` returns mixed projects (regression at producer), the
    // CLI must defensively drop foreign sessions before the kill loop.
    const killCalls = mockSessionManager.kill.mock.calls.map((c: unknown[]) => c[0]);
    expect(killCalls).toContain("p2-1");
    expect(killCalls).not.toContain("p1-1");
  });

  it("full stop (no arg) still kills parent and dashboard", async () => {
    mockConfigRef.current = makeConfig({
      "project-1": makeProject({ name: "Project 1", sessionPrefix: "p1" }),
    });
    mockGetRunning.mockResolvedValue({
      pid: 99999,
      configPath: "/fake/config.yaml",
      port: 3000,
      startedAt: new Date().toISOString(),
      projects: ["project-1"],
    });
    mockSessionManager.list.mockResolvedValue([]);
    mockExec.mockRejectedValue(new Error("no process"));

    await program.parseAsync(["node", "test", "stop"]);

    // Stop now goes through killProcessTree (which is module-mocked above),
    // not a direct process.kill — that's how it gets `taskkill /T /F` on
    // Windows and process-group kill on Unix. Assert on the mock.
    expect(mockKillProcessTree).toHaveBeenCalledWith(99999, "SIGTERM");
    expect(mockSweepDaemonChildren).toHaveBeenCalledWith({ ownerPid: 99999 });
    expect(mockUnregister).toHaveBeenCalled();
    expect(mockRemoveProjectFromRunning).not.toHaveBeenCalled();
  });

  it("targeted stop records last-stop with correct project scope", async () => {
    const mockWriteLastStop = vi.fn().mockResolvedValue(undefined);
    const runningStateMod = await import("../../src/lib/running-state.js");
    vi.spyOn(runningStateMod, "writeLastStop").mockImplementation(mockWriteLastStop);

    mockConfigRef.current = makeConfig({
      "project-1": makeProject({ name: "Project 1", sessionPrefix: "p1" }),
      "project-2": makeProject({ name: "Project 2", sessionPrefix: "p2" }),
    });
    mockGetRunning.mockResolvedValue({
      pid: 99999,
      configPath: "/fake/config.yaml",
      port: 3000,
      startedAt: new Date().toISOString(),
      projects: ["project-1", "project-2"],
    });
    mockSessionManager.list.mockResolvedValue([
      {
        id: "p2-1",
        projectId: "project-2",
        status: "working",
        activity: "active",
        metadata: {},
        lastActivityAt: new Date(),
        runtimeHandle: { id: "tmux-1" },
      },
    ]);
    mockSessionManager.kill.mockResolvedValue({ cleaned: true, alreadyTerminated: false });
    mockExec.mockRejectedValue(new Error("no process"));

    await program.parseAsync(["node", "test", "stop", "project-2"]);

    expect(mockWriteLastStop).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-2",
        sessionIds: expect.arrayContaining(["p2-1"]),
      }),
    );
  });

  // Regression: `ao stop <project>` then `ao start <project>` used to fall
  // through the projectNeedsRestart path into runStartup(), which spawned a
  // SECOND dashboard on a new port and clobbered running.json — leaving the
  // original parent process orphaned. Now it must attach to the running
  // daemon: ensureOrchestrator runs against the existing session manager,
  // running.json gets the project re-added, and runStartup is never called.
  it("ao start <project> while daemon alive but project removed: attaches to existing daemon (no second dashboard)", async () => {
    // Force the global-config fallback to use mockConfigRef.current rather
    // than reading the test machine's real ~/.agent-orchestrator/config.yaml.
    const origGlobalEnv = process.env["AO_GLOBAL_CONFIG"];
    process.env["AO_GLOBAL_CONFIG"] = join(tmpDir, "no-such-global.yaml");

    try {
      mockConfigRef.current = makeConfig({
        "project-1": makeProject({ name: "Project 1", sessionPrefix: "p1" }),
        "project-2": makeProject({ name: "Project 2", sessionPrefix: "p2" }),
      });

      // Daemon alive; project-2 was just removed by `ao stop project-2`.
      mockIsAlreadyRunning.mockResolvedValue({
        pid: 99999,
        configPath: "/fake/config.yaml",
        port: 3000,
        startedAt: new Date().toISOString(),
        projects: ["project-1"],
      });

      await expect(
        program.parseAsync([
          "node",
          "test",
          "start",
          "project-2",
          "--no-dashboard",
          "--no-orchestrator",
        ]),
      ).rejects.toThrow("process.exit(1)");

      // Attached to existing daemon, did not register a new one.
      expect(mockRegister).not.toHaveBeenCalled();
      // ensureOrchestrator was invoked for the requested project.
      expect(mockSessionManager.ensureOrchestrator).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: "project-2" }),
      );
      // The one-shot attach path does not mutate running.json directly;
      // the long-lived supervisor reconciles it after attaching polling.
      expect(mockAddProjectToRunning).not.toHaveBeenCalled();
      // No menu — this is a deterministic attach, not an interactive choice.
      expect(mockPromptSelect).not.toHaveBeenCalled();

      const output = vi
        .mocked(console.log)
        .mock.calls.map((c) => c.join(" "))
        .join("\n");
      expect(output).toContain("Attaching to running AO instance");
      expect(output).toContain("reattached to running daemon");
    } finally {
      if (origGlobalEnv === undefined) delete process.env["AO_GLOBAL_CONFIG"];
      else process.env["AO_GLOBAL_CONFIG"] = origGlobalEnv;
    }
  });
});

// ---------------------------------------------------------------------------
// autoCreateConfig — config generation defaults
// ---------------------------------------------------------------------------

describe("start command — autoCreateConfig", () => {
  it("generates config with empty notifiers array (no desktop notifier added by default)", async () => {
    const { detectEnvironment } = await import("../../src/lib/detect-env.js");
    vi.mocked(detectEnvironment).mockResolvedValue({
      isGitRepo: true,
      gitRemote: null,
      ownerRepo: null,
      currentBranch: "main",
      defaultBranch: "main",
      hasTmux: true,
      hasGh: false,
      ghAuthed: false,
      hasLinearKey: false,
      hasSlackWebhook: false,
    });

    const { detectProjectType } = await import("../../src/lib/project-detection.js");
    vi.mocked(detectProjectType).mockReturnValue({ languages: [], frameworks: [], tools: [] });

    const { detectAvailableAgents, detectAgentRuntime } =
      await import("../../src/lib/detect-agent.js");
    vi.mocked(detectAvailableAgents).mockResolvedValue([]);
    vi.mocked(detectAgentRuntime).mockResolvedValue("claude-code");

    const { findFreePort } = await import("../../src/lib/web-dir.js");
    vi.mocked(findFreePort).mockResolvedValue(3000);

    // start.ts uses `import { cwd } from "node:process"` which is intercepted
    // by the node:process mock defined at the top of this file.
    mockProcessCwd.mockReturnValue(tmpDir);

    // Non-interactive — skip the repo prompt (no ownerRepo detected)
    const callerContext = await import("../../src/lib/caller-context.js");
    vi.spyOn(callerContext, "isHumanCaller").mockReturnValue(false);

    await autoCreateConfig(tmpDir);

    const configPath = join(tmpDir, "agent-orchestrator.yaml");
    expect(existsSync(configPath)).toBe(true);

    const content = readFileSync(configPath, "utf-8");
    const parsed = parseYaml(content) as {
      $schema?: string;
      defaults?: { notifiers?: unknown[] };
    };
    expect(parsed["$schema"]).toBe(
      "https://raw.githubusercontent.com/ComposioHQ/agent-orchestrator/main/schema/config.schema.json",
    );
    expect(parsed.defaults?.notifiers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Already-running detection (moved before config mutation)
// ---------------------------------------------------------------------------

describe("start command — already-running detection", () => {
  it("exits immediately for non-TTY caller when AO is already running", async () => {
    mockIsAlreadyRunning.mockResolvedValue({
      pid: 9999,
      configPath: "/fake/config.yaml",
      port: 3000,
      startedAt: "2026-01-01T00:00:00Z",
      projects: ["my-app"],
    });

    mockIsHumanCaller.mockReturnValue(false);

    mockConfigRef.current = makeConfig({ "my-app": makeProject() });

    // process.exit(0) throws in tests, caught by the action's catch block which calls exit(1)
    await expect(
      program.parseAsync(["node", "test", "start", "--no-dashboard", "--no-orchestrator"]),
    ).rejects.toThrow("process.exit(1)");

    // Verify the already-running message was printed (not a config error)
    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("AO is already running");
    expect(output).toContain("PID: 9999");
  });

  it("exits when human caller selects 'quit'", async () => {
    mockIsAlreadyRunning.mockResolvedValue({
      pid: 9999,
      configPath: "/fake/config.yaml",
      port: 3000,
      startedAt: "2026-01-01T00:00:00Z",
      projects: ["my-app"],
    });

    mockPromptSelect.mockResolvedValue("quit");

    mockConfigRef.current = makeConfig({ "my-app": makeProject() });

    await expect(
      program.parseAsync(["node", "test", "start", "--no-dashboard", "--no-orchestrator"]),
    ).rejects.toThrow("process.exit(1)");

    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("AO is already running");
  });

  it("path arg already registered + running: opens dashboard without prompting and does not mutate YAML", async () => {
    const repoDir = join(tmpDir, "registered-repo");
    createFakeRepo(repoDir, "https://github.com/org/registered-repo.git");

    // Point AO_GLOBAL_CONFIG at a non-existent file so the global lookup
    // falls back to mockConfigRef.current.
    const origGlobalEnv = process.env["AO_GLOBAL_CONFIG"];
    process.env["AO_GLOBAL_CONFIG"] = join(tmpDir, "no-such-global.yaml");

    try {
      mockIsAlreadyRunning.mockResolvedValue({
        pid: 9999,
        configPath: "/fake/config.yaml",
        port: 3000,
        startedAt: "2026-01-01T00:00:00Z",
        projects: ["my-app"],
      });

      mockConfigRef.current = makeConfig({
        "my-app": makeProject({ path: repoDir }),
      });

      await expect(
        program.parseAsync([
          "node",
          "test",
          "start",
          repoDir,
          "--no-dashboard",
          "--no-orchestrator",
        ]),
      ).rejects.toThrow("process.exit(1)");

      // No menu shown
      expect(mockPromptSelect).not.toHaveBeenCalled();

      const output = vi
        .mocked(console.log)
        .mock.calls.map((c) => c.join(" "))
        .join("\n");
      expect(output).toContain("AO is already running");
      expect(output).toContain("my-app");
      expect(output).toContain("already registered and running");
    } finally {
      if (origGlobalEnv === undefined) delete process.env["AO_GLOBAL_CONFIG"];
      else process.env["AO_GLOBAL_CONFIG"] = origGlobalEnv;
    }
  });

  it("path arg unregistered + AO running: registers in global config and spawns orchestrator without showing the menu", async () => {
    const repoDir = join(tmpDir, "new-repo");
    createFakeRepo(repoDir, "https://github.com/org/new-repo.git");

    // Point AO_GLOBAL_CONFIG at a real file in tmpDir so addProjectToConfig
    // routes through registerProjectInGlobalConfig.
    const globalConfigPath = join(tmpDir, "global-config.yaml");
    const { stringify: yamlStringify } = await import("yaml");
    writeFileSync(
      globalConfigPath,
      yamlStringify(
        {
          defaults: {
            runtime: "process",
            agent: "claude-code",
            workspace: "worktree",
            notifiers: [],
          },
          projects: {
            "my-app": {
              name: "My App",
              repo: "org/my-app",
              path: join(tmpDir, "main-repo"),
              defaultBranch: "main",
              sessionPrefix: "app",
            },
          },
        },
        { indent: 2 },
      ),
    );

    const origGlobalEnv = process.env["AO_GLOBAL_CONFIG"];
    const origConfigEnv = process.env["AO_CONFIG_PATH"];
    process.env["AO_GLOBAL_CONFIG"] = globalConfigPath;
    process.env["AO_CONFIG_PATH"] = globalConfigPath;

    try {
      mockConfigRef.current = makeConfig({
        "my-app": makeProject({ path: join(tmpDir, "main-repo") }),
      });

      mockIsAlreadyRunning.mockResolvedValue({
        pid: 9999,
        configPath: globalConfigPath,
        port: 3000,
        startedAt: "2026-01-01T00:00:00Z",
        projects: ["my-app"],
      });

      const shell = await import("../../src/lib/shell.js");
      vi.mocked(shell.git).mockImplementation(async (args: string[], workingDir?: string) => {
        if (args[0] === "rev-parse" && args[1] === "--git-dir" && workingDir === repoDir)
          return ".git";
        if (
          args[0] === "remote" &&
          args[1] === "get-url" &&
          args[2] === "origin" &&
          workingDir === repoDir
        ) {
          return "https://github.com/org/new-repo.git";
        }
        if (args[0] === "symbolic-ref" && workingDir === repoDir) return "refs/remotes/origin/main";
        if (args[0] === "rev-parse" && args[1] === "--verify" && workingDir === repoDir)
          return "abc";
        return null;
      });

      await expect(
        program.parseAsync([
          "node",
          "test",
          "start",
          repoDir,
          "--no-dashboard",
          "--no-orchestrator",
        ]),
      ).rejects.toThrow("process.exit(1)");

      // No menu shown — went straight to register + spawn
      expect(mockPromptSelect).not.toHaveBeenCalled();

      // ensureOrchestrator was called for the newly-registered project
      expect(mockSessionManager.ensureOrchestrator).toHaveBeenCalled();
      const callArgs = mockSessionManager.ensureOrchestrator.mock.calls[0]?.[0];
      expect(callArgs?.projectId).toBeDefined();
      expect(callArgs?.projectId).not.toBe("my-app");

      const output = vi
        .mocked(console.log)
        .mock.calls.map((c) => c.join(" "))
        .join("\n");
      expect(output).toContain("registered in the global config");
      expect(output).toContain("Orchestrator session ready");
      expect(output).toContain("Opening dashboard");
    } finally {
      if (origGlobalEnv === undefined) delete process.env["AO_GLOBAL_CONFIG"];
      else process.env["AO_GLOBAL_CONFIG"] = origGlobalEnv;
      if (origConfigEnv === undefined) delete process.env["AO_CONFIG_PATH"];
      else process.env["AO_CONFIG_PATH"] = origConfigEnv;
    }
  });

  it("offers to add cwd when AO is running and cwd is an unregistered git repo", async () => {
    mockIsAlreadyRunning.mockResolvedValue({
      pid: 9999,
      configPath: "/fake/config.yaml",
      port: 3000,
      startedAt: "2026-01-01T00:00:00Z",
      projects: ["my-app"],
    });

    createFakeRepo(tmpDir, "https://github.com/org/unregistered.git");
    mockProcessCwd.mockReturnValue(tmpDir);
    mockPromptSelect.mockResolvedValue("quit");
    mockConfigRef.current = makeConfig({
      "my-app": makeProject({ path: join(tmpDir, "main-repo") }),
    });

    await expect(
      program.parseAsync(["node", "test", "start", "--no-dashboard", "--no-orchestrator"]),
    ).rejects.toThrow("process.exit(1)");

    const options = mockPromptSelect.mock.calls[0]?.[1] as
      | Array<{ value: string; label: string }>
      | undefined;
    expect(options?.some((option) => option.value === "add" && option.label.includes("Add"))).toBe(
      true,
    );
  });

  it("exits when human caller selects 'open'", async () => {
    mockIsAlreadyRunning.mockResolvedValue({
      pid: 9999,
      configPath: "/fake/config.yaml",
      port: 3000,
      startedAt: "2026-01-01T00:00:00Z",
      projects: ["my-app"],
    });

    mockPromptSelect.mockResolvedValue("open");

    mockConfigRef.current = makeConfig({ "my-app": makeProject() });

    await expect(
      program.parseAsync(["node", "test", "start", "--no-dashboard", "--no-orchestrator"]),
    ).rejects.toThrow("process.exit(1)");

    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("AO is already running");
  });

  it("kills existing process and continues when human caller selects 'restart'", async () => {
    mockIsAlreadyRunning.mockResolvedValue({
      pid: 9999,
      configPath: "/fake/config.yaml",
      port: 3000,
      startedAt: "2026-01-01T00:00:00Z",
      projects: ["my-app"],
    });

    mockWaitForExit.mockResolvedValue(true);
    mockKillProcessTree.mockResolvedValue(undefined);

    mockPromptSelect.mockResolvedValue("restart");

    mockConfigRef.current = makeConfig({ "my-app": makeProject() });

    // After restart the startup flow continues — it may succeed or fail
    // depending on infrastructure mocks, so we just verify the restart actions
    try {
      await program.parseAsync(["node", "test", "start", "--no-dashboard", "--no-orchestrator"]);
    } catch {
      // Startup after restart may throw — that's OK for this test
    }

    // killExistingDaemon delegates to killProcessTree (taskkill /T /F on Windows,
    // process group signalling on Unix) instead of raw process.kill, so dead
    // grandchildren of the daemon don't leak.
    expect(mockKillProcessTree).toHaveBeenCalledWith(9999, "SIGTERM");
    expect(mockUnregister).toHaveBeenCalled();

    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("Stopped existing instance");
  });

  it("creates new orchestrator entry when human caller selects 'new'", async () => {
    mockIsAlreadyRunning.mockResolvedValue({
      pid: 9999,
      configPath: "/fake/config.yaml",
      port: 3000,
      startedAt: "2026-01-01T00:00:00Z",
      projects: ["my-app"],
    });

    mockPromptSelect.mockResolvedValue("new");

    const configPath = join(tmpDir, "agent-orchestrator.yaml");
    const { stringify: yamlStringify } = await import("yaml");
    writeFileSync(
      configPath,
      yamlStringify(
        {
          defaults: {
            runtime: "process",
            agent: "claude-code",
            workspace: "worktree",
            notifiers: [],
          },
          projects: {
            "my-app": {
              name: "My App",
              repo: "org/my-app",
              path: join(tmpDir, "main-repo"),
              defaultBranch: "main",
              sessionPrefix: "app",
            },
          },
        },
        { indent: 2 },
      ),
    );

    mockConfigRef.current = makeConfig({ "my-app": makeProject() });
    (mockConfigRef.current as Record<string, unknown>).configPath = configPath;

    // After "new" the startup flow continues — it may fail on infrastructure
    try {
      await program.parseAsync(["node", "test", "start", "--no-dashboard", "--no-orchestrator"]);
    } catch {
      // Startup may throw — that's OK for this test
    }

    // Verify a new orchestrator entry was added to the YAML
    const updatedContent = readFileSync(configPath, "utf-8");
    const updatedConfig = parseYaml(updatedContent) as { projects: Record<string, unknown> };
    const projectKeys = Object.keys(updatedConfig.projects);
    expect(projectKeys.length).toBe(2);
    expect(projectKeys).toContain("my-app");
    // The new entry should have a suffix like "my-app-xxxx"
    const newKey = projectKeys.find((k) => k !== "my-app");
    expect(newKey).toMatch(/^my-app-/);
  });

  it("does not mutate YAML when non-TTY caller detects already running (path arg)", async () => {
    mockIsAlreadyRunning.mockResolvedValue({
      pid: 9999,
      configPath: "/fake/config.yaml",
      port: 3000,
      startedAt: "2026-01-01T00:00:00Z",
      projects: ["my-app"],
    });

    mockIsHumanCaller.mockReturnValue(false);

    const repoDir = join(tmpDir, "some-project");
    createFakeRepo(repoDir, "https://github.com/org/some-project.git");

    const configPath = join(tmpDir, "agent-orchestrator.yaml");
    const { stringify: yamlStringify } = await import("yaml");
    const originalYaml = yamlStringify(
      {
        defaults: {
          runtime: "process",
          agent: "claude-code",
          workspace: "worktree",
          notifiers: [],
        },
        projects: {
          "my-app": {
            name: "My App",
            repo: "org/my-app",
            path: join(tmpDir, "main-repo"),
            defaultBranch: "main",
            sessionPrefix: "app",
          },
        },
      },
      { indent: 2 },
    );
    writeFileSync(configPath, originalYaml);

    mockConfigRef.current = makeConfig({ "my-app": makeProject() });
    mockCwd(tmpDir);

    // process.exit(0) throws, caught by catch block which calls exit(1)
    await expect(
      program.parseAsync(["node", "test", "start", repoDir, "--no-dashboard", "--no-orchestrator"]),
    ).rejects.toThrow("process.exit(1)");

    // Verify the already-running message was printed
    const output = vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
    expect(output).toContain("AO is already running");

    // YAML should be unchanged — no duplicate entry added
    const afterYaml = readFileSync(configPath, "utf-8");
    expect(afterYaml).toBe(originalYaml);
  });
});

// ---------------------------------------------------------------------------
// addProjectToConfig — path-based deduplication
// ---------------------------------------------------------------------------

describe("start command — path-based deduplication in addProjectToConfig", () => {
  it("skips addProjectToConfig when path arg matches an existing project", async () => {
    // Pass a local path that's already registered in config.
    // The path-argument branch should find the existing entry and skip addProjectToConfig.
    const repoDir = join(tmpDir, "my-app");
    createFakeRepo(repoDir, "https://github.com/org/my-app.git");

    const configPath = join(tmpDir, "agent-orchestrator.yaml");
    const { stringify: yamlStringify } = await import("yaml");
    writeFileSync(
      configPath,
      yamlStringify(
        {
          defaults: {
            runtime: "process",
            agent: "claude-code",
            workspace: "worktree",
            notifiers: [],
          },
          projects: {
            "my-app": {
              name: "My App",
              repo: "org/my-app",
              path: repoDir,
              defaultBranch: "main",
              sessionPrefix: "app",
            },
          },
        },
        { indent: 2 },
      ),
    );

    // Set AO_CONFIG_PATH so findConfigFile() finds our config in the path-arg branch
    const origEnv = process.env["AO_CONFIG_PATH"];
    process.env["AO_CONFIG_PATH"] = configPath;

    try {
      // Pass repoDir as a local path arg — enters the path-argument branch
      await program.parseAsync([
        "node",
        "test",
        "start",
        repoDir,
        "--no-dashboard",
        "--no-orchestrator",
      ]);

      // Verify no duplicate entry was created in the YAML
      const content = readFileSync(configPath, "utf-8");
      const parsed = parseYaml(content) as { projects: Record<string, unknown> };
      expect(Object.keys(parsed.projects)).toEqual(["my-app"]);
    } finally {
      if (origEnv === undefined) delete process.env["AO_CONFIG_PATH"];
      else process.env["AO_CONFIG_PATH"] = origEnv;
    }
  });

  it("deduplicates via addProjectToConfig when path exists under a different name", async () => {
    // Register a project under name "old-name" pointing to repoDir.
    // Then pass repoDir as a path arg with a config that doesn't match by name.
    // addProjectToConfig's path dedup should return "old-name" without creating a duplicate.
    const repoDir = join(tmpDir, "new-project");
    createFakeRepo(repoDir, "https://github.com/org/new-project.git");

    const configPath = join(tmpDir, "agent-orchestrator.yaml");
    const { stringify: yamlStringify } = await import("yaml");
    writeFileSync(
      configPath,
      yamlStringify(
        {
          defaults: {
            runtime: "process",
            agent: "claude-code",
            workspace: "worktree",
            notifiers: [],
          },
          projects: {
            "old-name": {
              name: "Old Name",
              repo: "org/new-project",
              path: repoDir,
              defaultBranch: "main",
              sessionPrefix: "old",
            },
          },
        },
        { indent: 2 },
      ),
    );

    // Set AO_CONFIG_PATH so findConfigFile() finds our config
    const origEnv = process.env["AO_CONFIG_PATH"];
    process.env["AO_CONFIG_PATH"] = configPath;

    try {
      // Pass repoDir as path arg. The path-argument branch's path-match check
      // at lines 1304-1311 finds "old-name" by path and skips addProjectToConfig.
      // If that outer check were removed, addProjectToConfig's own dedup (lines 656-665)
      // would catch it. Either way, no duplicate entry should be created.
      await program.parseAsync([
        "node",
        "test",
        "start",
        repoDir,
        "--no-dashboard",
        "--no-orchestrator",
      ]);

      const content = readFileSync(configPath, "utf-8");
      const parsed = parseYaml(content) as { projects: Record<string, unknown> };
      expect(Object.keys(parsed.projects)).toEqual(["old-name"]);
    } finally {
      if (origEnv === undefined) delete process.env["AO_CONFIG_PATH"];
      else process.env["AO_CONFIG_PATH"] = origEnv;
    }
  });
});

describe("start command — global registry mutations", () => {
  it("adds a project to the global registry and writes behavior to the repo-local config", async () => {
    const currentRepoDir = join(tmpDir, "current");
    const addedRepoDir = join(tmpDir, "added");
    createFakeRepo(currentRepoDir, "https://github.com/org/current.git");
    createFakeRepo(addedRepoDir, "https://github.com/org/added.git");
    writeFileSync(join(addedRepoDir, ".git", "refs", "remotes", "origin", "master"), "abc\n");

    const localCurrentConfigPath = join(currentRepoDir, "agent-orchestrator.yaml");
    writeFileSync(localCurrentConfigPath, "agent: claude-code\n");

    const globalConfigPath = join(tmpDir, "config.yaml");
    const { stringify: yamlStringify } = await import("yaml");
    writeFileSync(
      globalConfigPath,
      yamlStringify(
        {
          defaults: {
            runtime: "process",
            agent: "claude-code",
            workspace: "worktree",
            notifiers: [],
          },
          projects: {
            current: {
              projectId: "current",
              path: currentRepoDir,
              storageKey: "current-storage",
              defaultBranch: "main",
              displayName: "Current",
              sessionPrefix: "current",
            },
          },
        },
        { indent: 2 },
      ),
    );
    mockConfigRef.current = makeConfig({
      current: makeProject({ name: "Current", path: currentRepoDir, sessionPrefix: "current" }),
    });
    (mockConfigRef.current as Record<string, unknown>).configPath = globalConfigPath;

    const origEnv = process.env["AO_CONFIG_PATH"];
    const origGlobalEnv = process.env["AO_GLOBAL_CONFIG"];
    process.env["AO_CONFIG_PATH"] = globalConfigPath;
    process.env["AO_GLOBAL_CONFIG"] = globalConfigPath;

    const shell = await import("../../src/lib/shell.js");
    vi.mocked(shell.git).mockImplementation(async (args: string[], workingDir?: string) => {
      if (args[0] === "rev-parse" && args[1] === "--git-dir" && workingDir === addedRepoDir)
        return ".git";
      if (
        args[0] === "remote" &&
        args[1] === "get-url" &&
        args[2] === "origin" &&
        workingDir === addedRepoDir
      ) {
        return "https://github.com/org/added.git";
      }
      if (args[0] === "symbolic-ref" && workingDir === addedRepoDir)
        return "refs/remotes/origin/master";
      if (args[0] === "rev-parse" && args[1] === "--verify" && workingDir === addedRepoDir)
        return "abc";
      return null;
    });

    try {
      try {
        await program.parseAsync([
          "node",
          "test",
          "start",
          addedRepoDir,
          "--no-dashboard",
          "--no-orchestrator",
        ]);
      } catch (error) {
        const loggedErrors = vi
          .mocked(console.error)
          .mock.calls.map((call) => call.join(" "))
          .join("\n");
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n${loggedErrors}`,
          { cause: error },
        );
      }

      const globalConfig = parseYaml(readFileSync(globalConfigPath, "utf-8")) as {
        projects: Record<string, Record<string, unknown>>;
      };
      const addedEntry = Object.values(globalConfig.projects).find(
        (entry) => entry.path === realpathSync(addedRepoDir),
      );
      expect(addedEntry).toMatchObject({
        path: realpathSync(addedRepoDir),
        defaultBranch: "master",
        sessionPrefix: "add",
      });
      expect(addedEntry).not.toHaveProperty("agentRules");

      const localAddedConfig = readFileSync(join(addedRepoDir, "agent-orchestrator.yaml"), "utf-8");
      expect(localAddedConfig).not.toContain("projects:");
    } finally {
      if (origEnv === undefined) delete process.env["AO_CONFIG_PATH"];
      else process.env["AO_CONFIG_PATH"] = origEnv;
      if (origGlobalEnv === undefined) delete process.env["AO_GLOBAL_CONFIG"];
      else process.env["AO_GLOBAL_CONFIG"] = origGlobalEnv;
    }
  });

  it("writes interactive agent overrides to the repo-local config when using the global registry", async () => {
    const repoDir = join(tmpDir, "current");
    createFakeRepo(repoDir, "https://github.com/org/current.git");

    const localConfigPath = join(repoDir, "agent-orchestrator.yaml");
    writeFileSync(localConfigPath, "agent: claude-code\n");

    const globalConfigPath = join(tmpDir, "config.yaml");
    const { stringify: yamlStringify } = await import("yaml");
    writeFileSync(
      globalConfigPath,
      yamlStringify(
        {
          defaults: {
            runtime: "process",
            agent: "claude-code",
            workspace: "worktree",
            notifiers: [],
          },
          projects: {
            current: {
              projectId: "current",
              path: repoDir,
              storageKey: "current-storage",
              defaultBranch: "main",
              displayName: "Current",
              sessionPrefix: "current",
            },
          },
        },
        { indent: 2 },
      ),
    );
    mockConfigRef.current = makeConfig({
      current: makeProject({ name: "Current", path: repoDir, sessionPrefix: "current" }),
    });
    (mockConfigRef.current as Record<string, unknown>).configPath = globalConfigPath;

    const origEnv = process.env["AO_CONFIG_PATH"];
    const origGlobalEnv = process.env["AO_GLOBAL_CONFIG"];
    process.env["AO_CONFIG_PATH"] = globalConfigPath;
    process.env["AO_GLOBAL_CONFIG"] = globalConfigPath;

    const detectAgent = await import("../../src/lib/detect-agent.js");
    vi.mocked(detectAgent.detectAvailableAgents).mockResolvedValue([
      { name: "codex", displayName: "Codex" },
      { name: "opencode", displayName: "OpenCode" },
    ]);
    mockPromptSelect.mockResolvedValueOnce("codex").mockResolvedValueOnce("opencode");
    const originalStdinTty = process.stdin.isTTY;
    const originalStdoutTty = process.stdout.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

    try {
      await program.parseAsync([
        "node",
        "test",
        "start",
        "--interactive",
        "--no-dashboard",
        "--no-orchestrator",
      ]);

      const localConfig = readFileSync(localConfigPath, "utf-8");
      expect(localConfig).toContain("orchestrator:");
      expect(localConfig).toContain("agent: codex");
      expect(localConfig).toContain("worker:");
      expect(localConfig).toContain("agent: opencode");

      const globalConfig = readFileSync(globalConfigPath, "utf-8");
      expect(globalConfig).not.toContain("orchestrator:");
      expect(globalConfig).not.toContain("worker:");
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: originalStdinTty,
        configurable: true,
      });
      Object.defineProperty(process.stdout, "isTTY", {
        value: originalStdoutTty,
        configurable: true,
      });
      if (origEnv === undefined) delete process.env["AO_CONFIG_PATH"];
      else process.env["AO_CONFIG_PATH"] = origEnv;
      if (origGlobalEnv === undefined) delete process.env["AO_GLOBAL_CONFIG"];
      else process.env["AO_GLOBAL_CONFIG"] = origGlobalEnv;
    }
  });
});
