import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  getProjectRouteDataMock: vi.fn(),
  getDashboardPageDataMock: vi.fn(),
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
  Dashboard: () => <div data-testid="dashboard" />,
}));

import ProjectPage from "./page";

describe("ProjectPage", () => {
  it("renders the dashboard inside a bounded flex item owned by the project shell", async () => {
    hoisted.getProjectRouteDataMock.mockResolvedValue({
      projectId: "project-1",
      project: { id: "project-1" },
      projects: [{ id: "project-1", name: "Project 1" }],
      degradedProject: null,
    });
    hoisted.getDashboardPageDataMock.mockResolvedValue({
      sessions: [],
      selectedProjectId: "project-1",
      projectName: "Project 1",
      projects: [{ id: "project-1", name: "Project 1" }],
      orchestrators: [],
      attentionZones: "simple",
    });

    render(await ProjectPage({ params: Promise.resolve({ projectId: "project-1" }) }));

    expect(screen.getByTestId("dashboard").parentElement).toHaveClass(
      "flex",
      "min-h-0",
      "min-w-0",
      "flex-1",
    );
    expect(screen.getByTestId("dashboard").parentElement).not.toHaveClass("min-h-screen");
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
    expect(screen.getByRole("link", { name: "Back to dashboard" })).toHaveAttribute("href", "/");
    expect(screen.queryByRole("link", { name: "Edit settings" })).not.toBeInTheDocument();
  });
});
