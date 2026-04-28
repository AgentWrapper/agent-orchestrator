import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

let currentMuxLastError: string | null = null;

vi.mock("@/providers/MuxProvider", () => ({
  useMuxOptional: () => ({
    subscribeTerminal: () => () => {},
    writeTerminal: () => {},
    openTerminal: () => {},
    closeTerminal: () => {},
    resizeTerminal: () => {},
    // "connecting" so muxSessions stays undefined — prevents snapshot dispatch from
    // immediately flipping liveSessionsResolved and masking the SSR load error.
    status: "connecting" as const,
    sessions: [],
    lastError: currentMuxLastError,
  }),
  MuxProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { Dashboard } from "../Dashboard";

beforeEach(() => {
  global.fetch = vi.fn();
  currentMuxLastError = null;
});

describe("Dashboard empty state", () => {
  it("shows empty state when there are no sessions (single-project view)", () => {
    render(<Dashboard initialSessions={[]} />);
    expect(screen.getByText(/Ready to orchestrate/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Open the main orchestrator to start a session and fan out parallel agents across your codebase/i),
    ).toBeInTheDocument();
  });

  it("shows spawn orchestrator actions for a fresh project with no orchestrator", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        orchestrator: {
          id: "hello-orchestrator",
          projectId: "hello-world",
          projectName: "Hello World",
        },
      }),
    } as Response);

    render(
      <Dashboard
        initialSessions={[]}
        projectId="hello-world"
        projectName="Hello World"
        projects={[{ id: "hello-world", name: "Hello World" }]}
        orchestrators={[]}
      />,
    );

    expect(screen.getAllByRole("button", { name: "Spawn Orchestrator" })).toHaveLength(2);

    fireEvent.click(screen.getAllByRole("button", { name: "Spawn Orchestrator" })[0]);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/api/orchestrators", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "hello-world" }),
      });
    });
  });

  it("does not show empty state when sessions exist", () => {
    const { queryByText } = render(
      <Dashboard
        initialSessions={[
          {
            id: "s1",
            projectId: "proj",
            status: "working",
            activity: "active",
            branch: "feat/x",
            issueId: null,
            issueUrl: null,
            issueLabel: null,
            issueTitle: null,
            summary: "Working on it",
            summaryIsFallback: false,
            createdAt: new Date().toISOString(),
            lastActivityAt: new Date().toISOString(),
            pr: null,
            metadata: {},
          },
        ]}
      />,
    );
    expect(queryByText(/Ready to orchestrate/i)).not.toBeInTheDocument();
  });

  it("shows load error banner instead of empty state when SSR services failed", () => {
    render(
      <Dashboard
        initialSessions={[]}
        dashboardLoadError="No agent-orchestrator.yaml found"
      />,
    );
    expect(screen.queryByText(/Ready to orchestrate/i)).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Orchestrator failed to load");
    expect(screen.getByRole("alert")).toHaveTextContent("No agent-orchestrator.yaml found");
  });

  it("shows live load-error banner when WS transport reports a fetch failure", async () => {
    let forceUpdate: () => void = () => {};
    function Wrapper() {
      const [, tick] = useState(0);
      forceUpdate = () => tick((n) => n + 1);
      return <Dashboard initialSessions={[]} />;
    }

    render(<Wrapper />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await act(async () => {
      currentMuxLastError = "Session fetch failed: HTTP 503";
      forceUpdate();
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Orchestrator failed to load");
    expect(screen.getByRole("alert")).toHaveTextContent("Session fetch failed: HTTP 503");
  });

  it("clears live load-error banner when the next WS snapshot succeeds", async () => {
    let forceUpdate: () => void = () => {};
    function Wrapper() {
      const [, tick] = useState(0);
      forceUpdate = () => tick((n) => n + 1);
      return <Dashboard initialSessions={[]} />;
    }

    render(<Wrapper />);

    await act(async () => {
      currentMuxLastError = "Session fetch failed: HTTP 503";
      forceUpdate();
    });

    expect(screen.getByRole("alert")).toBeInTheDocument();

    await act(async () => {
      currentMuxLastError = null;
      forceUpdate();
    });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows empty state when only done sessions exist", () => {
    render(
      <Dashboard
        initialSessions={[
          {
            id: "s-done",
            projectId: "proj",
            status: "killed",
            activity: "exited",
            branch: "feat/done",
            issueId: null,
            issueUrl: null,
            issueLabel: null,
            issueTitle: null,
            summary: "Finished",
            summaryIsFallback: false,
            createdAt: new Date().toISOString(),
            lastActivityAt: new Date().toISOString(),
            pr: null,
            metadata: {},
          },
        ]}
      />,
    );

    expect(screen.getByText(/Ready to orchestrate/i)).toBeInTheDocument();
    expect(screen.getByText("Done / Terminated")).toBeInTheDocument();
  });
});
