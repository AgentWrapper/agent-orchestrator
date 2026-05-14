import { act, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AttentionLevel, DashboardSession } from "@/lib/types";
import type { SessionPatch } from "@/lib/mux-protocol";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/components/AttentionZone", () => ({
  AttentionZone: ({ level, sessions }: { level: AttentionLevel; sessions: DashboardSession[] }) => (
    <section data-testid={`zone-${level}`}>
      {sessions.map((session) => (
        <span key={session.id}>{session.id}</span>
      ))}
    </section>
  ),
}));

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

let forceUpdate: () => void = () => {};

function ControlledDashboard({ initialSessions }: { initialSessions: DashboardSession[] }) {
  const [, tick] = useState(0);
  forceUpdate = () => tick((n) => n + 1);
  return <Dashboard initialSessions={initialSessions} attentionZones="simple" />;
}

describe("Dashboard live attention grouping", () => {
  beforeEach(() => {
    currentMuxSessions = [];
    forceUpdate = () => {};
    global.fetch = vi.fn(
      () =>
        new Promise<Response>(() => {
          // Keep refresh pending so this test observes the immediate mux regroup.
        }),
    );
  });

  it("uses mux attentionLevel to move a card when session fields are otherwise unchanged", async () => {
    const lastActivityAt = new Date().toISOString();
    const initialSessions = [
      makeSession({
        id: "session-1",
        status: "stuck",
        activity: "active",
        lastActivityAt,
      }),
    ];

    render(<ControlledDashboard initialSessions={initialSessions} />);

    expect(within(screen.getByTestId("zone-action")).getByText("session-1")).toBeInTheDocument();

    await act(async () => {
      currentMuxSessions = [
        {
          id: "session-1",
          status: "stuck",
          activity: "active",
          attentionLevel: "merge",
          lastActivityAt,
        },
      ];
      forceUpdate();
    });

    expect(within(screen.getByTestId("zone-merge")).getByText("session-1")).toBeInTheDocument();
  });
});
