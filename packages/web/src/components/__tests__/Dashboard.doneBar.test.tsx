import { render, screen, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "../Dashboard";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

beforeEach(() => {
  const eventSourceMock = {
    onmessage: null,
    onerror: null,
    close: vi.fn(),
  };
  const eventSourceConstructor = vi.fn(() => eventSourceMock as unknown as EventSource);
  global.EventSource = Object.assign(eventSourceConstructor, {
    CONNECTING: 0,
    OPEN: 1,
    CLOSED: 2,
  }) as unknown as typeof EventSource;
  global.fetch = vi.fn();
});

const DONE_SESSION = {
  id: "done-1",
  projectId: "proj",
  status: "merged" as const,
  activity: "exited" as const,
  branch: "feat/done",
  issueId: null,
  issueUrl: null,
  issueLabel: null,
  issueTitle: null,
  summary: "Finished task",
  summaryIsFallback: false,
  createdAt: new Date().toISOString(),
  lastActivityAt: new Date().toISOString(),
  pr: null,
  metadata: {},
};

describe("Dashboard done bar", () => {
  it("shows the done bar when done sessions exist", () => {
    render(<Dashboard initialSessions={[DONE_SESSION]} />);
    expect(screen.getByText("Done / Terminated")).toBeInTheDocument();
  });

  it("expands to show session cards when clicked", () => {
    const { container } = render(<Dashboard initialSessions={[DONE_SESSION]} />);
    const toggle = screen.getByText("Done / Terminated").closest("button")!;
    expect(container.querySelector(".done-bar__cards")).toBeNull();
    fireEvent.click(toggle);
    expect(container.querySelector(".done-bar__cards")).toBeInTheDocument();
  });

  it("does not show empty state when only done sessions exist", () => {
    render(<Dashboard initialSessions={[DONE_SESSION]} />);
    expect(screen.queryByText(/No active sessions/i)).not.toBeInTheDocument();
  });

  it("renders a restore action for merged sessions", () => {
    render(<Dashboard initialSessions={[DONE_SESSION]} />);
    const toggle = screen.getByText("Done / Terminated").closest("button")!;
    fireEvent.click(toggle);
    expect(screen.queryByRole("button", { name: /restore/i })).toBeInTheDocument();
  });
});
