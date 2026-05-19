/**
 * Tests for shutdown.ts activity-event instrumentation (issue #1654).
 *
 * Each test mounts handlers via `installShutdownHandlers`, fires a signal,
 * and asserts the expected `cli.*` activity events are emitted. Real
 * `process.exit` is stubbed so the test process is not terminated by the
 * shutdown handler.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { recordActivityEvent } from "@aoagents/ao-core";

const {
  mockListSessions,
  mockKillSession,
  mockGetSessionManager,
  mockUnregister,
  mockWriteLastStop,
  mockStopBunTmpJanitor,
  mockStopProjectSupervisor,
  mockStopAllLifecycleWorkers,
  mockLoadConfig,
  mockIsTerminalSession,
} = vi.hoisted(() => ({
  mockListSessions: vi.fn(),
  mockKillSession: vi.fn(),
  mockGetSessionManager: vi.fn(),
  mockUnregister: vi.fn(),
  mockWriteLastStop: vi.fn(),
  mockStopBunTmpJanitor: vi.fn(),
  mockStopProjectSupervisor: vi.fn(),
  mockStopAllLifecycleWorkers: vi.fn(),
  mockLoadConfig: vi.fn(),
  mockIsTerminalSession: vi.fn(),
}));

vi.mock("@aoagents/ao-core", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("@aoagents/ao-core")>();
  return {
    ...actual,
    loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
    isTerminalSession: (...args: unknown[]) => mockIsTerminalSession(...args),
    recordActivityEvent: vi.fn(),
  };
});

vi.mock("../../src/lib/create-session-manager.js", () => ({
  getSessionManager: (...args: unknown[]) => mockGetSessionManager(...args),
}));

vi.mock("../../src/lib/lifecycle-service.js", () => ({
  stopAllLifecycleWorkers: (...args: unknown[]) => mockStopAllLifecycleWorkers(...args),
}));

vi.mock("../../src/lib/project-supervisor.js", () => ({
  stopProjectSupervisor: (...args: unknown[]) => mockStopProjectSupervisor(...args),
}));

vi.mock("../../src/lib/running-state.js", () => ({
  unregister: (...args: unknown[]) => mockUnregister(...args),
  writeLastStop: (...args: unknown[]) => mockWriteLastStop(...args),
}));

vi.mock("../../src/lib/bun-tmp-janitor.js", () => ({
  stopBunTmpJanitor: (...args: unknown[]) => mockStopBunTmpJanitor(...args),
}));

const recordedEvents = (): Array<Record<string, unknown>> =>
  vi.mocked(recordActivityEvent).mock.calls.map((c) => c[0] as Record<string, unknown>);

const flushAsync = async (): Promise<void> => {
  // The shutdown handler launches an async IIFE; allow it to settle.
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setImmediate(r));
  }
};

describe("shutdown handlers — activity events", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let originalListenersSigint: NodeJS.SignalsListener[];
  let originalListenersSigterm: NodeJS.SignalsListener[];

  beforeEach(async () => {
    vi.resetModules();
    vi.mocked(recordActivityEvent).mockClear();
    mockListSessions.mockReset();
    mockKillSession.mockReset();
    mockGetSessionManager.mockReset();
    mockUnregister.mockReset();
    mockWriteLastStop.mockReset();
    mockStopBunTmpJanitor.mockReset();
    mockStopProjectSupervisor.mockReset();
    mockStopAllLifecycleWorkers.mockReset();
    mockLoadConfig.mockReset();
    mockIsTerminalSession.mockReset();

    mockLoadConfig.mockReturnValue({ projects: {} });
    mockIsTerminalSession.mockReturnValue(false);
    mockGetSessionManager.mockResolvedValue({
      list: mockListSessions,
      kill: mockKillSession,
    });
    mockListSessions.mockResolvedValue([]);
    mockKillSession.mockResolvedValue({ cleaned: true });
    mockUnregister.mockResolvedValue(undefined);
    mockWriteLastStop.mockResolvedValue(undefined);
    mockStopBunTmpJanitor.mockResolvedValue(undefined);

    // Snapshot existing signal listeners so we can restore them after each
    // test and avoid leaking handlers across tests in the same process.
    originalListenersSigint = process.listeners("SIGINT") as NodeJS.SignalsListener[];
    originalListenersSigterm = process.listeners("SIGTERM") as NodeJS.SignalsListener[];

    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      // Throw a sentinel to short-circuit the async IIFE without leaving
      // the test process in an unknown state.
      return undefined as never;
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();

    // Restore signal listeners
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
    for (const l of originalListenersSigint) process.on("SIGINT", l);
    for (const l of originalListenersSigterm) process.on("SIGTERM", l);
  });

  it("emits cli.shutdown_signal when SIGINT is received", async () => {
    const { installShutdownHandlers } = await import("../../src/lib/shutdown.js");
    installShutdownHandlers({ configPath: "/tmp/cfg.yaml", projectId: "p1" });

    process.emit("SIGINT", "SIGINT");
    await flushAsync();

    const events = recordedEvents();
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "cli.shutdown_signal",
        source: "cli",
        projectId: "p1",
        data: expect.objectContaining({ signal: "SIGINT", exitCode: 130 }),
      }),
    );
  });

  it("emits cli.shutdown_completed after clean shutdown", async () => {
    const { installShutdownHandlers } = await import("../../src/lib/shutdown.js");
    installShutdownHandlers({ configPath: "/tmp/cfg.yaml", projectId: "p1" });

    process.emit("SIGTERM", "SIGTERM");
    await flushAsync();

    const events = recordedEvents();
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "cli.shutdown_completed",
        source: "cli",
        projectId: "p1",
      }),
    );
  });

  it("emits cli.shutdown_failed when shutdown body throws before completion", async () => {
    const { installShutdownHandlers } = await import("../../src/lib/shutdown.js");
    mockGetSessionManager.mockRejectedValue(new Error("getSessionManager boom"));

    installShutdownHandlers({ configPath: "/tmp/cfg.yaml", projectId: "p1" });

    process.emit("SIGTERM", "SIGTERM");
    await flushAsync();

    const events = recordedEvents();
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "cli.shutdown_failed",
        source: "cli",
        level: "error",
        data: expect.objectContaining({ errorMessage: "getSessionManager boom" }),
      }),
    );
    // Failure path should NOT emit shutdown_completed
    const completedEvents = events.filter((e) => e.kind === "cli.shutdown_completed");
    expect(completedEvents).toHaveLength(0);
  });

  it("still unregisters running state when writing last-stop state fails", async () => {
    const { installShutdownHandlers } = await import("../../src/lib/shutdown.js");
    mockListSessions.mockResolvedValue([
      {
        id: "s1",
        projectId: "p1",
        status: "working",
      },
    ]);
    mockWriteLastStop.mockRejectedValue(new Error("disk full"));

    installShutdownHandlers({ configPath: "/tmp/cfg.yaml", projectId: "p1" });

    process.emit("SIGTERM", "SIGTERM");
    await flushAsync();

    expect(mockWriteLastStop).toHaveBeenCalled();
    expect(mockUnregister).toHaveBeenCalled();

    const events = recordedEvents();
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "cli.last_stop_write_failed",
        source: "cli",
        level: "error",
        data: expect.objectContaining({
          targetSessionCount: 1,
          otherProjectCount: 0,
          totalKilled: 1,
          errorMessage: "disk full",
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "cli.shutdown_completed",
        source: "cli",
        projectId: "p1",
      }),
    );
    expect(events.filter((e) => e.kind === "cli.shutdown_failed")).toHaveLength(0);
  });

  it("emits cli.shutdown_force_exit when the 10s timer fires", async () => {
    vi.useFakeTimers();
    try {
      const { installShutdownHandlers } = await import("../../src/lib/shutdown.js");
      // Hang the async cleanup so the force-exit timer wins.
      mockGetSessionManager.mockReturnValue(new Promise(() => {}));

      installShutdownHandlers({ configPath: "/tmp/cfg.yaml", projectId: "p1" });

      process.emit("SIGINT", "SIGINT");
      // Advance past the 10s timeout
      await vi.advanceTimersByTimeAsync(10_000);

      const events = recordedEvents();
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "cli.shutdown_force_exit",
          source: "cli",
          level: "warn",
          data: expect.objectContaining({ timeoutMs: 10_000, exitCode: 130 }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
