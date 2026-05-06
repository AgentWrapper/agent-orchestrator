"use client";

import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionDetail } from "../SessionDetail";
import { makePR, makeSession } from "../../__tests__/helpers";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
}));

vi.mock("../DirectTerminal", () => ({
  DirectTerminal: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="direct-terminal">{sessionId}</div>
  ),
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

describe("SessionDetail unified layout (mobile viewport)", () => {
  beforeEach(() => {
    mockMobileViewport();
  });

  it("shows hamburger toggle button in topbar on mobile", () => {
    render(
      <SessionDetail
        session={makeSession({ id: "worker-1", projectId: "my-app" })}
        projects={[{ id: "my-app", name: "My App" }]}
        projectOrchestratorId={null}
      />,
    );

    expect(screen.getByLabelText("Toggle sidebar")).toBeInTheDocument();
  });

  it("shows session ID in topbar header", () => {
    render(
      <SessionDetail
        session={makeSession({ id: "worker-stable-title", projectId: "my-app" })}
        projectOrchestratorId="my-app-orchestrator"
      />,
    );

    // Session id is rendered twice (mobile + desktop copies, media-query toggled);
    // jsdom ignores media queries so both appear. Assert at least one is present.
    expect(screen.getAllByText("worker-stable-title").length).toBeGreaterThan(0);
  });

  it("shows PR info for sessions with a PR", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "worker-2",
          projectId: "my-app",
          summary: "Compact mobile header",
          branch: "feat/compact-header",
          pr: makePR({ number: 77, title: "Compact header polish" }),
        })}
        projectOrchestratorId="my-app-orchestrator"
      />,
    );

    expect(screen.getAllByText("worker-2").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: /PR #77/i }).length).toBeGreaterThan(0);
  });

  it("shows PR info for sessions with enriched PRs", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "worker-3",
          projectId: "my-app",
          pr: makePR({
            number: 88,
            title: "Keep PR detail intact",
            ciStatus: "failing",
            reviewDecision: "changes_requested",
            unresolvedThreads: 2,
          }),
        })}
        projectOrchestratorId="my-app-orchestrator"
      />,
    );

    expect(screen.getAllByRole("link", { name: /PR #88/i }).length).toBeGreaterThan(0);
  });

  it("renders the session detail shell for active sessions", () => {
    render(
      <SessionDetail
        session={makeSession({ id: "worker-terminal", projectId: "my-app", status: "running" })}
        projects={[{ id: "my-app", name: "My App" }]}
        projectOrchestratorId={null}
      />,
    );

    // The terminal section is always rendered; terminal mounts after rAF
    expect(screen.getAllByText("worker-terminal").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Toggle sidebar")).toBeInTheDocument();
  });

  it("shows orchestrator button in topbar when orchestrator exists", () => {
    render(
      <SessionDetail
        session={makeSession({ id: "worker-4", projectId: "my-app" })}
        projectOrchestratorId="my-app-orchestrator"
      />,
    );

    // Scope to the topbar since MobileBottomNav also has an orchestrator link
    expect(within(screen.getByRole("banner")).getByRole("link", { name: "Orchestrator" })).toBeInTheDocument();
  });

  it("does not show orchestrator button when no orchestrator exists", () => {
    render(
      <SessionDetail
        session={makeSession({ id: "worker-5", projectId: "my-app" })}
        projectOrchestratorId={null}
      />,
    );

    expect(within(screen.getByRole("banner")).queryByRole("link", { name: "Orchestrator" })).not.toBeInTheDocument();
  });

  it("shows merged PR link for merged sessions", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "worker-merged",
          projectId: "my-app",
          pr: makePR({ number: 89, state: "merged", title: "Preserve merged badge styling" }),
        })}
        projectOrchestratorId="my-app-orchestrator"
      />,
    );

    expect(screen.getAllByRole("link", { name: /PR #89/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByText("worker-merged").length).toBeGreaterThan(0);
  });
});
