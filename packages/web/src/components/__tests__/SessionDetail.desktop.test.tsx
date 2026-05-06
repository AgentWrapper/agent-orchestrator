import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionDetail } from "../SessionDetail";
import { makePR, makeSession } from "../../__tests__/helpers";

const { routerPushMock, routerReplaceMock, routerRefreshMock } = vi.hoisted(() => ({
  routerPushMock: vi.fn(),
  routerReplaceMock: vi.fn(),
  routerRefreshMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({
    push: routerPushMock,
    replace: routerReplaceMock,
    refresh: routerRefreshMock,
  }),
  usePathname: () => "/sessions/worker-desktop",
}));

vi.mock("../DirectTerminal", () => ({
  DirectTerminal: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="direct-terminal">{sessionId}</div>
  ),
}));

function mockDesktopViewport() {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: () => ({
      matches: false,
      media: "",
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

describe("SessionDetail desktop layout", () => {
  beforeEach(() => {
    mockDesktopViewport();
    routerPushMock.mockReset();
    routerReplaceMock.mockReset();
    routerRefreshMock.mockReset();
    window.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    window.cancelAnimationFrame = vi.fn();
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(""),
      } as Response),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the desktop shell, PR blockers, and unresolved comments", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "worker-desktop",
          projectId: "my-app",
          summary: "Desktop session detail",
          branch: "feat/desktop-detail",
          pr: makePR({
            number: 310,
            title: "Desktop detail coverage",
            branch: "feat/desktop-detail",
            additions: 18,
            deletions: 4,
            ciStatus: "pending",
            ciChecks: [
              { name: "build", status: "failed" },
              { name: "lint", status: "pending" },
              { name: "typecheck", status: "queued" },
            ],
            reviewDecision: "changes_requested",
            mergeability: {
              mergeable: false,
              ciPassing: false,
              approved: false,
              noConflicts: false,
              blockers: [],
            },
            changedFiles: 3,
            isDraft: true,
            unresolvedThreads: 1,
            unresolvedComments: [
              {
                url: "https://github.com/acme/app/pull/310#discussion_r1",
                path: "packages/web/src/components/SessionDetail.tsx",
                author: "bugbot",
                body: "### Tighten the copy\n<!-- DESCRIPTION START -->The empty state text needs to be shorter.<!-- DESCRIPTION END -->",
              },
            ],
          }),
          metadata: {
            status: "changes_requested",
            lastMergeConflictDispatched: "true",
            lastPendingReviewDispatchHash: "review-hash",
          },
        })}
        projectOrchestratorId="my-app-orchestrator"
        projects={[{ id: "my-app", name: "My App", path: "/tmp/my-app" }]}
        sidebarSessions={[makeSession({ id: "sidebar-1" })]}
      />,
    );

    expect(screen.getByRole("button", { name: "Toggle sidebar" })).toBeInTheDocument();
    expect(screen.getAllByText("My App").length).toBeGreaterThanOrEqual(1);
    // Scope to topbar since MobileBottomNav also has an Orchestrator link
    expect(
      within(screen.getByRole("banner")).getByRole("link", { name: "Orchestrator" }),
    ).toHaveAttribute("href", "/projects/my-app/sessions/my-app-orchestrator");
    // Branch pill is rendered as link when session has a PR
    expect(screen.getByRole("link", { name: "feat/desktop-detail" })).toHaveAttribute(
      "href",
      "https://github.com/acme/app/tree/feat/desktop-detail",
    );
    // PR button is anchored to the PR URL (ctrl-click opens on GitHub, plain click toggles popover)
    const prButton = screen.getByRole("link", { name: "PR #310" });
    expect(prButton).toHaveAttribute("href", "https://github.com/acme/app/pull/100");

    // PR details (blockers, file count, unresolved comments) now live inside a
    // popover anchored to the PR button. Click to open it before asserting contents.
    fireEvent.click(prButton);

    expect(screen.getByText("3 files")).toBeInTheDocument();
    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.getByText(/Changes requested/i)).toBeInTheDocument();
    expect(screen.getByText(/Merge conflicts/i)).toBeInTheDocument();
    expect(screen.getByText(/Unresolved Comments/i)).toBeInTheDocument();
    expect(screen.getByText("Tighten the copy")).toBeInTheDocument();
    expect(screen.getByText("The empty state text needs to be shorter.")).toBeInTheDocument();
  });

  it("sends unresolved comments back to the agent and shows sent state", async () => {
    vi.useFakeTimers();

    render(
      <SessionDetail
        session={makeSession({
          id: "worker-fix",
          projectId: "my-app",
          pr: makePR({
            number: 311,
            unresolvedThreads: 1,
            unresolvedComments: [
              {
                url: "https://github.com/acme/app/pull/311#discussion_r2",
                path: "packages/web/src/components/Skeleton.tsx",
                author: "bugbot",
                body: "### Improve empty state\n<!-- DESCRIPTION START -->Use a stronger CTA label.<!-- DESCRIPTION END -->",
              },
            ],
          }),
        })}
      />,
    );

    // Open the PR popover (button is now a link with aria-label "PR #311")
    fireEvent.click(screen.getByRole("link", { name: "PR #311" }));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Ask Agent to Fix" }));
    });

    expect(global.fetch).toHaveBeenCalledWith("/api/sessions/worker-fix/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: expect.stringContaining("Improve empty state"),
    });
    expect(screen.getByRole("button", { name: /Sent/i })).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(screen.getByRole("button", { name: "Ask Agent to Fix" })).toBeInTheDocument();
  });

  it("shows an actionable summary for exited desktop sessions", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "worker-ended",
          projectId: "my-app",
          status: "terminated",
          activity: "exited",
          summary: "Investigated the dashboard loading issue",
          branch: "fix/session-loading",
          pr: null,
        })}
      />,
    );

    expect(screen.getByRole("region", { name: "Session ended summary" })).toBeInTheDocument();
    expect(screen.getByText("Terminal ended")).toBeInTheDocument();
    expect(screen.getByText("Investigated the dashboard loading issue")).toBeInTheDocument();
    expect(
      within(screen.getByLabelText("Session facts")).getByText("worker-ended"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restore terminal" })).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("banner")).getByRole("button", { name: "Restore" }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("banner")).queryByRole("link", { name: "Orchestrator" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to dashboard" })).toHaveAttribute(
      "href",
      "/projects/my-app",
    );
    expect(screen.queryByTestId("direct-terminal")).not.toBeInTheDocument();
  });

  it("shows restore for restorable orchestrator sessions", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "my-app-orchestrator",
          projectId: "my-app",
          status: "terminated",
          activity: "exited",
          summary: "Project orchestrator",
          pr: null,
        })}
        isOrchestrator
        orchestratorZones={{
          merge: 1,
          respond: 0,
          review: 0,
          pending: 0,
          working: 2,
          done: 3,
        }}
        projectOrchestratorId="my-app-orchestrator"
        projects={[{ id: "my-app", name: "My App", path: "/tmp/my-app" }]}
      />,
    );

    expect(within(screen.getByRole("banner")).getByRole("button", { name: "Restore" })).toHaveClass(
      "dashboard-app-btn--restore",
    );
    expect(
      within(screen.getByRole("banner")).queryByRole("button", { name: "Kill" }),
    ).not.toBeInTheDocument();
  });

  it("restores without using router refresh on the client-only session page", async () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "worker-restore",
          projectId: "my-app",
          status: "terminated",
          activity: "exited",
          pr: null,
        })}
        projects={[{ id: "my-app", name: "My App", path: "/tmp/my-app" }]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Restore" }));

    await act(async () => {});

    expect(global.fetch).toHaveBeenCalledWith("/api/sessions/worker-restore/restore", {
      method: "POST",
    });
    expect(routerRefreshMock).not.toHaveBeenCalled();
  });

  it("keeps the desktop orchestrator button on orchestrator session pages", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "my-app-orchestrator",
          summary: "Project orchestrator",
        })}
        isOrchestrator
        orchestratorZones={{
          merge: 1,
          respond: 0,
          review: 0,
          pending: 0,
          working: 2,
          done: 3,
        }}
        projectOrchestratorId="my-app-orchestrator"
        projects={[{ id: "my-app", name: "My App", path: "/tmp/my-app" }]}
      />,
    );

    expect(
      within(screen.getByRole("banner")).getByRole("link", { name: "Orchestrator" }),
    ).toHaveAttribute("href", "/projects/my-app/sessions/my-app-orchestrator");
    expect(screen.getByText("orchestrator")).toBeInTheDocument();
  });

  it("shows the main orchestrator button when an orchestrator target exists", () => {
    const { rerender } = render(
      <SessionDetail
        session={makeSession({ id: "worker-with-orchestrator", projectId: "my-app" })}
        projectOrchestratorId="my-app-orchestrator"
        projects={[{ id: "my-app", name: "My App", path: "/tmp/my-app" }]}
      />,
    );

    expect(
      within(screen.getByRole("banner")).getByRole("link", { name: "Orchestrator" }),
    ).toHaveAttribute("href", "/projects/my-app/sessions/my-app-orchestrator");

    rerender(
      <SessionDetail
        session={makeSession({ id: "worker-without-orchestrator", projectId: "my-app" })}
        projectOrchestratorId={null}
        projects={[{ id: "my-app", name: "My App", path: "/tmp/my-app" }]}
      />,
    );

    expect(
      within(screen.getByRole("banner")).queryByRole("link", { name: "Orchestrator" }),
    ).not.toBeInTheDocument();

    rerender(
      <SessionDetail
        session={makeSession({
          id: "my-app-orchestrator",
          projectId: "my-app",
          summary: "Project orchestrator",
        })}
        isOrchestrator
        orchestratorZones={{
          merge: 1,
          respond: 0,
          review: 0,
          pending: 0,
          working: 2,
          done: 3,
        }}
        projectOrchestratorId="my-app-orchestrator"
        projects={[{ id: "my-app", name: "My App", path: "/tmp/my-app" }]}
      />,
    );

    expect(
      within(screen.getByRole("banner")).getByRole("link", { name: "Orchestrator" }),
    ).toHaveAttribute("href", "/projects/my-app/sessions/my-app-orchestrator");
  });

  it("routes to the project orchestrator after killing a worker session", async () => {
    render(
      <SessionDetail
        session={makeSession({ id: "worker-kill", projectId: "my-app", status: "running" })}
        projectOrchestratorId="my-app-orchestrator"
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Kill" }));
    });

    expect(global.fetch).toHaveBeenCalledWith("/api/sessions/worker-kill/kill", { method: "POST" });
    expect(routerPushMock).toHaveBeenCalledWith("/projects/my-app/sessions/my-app-orchestrator");
  });

  it("routes to the project dashboard after killing a worker with no orchestrator", async () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "worker-kill-dashboard",
          projectId: "my-app",
          status: "running",
        })}
        projectOrchestratorId={null}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Kill" }));
    });

    expect(routerPushMock).toHaveBeenCalledWith("/projects/my-app");
  });
});
