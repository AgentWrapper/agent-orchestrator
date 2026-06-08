import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLoadConfig = vi.fn();
const mockGetSessionManager = vi.fn();
const mockEnsureLifecycleWorker = vi.fn();
const mockAddProjectToRunning = vi.fn();
const mockRemoveProjectFromRunning = vi.fn();
const mockSetHealth = vi.fn();
const activeWorkers = new Set<string>();

vi.mock("@aoagents/ao-core", () => ({
  ConfigNotFoundError: class ConfigNotFoundError extends Error {
    constructor(message = "No agent-orchestrator.yaml found.") {
      super(message);
      this.name = "ConfigNotFoundError";
    }
  },
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

function makeConfig(projectIds: string[], configPath = "/tmp/global-config.yaml") {
  return {
    configPath,
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

    const startPromise = startProjectSupervisor({ intervalMs: 1_000 });
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

    await expect(startProjectSupervisor({ intervalMs: 1_000 })).rejects.toThrow("bad config");
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

    const handle = await startProjectSupervisor({ intervalMs: 1_000 });

    expect(handle).toEqual({
      stop: expect.any(Function),
      reconcileNow: expect.any(Function),
    });
    handle.stop();
  });

  it("falls back to local config when the global config is missing (ENOENT)", async () => {
    // The local fallback uses a DIFFERENT configPath than the global —
    // a real bare `loadConfig()` discovers the local file and sets
    // `config.configPath` to that path. Asserting on the local path here
    // catches any bug that would propagate the global path through the
    // fallback (e.g. accidentally returning the global config object).
    const localConfigPath = "/tmp/cwd/agent-orchestrator.yaml";
    sessionsByProject.set("app", [makeSession("app")]);
    mockLoadConfig.mockImplementation((path?: string) => {
      if (path === "/tmp/global-config.yaml") {
        throw Object.assign(new Error("ENOENT"), {
          code: "ENOENT",
          path: "/tmp/global-config.yaml",
        });
      }
      return makeConfig(["app"], localConfigPath);
    });

    await reconcileProjectSupervisor();

    expect(mockLoadConfig).toHaveBeenCalledWith("/tmp/global-config.yaml");
    expect(mockLoadConfig).toHaveBeenCalledWith();
    expect(mockEnsureLifecycleWorker).toHaveBeenCalledWith(
      expect.objectContaining({ configPath: localConfigPath }),
      "app",
      undefined,
    );
    expect(activeWorkers.has("app")).toBe(true);
  });

  it("uses the caller-provided configPath as the local fallback when global is missing", async () => {
    sessionsByProject.set("app", [makeSession("app")]);
    mockLoadConfig.mockImplementation((path?: string) => {
      if (path === "/tmp/global-config.yaml") {
        throw Object.assign(new Error("ENOENT"), {
          code: "ENOENT",
          path: "/tmp/global-config.yaml",
        });
      }
      if (path === "/some/repo/agent-orchestrator.yaml") {
        return makeConfig(["app"]);
      }
      throw new Error(`unexpected loadConfig path: ${path}`);
    });

    await reconcileProjectSupervisor({ configPath: "/some/repo/agent-orchestrator.yaml" });

    expect(mockLoadConfig).toHaveBeenCalledWith("/tmp/global-config.yaml");
    expect(mockLoadConfig).toHaveBeenCalledWith("/some/repo/agent-orchestrator.yaml");
    // No bare cwd-walk when the caller resolved a path for us.
    expect(mockLoadConfig).not.toHaveBeenCalledWith();
    expect(activeWorkers.has("app")).toBe(true);
  });

  it("ignores the caller-provided configPath when the global config is healthy", async () => {
    sessionsByProject.set("app", [makeSession("app")]);
    // Both paths would return a valid config — assert we only ever consult
    // the global path. The configPath is the fallback, not an override.
    mockLoadConfig.mockImplementation((path?: string) => {
      if (path === "/tmp/global-config.yaml") return makeConfig(["app"]);
      if (path === "/repo/agent-orchestrator.yaml") {
        throw new Error("supervisor should not consult configPath when global is healthy");
      }
      throw new Error(`unexpected loadConfig path: ${path}`);
    });

    await reconcileProjectSupervisor({ configPath: "/repo/agent-orchestrator.yaml" });

    expect(mockLoadConfig).toHaveBeenCalledWith("/tmp/global-config.yaml");
    expect(mockLoadConfig).not.toHaveBeenCalledWith("/repo/agent-orchestrator.yaml");
    expect(activeWorkers.has("app")).toBe(true);
  });

  it("preserves workers across a global→fallback transition (multi-tick)", async () => {
    // Tick 1: global exists with {alpha, beta, gamma} — supervisor attaches
    // all three. Tick 2: global has been deleted; the local fallback config
    // (passed-in configPath) lists only {alpha}. Without the source-aware
    // detach skip, the second tick would kill beta and gamma even though
    // they're still running real sessions.
    sessionsByProject.set("alpha", [makeSession("alpha")]);
    sessionsByProject.set("beta", [makeSession("beta")]);
    sessionsByProject.set("gamma", [makeSession("gamma")]);

    // Tick 1: global is the source.
    mockLoadConfig.mockImplementation((path?: string) => {
      if (path === "/tmp/global-config.yaml") return makeConfig(["alpha", "beta", "gamma"]);
      throw new Error(`unexpected path on tick 1: ${path}`);
    });
    await reconcileProjectSupervisor({ configPath: "/repo/agent-orchestrator.yaml" });
    expect(activeWorkers.has("alpha")).toBe(true);
    expect(activeWorkers.has("beta")).toBe(true);
    expect(activeWorkers.has("gamma")).toBe(true);

    // Tick 2: global deleted, fallback has a narrower view.
    mockLoadConfig.mockImplementation((path?: string) => {
      if (path === "/tmp/global-config.yaml") {
        throw Object.assign(new Error("ENOENT"), {
          code: "ENOENT",
          path: "/tmp/global-config.yaml",
        });
      }
      if (path === "/repo/agent-orchestrator.yaml") return makeConfig(["alpha"]);
      throw new Error(`unexpected path on tick 2: ${path}`);
    });
    await reconcileProjectSupervisor({ configPath: "/repo/agent-orchestrator.yaml" });

    // All three workers must survive — fallback isn't authoritative for removal.
    expect(activeWorkers.has("alpha")).toBe(true);
    expect(activeWorkers.has("beta")).toBe(true);
    expect(activeWorkers.has("gamma")).toBe(true);
    expect(mockRemoveProjectFromRunning).not.toHaveBeenCalledWith("beta");
    expect(mockRemoveProjectFromRunning).not.toHaveBeenCalledWith("gamma");
  });

  it("does detach when global is restored after a fallback period (symmetric flip)", async () => {
    // Documents intentional current behavior: when source flips back to
    // "global", the detach pass treats the global config as authoritative,
    // so projects not listed there ARE detached — including any that were
    // attached during a prior fallback window. The reviewer's guidance was
    // scoped to the fallback direction; protecting the symmetric flip would
    // require per-worker source tracking and is out of scope here.
    sessionsByProject.set("local-only", [makeSession("local-only")]);
    sessionsByProject.set("from-global", [makeSession("from-global")]);

    // Tick 1: no global, fallback attaches local-only.
    mockLoadConfig.mockImplementation((path?: string) => {
      if (path === "/tmp/global-config.yaml") {
        throw Object.assign(new Error("ENOENT"), {
          code: "ENOENT",
          path: "/tmp/global-config.yaml",
        });
      }
      if (path === "/repo/agent-orchestrator.yaml") return makeConfig(["local-only"]);
      throw new Error(`unexpected path on tick 1: ${path}`);
    });
    await reconcileProjectSupervisor({ configPath: "/repo/agent-orchestrator.yaml" });
    expect(activeWorkers.has("local-only")).toBe(true);

    // Tick 2: global appears (e.g. another `ao start <url>` wrote it),
    // listing only "from-global". Source = "global" → detach pass runs.
    mockLoadConfig.mockImplementation((path?: string) => {
      if (path === "/tmp/global-config.yaml") return makeConfig(["from-global"]);
      throw new Error(`unexpected path on tick 2: ${path}`);
    });
    await reconcileProjectSupervisor({ configPath: "/repo/agent-orchestrator.yaml" });

    expect(activeWorkers.has("from-global")).toBe(true);
    expect(activeWorkers.has("local-only")).toBe(false);
    expect(mockRemoveProjectFromRunning).toHaveBeenCalledWith("local-only");
  });

  it("does not detach unrelated active workers when operating from local fallback", async () => {
    // Simulates: daemon already supervising "other-project" (registered via
    // a prior reconcile against a global config that has since been deleted).
    // The current reconcile sees only "cwd-project" in the local fallback —
    // it must NOT treat "other-project" as removed.
    activeWorkers.add("other-project");
    sessionsByProject.set("cwd-project", [makeSession("cwd-project")]);
    mockLoadConfig.mockImplementation((path?: string) => {
      if (path === "/tmp/global-config.yaml") {
        throw Object.assign(new Error("ENOENT"), {
          code: "ENOENT",
          path: "/tmp/global-config.yaml",
        });
      }
      return makeConfig(["cwd-project"]);
    });

    await reconcileProjectSupervisor({ configPath: "/repo/agent-orchestrator.yaml" });

    expect(activeWorkers.has("other-project")).toBe(true);
    expect(mockRemoveProjectFromRunning).not.toHaveBeenCalledWith("other-project");
    // Attach pass still runs for the configured cwd project.
    expect(activeWorkers.has("cwd-project")).toBe(true);
  });

  it("rethrows ENOENT from a nested file referenced by the global config", async () => {
    mockLoadConfig.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), {
        code: "ENOENT",
        path: "/tmp/some-referenced-file.yaml",
      });
    });

    await expect(reconcileProjectSupervisor()).rejects.toThrow("ENOENT");
    expect(mockLoadConfig).toHaveBeenCalledTimes(1);
  });

  it("rethrows non-missing-config errors from the global config load", async () => {
    mockLoadConfig.mockImplementation(() => {
      throw new Error("invalid yaml");
    });

    await expect(reconcileProjectSupervisor()).rejects.toThrow("invalid yaml");
    expect(mockLoadConfig).toHaveBeenCalledTimes(1);
  });

  it("exits cleanly when neither global nor local config exists", async () => {
    const { ConfigNotFoundError } = await import("@aoagents/ao-core");
    mockLoadConfig
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("ENOENT"), {
          code: "ENOENT",
          path: "/tmp/global-config.yaml",
        });
      })
      .mockImplementationOnce(() => {
        throw new ConfigNotFoundError();
      });

    const handle = await startProjectSupervisor({ intervalMs: 1_000 });

    expect(handle).toEqual({
      stop: expect.any(Function),
      reconcileNow: expect.any(Function),
    });
    expect(mockEnsureLifecycleWorker).not.toHaveBeenCalled();
    handle.stop();
  });

  it("forwards the supervisor interval to lifecycle workers it starts", async () => {
    sessionsByProject.set("app", [makeSession("app")]);

    const handle = await startProjectSupervisor({ intervalMs: 1_234 });

    expect(mockEnsureLifecycleWorker).toHaveBeenCalledWith(
      expect.objectContaining({ configPath: "/tmp/global-config.yaml" }),
      "app",
      1_234,
    );
    handle.stop();
  });

  it("reconcileNow waits for a queued reconcile when one is already running", async () => {
    const handle = await startProjectSupervisor({ intervalMs: 1_000 });
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
