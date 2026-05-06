import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLoadConfig = vi.fn();
const mockGetSessionManager = vi.fn();
const mockEnsureLifecycleWorker = vi.fn();
const mockAddProjectToRunning = vi.fn();
const mockRemoveProjectFromRunning = vi.fn();
const mockSetHealth = vi.fn();
const activeWorkers = new Set<string>();

vi.mock("@aoagents/ao-core", () => ({
  createCorrelationId: () => "correlation-id",
  createProjectObserver: () => ({ setHealth: (...args: unknown[]) => mockSetHealth(...args) }),
  getGlobalConfigPath: () => "/tmp/global-config.yaml",
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
  isTerminalSession: (session: {
    status: string;
    activity: string | null;
    lifecycle?: {
      session: { state: string };
      pr: { state: string };
      runtime: { state: string };
    };
  }) => {
    if (session.lifecycle) {
      return (
        session.lifecycle.session.state === "done" ||
        session.lifecycle.session.state === "terminated" ||
        session.lifecycle.pr.state === "merged" ||
        session.lifecycle.runtime.state === "missing" ||
        session.lifecycle.runtime.state === "exited"
      );
    }
    return (
      ["done", "killed", "terminated", "errored", "merged", "cleanup"].includes(
        session.status,
      ) || session.activity === "exited"
    );
  },
}));

vi.mock("../../src/lib/create-session-manager.js", () => ({
  getSessionManager: (...args: unknown[]) => mockGetSessionManager(...args),
}));

vi.mock("../../src/lib/lifecycle-service.js", () => ({
  ensureLifecycleWorker: async (...args: unknown[]) => {
    const projectId = args[1] as string;
    const result = await mockEnsureLifecycleWorker(...args);
    activeWorkers.add(projectId);
    return result;
  },
  stopLifecycleWorker: (projectId: string) => {
    activeWorkers.delete(projectId);
  },
  listLifecycleWorkers: () => Array.from(activeWorkers),
}));

vi.mock("../../src/lib/running-state.js", () => ({
  addProjectToRunning: (...args: unknown[]) => mockAddProjectToRunning(...args),
  removeProjectFromRunning: (...args: unknown[]) => mockRemoveProjectFromRunning(...args),
}));

import {
  reconcileProjectSupervisor,
  startProjectSupervisor,
  stopProjectSupervisor,
} from "../../src/lib/project-supervisor.js";

function makeConfig(projectIds: string[]) {
  return {
    configPath: "/tmp/global-config.yaml",
    projects: Object.fromEntries(projectIds.map((id) => [id, { name: id, path: `/tmp/${id}` }])),
  };
}

function makeSession(projectId: string, status = "working") {
  return { id: `${projectId}-1`, projectId, status, activity: null };
}

describe("project-supervisor", () => {
  let sessionsByProject: Map<string, unknown[]>;

  beforeEach(() => {
    stopProjectSupervisor();
    activeWorkers.clear();
    sessionsByProject = new Map();
    mockLoadConfig.mockReset();
    mockGetSessionManager.mockReset();
    mockEnsureLifecycleWorker.mockReset();
    mockAddProjectToRunning.mockReset();
    mockRemoveProjectFromRunning.mockReset();
    mockSetHealth.mockReset();
    mockLoadConfig.mockReturnValue(makeConfig(["app"]));
    mockGetSessionManager.mockResolvedValue({
      list: async (projectId: string) => sessionsByProject.get(projectId) ?? [],
    });
    mockEnsureLifecycleWorker.mockResolvedValue({ running: true, started: true });
  });

  it("attaches a worker for a globally registered project with a non-terminal session", async () => {
    sessionsByProject.set("app", [makeSession("app")]);

    await reconcileProjectSupervisor();

    expect(mockEnsureLifecycleWorker).toHaveBeenCalledWith(
      expect.objectContaining({ configPath: "/tmp/global-config.yaml" }),
      "app",
      undefined,
    );
    expect(mockAddProjectToRunning).toHaveBeenCalledWith("app");
    expect(activeWorkers.has("app")).toBe(true);
  });

  it("does not attach for a registered project with no non-terminal sessions", async () => {
    sessionsByProject.set("app", [makeSession("app", "done")]);

    await reconcileProjectSupervisor();

    expect(mockEnsureLifecycleWorker).not.toHaveBeenCalled();
    expect(mockAddProjectToRunning).not.toHaveBeenCalled();
  });

  it("treats lifecycle-terminal sessions as terminal even when legacy status is working", async () => {
    sessionsByProject.set("app", [
      {
        ...makeSession("app", "working"),
        lifecycle: {
          session: { state: "done" },
          pr: { state: "none" },
          runtime: { state: "running" },
        },
      },
    ]);

    await reconcileProjectSupervisor();

    expect(mockEnsureLifecycleWorker).not.toHaveBeenCalled();
    expect(mockAddProjectToRunning).not.toHaveBeenCalled();
  });

  it("detaches a worker when the project is removed from global config", async () => {
    activeWorkers.add("removed");
    mockLoadConfig.mockReturnValue(makeConfig(["app"]));

    await reconcileProjectSupervisor();

    expect(activeWorkers.has("removed")).toBe(false);
    expect(mockRemoveProjectFromRunning).toHaveBeenCalledWith("removed");
  });

  it("detaches a worker when the last session becomes terminal", async () => {
    activeWorkers.add("app");
    sessionsByProject.set("app", [makeSession("app", "done")]);

    await reconcileProjectSupervisor();

    expect(activeWorkers.has("app")).toBe(false);
    expect(mockRemoveProjectFromRunning).toHaveBeenCalledWith("app");
  });

  it("updates running.projects for attached and detached workers", async () => {
    activeWorkers.add("idle");
    mockLoadConfig.mockReturnValue(makeConfig(["active", "idle"]));
    sessionsByProject.set("active", [makeSession("active")]);
    sessionsByProject.set("idle", [makeSession("idle", "done")]);

    await reconcileProjectSupervisor();

    expect(mockAddProjectToRunning).toHaveBeenCalledWith("active");
    expect(mockRemoveProjectFromRunning).toHaveBeenCalledWith("idle");
    expect(activeWorkers.has("active")).toBe(true);
    expect(activeWorkers.has("idle")).toBe(false);
  });

  it("continues reconciling other projects when one project fails", async () => {
    mockLoadConfig.mockReturnValue(makeConfig(["broken", "healthy"]));
    sessionsByProject.set("healthy", [makeSession("healthy")]);
    mockGetSessionManager.mockResolvedValue({
      list: async (projectId: string) => {
        if (projectId === "broken") throw new Error("boom");
        return sessionsByProject.get(projectId) ?? [];
      },
    });

    await reconcileProjectSupervisor();

    expect(mockEnsureLifecycleWorker).toHaveBeenCalledWith(
      expect.anything(),
      "healthy",
      undefined,
    );
    expect(mockSetHealth).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "project-supervisor.reconcile",
        status: "warn",
        projectId: "broken",
      }),
    );
    expect(activeWorkers.has("healthy")).toBe(true);
  });

  it("retries running-state registration for already-attached active projects", async () => {
    sessionsByProject.set("app", [makeSession("app")]);
    mockAddProjectToRunning.mockRejectedValueOnce(new Error("lock timeout"));

    await reconcileProjectSupervisor();
    await reconcileProjectSupervisor();

    expect(mockEnsureLifecycleWorker).toHaveBeenCalledTimes(1);
    expect(mockAddProjectToRunning).toHaveBeenCalledTimes(2);
    expect(activeWorkers.has("app")).toBe(true);
  });

  it("returns its handle even if stopped during the initial reconcile", async () => {
    let releaseList: (() => void) | undefined;
    mockGetSessionManager.mockResolvedValue({
      list: async () => {
        await new Promise<void>((resolve) => {
          releaseList = resolve;
        });
        return [];
      },
    });

    const startPromise = startProjectSupervisor(1_000);
    await vi.waitFor(() => expect(releaseList).toBeDefined());

    stopProjectSupervisor();
    releaseList?.();

    const handle = await startPromise;

    expect(handle).toEqual({
      stop: expect.any(Function),
      reconcileNow: expect.any(Function),
    });
  });

  it("rejects when the initial supervisor reconcile fails", async () => {
    mockLoadConfig.mockImplementation(() => {
      throw new Error("bad config");
    });

    await expect(startProjectSupervisor(1_000)).rejects.toThrow("bad config");
  });

  it("allows startup when the global config does not exist yet", async () => {
    const error = Object.assign(
      new Error("ENOENT: no such file or directory, open '/tmp/global-config.yaml'"),
      {
        code: "ENOENT",
        path: "/tmp/global-config.yaml",
      },
    );
    mockLoadConfig.mockImplementation(() => {
      throw error;
    });

    const handle = await startProjectSupervisor(1_000);

    expect(handle).toEqual({
      stop: expect.any(Function),
      reconcileNow: expect.any(Function),
    });
    handle.stop();
  });

  it("forwards the supervisor interval to lifecycle workers it starts", async () => {
    sessionsByProject.set("app", [makeSession("app")]);

    const handle = await startProjectSupervisor(1_234);

    expect(mockEnsureLifecycleWorker).toHaveBeenCalledWith(
      expect.objectContaining({ configPath: "/tmp/global-config.yaml" }),
      "app",
      1_234,
    );
    handle.stop();
  });

  it("reconcileNow waits for a queued reconcile when one is already running", async () => {
    const handle = await startProjectSupervisor(1_000);
    let firstRelease: (() => void) | undefined;
    let secondRelease: (() => void) | undefined;
    let listCalls = 0;
    mockGetSessionManager.mockResolvedValue({
      list: async () => {
        listCalls++;
        if (listCalls === 1) {
          await new Promise<void>((resolve) => {
            firstRelease = resolve;
          });
        } else if (listCalls === 2) {
          await new Promise<void>((resolve) => {
            secondRelease = resolve;
          });
        }
        return [];
      },
    });

    const firstReconcile = handle.reconcileNow();
    await vi.waitFor(() => expect(firstRelease).toBeDefined());

    let secondResolved = false;
    const secondReconcile = handle.reconcileNow().then(() => {
      secondResolved = true;
    });

    firstRelease?.();
    await vi.waitFor(() => expect(secondRelease).toBeDefined());
    expect(secondResolved).toBe(false);

    secondRelease?.();
    await firstReconcile;
    await secondReconcile;

    expect(secondResolved).toBe(true);
    handle.stop();
  });
});
