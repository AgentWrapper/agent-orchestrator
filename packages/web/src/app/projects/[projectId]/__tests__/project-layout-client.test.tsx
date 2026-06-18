import { render, screen, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

let mockPathname = "/projects/proj-1";
let mockParams: Record<string, string> = { projectId: "proj-1" };

vi.mock("next/navigation", () => ({
  useParams: () => mockParams,
  usePathname: () => mockPathname,
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light", setTheme: vi.fn() }),
}));

vi.mock("@/providers/MuxProvider", () => ({
  useMuxOptional: () => ({ status: "connecting", sessions: [], lastError: null }),
}));

vi.mock("@/hooks/useSessionEvents", () => ({
  useSessionEvents: ({ initialSessions }: { initialSessions: unknown[] }) => ({
    sessions: initialSessions,
    liveSessionsResolved: true,
    attentionLevels: {},
    loadError: null,
  }),
}));

vi.mock("@/components/ProjectSidebar", () => ({
  ProjectSidebar: (props: { activeProjectId?: string; orchestrators?: unknown[] }) => (
    <div
      data-testid="sidebar"
      data-project={props.activeProjectId}
      data-orchestrators={JSON.stringify(props.orchestrators ?? [])}
    />
  ),
}));

import { ProjectLayoutClient } from "../project-layout-client";

const projects = [{ id: "proj-1", name: "Project One", sessionPrefix: "proj-1" }];
const orchestrators = [{ id: "proj-1-orchestrator", projectId: "proj-1" }];

beforeEach(() => {
  mockPathname = "/projects/proj-1";
  mockParams = { projectId: "proj-1" };
});

describe("ProjectLayoutClient", () => {
  it("renders children and sidebar", () => {
    render(
      <ProjectLayoutClient
        initialSessions={[]}
        initialProjects={projects}
        initialOrchestrators={[]}
      >
        <div data-testid="page-content">Page</div>
      </ProjectLayoutClient>,
    );

    expect(screen.getByTestId("sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("page-content")).toBeInTheDocument();
  });

  it("passes activeProjectId from route params to sidebar", () => {
    mockParams = { projectId: "proj-1" };

    render(
      <ProjectLayoutClient
        initialSessions={[]}
        initialProjects={projects}
        initialOrchestrators={[]}
      >
        <div />
      </ProjectLayoutClient>,
    );

    expect(screen.getByTestId("sidebar").dataset.project).toBe("proj-1");
  });

  it("passes initialOrchestrators directly to sidebar", () => {
    render(
      <ProjectLayoutClient
        initialSessions={[]}
        initialProjects={projects}
        initialOrchestrators={orchestrators}
      >
        <div />
      </ProjectLayoutClient>,
    );

    const sidebar = screen.getByTestId("sidebar");
    expect(JSON.parse(sidebar.dataset.orchestrators ?? "[]")).toEqual(orchestrators);
  });

  it("resets mobile sidebar when pathname changes", async () => {
    const { rerender } = render(
      <ProjectLayoutClient
        initialSessions={[]}
        initialProjects={projects}
        initialOrchestrators={[]}
      >
        <div />
      </ProjectLayoutClient>,
    );

    // Simulate pathname change
    mockPathname = "/projects/proj-1/sessions/sess-1";

    await act(async () => {
      rerender(
        <ProjectLayoutClient
          initialSessions={[]}
          initialProjects={projects}
          initialOrchestrators={[]}
        >
          <div />
        </ProjectLayoutClient>,
      );
    });

    // Sidebar wrapper should not have the mobile-open class
    const wrapper = document.querySelector(".sidebar-wrapper");
    expect(wrapper?.classList.contains("sidebar-wrapper--mobile-open")).toBe(false);
  });
});
