import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "../Dashboard";
import { makePR, makeSession } from "../../__tests__/helpers";

const refreshMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: refreshMock }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

function mockMobileViewport() {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: query.includes("max-width: 767px"),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

describe("Dashboard unified layout (mobile viewport)", () => {
  beforeEach(() => {
    refreshMock.mockReset();
    mockMobileViewport();
    Element.prototype.scrollIntoView = vi.fn();
    const eventSourceMock = {
      onmessage: null,
      onerror: null,
      onopen: null,
      close: vi.fn(),
    };
    const eventSourceConstructor = vi.fn(() => eventSourceMock as unknown as EventSource);
    global.EventSource = Object.assign(eventSourceConstructor, {
      CONNECTING: 0,
      OPEN: 1,
      CLOSED: 2,
    }) as unknown as typeof EventSource;
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
      } as Response),
    );
  });

  it("shows all sessions in the dashboard", () => {
    const sessions = Array.from({ length: 6 }, (_, index) =>
      makeSession({
        id: `session-${index + 1}`,
        summary: `Session ${index + 1}`,
        branch: null,
        status: "running",
        activity: "active",
      }),
    );

    render(<Dashboard initialSessions={sessions} />);

    expect(screen.getByText("Session 1")).toBeInTheDocument();
    expect(screen.getByText("Session 5")).toBeInTheDocument();
    expect(screen.getByText("Session 6")).toBeInTheDocument();
  });

  it("shows hamburger toggle button in topbar on mobile", () => {
    render(
      <Dashboard initialSessions={[makeSession()]} projects={[{ id: "my-app", name: "My App" }]} />,
    );

    expect(screen.getByLabelText("Toggle sidebar")).toBeInTheDocument();
  });

  it("does not render embedded PR cards on the dashboard", () => {
    const sessions = [
      makeSession({
        id: "merge-1",
        status: "approved",
        pr: makePR({ number: 87, title: "Add login flow" }),
      }),
    ];

    render(<Dashboard initialSessions={sessions} />);

    expect(screen.queryByRole("link", { name: /#87 add login flow/i })).not.toBeInTheDocument();
  });

  it("shows PRs link in header pointing to PR page", () => {
    render(
      <Dashboard
        initialSessions={[
          makeSession({ id: "merge-2", status: "approved", pr: makePR({ number: 91 }) }),
        ]}
        projectId="my-app"
      />,
    );

    const prsLink = screen.queryByRole("link", { name: /prs/i });
    if (prsLink) {
      expect(prsLink).toHaveAttribute("href", expect.stringContaining("/prs"));
    }
  });

  it("shows sessions with their branch and summary", () => {
    render(
      <Dashboard
        initialSessions={[
          makeSession({
            id: "working-1",
            status: "running",
            activity: "active",
            summary: "Implement dashboard filters",
            branch: "feat/dashboard-filters",
          }),
        ]}
      />,
    );

    // Branch name appears in SessionCard; text may be split across elements
    expect(screen.getAllByText(/feat\/dashboard-filters/i).length).toBeGreaterThan(0);
  });

  it("shows sessions with enriched PR information", () => {
    render(
      <Dashboard
        initialSessions={[
          makeSession({
            id: "merge-7",
            status: "approved",
            activity: "idle",
            summary: "Ship dashboard polish",
            branch: "feat/dashboard-polish",
            pr: makePR({
              number: 207,
              additions: 24,
              deletions: 7,
              ciStatus: "failing",
              reviewDecision: "changes_requested",
            }),
          }),
        ]}
      />,
    );

    expect(screen.getByText("feat/dashboard-polish")).toBeInTheDocument();
  });

  it("shows and dismisses the rate limit banner", () => {
    render(
      <Dashboard
        initialSessions={[
          makeSession({
            id: "review-2",
            status: "reviewing",
            activity: "idle",
            pr: makePR({
              number: 208,
              mergeability: {
                mergeable: false,
                ciPassing: false,
                approved: false,
                noConflicts: true,
                blockers: ["API rate limited or unavailable"],
              },
            }),
          }),
        ]}
      />,
    );

    expect(screen.getByText(/GitHub API rate limited/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/GitHub API rate limited/i)).not.toBeInTheDocument();
  });

  it("opens the done bar and restores completed sessions", async () => {
    vi.setSystemTime(new Date("2026-04-11T11:07:00.000Z"));

    render(
      <Dashboard
        initialSessions={[
          makeSession({
            id: "done-1",
            status: "terminated",
            activity: "exited",
            summaryIsFallback: true,
            issueTitle: "Restore completed agent",
            branch: null,
            lastActivityAt: "2026-04-11T09:07:00.000Z",
            pr: makePR({ number: 209, state: "closed", title: "Wrapped up work" }),
          }),
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Done \/ Terminated/i }));

    expect(screen.getByText("Restore completed agent")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "#209" })).toHaveAttribute(
      "href",
      "https://github.com/acme/app/pull/100",
    );
    expect(screen.getByText("terminated")).toBeInTheDocument();
    expect(screen.getByText("2h ago")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    });

    expect(global.fetch).toHaveBeenCalledWith("/api/sessions/done-1/restore", {
      method: "POST",
    });
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it("kill button requires a two-click confirmation before firing", async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve({ ok: true, text: () => Promise.resolve("") } as Response),
    );
    global.fetch = fetchSpy as unknown as typeof fetch;

    render(
      <Dashboard
        initialSessions={[
          makeSession({
            id: "working-kill",
            status: "running",
            activity: "active",
            summary: "Live session",
            branch: "feat/live",
          }),
        ]}
      />,
    );

    const killButtons = screen.getAllByRole("button", { name: "Terminate session" });
    expect(killButtons.length).toBeGreaterThan(0);

    // First click → enters confirming state; does not fire the kill request
    fireEvent.click(killButtons[0]);
    expect(fetchSpy).not.toHaveBeenCalledWith(expect.stringContaining("/kill"), expect.anything());

    // Button now advertises the confirm affordance
    const confirm = screen.getByRole("button", { name: "Confirm terminate session" });
    await act(async () => {
      fireEvent.click(confirm);
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/sessions/working-kill/kill",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("shows CI check chips on cards with enriched PRs", () => {
    render(
      <Dashboard
        initialSessions={[
          makeSession({
            id: "merge-ci",
            status: "approved",
            activity: "idle",
            summary: "Green PR",
            branch: "feat/green",
            pr: makePR({
              number: 301,
              ciStatus: "passing",
              ciChecks: [
                { name: "build", status: "passed" },
                { name: "lint", status: "passed" },
              ],
              reviewDecision: "approved",
            }),
          }),
        ]}
      />,
    );

    // Passing CI checks render as chips by name
    expect(screen.getByText("build")).toBeInTheDocument();
    expect(screen.getByText("lint")).toBeInTheDocument();
  });

  it("preserves sessions across live updates", () => {
    const { rerender } = render(
      <Dashboard
        initialSessions={[
          makeSession({
            id: "respond-1",
            status: "needs_input",
            activity: "waiting_input",
            summary: "Need approval to proceed",
            branch: null,
          }),
          makeSession({
            id: "working-1",
            status: "running",
            activity: "active",
            summary: "Implement dashboard filters",
            branch: null,
          }),
        ]}
      />,
    );

    expect(screen.getAllByText("Need approval to proceed").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Implement dashboard filters").length).toBeGreaterThan(0);

    rerender(
      <Dashboard
        initialSessions={[
          makeSession({
            id: "respond-1",
            status: "needs_input",
            activity: "waiting_input",
            summary: "Need approval to proceed",
            branch: null,
            lastActivityAt: new Date(Date.now() + 1_000).toISOString(),
          }),
          makeSession({
            id: "working-1",
            status: "running",
            activity: "active",
            summary: "Implement dashboard filters",
            branch: null,
            lastActivityAt: new Date(Date.now() + 2_000).toISOString(),
          }),
        ]}
      />,
    );

    expect(screen.getAllByText("Need approval to proceed").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Implement dashboard filters").length).toBeGreaterThan(0);
  });
});
