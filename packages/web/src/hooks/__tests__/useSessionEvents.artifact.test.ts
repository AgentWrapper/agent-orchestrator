import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { Artifact } from "@aoagents/ao-core";
import { useSessionEvents, type IncomingArtifactEvent } from "../useSessionEvents";
import type { DashboardSession } from "@/lib/types";

const now = new Date().toISOString();
const s1 = { id: "s1", projectId: "proj", lastActivityAt: now } as unknown as DashboardSession;
// Stable reference — passing a fresh array on every render triggers the
// `reset` effect repeatedly and dispatches in a loop.
const stableSessions: DashboardSession[] = [s1];

function makeArtifact(id: string, title = "Artifact"): Artifact {
  return {
    version: 1,
    id,
    type: "markdown",
    title,
    createdAt: now,
    updatedAt: now,
    payload: { markdown: "# hi" },
  };
}

describe("useSessionEvents - artifact events", () => {
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
  });

  it("artifact-update adds an artifact to state for the matching session", async () => {
    const artifact = makeArtifact("c1");
    const events: IncomingArtifactEvent[] = [
      { type: "artifact-update", sessionId: "s1", artifact },
    ];
    const { result } = renderHook(() =>
      useSessionEvents({
        initialSessions: stableSessions,
        attentionZones: "simple",
        artifactEvents: events,
      }),
    );
    await waitFor(() => {
      expect(result.current.artifactsBySession["s1"]).toEqual([artifact]);
    });
  });

  it("artifact-update replaces an existing artifact with the same id", async () => {
    const v1 = makeArtifact("c1", "first");
    const v2 = makeArtifact("c1", "second");
    const { result, rerender } = renderHook(
      ({ events }: { events: IncomingArtifactEvent[] }) =>
        useSessionEvents({
          initialSessions: stableSessions,
          attentionZones: "simple",
          artifactEvents: events,
        }),
      {
        initialProps: {
          events: [{ type: "artifact-update", sessionId: "s1", artifact: v1 }] as IncomingArtifactEvent[],
        },
      },
    );
    await waitFor(() => {
      expect(result.current.artifactsBySession["s1"]).toEqual([v1]);
    });

    rerender({
      events: [{ type: "artifact-update", sessionId: "s1", artifact: v2 }] as IncomingArtifactEvent[],
    });

    await waitFor(() => {
      const artifacts = result.current.artifactsBySession["s1"];
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]?.title).toBe("second");
    });
  });

  it("artifact-delete removes an artifact from state", async () => {
    const c1 = makeArtifact("c1");
    const c2 = makeArtifact("c2");
    const { result, rerender } = renderHook(
      ({ events }: { events: IncomingArtifactEvent[] }) =>
        useSessionEvents({
          initialSessions: stableSessions,
          attentionZones: "simple",
          artifactEvents: events,
        }),
      {
        initialProps: {
          events: [
            { type: "artifact-update", sessionId: "s1", artifact: c1 },
            { type: "artifact-update", sessionId: "s1", artifact: c2 },
          ] as IncomingArtifactEvent[],
        },
      },
    );
    await waitFor(() => {
      expect(result.current.artifactsBySession["s1"]).toHaveLength(2);
    });

    rerender({
      events: [
        { type: "artifact-delete", sessionId: "s1", artifactId: "c1" },
      ] as IncomingArtifactEvent[],
    });

    await waitFor(() => {
      const artifacts = result.current.artifactsBySession["s1"];
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]?.id).toBe("c2");
    });
  });

  it("artifact-error is observable via artifactErrorsBySession", async () => {
    const events: IncomingArtifactEvent[] = [
      {
        type: "artifact-error",
        sessionId: "s1",
        artifactId: "c1",
        errors: [{ path: ["payload", "markdown"], message: "too long" }],
      },
    ];
    const { result } = renderHook(() =>
      useSessionEvents({
        initialSessions: stableSessions,
        attentionZones: "simple",
        artifactEvents: events,
      }),
    );
    await waitFor(() => {
      const errs = result.current.artifactErrorsBySession["s1"];
      expect(errs).toHaveLength(1);
      expect(errs?.[0]?.artifactId).toBe("c1");
      expect(errs?.[0]?.errors[0]?.message).toBe("too long");
    });
  });
});
