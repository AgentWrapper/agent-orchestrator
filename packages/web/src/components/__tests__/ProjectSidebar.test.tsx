import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProjectSidebar } from "@/components/ProjectSidebar";
import { makePR, makeSession } from "@/__tests__/helpers";

const mockPush = vi.fn();
const mockRefresh = vi.fn();
let mockPathname = "/";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, refresh: mockRefresh }),
  usePathname: () => mockPathname,
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({
    resolvedTheme: "light",
    setTheme: vi.fn(),
  }),
}));

describe("ProjectSidebar", () => {
  const projects = [
    { id: "project-1", name: "Project One", sessionPrefix: "project-1" },
    { id: "project-2", name: "Project Two", sessionPrefix: "project-2" },
  ];

  beforeEach(() => {
    mockPush.mockReset();
    mockRefresh.mockReset();
    mockPathname = "/";
    vi.unstubAllGlobals();
  });

  it("renders the empty-state header with the + button when no projects are configured", () => {
    render(
      <ProjectSidebar
        projects={[]}
        sessions={[]}
        activeProjectId={undefined}
        activeSessionId={undefined}
      />,
    );

    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /new project/i })).toBeInTheDocument();
    expect(screen.getByText(/no projects yet/i)).toBeInTheDocument();
  });

  it("opens AddProjectModal from the empty-state + button", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ entries: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ProjectSidebar
        projects={[]}
        sessions={[]}
        activeProjectId={undefined}
        activeSessionId={undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /new project/i }));

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: /add project/i })).toBeInTheDocument();
    });
  });

  it("renders the theme toggle in the empty-state footer", () => {
    render(
      <ProjectSidebar
        projects={[]}
        sessions={[]}
        activeProjectId={undefined}
        activeSessionId={undefined}
      />,
    );

    expect(
      screen.getByRole("button", { name: /switch to (dark|light) mode/i }),
    ).toBeInTheDocument();
  });

  it("renders a collapsed empty rail when collapsed with no projects", () => {
    const { container } = render(
      <ProjectSidebar
        projects={[]}
        sessions={[]}
        activeProjectId={undefined}
        activeSessionId={undefined}
        collapsed
      />,
    );

    expect(container.querySelector(".project-sidebar--collapsed")).not.toBeNull();
    // Header label, empty-state copy, and footer are hidden in the collapsed rail
    expect(screen.queryByText("Projects")).not.toBeInTheDocument();
    expect(screen.queryByText(/no projects yet/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /switch to (dark|light) mode/i }),
    ).not.toBeInTheDocument();
    // The + button is still reachable so users can add a project from the rail
    expect(screen.getByRole("button", { name: /new project/i })).toBeInTheDocument();
  });

  it("renders the compact sidebar header and project rows", () => {
    render(
      <ProjectSidebar
        projects={projects}
        sessions={[]}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );

    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Project One 0$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Project Two 0$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /new project/i })).toBeInTheDocument();
  });

  it("marks the active project row as the current page", () => {
    render(
      <ProjectSidebar
        projects={projects}
        sessions={[]}
        activeProjectId="project-2"
        activeSessionId={undefined}
      />,
    );

    expect(screen.getByRole("button", { name: /^Project Two 0$/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("button", { name: /^Project One 0$/ })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("links to the project dashboard via the per-row dashboard button", () => {
    render(
      <ProjectSidebar
        projects={projects}
        sessions={[]}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );

    // Per-row "Dashboard" anchor (separate from the expand/collapse toggle)
    const dashboardLink = screen.getByRole("link", { name: /Open Project Two dashboard/ });
    expect(dashboardLink).toHaveAttribute("href", "/projects/project-2");
  });

  it("project toggle expands/collapses without navigating", () => {
    render(
      <ProjectSidebar
        projects={projects}
        sessions={[]}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );

    const toggle = screen.getByRole("button", { name: /^Project Two 0$/ });
    fireEvent.click(toggle);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("renders degraded projects distinctly and navigates them to the project page", () => {
    render(
      <ProjectSidebar
        projects={[
          ...projects,
          { id: "broken-project", name: "Broken Project", resolveError: "Bad config" },
        ]}
        sessions={[]}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );

    expect(screen.getByText("degraded")).toBeInTheDocument();
    expect(screen.getByText("Config needs repair")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: /Broken Project/ }));

    expect(mockPush).toHaveBeenCalledWith("/projects/broken-project");
  });

  it("navigates to the add-project flow from the plus button", () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ entries: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ProjectSidebar
        projects={projects}
        sessions={[]}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /new project/i }));

    return waitFor(() => {
      expect(screen.getByRole("dialog", { name: /add project/i })).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledWith("/api/filesystem/browse?path=~");
      expect(mockPush).not.toHaveBeenCalled();
    });
  });

  it("opens a project actions menu with a settings link", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        project: {
          id: "project-2",
          name: "Project Two",
          path: "/tmp/project-2",
          repo: "org/project-2",
          defaultBranch: "main",
          agent: "claude-code",
          runtime: "tmux",
          tracker: { plugin: "github" },
          scm: { plugin: "github" },
          reactions: {},
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ProjectSidebar
        projects={projects}
        sessions={[]}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Project actions for Project Two/i }));

    expect(await screen.findByRole("menuitem", { name: "Remove project" })).toBeInTheDocument();

    fireEvent.click(await screen.findByRole("menuitem", { name: "Project settings" }));

    expect(await screen.findByRole("dialog", { name: "Project settings" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/project-2");
  });

  it("removes a project from the project actions menu", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );

    render(
      <ProjectSidebar
        projects={projects}
        sessions={[]}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Project actions for Project Two/i }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove project" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/projects/project-2", { method: "DELETE" });
      expect(mockRefresh).toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: /^Project Two 0$/ })).not.toBeInTheDocument();
    });
  });

  it("shows non-done worker sessions for the expanded active project", () => {
    render(
      <ProjectSidebar
        projects={projects}
        sessions={[
          makeSession({
            id: "worker-1",
            projectId: "project-1",
            summary: "Review API changes",
            branch: null,
            status: "needs_input",
            activity: "waiting_input",
          }),
          makeSession({
            id: "worker-2",
            projectId: "project-1",
            summary: "Already done",
            status: "merged",
            activity: "exited",
          }),
        ]}
        activeProjectId="project-1"
        activeSessionId="worker-1"
      />,
    );

    // Session rows are now anchors (support ctrl/cmd-click to open in new tab)
    expect(screen.getByRole("link", { name: "Open Review API changes" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open feat/test" })).not.toBeInTheDocument();
  });

  it("keeps killed sessions visible when they still need attention", () => {
    const lastActivityAt = new Date().toISOString();

    render(
      <ProjectSidebar
        projects={projects}
        sessions={[
          makeSession({
            id: "worker-ended",
            projectId: "project-1",
            summary: "Runtime missing but needs review",
            branch: null,
            status: "killed",
            activity: "exited",
            lastActivityAt,
            pr: makePR({
              title: "Runtime missing but needs review",
              ciStatus: "failing",
              mergeability: {
                mergeable: false,
                ciPassing: false,
                approved: true,
                noConflicts: true,
                blockers: ["CI failing"],
              },
            }),
            lifecycle: {
              sessionState: "detecting",
              sessionReason: "probe_failure",
              prState: "open",
              prReason: "ci_failing",
              runtimeState: "missing",
              runtimeReason: "process_missing",
              session: {
                state: "detecting",
                reason: "probe_failure",
                label: "Detecting",
                reasonLabel: "Probe failure",
                startedAt: lastActivityAt,
                completedAt: null,
                terminatedAt: null,
                lastTransitionAt: lastActivityAt,
              },
              pr: {
                state: "open",
                reason: "ci_failing",
                label: "Open",
                reasonLabel: "CI failing",
                number: 100,
                url: "https://github.com/acme/app/pull/100",
                lastObservedAt: lastActivityAt,
              },
              runtime: {
                state: "missing",
                reason: "process_missing",
                label: "Missing",
                reasonLabel: "Process missing",
                lastObservedAt: lastActivityAt,
              },
              legacyStatus: "killed",
              evidence: null,
              detectingAttempts: 1,
              detectingEscalatedAt: null,
              summary: "Session detecting, PR open, runtime missing",
              guidance: null,
            },
          }),
          makeSession({
            id: "worker-done",
            projectId: "project-1",
            summary: "Actually finished",
            status: "merged",
            activity: "exited",
            pr: makePR({ state: "merged" }),
          }),
        ]}
        activeProjectId="project-1"
        activeSessionId="worker-ended"
      />,
    );

    expect(screen.getByRole("button", { name: /^Project One 1$/ })).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open Runtime missing but needs review" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open Actually finished" })).not.toBeInTheDocument();
  });

  it("navigates session rows to the selected session detail route", () => {
    mockPathname = "/sessions/ao-143";

    render(
      <ProjectSidebar
        projects={projects}
        sessions={[
          makeSession({
            id: "worker-1",
            projectId: "project-1",
            summary: "Review API changes",
            branch: null,
            status: "needs_input",
            activity: "waiting_input",
          }),
          makeSession({
            id: "worker-2",
            projectId: "project-1",
            summary: "Implement sidebar polish",
            branch: null,
            status: "working",
            activity: "active",
          }),
        ]}
        activeProjectId="project-1"
        activeSessionId="worker-1"
      />,
    );

    fireEvent.click(screen.getByRole("link", { name: "Open Implement sidebar polish" }));

    expect(mockPush).toHaveBeenCalledWith("/projects/project-1/sessions/worker-2");
  });

  it("filters out orchestrator sessions from the project tree", () => {
    render(
      <ProjectSidebar
        projects={projects}
        sessions={[
          makeSession({
            id: "project-1-orchestrator-0",
            projectId: "project-1",
            summary: "Orchestrator",
            metadata: { role: "orchestrator" },
          }),
          makeSession({
            id: "worker-1",
            projectId: "project-1",
            summary: "Implement sidebar polish",
          }),
        ]}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );

    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.queryByText("Orchestrator")).not.toBeInTheDocument();
  });

  it("shows 'Open orchestrator' in the project actions menu when the orchestrators prop has an entry", async () => {
    render(
      <ProjectSidebar
        projects={projects}
        sessions={[]}
        orchestrators={[{ id: "project-2-orchestrator-1", projectId: "project-2" }]}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Project actions for Project Two/i }));

    expect(await screen.findByRole("menuitem", { name: "Open orchestrator" })).toBeInTheDocument();
  });

  it("omits 'Open orchestrator' from the menu when no orchestrator entry exists for the project", async () => {
    render(
      <ProjectSidebar
        projects={projects}
        sessions={[]}
        orchestrators={[{ id: "project-1-orchestrator", projectId: "project-1" }]}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Project actions for Project Two/i }));

    expect(await screen.findByRole("menuitem", { name: "Project settings" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Open orchestrator" })).not.toBeInTheDocument();
  });

  it("navigates to the orchestrator id from the prop when 'Open orchestrator' is clicked", async () => {
    render(
      <ProjectSidebar
        projects={projects}
        sessions={[]}
        orchestrators={[{ id: "project-2-orchestrator-1", projectId: "project-2" }]}
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Project actions for Project Two/i }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open orchestrator" }));

    expect(mockPush).toHaveBeenCalledWith("/projects/project-2/sessions/project-2-orchestrator-1");
    await waitFor(() => {
      expect(screen.queryByRole("menuitem", { name: "Open orchestrator" })).not.toBeInTheDocument();
    });
  });

  it("renders the collapsed rail when collapsed", () => {
    const { container } = render(
      <ProjectSidebar
        projects={projects}
        sessions={[]}
        activeProjectId="project-1"
        activeSessionId={undefined}
        collapsed
      />,
    );

    expect(container.querySelector(".project-sidebar--collapsed")).not.toBeNull();
    expect(screen.queryByText("Projects")).not.toBeInTheDocument();
  });

  it("shows loading skeletons instead of the empty state while sessions are loading", () => {
    render(
      <ProjectSidebar
        projects={projects}
        sessions={null}
        loading
        activeProjectId="project-1"
        activeSessionId={undefined}
      />,
    );

    expect(screen.getByLabelText("Loading sessions")).toBeInTheDocument();
    expect(screen.queryByText("No sessions shown")).not.toBeInTheDocument();
  });

  // ── Rename worker sessions ───────────────────────────────────────────

  describe("session rename", () => {
    function renderWithSession(displayName: string | null = null) {
      // When a displayName is supplied, treat it as a user-set rename so the
      // sidebar renders it as the row label (auto-derived names are gated).
      return render(
        <ProjectSidebar
          projects={projects}
          sessions={[
            makeSession({
              id: "worker-1",
              projectId: "project-1",
              summary: "Review API changes",
              displayName,
              displayNameUserSet: displayName !== null,
              branch: null,
              status: "needs_input",
              activity: "waiting_input",
            }),
          ]}
          activeProjectId="project-1"
          activeSessionId="worker-1"
        />,
      );
    }

    it("renders a pencil button for each worker session row", () => {
      renderWithSession();
      expect(screen.getByRole("button", { name: /rename worker-1/i })).toBeInTheDocument();
    });

    it("opens an inline input prefilled with the displayed title on pencil click", () => {
      renderWithSession();
      fireEvent.click(screen.getByRole("button", { name: /rename worker-1/i }));
      const input = screen.getByRole("textbox", { name: /rename worker-1/i }) as HTMLInputElement;
      expect(input.value).toBe("Review API changes");
    });

    it("PATCHes the new name and shows it immediately on Enter", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: "worker-1", displayName: "PR 1466 review" }),
      });
      vi.stubGlobal("fetch", fetchMock);
      renderWithSession();

      fireEvent.click(screen.getByRole("button", { name: /rename worker-1/i }));
      const input = screen.getByRole("textbox", { name: /rename worker-1/i });
      fireEvent.change(input, { target: { value: "PR 1466 review" } });
      fireEvent.keyDown(input, { key: "Enter" });

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/sessions/worker-1",
          expect.objectContaining({
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ displayName: "PR 1466 review" }),
          }),
        );
      });

      // Optimistic update: the new name appears without waiting for SSE.
      expect(screen.getByRole("link", { name: "Open PR 1466 review" })).toBeInTheDocument();
    });

    it("sends null to clear when the input is empty (revert to default)", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: "worker-1", displayName: null }),
      });
      vi.stubGlobal("fetch", fetchMock);
      renderWithSession("Existing rename");

      fireEvent.click(screen.getByRole("button", { name: /rename worker-1/i }));
      const input = screen.getByRole("textbox", { name: /rename worker-1/i });
      fireEvent.change(input, { target: { value: "   " } });
      fireEvent.keyDown(input, { key: "Enter" });

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/sessions/worker-1",
          expect.objectContaining({
            body: JSON.stringify({ displayName: null }),
          }),
        );
      });
    });

    it("cancels on Escape without firing PATCH", () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      renderWithSession("Existing rename");

      fireEvent.click(screen.getByRole("button", { name: /rename worker-1/i }));
      const input = screen.getByRole("textbox", { name: /rename worker-1/i });
      fireEvent.change(input, { target: { value: "Half-typed change" } });
      fireEvent.keyDown(input, { key: "Escape" });

      expect(fetchMock).not.toHaveBeenCalled();
      // Input is gone; original name is back.
      expect(screen.queryByRole("textbox", { name: /rename worker-1/i })).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Open Existing rename" })).toBeInTheDocument();
    });

    it("does not fire a duplicate PATCH if Enter and onBlur both trigger", async () => {
      // Some browsers fire blur during input unmount after the Enter handler
      // already cleared editing state. The submitRename guard should swallow
      // the second call.
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: "worker-1", displayName: "Renamed" }),
      });
      vi.stubGlobal("fetch", fetchMock);
      renderWithSession();

      fireEvent.click(screen.getByRole("button", { name: /rename worker-1/i }));
      const input = screen.getByRole("textbox", { name: /rename worker-1/i });
      fireEvent.change(input, { target: { value: "Renamed" } });
      fireEvent.keyDown(input, { key: "Enter" });
      // Simulate the post-unmount blur cascade.
      fireEvent.blur(input);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
    });

    it("does not shadow PR title with auto-derived displayName (displayNameUserSet=false)", () => {
      // Regression: an auto-derived displayName captured at spawn time must not
      // beat a live PR title in the sidebar. Mirrors the gate in getSessionTitle.
      render(
        <ProjectSidebar
          projects={projects}
          sessions={[
            makeSession({
              id: "worker-1",
              projectId: "project-1",
              displayName: "Stale spawn-time label",
              displayNameUserSet: false,
              branch: null,
              pr: makePR({ title: "feat: live PR title" }),
            }),
          ]}
          activeProjectId="project-1"
          activeSessionId="worker-1"
        />,
      );
      expect(screen.getByRole("link", { name: "Open feat: live PR title" })).toBeInTheDocument();
      expect(screen.queryByText("Stale spawn-time label")).not.toBeInTheDocument();
    });

    it("rolls back the optimistic name when the PATCH fails", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ error: "Failed to rename session" }),
      });
      vi.stubGlobal("fetch", fetchMock);
      renderWithSession("Original");

      fireEvent.click(screen.getByRole("button", { name: /rename worker-1/i }));
      const input = screen.getByRole("textbox", { name: /rename worker-1/i });
      fireEvent.change(input, { target: { value: "Optimistic name" } });
      fireEvent.keyDown(input, { key: "Enter" });

      // Settles back to the prop value once the failed PATCH resolves.
      await waitFor(() => {
        expect(screen.getByRole("link", { name: "Open Original" })).toBeInTheDocument();
      });
    });
  });
});
