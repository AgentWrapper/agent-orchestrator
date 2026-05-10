import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  getDashboardPageDataMock: vi.fn(),
  getDashboardProjectNameMock: vi.fn(),
  resolveDashboardProjectFilterMock: vi.fn(),
  dashboardPropsMock: vi.fn(),
}));

vi.mock("@/lib/dashboard-page-data", () => ({
  getDashboardPageData: hoisted.getDashboardPageDataMock,
  getDashboardProjectName: hoisted.getDashboardProjectNameMock,
  resolveDashboardProjectFilter: hoisted.resolveDashboardProjectFilterMock,
}));

vi.mock("@/components/Dashboard", () => ({
  Dashboard: (props: Record<string, unknown>) => {
    hoisted.dashboardPropsMock(props);
    return <div data-testid="dashboard" />;
  },
}));

import Home from "./page";

describe("Home dashboard route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the selected project context but seeds Dashboard with all-project sidebar data", async () => {
    hoisted.resolveDashboardProjectFilterMock.mockReturnValue("nebula");
    const selectedProjectData = {
      sessions: [{ id: "neb-1" }],
      orchestrators: [{ id: "orch-neb", projectId: "nebula" }],
      projectName: "Nebula",
      projects: [
        { id: "nebula", name: "Nebula" },
        { id: "other", name: "Other" },
      ],
      selectedProjectId: "nebula",
      attentionZones: "simple",
    };
    const allProjectData = {
      ...selectedProjectData,
      sessions: [{ id: "neb-1" }, { id: "other-1" }],
      orchestrators: [
        { id: "orch-neb", projectId: "nebula" },
        { id: "orch-other", projectId: "other" },
      ],
      projectName: "All Projects",
      selectedProjectId: undefined,
    };
    hoisted.getDashboardPageDataMock.mockImplementation(async (project?: string) =>
      project === "all" ? allProjectData : selectedProjectData,
    );

    render(await Home({ searchParams: Promise.resolve({ project: "nebula" }) }));

    expect(hoisted.resolveDashboardProjectFilterMock).toHaveBeenCalledWith("nebula");
    expect(hoisted.getDashboardPageDataMock).toHaveBeenCalledWith("nebula");
    expect(hoisted.getDashboardPageDataMock).toHaveBeenCalledWith("all");
    expect(hoisted.dashboardPropsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        initialSessions: allProjectData.sessions,
        orchestrators: allProjectData.orchestrators,
        projectId: "nebula",
        projectName: "Nebula",
      }),
    );
  });
});
