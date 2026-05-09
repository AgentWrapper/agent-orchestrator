import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useSessionEvents } from "../useSessionEvents";
import type { DashboardSession } from "@/lib/types";

const now = new Date().toISOString();
const s1 = { id: "s1", projectId: "proj", lastActivityAt: now } as unknown as DashboardSession;

describe("useSessionEvents - mux", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ sessions: [s1] }),
      } as unknown as Response),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("triggers refresh when mux patch contains unknown id", async () => {
    const initialSessions = [s1];
    const muxSessions = [
      {
        id: "s1",
        status: "working",
        activity: "active",
        attentionLevel: "working" as const,
        lastActivityAt: now,
      },
      {
        id: "s2",
        status: "working",
        activity: "active",
        attentionLevel: "working" as const,
        lastActivityAt: now,
      },
    ];
    renderHook(() =>
      useSessionEvents({
        initialSessions,
        project: "proj",
        muxSessions,
        attentionZones: "simple",
      }),
    );
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/sessions?project=proj",
        expect.objectContaining({ signal: expect.any(AbortSignal), cache: "no-store" }),
      );
    });
  });

  it("ignores in-flight refreshes from an old project scope", async () => {
    vi.useFakeTimers();
    const sOther = {
      id: "other-1",
      projectId: "other",
      lastActivityAt: now,
    } as unknown as DashboardSession;
    const staleSession = {
      id: "stale-old-project",
      projectId: "proj",
      lastActivityAt: now,
    } as unknown as DashboardSession;
    let resolveOldRefresh: (response: Response) => void = () => {};
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveOldRefresh = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    let project = "proj";
    let initialSessions = [s1];
    let muxSessions: Parameters<typeof useSessionEvents>[0]["muxSessions"] = [
      {
        id: "s1",
        status: "working",
        activity: "active",
        attentionLevel: "working" as const,
        lastActivityAt: now,
      },
      {
        id: "s2",
        status: "working",
        activity: "active",
        attentionLevel: "working" as const,
        lastActivityAt: now,
      },
    ];

    const { result, rerender } = renderHook(() =>
      useSessionEvents({
        initialSessions,
        project,
        muxSessions,
        attentionZones: "simple",
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions?project=proj",
      expect.objectContaining({ signal: expect.any(AbortSignal), cache: "no-store" }),
    );

    project = "other";
    initialSessions = [sOther];
    muxSessions = undefined;
    await act(async () => {
      rerender();
    });
    expect(result.current.sessions.map((session) => session.id)).toEqual(["other-1"]);

    await act(async () => {
      resolveOldRefresh({
        ok: true,
        json: async () => ({ sessions: [staleSession] }),
      } as Response);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.sessions.map((session) => session.id)).toEqual(["other-1"]);
  });

  it("does not warn when an in-flight refresh is aborted on unmount", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("The operation was aborted.", "AbortError")),
              { once: true },
            );
          }),
      ),
    );

    const initialSessions = [s1];
    const muxSessions = [
      {
        id: "s1",
        status: "working",
        activity: "active",
        attentionLevel: "working" as const,
        lastActivityAt: now,
      },
      {
        id: "s2",
        status: "working",
        activity: "active",
        attentionLevel: "working" as const,
        lastActivityAt: now,
      },
    ];

    const { unmount } = renderHook(() =>
      useSessionEvents({
        initialSessions,
        project: "proj",
        muxSessions,
        attentionZones: "simple",
      }),
    );

    await vi.advanceTimersByTimeAsync(120);
    unmount();
    await Promise.resolve();

    expect(warnSpy).not.toHaveBeenCalledWith(
      "[useSessionEvents] refresh failed:",
      expect.anything(),
    );
    vi.useRealTimers();
  });
});
