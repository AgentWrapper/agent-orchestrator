import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  getDashboardPageDataMock: vi.fn(),
  getDashboardProjectNameMock: vi.fn(),
  resolveDashboardProjectFilterMock: vi.fn(),
  pullRequestsPagePropsMock: vi.fn(),
}));

vi.mock("@/lib/dashboard-page-data", () => ({
  getDashboardPageData: hoisted.getDashboardPageDataMock,
  getDashboardProjectName: hoisted.getDashboardProjectNameMock,
  resolveDashboardProjectFilter: hoisted.resolveDashboardProjectFilterMock,
}));

vi.mock("@/components/PullRequestsPage", () => ({
  PullRequestsPage: (props: Record<string, unknown>) => {
    hoisted.pullRequestsPagePropsMock(props);
    return <div data-testid="pull-requests-page" />;
  },
}));

import PullRequestsRoute from "./page";

describe("PullRequestsRoute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads all sessions once and keeps the selected project context for client filtering", async () => {
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

    render(await PullRequestsRoute({ searchParams: Promise.resolve({ project: "alpha" }) }));

    expect(hoisted.resolveDashboardProjectFilterMock).toHaveBeenCalledWith("alpha");
    expect(hoisted.getDashboardPageDataMock).toHaveBeenCalledTimes(1);
    expect(hoisted.getDashboardPageDataMock).toHaveBeenCalledWith("all");
    expect(hoisted.getDashboardProjectNameMock).toHaveBeenCalledWith("alpha");
    expect(hoisted.pullRequestsPagePropsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        initialSessions: allProjectData.sessions,
        orchestrators: allProjectData.orchestrators,
        projectId: "alpha",
        projectName: "Alpha",
      }),
    );
  });
});
