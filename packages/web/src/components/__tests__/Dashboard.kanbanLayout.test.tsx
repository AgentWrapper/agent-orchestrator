import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
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
    const titles = Array.from(document.querySelectorAll(".kanban-column__title")).map(
      (el) => el.textContent,
    );
    expect(titles).toEqual(["Pending", "Needs you", "In review", "Ready to merge"]);
  });

  it("splits the pending column into working and idle sessions", () => {
    render(
      <Dashboard
        initialSessions={[
          makeSession({
            id: "working-1",
            activity: "active",
            issueLabel: "ACTIVE-1",
          }),
          makeSession({
            id: "idle-1",
            activity: "idle",
            issueLabel: "IDLE-1",
          }),
        ]}
      />,
    );

    const pendingColumn = document.querySelector('.kanban-column[data-level="working"]');
    expect(pendingColumn).toBeTruthy();
    const pendingScope = within(pendingColumn as HTMLElement);

    expect(pendingScope.getByText("Pending")).toBeInTheDocument();
    const workingSection = pendingColumn?.querySelector('[aria-label="Working sessions"]');
    const idleSection = pendingColumn?.querySelector('[aria-label="Idle sessions"]');
    expect(workingSection).toBeTruthy();
    expect(idleSection).toBeTruthy();
    expect(within(workingSection as HTMLElement).getByText("working-1")).toBeInTheDocument();
    expect(within(idleSection as HTMLElement).getByText("idle-1")).toBeInTheDocument();
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
    expect(screen.getByText("Needs you")).toBeInTheDocument();
  });
});
