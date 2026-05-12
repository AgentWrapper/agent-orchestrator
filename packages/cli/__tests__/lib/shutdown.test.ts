import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockLoadAllProjectsConfigWithFallback,
  mockGetSessionManager,
  mockStopAllLifecycleWorkers,
  mockStopProjectSupervisor,
  mockUnregister,
  mockWriteLastStop,
  mockStopBunTmpJanitor,
} = vi.hoisted(() => ({
  mockLoadAllProjectsConfigWithFallback: vi.fn(),
  mockGetSessionManager: vi.fn(),
  mockStopAllLifecycleWorkers: vi.fn(),
  mockStopProjectSupervisor: vi.fn(),
  mockUnregister: vi.fn().mockResolvedValue(undefined),
  mockWriteLastStop: vi.fn().mockResolvedValue(undefined),
  mockStopBunTmpJanitor: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/lib/all-projects-config.js", () => ({
  loadAllProjectsConfigWithFallback: (...args: unknown[]) =>
    mockLoadAllProjectsConfigWithFallback(...args),
}));

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

describe("shutdown handler", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    mockLoadAllProjectsConfigWithFallback.mockReset();
    mockGetSessionManager.mockReset();
    mockStopAllLifecycleWorkers.mockReset();
    mockStopProjectSupervisor.mockReset();
    mockUnregister.mockReset();
    mockUnregister.mockResolvedValue(undefined);
    mockWriteLastStop.mockReset();
    mockWriteLastStop.mockResolvedValue(undefined);
    mockStopBunTmpJanitor.mockReset();
    mockStopBunTmpJanitor.mockResolvedValue(undefined);
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it("unregisters and exits even when cleanup config loading fails", async () => {
    mockLoadAllProjectsConfigWithFallback.mockImplementation(() => {
      throw new Error("invalid global config");
    });

    const { installShutdownHandlers } = await import("../../src/lib/shutdown.js");
    installShutdownHandlers({
      configPath: "/local/agent-orchestrator.yaml",
      projectId: "project-1",
    });

    process.emit("SIGTERM", "SIGTERM");

    await vi.waitFor(() => expect(mockUnregister).toHaveBeenCalledTimes(1));
    expect(mockGetSessionManager).not.toHaveBeenCalled();
    expect(mockStopBunTmpJanitor).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
  });

  it("uses the fallback all-project config for graceful session cleanup", async () => {
    const config = { projects: { "project-1": {}, "project-2": {} } };
    const sessionManager = {
      list: vi.fn(() => new Promise(() => {})),
      listStored: vi.fn().mockResolvedValue([
        { id: "p1-1", projectId: "project-1", status: "working", activity: "active" },
        { id: "p2-1", projectId: "project-2", status: "working", activity: "active" },
      ]),
      kill: vi.fn().mockResolvedValue({ cleaned: true, alreadyTerminated: false }),
    };
    mockLoadAllProjectsConfigWithFallback.mockReturnValue({
      config,
      warning: "using fallback",
    });
    mockGetSessionManager.mockResolvedValue(sessionManager);

    const { installShutdownHandlers } = await import("../../src/lib/shutdown.js");
    installShutdownHandlers({
      configPath: "/local/agent-orchestrator.yaml",
      projectId: "project-1",
    });

    process.emit("SIGINT", "SIGINT");

    await vi.waitFor(() => expect(mockWriteLastStop).toHaveBeenCalledTimes(1));
    expect(mockLoadAllProjectsConfigWithFallback).toHaveBeenCalledWith(
      "/local/agent-orchestrator.yaml",
    );
    expect(sessionManager.listStored).toHaveBeenCalledTimes(1);
    expect(sessionManager.list).not.toHaveBeenCalled();
    expect(sessionManager.kill).toHaveBeenCalledWith("p1-1");
    expect(sessionManager.kill).toHaveBeenCalledWith("p2-1");
    expect(mockWriteLastStop).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        sessionIds: ["p1-1"],
        otherProjects: [{ projectId: "project-2", sessionIds: ["p2-1"] }],
      }),
    );
    expect(mockUnregister).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(130));
  });
});
