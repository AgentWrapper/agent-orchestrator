import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LifecycleManager, OrchestratorConfig } from "@aoagents/ao-core";

const mockGetLifecycleManager = vi.fn();

vi.mock("../../src/lib/create-session-manager.js", () => ({
  getLifecycleManager: (...args: unknown[]) => mockGetLifecycleManager(...args),
}));

// Import after mocks
import {
  ensureLifecycleWorker,
  stopLifecycleWorker,
  stopAllLifecycleWorkers,
  isLifecycleWorkerRunning,
  listLifecycleWorkers,
} from "../../src/lib/lifecycle-service.js";

function makeConfig(projectIds: string[]): OrchestratorConfig {
  return {
    configPath: "/tmp/agent-orchestrator.yaml",
    port: 3000,
    readyThresholdMs: 300_000,
    defaults: { runtime: "tmux", agent: "claude-code", workspace: "worktree", notifiers: [] },
    projects: Object.fromEntries(
      projectIds.map((id) => [id, { name: id, repo: "", path: "/tmp", defaultBranch: "main" }]),
    ),
    notifiers: {},
    notificationRouting: {},
    reactions: {},
  } as OrchestratorConfig;
}

function makeFakeLifecycle(overrides?: Partial<LifecycleManager>): LifecycleManager & {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  const start = vi.fn();
  const stop = vi.fn();
  return { start, stop, ...overrides } as unknown as LifecycleManager & {
    start: typeof start;
    stop: typeof stop;
  };
}

describe("lifecycle-service", () => {
  beforeEach(() => {
    stopAllLifecycleWorkers();
    mockGetLifecycleManager.mockReset();
  });

  afterEach(() => {
    stopAllLifecycleWorkers();
  });

  it("starts polling in-process for a known project", async () => {
    const lifecycle = makeFakeLifecycle();
    mockGetLifecycleManager.mockResolvedValue(lifecycle);

    const result = await ensureLifecycleWorker(makeConfig(["app"]), "app", 1000);

    expect(result).toEqual({ running: true, started: true });
    expect(lifecycle.start).toHaveBeenCalledWith(1000);
    expect(isLifecycleWorkerRunning("app")).toBe(true);
  });

  it("is idempotent — second ensure is a no-op", async () => {
    const lifecycle = makeFakeLifecycle();
    mockGetLifecycleManager.mockResolvedValue(lifecycle);

    const first = await ensureLifecycleWorker(makeConfig(["app"]), "app");
    const second = await ensureLifecycleWorker(makeConfig(["app"]), "app");

    expect(first.started).toBe(true);
    expect(second.started).toBe(false);
    expect(lifecycle.start).toHaveBeenCalledTimes(1);
  });

  it("throws on unknown projects", async () => {
    await expect(
      ensureLifecycleWorker(makeConfig(["app"]), "missing"),
    ).rejects.toThrow(/Unknown project/);
  });

  it("isolates errors: one project failing to start does not affect another", async () => {
    const healthy = makeFakeLifecycle();
    mockGetLifecycleManager.mockImplementation(async (_config, projectId: string) => {
      if (projectId === "broken") {
        throw new Error("boom — broken project plugin");
      }
      return healthy;
    });

    const config = makeConfig(["healthy", "broken"]);

    await expect(ensureLifecycleWorker(config, "broken")).rejects.toThrow(/boom/);
    expect(isLifecycleWorkerRunning("broken")).toBe(false);

    const result = await ensureLifecycleWorker(config, "healthy");
    expect(result.started).toBe(true);
    expect(healthy.start).toHaveBeenCalledTimes(1);
    expect(isLifecycleWorkerRunning("healthy")).toBe(true);
  });

  it("stopLifecycleWorker is a no-op for unknown projects", () => {
    expect(() => stopLifecycleWorker("missing")).not.toThrow();
    expect(listLifecycleWorkers()).toEqual([]);
  });

  it("stopLifecycleWorker stops only the requested project", async () => {
    const a = makeFakeLifecycle();
    const b = makeFakeLifecycle();
    mockGetLifecycleManager.mockImplementation(async (_cfg, projectId: string) =>
      projectId === "a" ? a : b,
    );

    const config = makeConfig(["a", "b"]);
    await ensureLifecycleWorker(config, "a");
    await ensureLifecycleWorker(config, "b");

    stopLifecycleWorker("a");

    expect(a.stop).toHaveBeenCalledTimes(1);
    expect(b.stop).not.toHaveBeenCalled();
    expect(listLifecycleWorkers()).toEqual(["b"]);
  });

  it("stopLifecycleWorker removes a project even when lifecycle stop throws", async () => {
    const broken = makeFakeLifecycle();
    (broken.stop as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("stop failed");
    });
    mockGetLifecycleManager.mockResolvedValue(broken);

    await ensureLifecycleWorker(makeConfig(["broken"]), "broken");

    expect(() => stopLifecycleWorker("broken")).not.toThrow();
    expect(listLifecycleWorkers()).toEqual([]);
  });

  it("stopAllLifecycleWorkers is a no-op when nothing is active", () => {
    expect(() => stopAllLifecycleWorkers()).not.toThrow();
    expect(listLifecycleWorkers()).toEqual([]);
  });

  it("stopAllLifecycleWorkers stops every registered project", async () => {
    const a = makeFakeLifecycle();
    const b = makeFakeLifecycle();
    mockGetLifecycleManager.mockImplementation(async (_cfg, projectId: string) =>
      projectId === "a" ? a : b,
    );

    const config = makeConfig(["a", "b"]);
    await ensureLifecycleWorker(config, "a");
    await ensureLifecycleWorker(config, "b");

    expect(listLifecycleWorkers().sort()).toEqual(["a", "b"]);

    stopAllLifecycleWorkers();

    expect(a.stop).toHaveBeenCalledTimes(1);
    expect(b.stop).toHaveBeenCalledTimes(1);
    expect(listLifecycleWorkers()).toEqual([]);
  });

  it("a throwing stop on one project does not prevent others from stopping", async () => {
    const broken = makeFakeLifecycle();
    (broken.stop as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("stop failed");
    });
    const healthy = makeFakeLifecycle();
    mockGetLifecycleManager.mockImplementation(async (_cfg, projectId: string) =>
      projectId === "broken" ? broken : healthy,
    );

    const config = makeConfig(["broken", "healthy"]);
    await ensureLifecycleWorker(config, "broken");
    await ensureLifecycleWorker(config, "healthy");

    expect(() => stopAllLifecycleWorkers()).not.toThrow();
    expect(healthy.stop).toHaveBeenCalledTimes(1);
    expect(listLifecycleWorkers()).toEqual([]);
  });
});
