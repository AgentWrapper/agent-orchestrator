import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  getServicesMock: vi.fn(),
  getSCMMock: vi.fn(),
  sessionToDashboardMock: vi.fn(),
  resolveProjectMock: vi.fn(),
  enrichSessionPRMock: vi.fn(),
  enrichSessionsMetadataFastMock: vi.fn(),
  listDashboardOrchestratorsMock: vi.fn(),
  filterProjectSessionsMock: vi.fn(),
  filterWorkerSessionsMock: vi.fn(),
  resolveGlobalPauseMock: vi.fn(),
  getAllProjectsMock: vi.fn(),
  getPrimaryProjectIdMock: vi.fn(),
  getProjectNameMock: vi.fn(),
}));

vi.mock("@/lib/services", () => ({
  getServices: hoisted.getServicesMock,
  getSCM: hoisted.getSCMMock,
}));

vi.mock("@/lib/serialize", () => ({
  sessionToDashboard: hoisted.sessionToDashboardMock,
  resolveProject: hoisted.resolveProjectMock,
  enrichSessionPR: hoisted.enrichSessionPRMock,
  enrichSessionsMetadataFast: hoisted.enrichSessionsMetadataFastMock,
  listDashboardOrchestrators: hoisted.listDashboardOrchestratorsMock,
}));

vi.mock("@/lib/project-utils", () => ({
  filterProjectSessions: hoisted.filterProjectSessionsMock,
  filterWorkerSessions: hoisted.filterWorkerSessionsMock,
}));

vi.mock("@/lib/global-pause", () => ({
  resolveGlobalPause: hoisted.resolveGlobalPauseMock,
}));

vi.mock("@/lib/project-name", () => ({
  getAllProjects: hoisted.getAllProjectsMock,
  getPrimaryProjectId: hoisted.getPrimaryProjectIdMock,
  getProjectName: hoisted.getProjectNameMock,
}));

import { getDashboardPageData } from "@/lib/dashboard-page-data";

describe("getDashboardPageData fast path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.getAllProjectsMock.mockReturnValue([
      { id: "docs", name: "Docs" },
      { id: "mono", name: "Mono" },
    ]);
    hoisted.getPrimaryProjectIdMock.mockReturnValue("docs");
    hoisted.getProjectNameMock.mockReturnValue("Docs");
    hoisted.resolveGlobalPauseMock.mockReturnValue({ reason: "paused" });
    hoisted.listDashboardOrchestratorsMock.mockReturnValue([{ id: "orch-1", projectId: "docs", projectName: "Docs" }]);
    hoisted.enrichSessionsMetadataFastMock.mockResolvedValue(undefined);
  });

  it("runs fast enrichment, uses cache-only PR hydration, and preserves canonical PR state on cache misses even without SCM", async () => {
    const noPrCore = { id: "session-no-pr", status: "working", pr: null };
    const closedCore = { id: "session-closed", status: "idle", pr: { number: 2 } };
    const mergedCore = { id: "session-merged", status: "idle", pr: { number: 3 } };
    const allSessions = [noPrCore, closedCore, mergedCore];

    const dashboardNoPr = { id: "session-no-pr", pr: null };
    const dashboardClosed = { id: "session-closed", pr: { state: "closed", enriched: false } };
    const dashboardMerged = { id: "session-merged", pr: { state: "merged", enriched: false } };

    hoisted.getServicesMock.mockResolvedValue({
      config: { projects: { docs: { id: "docs" } } },
      registry: { scm: "registry" },
      sessionManager: { listCached: vi.fn().mockResolvedValue(allSessions) },
    });
    hoisted.filterProjectSessionsMock.mockReturnValue(allSessions);
    hoisted.filterWorkerSessionsMock.mockReturnValue(allSessions);
    hoisted.sessionToDashboardMock
      .mockReturnValueOnce(dashboardNoPr)
      .mockReturnValueOnce(dashboardClosed)
      .mockReturnValueOnce(dashboardMerged);
    hoisted.resolveProjectMock.mockImplementation((core) => ({ id: core.id }));
    hoisted.getSCMMock
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ provider: "github" });

    const pageData = await getDashboardPageData("docs");

    expect(hoisted.enrichSessionsMetadataFastMock).toHaveBeenCalledWith(
      allSessions,
      [dashboardNoPr, dashboardClosed, dashboardMerged],
      { projects: { docs: { id: "docs" } } },
      { scm: "registry" },
    );
    expect(hoisted.enrichSessionPRMock).toHaveBeenCalledTimes(2);
    expect(hoisted.enrichSessionPRMock).toHaveBeenCalledWith(dashboardClosed);
    expect(hoisted.enrichSessionPRMock).toHaveBeenCalledWith(dashboardMerged);
    expect(pageData.sessions).toEqual([dashboardNoPr, dashboardClosed, dashboardMerged]);
  });

  it("does not block SSR indefinitely when fast metadata enrichment hangs", async () => {
    vi.useFakeTimers();

    try {
      const core = { id: "session-hung", status: "working", pr: null };
      const dashboard = { id: "session-hung", pr: null };

      hoisted.getServicesMock.mockResolvedValue({
        config: { projects: { mono: { id: "mono" } } },
        registry: { scm: "registry" },
        sessionManager: { listCached: vi.fn().mockResolvedValue([core]) },
      });
      hoisted.filterProjectSessionsMock.mockReturnValue([core]);
      hoisted.filterWorkerSessionsMock.mockReturnValue([core]);
      hoisted.sessionToDashboardMock.mockReturnValue(dashboard);
      hoisted.enrichSessionsMetadataFastMock.mockImplementation(
        () => new Promise(() => {}),
      );

      const pageDataPromise = getDashboardPageData("mono");
      await vi.advanceTimersByTimeAsync(3_000);
      const pageData = await pageDataPromise;

      expect(pageData.sessions).toEqual([dashboard]);
      expect(hoisted.enrichSessionPRMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves orchestrators and base sessions when enrichment throws", async () => {
    const core = { id: "session-broken", status: "working", pr: { number: 7 } };
    const dashboard = { id: "session-broken", pr: { state: "open", enriched: false } };
    const orchestrators = [{ id: "mono-orchestrator", projectId: "mono", projectName: "Mono" }];

    hoisted.getAllProjectsMock.mockReturnValue([{ id: "mono", name: "Mono" }]);
    hoisted.getPrimaryProjectIdMock.mockReturnValue("mono");
    hoisted.getProjectNameMock.mockReturnValue("Mono");
    hoisted.getServicesMock.mockResolvedValue({
      config: { projects: { mono: { id: "mono" } } },
      registry: { scm: "registry" },
      sessionManager: { listCached: vi.fn().mockResolvedValue([core]) },
    });
    hoisted.filterProjectSessionsMock.mockReturnValue([core]);
    hoisted.filterWorkerSessionsMock.mockReturnValue([core]);
    hoisted.sessionToDashboardMock.mockReturnValue(dashboard);
    hoisted.listDashboardOrchestratorsMock.mockReturnValue(orchestrators);
    hoisted.resolveProjectMock.mockReturnValue({ id: "mono" });
    hoisted.getSCMMock.mockReturnValue({ provider: "github" });
    hoisted.enrichSessionsMetadataFastMock.mockRejectedValue(new Error("metadata exploded"));
    hoisted.enrichSessionPRMock.mockRejectedValue(new Error("pr exploded"));

    const pageData = await getDashboardPageData("mono");

    expect(pageData.orchestrators).toEqual(orchestrators);
    expect(pageData.sessions).toEqual([dashboard]);
  });

  it("surfaces getServices failure as dashboardLoadError instead of a silent empty list", async () => {
    hoisted.getServicesMock.mockRejectedValue(new Error("No agent-orchestrator.yaml found"));

    const pageData = await getDashboardPageData("all");

    expect(pageData.sessions).toEqual([]);
    expect(pageData.orchestrators).toEqual([]);
    expect(pageData.dashboardLoadError).toBe("No agent-orchestrator.yaml found");
  });

  it("applies attentionZones from config when getServices succeeds but sessionManager.list fails", async () => {
    hoisted.getServicesMock.mockResolvedValue({
      config: {
        projects: { docs: { id: "docs" } },
        dashboard: { attentionZones: "detailed" },
      },
      registry: { scm: "registry" },
      sessionManager: { listCached: vi.fn().mockRejectedValue(new Error("list boom")) },
    });

    const pageData = await getDashboardPageData("docs");

    expect(pageData.attentionZones).toBe("detailed");
    expect(pageData.dashboardLoadError).toBe("list boom");
    expect(pageData.sessions).toEqual([]);
  });

  it("keeps the session list when PR enrichment fails", async () => {
    const core = { id: "session-pr", status: "working", pr: { number: 7 } };
    const dashboardSession = { id: "session-pr", pr: { state: "open", enriched: false } };

    hoisted.getServicesMock.mockResolvedValue({
      config: { projects: { docs: { id: "docs" } } },
      registry: { scm: "registry" },
      sessionManager: { listCached: vi.fn().mockResolvedValue([core]) },
    });
    hoisted.filterProjectSessionsMock.mockReturnValue([core]);
    hoisted.filterWorkerSessionsMock.mockReturnValue([core]);
    hoisted.sessionToDashboardMock.mockReturnValue(dashboardSession);
    hoisted.resolveProjectMock.mockReturnValue({ id: "docs" });
    hoisted.getSCMMock.mockReturnValue({ provider: "github" });
    hoisted.enrichSessionPRMock.mockRejectedValue(new Error("cache read failed"));

    const pageData = await getDashboardPageData("docs");

    expect(pageData.dashboardLoadError).toBeUndefined();
    expect(pageData.sessions).toEqual([dashboardSession]);
    expect(pageData.orchestrators).toEqual([{ id: "orch-1", projectId: "docs", projectName: "Docs" }]);
  });
});
