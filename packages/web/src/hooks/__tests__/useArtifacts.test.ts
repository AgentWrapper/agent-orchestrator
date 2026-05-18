import { describe, it, expect, vi, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { Artifact } from "@aoagents/ao-core";
import { useArtifacts } from "../useArtifacts";
import type { ArtifactMuxEvent } from "@/providers/MuxProvider";

// Mock useMuxOptional so we can drive subscribeArtifacts callbacks directly.
// Each test below overrides the return value via muxMock.mockReturnValueOnce.
const muxMock = vi.fn();
vi.mock("@/providers/MuxProvider", () => ({
  useMuxOptional: () => muxMock(),
}));

interface MuxStub {
  callbacks: Map<string, (event: ArtifactMuxEvent) => void>;
  value: {
    subscribeArtifacts: (
      sessionId: string,
      cb: (event: ArtifactMuxEvent) => void,
    ) => () => void;
  };
}

function makeMuxStub(): MuxStub {
  const callbacks = new Map<string, (event: ArtifactMuxEvent) => void>();
  return {
    callbacks,
    value: {
      subscribeArtifacts: (sessionId, cb) => {
        callbacks.set(sessionId, cb);
        return () => callbacks.delete(sessionId);
      },
    },
  };
}

const now = new Date().toISOString();

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

describe("useArtifacts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    muxMock.mockReset();
  });

  it("fetches artifacts on mount via GET /api/sessions/[id]/artifacts", async () => {
    const c1 = makeArtifact("c1");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ artifacts: [c1] }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useArtifacts("sess-1"));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/sess-1/artifacts",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.current.artifacts).toEqual([c1]);
    expect(result.current.error).toBeNull();
  });

  it("applies an artifact-update event delivered via mux to update an existing artifact", async () => {
    const c1 = makeArtifact("c1", "first");
    const c1Updated = makeArtifact("c1", "second");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ artifacts: [c1] }),
      } as unknown as Response),
    );

    const mux = makeMuxStub();
    muxMock.mockReturnValue(mux.value);

    const { result } = renderHook(() => useArtifacts("sess-1"));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.artifacts).toEqual([c1]);

    // Drive the mux callback registered by the hook.
    const cb = mux.callbacks.get("sess-1");
    expect(cb).toBeDefined();
    act(() => {
      cb!({ type: "artifact-update", sessionId: "sess-1", artifact: c1Updated });
    });

    await waitFor(() => {
      expect(result.current.artifacts).toEqual([c1Updated]);
    });
  });

  it("applies an artifact-delete event delivered via mux to remove an artifact", async () => {
    const c1 = makeArtifact("c1");
    const c2 = makeArtifact("c2");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ artifacts: [c1, c2] }),
      } as unknown as Response),
    );

    const mux = makeMuxStub();
    muxMock.mockReturnValue(mux.value);

    const { result } = renderHook(() => useArtifacts("sess-1"));
    await waitFor(() => {
      expect(result.current.artifacts).toHaveLength(2);
    });

    const cb = mux.callbacks.get("sess-1");
    expect(cb).toBeDefined();
    act(() => {
      cb!({ type: "artifact-delete", sessionId: "sess-1", artifactId: "c1" });
    });

    await waitFor(() => {
      expect(result.current.artifacts).toEqual([c2]);
    });
  });

  it("captures fetch errors for display", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 } as unknown as Response),
    );

    const { result } = renderHook(() => useArtifacts("sess-1"));
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.error).toBe("HTTP 500");
    expect(result.current.artifacts).toEqual([]);
  });

  it("cancels the in-flight fetch on unmount", async () => {
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { unmount } = renderHook(() => useArtifacts("sess-1"));
    unmount();
    // Give the abort time to propagate.
    await new Promise((r) => setTimeout(r, 5));
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
