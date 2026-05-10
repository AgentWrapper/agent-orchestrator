import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useSessionEvents } from "../useSessionEvents";
import type { DashboardSession } from "@/lib/types";

const now = new Date().toISOString();
const s1 = { id: "s1", projectId: "proj", lastActivityAt: now } as unknown as DashboardSession;

function makePRSession(
  overrides: Partial<DashboardSession> = {},
  prOverrides: Partial<NonNullable<DashboardSession["pr"]>> = {},
): DashboardSession {
  return {
    id: "s1",
    projectId: "proj",
    status: "mergeable",
    activity: "idle",
    lastActivityAt: now,
    createdAt: now,
    branch: "feat/one",
    issueId: null,
    issueUrl: null,
    issueLabel: null,
    issueTitle: null,
    userPrompt: null,
    displayName: null,
    summary: null,
    summaryIsFallback: false,
    metadata: {},
    agentReportAudit: [],
    attentionLevel: "merge",
    pr: {
      number: 42,
      url: "https://github.com/acme/proj/pull/42",
      title: "fix: stable rich card",
      owner: "acme",
      repo: "proj",
      branch: "feat/one",
      baseBranch: "main",
      isDraft: false,
      state: "open",
      additions: 12,
      deletions: 3,
      ciStatus: "passing",
      ciChecks: [],
      reviewDecision: "none",
      mergeability: {
        mergeable: true,
        ciPassing: true,
        approved: false,
        noConflicts: true,
        blockers: [],
      },
      unresolvedThreads: 0,
      unresolvedComments: [],
      enriched: true,
      ...prOverrides,
    },
    ...overrides,
  } as DashboardSession;
}

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
        "/api/sessions?project=proj&fresh=metadata",
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
      "/api/sessions?project=proj&fresh=metadata",
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

  it("does not downgrade enriched PR cards when a refresh returns unenriched placeholders", async () => {
    const refreshedAt = new Date(Date.now() + 1_000).toISOString();
    const richSession = makePRSession();
    const partialSession = makePRSession(
      { lastActivityAt: refreshedAt },
      {
        title: "",
        additions: 0,
        deletions: 0,
        ciStatus: "none",
        reviewDecision: "none",
        mergeability: {
          mergeable: false,
          ciPassing: false,
          approved: false,
          noConflicts: true,
          blockers: [],
        },
        enriched: false,
      },
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ sessions: [partialSession] }),
      } as unknown as Response),
    );

    const muxSessions = [
      {
        id: "s1",
        status: "mergeable",
        activity: "idle",
        attentionLevel: "merge" as const,
        lastActivityAt: now,
      },
      {
        id: "unknown",
        status: "working",
        activity: "active",
        attentionLevel: "working" as const,
        lastActivityAt: now,
      },
    ];
    const initialSessions = [richSession];

    const { result } = renderHook(() =>
      useSessionEvents({
        initialSessions,
        project: "proj",
        muxSessions,
        attentionZones: "simple",
      }),
    );

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/sessions?project=proj&fresh=metadata",
        expect.objectContaining({ signal: expect.any(AbortSignal), cache: "no-store" }),
      );
    });
    await waitFor(() => {
      expect(result.current.sessions[0]?.lastActivityAt).toBe(refreshedAt);
    });

    expect(result.current.sessions[0]).toMatchObject({
      lastActivityAt: refreshedAt,
      pr: {
        title: "fix: stable rich card",
        additions: 12,
        deletions: 3,
        ciStatus: "passing",
        mergeability: expect.objectContaining({ mergeable: true }),
        enriched: true,
      },
    });
    expect(result.current.attentionLevels.s1).toBe("merge");
  });

  it("does not preserve stale mergeability when the partial refresh is no longer merge-ready", async () => {
    const refreshedAt = new Date(Date.now() + 1_000).toISOString();
    const richSession = makePRSession(
      {},
      {
        mergeability: {
          mergeable: false,
          ciPassing: false,
          approved: false,
          noConflicts: false,
          blockers: ["Merge conflict"],
        },
      },
    );
    const partialSession = makePRSession(
      {
        status: "review_pending",
        attentionLevel: "pending",
        lastActivityAt: refreshedAt,
      },
      {
        title: "",
        additions: 0,
        deletions: 0,
        mergeability: {
          mergeable: false,
          ciPassing: false,
          approved: false,
          noConflicts: true,
          blockers: [],
        },
        enriched: false,
      },
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ sessions: [partialSession] }),
      } as unknown as Response),
    );

    const muxSessions = [
      {
        id: "s1",
        status: "review_pending",
        activity: "idle",
        attentionLevel: "pending" as const,
        lastActivityAt: now,
      },
      {
        id: "unknown",
        status: "working",
        activity: "active",
        attentionLevel: "working" as const,
        lastActivityAt: now,
      },
    ];
    const initialSessions = [richSession];

    const { result } = renderHook(() =>
      useSessionEvents({
        initialSessions,
        project: "proj",
        muxSessions,
        attentionZones: "simple",
      }),
    );

    await waitFor(() => {
      expect(result.current.sessions[0]?.lastActivityAt).toBe(refreshedAt);
    });

    expect(result.current.sessions[0]).toMatchObject({
      pr: {
        title: "fix: stable rich card",
        additions: 12,
        deletions: 3,
        mergeability: expect.objectContaining({
          mergeable: false,
          noConflicts: true,
          blockers: [],
        }),
        enriched: true,
      },
    });
    expect(result.current.attentionLevels.s1).toBe("pending");
  });

  it("does not keep stale non-mergeable data when a placeholder refresh becomes merge-ready", async () => {
    const refreshedAt = new Date(Date.now() + 1_000).toISOString();
    const richSession = makePRSession(
      {},
      {
        ciStatus: "failing",
        ciChecks: [{ name: "build", status: "failed", url: "https://ci.example/build" }],
        reviewDecision: "changes_requested",
        mergeability: {
          mergeable: false,
          ciPassing: false,
          approved: false,
          noConflicts: true,
          blockers: [],
        },
      },
    );
    const partialSession = makePRSession(
      {
        status: "mergeable",
        attentionLevel: "merge",
        lastActivityAt: refreshedAt,
      },
      {
        title: "",
        additions: 0,
        deletions: 0,
        mergeability: {
          mergeable: false,
          ciPassing: false,
          approved: false,
          noConflicts: true,
          blockers: [],
        },
        enriched: false,
      },
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ sessions: [partialSession] }),
      } as unknown as Response),
    );

    const muxSessions = [
      {
        id: "s1",
        status: "mergeable",
        activity: "idle",
        attentionLevel: "merge" as const,
        lastActivityAt: now,
      },
      {
        id: "unknown",
        status: "working",
        activity: "active",
        attentionLevel: "working" as const,
        lastActivityAt: now,
      },
    ];
    const initialSessions = [richSession];

    const { result } = renderHook(() =>
      useSessionEvents({
        initialSessions,
        project: "proj",
        muxSessions,
        attentionZones: "simple",
      }),
    );

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/api/sessions?project=proj&fresh=metadata",
        expect.objectContaining({ signal: expect.any(AbortSignal), cache: "no-store" }),
      );
    });
    await waitFor(() => {
      expect(result.current.sessions[0]?.lastActivityAt).toBe(refreshedAt);
    });

    expect(result.current.sessions[0]).toMatchObject({
      pr: {
        title: "fix: stable rich card",
        ciStatus: "passing",
        ciChecks: [],
        reviewDecision: "none",
        mergeability: expect.objectContaining({ mergeable: true }),
        enriched: true,
      },
    });
    expect(result.current.attentionLevels.s1).toBe("merge");
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
