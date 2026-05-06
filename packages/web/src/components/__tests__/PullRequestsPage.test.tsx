import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PullRequestsPage } from "../PullRequestsPage";
import { makePR, makeSession } from "../../__tests__/helpers";

const mockedUseSearchParams = vi.fn(() => new URLSearchParams());

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockedUseSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/prs",
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

function mockDesktopViewport() {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
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

describe("PullRequestsPage", () => {
  beforeEach(() => {
    mockMobileViewport();
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
  });

  it("renders PR cards and keeps the PR tab active on mobile", () => {
    render(
      <PullRequestsPage
        initialSessions={[
          makeSession({
            id: "merge-1",
            projectId: "my-app",
            status: "approved",
            pr: makePR({ number: 634, title: "Mobile dashboard density pass" }),
          }),
        ]}
        projectId="my-app"
        projectName="My App"
        orchestrators={[{ id: "my-app-orchestrator", projectId: "my-app", projectName: "My App" }]}
      />,
    );

    expect(screen.getByRole("link", { name: /#634 mobile dashboard density pass/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "PRs" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute("href", "/projects/my-app");
    expect(screen.getByRole("link", { name: "Orchestrator" })).toHaveAttribute(
      "href",
      "/projects/my-app/sessions/my-app-orchestrator",
    );
  });

  it("preserves the all-projects scope in mobile bottom nav links", () => {
    render(
      <PullRequestsPage
        initialSessions={[
          makeSession({
            id: "merge-1",
            projectId: "my-app",
            status: "approved",
            pr: makePR({ number: 634, title: "Mobile dashboard density pass" }),
          }),
        ]}
        projectName="All Projects"
        projects={[
          { id: "my-app", name: "My App", path: "/tmp/my-app" },
          { id: "docs", name: "Docs", path: "/tmp/docs" },
        ]}
      />,
    );

    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute("href", "/?project=all");
    expect(screen.getByRole("link", { name: "PRs" })).toHaveAttribute("href", "/prs?project=all");
  });

  it("renders merged and closed desktop sections when the default all filter is active", () => {
    mockDesktopViewport();

    render(
      <PullRequestsPage
        initialSessions={[
          makeSession({
            id: "merged-1",
            projectId: "my-app",
            status: "merged",
            pr: makePR({ number: 101, title: "Merged PR", state: "merged" }),
          }),
          makeSession({
            id: "closed-1",
            projectId: "my-app",
            status: "killed",
            pr: makePR({ number: 102, title: "Closed PR", state: "closed" }),
          }),
        ]}
        projectId="my-app"
        projectName="My App"
      />,
    );

    expect(screen.getAllByText("Merged")).toHaveLength(2);
    expect(screen.getAllByText("Closed")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "#101" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "#102" })).toBeInTheDocument();
    expect(screen.getByText("Merged PR")).toBeInTheDocument();
    expect(screen.getByText("Closed PR")).toBeInTheDocument();
  });

  it("shows the empty desktop state when there are no pull requests", () => {
    mockDesktopViewport();

    render(<PullRequestsPage initialSessions={[]} projectId="my-app" projectName="My App" />);

    expect(screen.getByText("No pull requests yet.")).toBeInTheDocument();
  });
});
