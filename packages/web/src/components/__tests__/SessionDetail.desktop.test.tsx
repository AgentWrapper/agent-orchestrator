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

const { directTerminalPropsMock } = vi.hoisted(() => ({
  directTerminalPropsMock: vi.fn(),
}));

vi.mock("../DirectTerminal", () => ({
  DirectTerminal: (props: { sessionId: string; appearance?: "theme" | "dark" }) => {
    directTerminalPropsMock(props);
    return <div data-testid="direct-terminal">{props.sessionId}</div>;
  },
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
    directTerminalPropsMock.mockReset();
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

    // On desktop the topbar has no sidebar toggle — the sidebar carries its own
    // collapse/expand affordance, so the redundant topbar toggle is mobile-only.
    expect(screen.queryByRole("button", { name: "Toggle sidebar" })).not.toBeInTheDocument();
    // Worker topbar leads with the "‹ Kanban" back link to the project board
    // (the project brand now lives in the sidebar, not the topbar).
    expect(within(screen.getByRole("banner")).getByRole("link", { name: "Kanban" })).toHaveAttribute(
      "href",
      "/projects/my-app",
    );
    // Scope to topbar since MobileBottomNav also has an Orchestrator link
    expect(
      within(screen.getByRole("banner")).getByRole("link", { name: "Orchestrator" }),
    ).toHaveAttribute("href", "/projects/my-app/sessions/my-app-orchestrator");
    // Branch pill is rendered as link when session has a PR
    expect(screen.getByRole("link", { name: "feat/desktop-detail" })).toHaveAttribute(
      "href",
      "https://github.com/acme/app/tree/feat/desktop-detail",
    );

    // On desktop, PR details (blockers, file count, unresolved comments) live in
    // the always-visible inspector rail Summary view — no popover to open.
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

    // On desktop the PR card (with its unresolved comments) lives in the
    // always-visible inspector rail — no popover to open first.
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
    // The ended-session body also exposes a prominent "Restore session" button
    // so users don't have to find the small icon in the header.
    expect(
      within(screen.getByRole("region", { name: "Session ended summary" })).getByRole("button", {
        name: "Restore session",
      }),
    ).toBeInTheDocument();
  });

  it("shows the Restore button in the ended-summary for pr_merged sessions (status=cleanup)", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "worker-pr-merged",
          projectId: "my-app",
          status: "cleanup",
          activity: "exited",
          pr: makePR({ number: 1904, state: "merged" }),
        })}
      />,
    );
    expect(
      within(screen.getByRole("region", { name: "Session ended summary" })).getByRole("button", {
        name: "Restore session",
      }),
    ).toBeInTheDocument();
  });

  it("keeps restored working sessions live when terminatedAt is stale", () => {
    const base = makeSession({
      id: "worker-restored-stale-terminal-marker",
      projectId: "my-app",
      status: "terminated",
      activity: "active",
      summary: "Restored worker is live",
      pr: null,
    });
    const staleLifecycle = {
      ...base.lifecycle!,
      sessionState: "working" as const,
      sessionReason: "task_in_progress" as const,
      runtimeState: "alive" as const,
      runtimeReason: "process_running" as const,
      session: {
        ...base.lifecycle!.session,
        state: "working" as const,
        reason: "task_in_progress" as const,
        label: "working",
        reasonLabel: "task in progress",
        terminatedAt: "2026-05-13T19:13:20.146Z",
      },
      runtime: {
        ...base.lifecycle!.runtime,
        state: "alive" as const,
        reason: "process_running" as const,
        label: "alive",
        reasonLabel: "process running",
      },
      legacyStatus: "terminated" as const,
      summary: "Session working (task in progress)",
    };

    render(<SessionDetail session={{ ...base, lifecycle: staleLifecycle }} />);

    expect(screen.queryByRole("region", { name: "Session ended summary" })).not.toBeInTheDocument();
    expect(screen.queryByText("Terminal ended")).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("banner")).queryByRole("button", { name: "Restore" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("direct-terminal")).toHaveTextContent(
      "worker-restored-stale-terminal-marker",
    );
  });

  it("does not open a blank terminal when activity exited but lifecycle still reports alive", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "worker-review-ended",
          projectId: "my-app",
          status: "review_pending",
          activity: "exited",
          summary: "Worker exited after opening a PR",
          pr: null,
          lifecycle: {
            sessionState: "idle",
            sessionReason: "awaiting_external_review",
            prState: "open",
            prReason: "review_pending",
            runtimeState: "alive",
            runtimeReason: "process_running",
            session: {
              state: "idle",
              reason: "awaiting_external_review",
              label: "idle",
              reasonLabel: "awaiting external review",
            },
            pr: {
              state: "open",
              reason: "review_pending",
              label: "open",
              reasonLabel: "review pending",
            },
            runtime: {
              state: "alive",
              reason: "process_running",
              label: "alive",
              reasonLabel: "process running",
            },
            legacyStatus: "review_pending",
            evidence: null,
            detectingAttempts: 0,
            detectingEscalatedAt: null,
            summary: "Waiting for external review",
            guidance: null,
          },
        })}
      />,
    );

    expect(screen.getByRole("region", { name: "Session ended summary" })).toBeInTheDocument();
    expect(screen.getByText("Terminal ended")).toBeInTheDocument();
    expect(screen.queryByTestId("direct-terminal")).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("banner")).getByRole("button", { name: "Restore" }),
    ).toBeInTheDocument();
  });

  it("keeps restore in the ended summary but not the top bar for restorable orchestrators", () => {
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

    expect(
      within(screen.getByRole("banner")).queryByRole("button", { name: "Restore" }),
    ).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Session ended summary" })).getByRole("button", {
        name: "Restore session",
      }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("banner")).getByRole("link", { name: "Open Kanban" }),
    ).toHaveAttribute("href", "/projects/my-app");
    expect(
      within(screen.getByRole("banner")).queryByRole("button", {
        name: /launch orchestrator \(clean context\)/i,
      }),
    ).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("banner")).queryByRole("button", { name: "Kill" }),
    ).not.toBeInTheDocument();
  });

  it("renders a scoped, non-repetitive orchestrator top bar", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "my-app-orchestrator",
          projectId: "my-app",
          status: "working",
          activity: "active",
          branch: "orchestrator/my-app-orchestrator",
          summary: "Project orchestrator",
          displayName: "# My App Orchestrator",
          pr: makePR({ number: 777 }),
        })}
        isOrchestrator
        orchestratorZones={{
          merge: 0,
          respond: 0,
          review: 1,
          pending: 2,
          working: 1,
          done: 4,
        }}
        projectOrchestratorId="my-app-orchestrator"
        projects={[{ id: "my-app", name: "My App", path: "/tmp/my-app" }]}
      />,
    );

    const banner = within(screen.getByRole("banner"));

    expect(banner.getByText("My App")).toBeInTheDocument();
    expect(banner.getByText("Orchestrator")).toBeInTheDocument();
    // Topbar status pill now uses the shared status system; this session's PR
    // (makePR defaults to approved + mergeable) resolves to "Mergeable".
    expect(banner.getByText("Mergeable")).toBeInTheDocument();
    expect(banner.getByText("Fleet")).toBeInTheDocument();
    expect(banner.getByText("review")).toBeInTheDocument();
    expect(banner.getByText("working")).toBeInTheDocument();
    expect(banner.getByText("pending")).toBeInTheDocument();
    expect(banner.getByText("done")).toBeInTheDocument();
    expect(banner.queryByText("my-app-orchestrator")).not.toBeInTheDocument();
    expect(banner.getByRole("link", { name: "Open Kanban" })).toHaveAttribute(
      "href",
      "/projects/my-app",
    );
    expect(banner.queryByText("Agent Orchestrator")).not.toBeInTheDocument();
    expect(banner.queryByText("# My App Orchestrator")).not.toBeInTheDocument();
    expect(banner.queryByText("orchestrator/my-app-orchestrator")).not.toBeInTheDocument();
    expect(banner.queryByRole("link", { name: "PR #777" })).not.toBeInTheDocument();
  });

  it("shows the project name for the Agent Orchestrator project header", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "ao-orchestrator",
          projectId: "agent-orchestrator",
          status: "working",
          activity: "ready",
          summary: "Project orchestrator",
        })}
        isOrchestrator
        orchestratorZones={{ merge: 0, respond: 0, review: 0, pending: 0, working: 1, done: 2 }}
        projectOrchestratorId="ao-orchestrator"
        projects={[
          { id: "agent-orchestrator", name: "Agent Orchestrator", path: "/tmp/agent-orchestrator" },
        ]}
      />,
    );

    const banner = within(screen.getByRole("banner"));

    expect(banner.getByText("Agent Orchestrator")).toBeInTheDocument();
    expect(banner.getByText("Orchestrator")).toHaveClass("session-detail-mode-badge--neutral");
    expect(banner.getByRole("link", { name: "Open Kanban" })).toHaveAttribute(
      "href",
      "/projects/agent-orchestrator",
    );
  });

  it("does not render Relaunch (clean) on worker sessions", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "worker-1",
          projectId: "my-app",
          status: "working",
        })}
        projects={[{ id: "my-app", name: "My App", path: "/tmp/my-app" }]}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /launch orchestrator \(clean context\)/i }),
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

  it("hides the desktop orchestrator button on orchestrator session pages", () => {
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
      within(screen.getByRole("banner")).queryByRole("link", { name: "Orchestrator" }),
    ).not.toBeInTheDocument();
    expect(within(screen.getByRole("banner")).getByText("Orchestrator")).toBeInTheDocument();
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
      within(screen.getByRole("banner")).queryByRole("link", { name: "Orchestrator" }),
    ).not.toBeInTheDocument();
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

  it("uses theme-aware terminal appearance on session detail", () => {
    render(
      <SessionDetail
        session={makeSession({
          id: "worker-themed-terminal",
          projectId: "my-app",
          metadata: {
            tmuxName: "my-app-worker-themed-terminal",
          },
        })}
        projectOrchestratorId="my-app-orchestrator"
        projects={[{ id: "my-app", name: "My App", path: "/tmp/my-app" }]}
      />,
    );

    expect(directTerminalPropsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "worker-themed-terminal",
        appearance: "theme",
      }),
    );
  });
});
