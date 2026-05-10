import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  getProjectRouteDataMock: vi.fn(),
  getDashboardPageDataMock: vi.fn(),
  dashboardPropsMock: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    ...props
  }: React.PropsWithChildren<React.AnchorHTMLAttributes<HTMLAnchorElement>>) => (
    <a {...props}>{children}</a>
  ),
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("@/lib/project-route-data", () => ({
  getProjectRouteData: hoisted.getProjectRouteDataMock,
}));

vi.mock("@/lib/dashboard-page-data", () => ({
  getDashboardPageData: hoisted.getDashboardPageDataMock,
}));

vi.mock("@/components/Dashboard", () => ({
  Dashboard: (props: Record<string, unknown>) => {
    hoisted.dashboardPropsMock(props);
    return <div data-testid="dashboard" />;
  },
}));

import ProjectPage from "./page";

describe("ProjectPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders degraded project state when the project is degraded", async () => {
    hoisted.getProjectRouteDataMock.mockResolvedValue({
      projectId: "broken",
      project: null,
      projects: [{ id: "broken", name: "Broken" }],
      degradedProject: {
        projectId: "broken",
        path: "/tmp/broken",
        resolveError: "Local config failed validation",
      },
    });

    render(await ProjectPage({ params: Promise.resolve({ projectId: "broken" }) }));

    expect(screen.getByText("This project's config failed to load")).toBeInTheDocument();
    expect(screen.getByText("Local config failed validation")).toBeInTheDocument();
    expect(screen.queryByTestId("dashboard")).not.toBeInTheDocument();
  });

  it("passes all-project sessions to the dashboard while keeping the selected project context", async () => {
    hoisted.getProjectRouteDataMock.mockResolvedValue({
      projectId: "alpha",
      project: { id: "alpha", name: "Alpha" },
      projects: [
        { id: "alpha", name: "Alpha" },
        { id: "beta", name: "Beta" },
      ],
      degradedProject: null,
    });
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

    render(await ProjectPage({ params: Promise.resolve({ projectId: "alpha" }) }));

    expect(hoisted.getDashboardPageDataMock).toHaveBeenCalledTimes(1);
    expect(hoisted.getDashboardPageDataMock).toHaveBeenCalledWith("all");
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
