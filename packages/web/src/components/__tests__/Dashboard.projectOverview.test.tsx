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
    // The Dashboard mounts UpdateBanner, which fetches /api/version on its
    // own. Default that to a no-op response (404) so the banner stays hidden
    // and doesn't consume `mockImplementationOnce` queued by individual tests
    // for /api/orchestrators or /api/spawn.
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/version")) {
        return { ok: false, status: 404, json: async () => ({}) } as Response;
      }
      return { ok: false, status: 500, json: async () => ({}) } as Response;
    });
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

  it("renders a Relaunch (clean) action in the header when an orchestrator exists", () => {
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

    expect(
      screen.getByRole("button", { name: /launch orchestrator \(clean context\)/i }),
    ).toBeInTheDocument();
  });

  it("Relaunch (clean) POSTs with clean:true after confirmation", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    let relaunchBody: string | null = null;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/orchestrators" && init?.method === "POST") {
        relaunchBody = init.body as string;
        return {
          ok: true,
          json: async () => ({
            orchestrator: {
              id: "my-app-orchestrator",
              projectId: "my-app",
              projectName: "My App",
            },
          }),
        } as Response;
      }
      return { ok: false, status: 500, json: async () => ({}) } as Response;
    });

    render(
      <Dashboard
        initialSessions={[makeSession({ projectId: "my-app" })]}
        projectId="my-app"
        projectName="My App"
        projects={[{ id: "my-app", name: "My App" }]}
        orchestrators={[{ id: "my-app-orchestrator", projectId: "my-app", projectName: "My App" }]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /launch orchestrator \(clean context\)/i }));

    expect(confirmSpy).toHaveBeenCalledWith(
      expect.stringContaining("discard the current orchestrator"),
    );
    await waitFor(() => {
      expect(relaunchBody).not.toBeNull();
      expect(JSON.parse(relaunchBody!)).toEqual({ projectId: "my-app", clean: true });
    });

    confirmSpy.mockRestore();
  });

  it("Relaunch (clean) is skipped when the user cancels the confirm prompt", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const fetchMock = vi.fn();
    global.fetch = fetchMock;

    render(
      <Dashboard
        initialSessions={[makeSession({ projectId: "my-app" })]}
        projectId="my-app"
        projectName="My App"
        projects={[{ id: "my-app", name: "My App" }]}
        orchestrators={[{ id: "my-app-orchestrator", projectId: "my-app", projectName: "My App" }]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /launch orchestrator \(clean context\)/i }));

    expect(confirmSpy).toHaveBeenCalled();
    // No POST to /api/orchestrators after cancel.
    const orchestratorPosts = fetchMock.mock.calls.filter(
      ([url, init]) =>
        typeof url === "string" &&
        url === "/api/orchestrators" &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    expect(orchestratorPosts).toHaveLength(0);

    confirmSpy.mockRestore();
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
    // Route by URL: UpdateBanner's /api/version stays on the default 404
    // (banner stays hidden); only /api/orchestrators is held until we resolve.
    let resolveSpawn: ((value: Response) => void) | null = null;
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/orchestrators")) {
        return new Promise<Response>((resolve) => {
          resolveSpawn = resolve;
        });
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        json: async () => ({}),
      } as Response);
    });

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
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/orchestrators")) {
        return Promise.resolve({
          ok: false,
          json: async () => ({ error: "Project is paused" }),
        } as Response);
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        json: async () => ({}),
      } as Response);
    });

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
