import { act, render } from "@testing-library/react";
import { memo, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const renderCounts = new Map<string, number>();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/components/SessionCard", () => ({
  SessionCard: memo(({ session }: { session: { id: string } }) => {
    renderCounts.set(session.id, (renderCounts.get(session.id) ?? 0) + 1);
    return <div data-testid={`session-card-${session.id}`}>{session.id}</div>;
  }),
}));

import type { SessionPatch } from "@/lib/mux-protocol";

// Module-level sessions updated by tests, read by the mock on every render.
let currentMuxSessions: SessionPatch[] = [];

vi.mock("@/providers/MuxProvider", () => ({
  useMuxOptional: () => ({
    subscribeTerminal: () => () => {},
    writeTerminal: () => {},
    openTerminal: () => {},
    closeTerminal: () => {},
    resizeTerminal: () => {},
    status: "connected" as const,
    sessions: currentMuxSessions,
  }),
  MuxProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { Dashboard } from "../Dashboard";
import { makeSession } from "../../__tests__/helpers";

// Wrapper that exposes a forceUpdate so tests can trigger re-renders after
// updating currentMuxSessions, causing Dashboard to re-call useMuxOptional().
let forceUpdate: () => void = () => {};

function ControlledDashboard({
  initialSessions,
}: {
  initialSessions: ReturnType<typeof makeSession>[];
}) {
  const [, tick] = useState(0);
  forceUpdate = () => tick((n) => n + 1);
  return <Dashboard initialSessions={initialSessions} />;
}

describe("Dashboard render cadence", () => {
  beforeEach(() => {
    renderCounts.clear();
    currentMuxSessions = [];
    global.fetch = vi.fn();
  });

  it("rerenders only the changed session card for same-membership snapshots", async () => {
    const ts = new Date().toISOString();
    const initialSessions = [
      makeSession({ id: "session-1", status: "working", activity: "active", lastActivityAt: ts }),
      makeSession({ id: "session-2", status: "working", activity: "active", lastActivityAt: ts }),
    ];

    render(<ControlledDashboard initialSessions={initialSessions} />);

    expect(renderCounts.get("session-1")).toBe(1);
    expect(renderCounts.get("session-2")).toBe(1);

    // Push a snapshot where only session-1 changes
    await act(async () => {
      currentMuxSessions = [
        {
          id: "session-1",
          status: "working",
          activity: "idle",
          attentionLevel: "working",
          lastActivityAt: new Date(Date.now() + 1000).toISOString(),
        },
        {
          id: "session-2",
          status: "working",
          activity: "active",
          attentionLevel: "working",
          lastActivityAt: ts,
        },
      ];
      forceUpdate();
    });

    expect(renderCounts.get("session-1")).toBe(2);
    expect(renderCounts.get("session-2")).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not rerender any card when snapshot data is identical", async () => {
    const ts = new Date().toISOString();
    const initialSessions = [
      makeSession({ id: "session-1", status: "working", activity: "active", lastActivityAt: ts }),
    ];

    render(<ControlledDashboard initialSessions={initialSessions} />);
    const countAfterInit = renderCounts.get("session-1") ?? 0;

    await act(async () => {
      currentMuxSessions = [
        {
          id: "session-1",
          status: "working",
          activity: "active",
          attentionLevel: "working",
          lastActivityAt: ts,
        },
      ];
      forceUpdate();
    });

    expect(renderCounts.get("session-1")).toBe(countAfterInit);
  });
});
