import { readFileSync } from "node:fs";
import type * as NodeFs from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- mocks -----------------------------------------------------------------

const mockLoadConfig = vi.fn();
const mockGetGlobalConfigPath = vi.fn(() => "/tmp/global.yaml");
const mockGenerateOrchestratorPrompt = vi.fn(() => "SYSTEM PROMPT");
const mockRecordActivityEvent = vi.fn();
const mockScanAoOrphans = vi.fn(async () => []);
const mockReapAoOrphans = vi.fn(async () => ({ attempted: 0 }));

const mockExistsSync = vi.fn(() => true);

const mockGetSessionManager = vi.fn();
const mockStartProjectSupervisor = vi.fn(async () => ({ stop: vi.fn(), reconcileNow: vi.fn() }));
const mockListLifecycleWorkers = vi.fn<() => string[]>(() => []);
const mockRuntimePreflight = vi.fn(async () => {});
const mockInstallShutdownHandlers = vi.fn();
const mockAcquireStartupLock = vi.fn(async () => () => {});
const mockIsAlreadyRunning = vi.fn(async () => null as unknown);
const mockRegister = vi.fn(async () => {});
const mockStartBunTmpJanitor = vi.fn();

// Keep the real `node:fs` (the manifest-decoupling test reads package.json)
// but stub `existsSync` so loadAllProjectsConfig takes the global-config path.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return { ...actual, existsSync: (...args: unknown[]) => mockExistsSync(...(args as [string])) };
});

// Spinner: no-op chainable stub so the headless path doesn't touch the TTY.
vi.mock("ora", () => ({
  default: () => {
    const spinner = { start: () => spinner, succeed: () => spinner, fail: () => spinner };
    return spinner;
  },
}));

vi.mock("@aoagents/ao-core", () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
  getGlobalConfigPath: (...args: unknown[]) => mockGetGlobalConfigPath(...args),
  generateOrchestratorPrompt: (...args: unknown[]) => mockGenerateOrchestratorPrompt(...args),
  recordActivityEvent: (...args: unknown[]) => mockRecordActivityEvent(...args),
  scanAoOrphans: (...args: unknown[]) => mockScanAoOrphans(...args),
  reapAoOrphans: (...args: unknown[]) => mockReapAoOrphans(...args),
}));

vi.mock("../../src/lib/create-session-manager.js", () => ({
  getSessionManager: (...args: unknown[]) => mockGetSessionManager(...args),
}));
vi.mock("../../src/lib/project-supervisor.js", () => ({
  startProjectSupervisor: (...args: unknown[]) => mockStartProjectSupervisor(...args),
}));
vi.mock("../../src/lib/lifecycle-service.js", () => ({
  listLifecycleWorkers: (...args: unknown[]) => mockListLifecycleWorkers(...args),
}));
vi.mock("../../src/lib/startup-preflight.js", () => ({
  runtimePreflight: (...args: unknown[]) => mockRuntimePreflight(...args),
}));
vi.mock("../../src/lib/shutdown.js", () => ({
  installShutdownHandlers: (...args: unknown[]) => mockInstallShutdownHandlers(...args),
}));
vi.mock("../../src/lib/running-state.js", () => ({
  acquireStartupLock: (...args: unknown[]) => mockAcquireStartupLock(...args),
  isAlreadyRunning: (...args: unknown[]) => mockIsAlreadyRunning(...args),
  register: (...args: unknown[]) => mockRegister(...args),
}));
vi.mock("../../src/lib/bun-tmp-janitor.js", () => ({
  startBunTmpJanitor: (...args: unknown[]) => mockStartBunTmpJanitor(...args),
}));

import { runHeadlessSupervisor } from "../../src/lib/headless-supervisor.js";

function makeConfig(projectIds: string[], configPath = "/tmp/global.yaml") {
  return {
    configPath,
    projects: Object.fromEntries(projectIds.map((id) => [id, { name: id, path: `/tmp/${id}` }])),
  };
}

describe("headless-supervisor (ao daemon / ao start --all)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockGetGlobalConfigPath.mockReturnValue("/tmp/global.yaml");
    mockLoadConfig.mockReturnValue(makeConfig(["app", "api"]));
    mockIsAlreadyRunning.mockResolvedValue(null);
    mockAcquireStartupLock.mockResolvedValue(() => {});
    mockStartProjectSupervisor.mockResolvedValue({ stop: vi.fn(), reconcileNow: vi.fn() });
    mockScanAoOrphans.mockResolvedValue([]);
    // Simulate the supervisor having attached a worker per active project.
    mockListLifecycleWorkers.mockReturnValue(["api", "app"]);
  });

  it("supervises ALL configured projects with a keep-alive supervisor and registers them", async () => {
    await runHeadlessSupervisor();

    // Reuses the already-global supervisor, with keep-alive so a daemon with
    // zero sessions still holds the event loop open.
    expect(mockStartProjectSupervisor).toHaveBeenCalledWith({
      configPath: "/tmp/global.yaml",
      keepProcessAlive: true,
    });

    // running.json records every supervised project (multi-project).
    expect(mockRegister).toHaveBeenCalledWith(
      expect.objectContaining({
        configPath: "/tmp/global.yaml",
        projects: ["api", "app"],
      }),
    );

    // Shutdown handler installed with a deterministic owner (sorted-first id).
    expect(mockInstallShutdownHandlers).toHaveBeenCalledWith({
      configPath: "/tmp/global.yaml",
      projectId: "api",
    });
  });

  it("does NOT auto-spawn orchestrators by default (parity with the dashboard server)", async () => {
    const ensureOrchestrator = vi.fn();
    mockGetSessionManager.mockResolvedValue({ ensureOrchestrator });

    await runHeadlessSupervisor();

    expect(mockGetSessionManager).not.toHaveBeenCalled();
    expect(ensureOrchestrator).not.toHaveBeenCalled();
  });

  it("ensures an orchestrator session for every project with --orchestrate-all", async () => {
    const ensureOrchestrator = vi.fn(async ({ projectId }: { projectId: string }) => ({
      id: `${projectId}-sess`,
    }));
    mockGetSessionManager.mockResolvedValue({ ensureOrchestrator });

    await runHeadlessSupervisor({ orchestrateAll: true });

    expect(ensureOrchestrator).toHaveBeenCalledTimes(2);
    expect(ensureOrchestrator).toHaveBeenCalledWith(expect.objectContaining({ projectId: "app" }));
    expect(ensureOrchestrator).toHaveBeenCalledWith(expect.objectContaining({ projectId: "api" }));
    // Supervisor still starts after orchestrators are ensured.
    expect(mockStartProjectSupervisor).toHaveBeenCalledWith({
      configPath: "/tmp/global.yaml",
      keepProcessAlive: true,
    });
  });

  it("keeps the daemon alive even when one project's orchestrator fails (best-effort)", async () => {
    const ensureOrchestrator = vi.fn(async ({ projectId }: { projectId: string }) => {
      if (projectId === "app") throw new Error("boom");
      return { id: `${projectId}-sess` };
    });
    mockGetSessionManager.mockResolvedValue({ ensureOrchestrator });

    await runHeadlessSupervisor({ orchestrateAll: true });

    // One project failed, but the supervisor still started.
    expect(ensureOrchestrator).toHaveBeenCalledTimes(2);
    expect(mockStartProjectSupervisor).toHaveBeenCalledTimes(1);
    expect(mockRegister).toHaveBeenCalledTimes(1);
  });

  it("short-circuits when AO is already running (no competing supervisor)", async () => {
    mockIsAlreadyRunning.mockResolvedValue({
      pid: 4242,
      port: 3000,
      configPath: "/tmp/global.yaml",
      startedAt: "2026-06-19T00:00:00.000Z",
      projects: ["app"],
    });

    await runHeadlessSupervisor();

    expect(mockStartProjectSupervisor).not.toHaveBeenCalled();
    expect(mockRegister).not.toHaveBeenCalled();
    expect(mockInstallShutdownHandlers).not.toHaveBeenCalled();
  });

  it("only reaps orphans when explicitly requested", async () => {
    await runHeadlessSupervisor();
    expect(mockScanAoOrphans).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockLoadConfig.mockReturnValue(makeConfig(["app", "api"]));
    mockIsAlreadyRunning.mockResolvedValue(null);
    mockAcquireStartupLock.mockResolvedValue(() => {});
    mockStartProjectSupervisor.mockResolvedValue({ stop: vi.fn(), reconcileNow: vi.fn() });
    mockListLifecycleWorkers.mockReturnValue(["api", "app"]);

    await runHeadlessSupervisor({ reapOrphans: true });
    expect(mockScanAoOrphans).toHaveBeenCalledTimes(1);
  });

  it("[web decoupling] the CLI package no longer depends on @aoagents/ao-web", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(resolve(here, "../../package.json"), "utf8")) as Record<
      string,
      Record<string, string> | undefined
    >;
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      expect(pkg[field]?.["@aoagents/ao-web"]).toBeUndefined();
    }
  });
});
