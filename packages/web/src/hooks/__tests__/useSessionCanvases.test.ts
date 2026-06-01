import { renderHook, waitFor, act } from "@testing-library/react";
import { describe, it, expect, afterEach, vi } from "vitest";
import type { CanvasArtifact } from "@aoagents/ao-core";
import { useSessionCanvases } from "../useSessionCanvases";

const sample: CanvasArtifact = {
  version: 1,
  id: "x",
  type: "markdown",
  title: "X",
  createdAt: "2026-05-05T00:00:00Z",
  updatedAt: "2026-05-05T00:00:00Z",
  payload: { markdown: "hi" },
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useSessionCanvases", () => {
  it("fetches once on mount", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ canvases: [sample] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useSessionCanvases("ao-1"));
    await waitFor(() => expect(result.current.canvases).toHaveLength(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/ao-1/canvases");
  });

  it("polls every 5 seconds", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ canvases: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers({ shouldAdvanceTime: true });

    renderHook(() => useSessionCanvases("ao-1"));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("surfaces non-OK responses as errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useSessionCanvases("ao-1"));
    await waitFor(() => expect(result.current.error).toBe("HTTP 500"));
  });

  it("returns empty when sessionId is null", () => {
    const { result } = renderHook(() => useSessionCanvases(null));
    expect(result.current.canvases).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it("ignores in-flight responses from a previous sessionId", async () => {
    let resolveOne: ((v: { canvases: CanvasArtifact[] }) => void) | null = null;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("ao-1")) {
        return new Promise((resolve) => {
          resolveOne = (v) => resolve({ ok: true, status: 200, json: async () => v });
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ canvases: [{ ...sample, id: "two" }] }),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useSessionCanvases(id),
      { initialProps: { id: "ao-1" } },
    );

    rerender({ id: "ao-2" });
    await waitFor(() => expect(result.current.canvases).toEqual([{ ...sample, id: "two" }]));

    // Resolve the stale ao-1 fetch — must not overwrite ao-2's canvases.
    resolveOne?.({ canvases: [{ ...sample, id: "one-stale" }] });
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current.canvases).toEqual([{ ...sample, id: "two" }]);
  });
});
