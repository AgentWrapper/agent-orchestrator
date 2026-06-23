import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useSessionEvents } from "../useSessionEvents";
import type { DashboardSession } from "@/lib/types";

const now = new Date().toISOString();

function makeSession(overrides: Partial<DashboardSession>): DashboardSession {
  return {
    id: "s1",
    projectId: "proj",
    status: "working",
    activity: "active",
    lastActivityAt: now,
    ...overrides,
  } as unknown as DashboardSession;
}

describe("useSessionEvents - terminated propagation (#8)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ sessions: [] }),
      } as unknown as Response),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllTimers();
  });

  it("reflects a killed status delivered via a mux patch (terminated reaches the stream)", async () => {
    const initialSessions = [makeSession({ id: "s1", status: "working", activity: "active" })];
    const muxSessions = [
      {
        id: "s1",
        status: "killed",
        activity: "exited" as const,
        attentionLevel: "done" as const,
        lastActivityAt: now,
      },
    ];

    const { result } = renderHook(() =>
      useSessionEvents({
        initialSessions,
        project: "proj",
        muxSessions,
        attentionZones: "simple",
      }),
    );

    await waitFor(() => {
      expect(result.current.sessions[0]?.status).toBe("killed");
    });
    expect(result.current.sessions[0]?.activity).toBe("exited");
  });

  it("reflects a terminated status delivered via a mux patch", async () => {
    const initialSessions = [makeSession({ id: "s1", status: "detecting", activity: "idle" })];
    const muxSessions = [
      {
        id: "s1",
        status: "terminated",
        activity: "exited" as const,
        attentionLevel: "done" as const,
        lastActivityAt: now,
      },
    ];

    const { result } = renderHook(() =>
      useSessionEvents({
        initialSessions,
        project: "proj",
        muxSessions,
        attentionZones: "simple",
      }),
    );

    await waitFor(() => {
      expect(result.current.sessions[0]?.status).toBe("terminated");
    });
  });
});
