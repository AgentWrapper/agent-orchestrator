import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Dashboard } from "@/components/Dashboard";
import { makeSession } from "@/__tests__/helpers";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

describe("Dashboard project overview cards", () => {
  beforeEach(() => {
    global.EventSource = vi.fn(
      () =>
        ({
          onmessage: null,
          onerror: null,
          close: vi.fn(),
        }) as unknown as EventSource,
    );
    global.fetch = vi.fn();
  });

  it("renders Spawn Orchestrator only for projects without one", () => {
    render(
      <Dashboard
        initialSessions={[makeSession({ projectId: "my-app" })]}
        projects={[
          { id: "my-app", name: "My App" },
          { id: "docs-app", name: "Docs App" },
        ]}
        orchestrators={[{ id: "my-app-orchestrator", projectId: "my-app", projectName: "My App" }]}
      />,
    );

    expect(screen.getAllByText("My App").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Docs App").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "orchestrator" })).toHaveAttribute(
      "href",
      "/projects/my-app/sessions/my-app-orchestrator",
    );
    expect(screen.getByRole("button", { name: "Spawn Orchestrator" })).toBeInTheDocument();
    expect(screen.getAllByText("No running orchestrator")).toHaveLength(1);
  });

  it("remains stable when orchestrators prop is omitted", () => {
    render(
      <Dashboard
        initialSessions={[makeSession({ projectId: "my-app" })]}
        projects={[
          { id: "my-app", name: "My App" },
          { id: "docs-app", name: "Docs App" },
        ]}
      />,
    );

    expect(screen.getAllByRole("button", { name: "Spawn Orchestrator" })).toHaveLength(2);
  });

  it("omits the desktop PRs link for project-scoped dashboards in the current layout", () => {
    render(
      <Dashboard
        initialSessions={[makeSession({ projectId: "my-app" })]}
        projectId="my-app"
        projectName="My App"
      />,
    );

    expect(screen.queryByRole("link", { name: "PRs" })).not.toBeInTheDocument();
  });

  it("renders the project-scoped orchestrator button in the header", () => {
    render(
      <Dashboard
        initialSessions={[makeSession({ projectId: "my-app" })]}
        projectId="my-app"
        projectName="My App"
        projects={[
          { id: "my-app", name: "My App" },
          { id: "docs-app", name: "Docs App" },
        ]}
        orchestrators={[{ id: "my-app-orchestrator", projectId: "my-app", projectName: "My App" }]}
      />,
    );

    expect(screen.getByRole("link", { name: "Orchestrator" })).toHaveAttribute(
      "href",
      "/projects/my-app/sessions/my-app-orchestrator",
    );
  });

  it("renders a header spawn action when the project has no orchestrator yet", () => {
    render(
      <Dashboard
        initialSessions={[makeSession({ projectId: "my-app" })]}
        projectId="my-app"
        projectName="My App"
        projects={[
          { id: "my-app", name: "My App" },
          { id: "docs-app", name: "Docs App" },
        ]}
        orchestrators={[]}
      />,
    );

    expect(screen.getByRole("button", { name: "Spawn Orchestrator" })).toBeInTheDocument();
  });

  it("omits the desktop PRs link for all-projects dashboards", () => {
    render(
      <Dashboard
        initialSessions={[makeSession({ projectId: "my-app" })]}
        projects={[
          { id: "my-app", name: "My App" },
          { id: "docs-app", name: "Docs App" },
        ]}
      />,
    );

    expect(screen.queryByRole("link", { name: "PRs" })).not.toBeInTheDocument();
  });

  it("updates the card after spawning an orchestrator", async () => {
    let resolveSpawn: ((value: Response) => void) | null = null;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveSpawn = resolve;
        }),
    );

    render(
      <Dashboard
        initialSessions={[makeSession({ projectId: "my-app" })]}
        projects={[
          { id: "my-app", name: "My App" },
          { id: "docs-app", name: "Docs App" },
        ]}
        orchestrators={[]}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Spawn Orchestrator" })[1]);

    expect(screen.getByRole("button", { name: "Spawning..." })).toBeDisabled();

    resolveSpawn?.({
      ok: true,
      json: async () => ({
        orchestrator: {
          id: "docs-orchestrator",
          projectId: "docs-app",
          projectName: "Docs App",
        },
      }),
    } as Response);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/api/orchestrators", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "docs-app" }),
      });
    });

    await waitFor(() => {
      const links = screen.getAllByRole("link", { name: "orchestrator" });
      expect(links).toHaveLength(1);
      expect(links[0]).toHaveAttribute("href", "/projects/docs-app/sessions/docs-orchestrator");
    });

    expect(screen.queryByText("Spawning...")).not.toBeInTheDocument();
    expect(screen.getAllByText("No running orchestrator")).toHaveLength(1);
  });

  it("shows the API error when spawning fails", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Project is paused" }),
    } as Response);

    render(
      <Dashboard
        initialSessions={[makeSession({ projectId: "my-app" })]}
        projects={[
          { id: "my-app", name: "My App" },
          { id: "docs-app", name: "Docs App" },
        ]}
        orchestrators={[]}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Spawn Orchestrator" })[1]);

    await waitFor(() => {
      expect(screen.getByText("Project is paused")).toBeInTheDocument();
    });
    expect(screen.getAllByRole("button", { name: "Spawn Orchestrator" })).toHaveLength(2);
  });

  it("renders degraded projects with a placeholder instead of a spawn action", () => {
    render(
      <Dashboard
        initialSessions={[makeSession({ projectId: "my-app" })]}
        projects={[
          { id: "my-app", name: "My App" },
          { id: "broken-app", name: "broken-app", resolveError: "bad config" },
        ]}
        orchestrators={[]}
      />,
    );

    expect(screen.getAllByText("Config needs repair").length).toBeGreaterThan(0);
    expect(screen.getByText("Project config could not be resolved")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Repair project" })).toHaveAttribute(
      "href",
      "/projects/broken-app",
    );
    expect(screen.getAllByRole("button", { name: "Spawn Orchestrator" })).toHaveLength(1);
  });
});
