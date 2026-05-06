import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Dashboard } from "@/components/Dashboard";
import { makePR, makeSession } from "@/__tests__/helpers";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

describe("Dashboard kanban layout", () => {
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

  it("uses four board columns in simple attention mode", () => {
    render(
      <Dashboard
        initialSessions={[
          makeSession({
            id: "respond-1",
            status: "waiting_input",
            activity: "waiting_input",
            summary: "Needs a reply",
          }),
        ]}
      />,
    );

    const board = document.querySelector(".kanban-board");
    expect(board).toHaveAttribute("data-columns", "4");
    expect(board).toHaveStyle({ "--kanban-column-count": "4" });
    expect(screen.getByText("Action")).toBeInTheDocument();
    expect(screen.queryByText("Respond")).not.toBeInTheDocument();
  });

  it("uses five board columns in detailed attention mode", () => {
    render(
      <Dashboard
        initialSessions={[
          makeSession({
            id: "review-1",
            status: "reviewing",
            pr: makePR({
              number: 42,
              reviewDecision: "changes_requested",
            }),
          }),
        ]}
        attentionZones="detailed"
      />,
    );

    const board = document.querySelector(".kanban-board");
    expect(board).toHaveAttribute("data-columns", "5");
    expect(board).toHaveStyle({ "--kanban-column-count": "5" });
    expect(screen.getByText("Respond")).toBeInTheDocument();
  });
});
