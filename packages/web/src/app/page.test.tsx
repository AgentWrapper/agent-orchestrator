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
    hoisted.resolveDashboardProjectFilterMock.mockReturnValue("alpha");
    hoisted.getDashboardProjectNameMock.mockReturnValue("Alpha");
    const allProjectData = {
      sessions: [{ id: "alpha-1" }, { id: "beta-1" }],
      orchestrators: [
        { id: "orch-alpha", projectId: "alpha" },
        { id: "orch-beta", projectId: "beta" },
      ],
      projects: [
        { id: "alpha", name: "Alpha" },
        { id: "beta", name: "Beta" },
      ],
      projectName: "All Projects",
      selectedProjectId: undefined,
      attentionZones: "simple",
    };
    hoisted.getDashboardPageDataMock.mockResolvedValue(allProjectData);

    render(await Home({ searchParams: Promise.resolve({ project: "alpha" }) }));

    expect(hoisted.resolveDashboardProjectFilterMock).toHaveBeenCalledWith("alpha");
    expect(hoisted.getDashboardPageDataMock).toHaveBeenCalledTimes(1);
    expect(hoisted.getDashboardPageDataMock).toHaveBeenCalledWith("all");
    expect(hoisted.getDashboardProjectNameMock).toHaveBeenCalledWith("alpha");
    expect(hoisted.dashboardPropsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        initialSessions: allProjectData.sessions,
        orchestrators: allProjectData.orchestrators,
        projectId: "alpha",
        projectName: "Alpha",
      }),
    );
  });
});
