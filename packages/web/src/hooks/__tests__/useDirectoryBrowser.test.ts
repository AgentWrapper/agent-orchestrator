import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useDirectoryBrowser } from "@/hooks/useDirectoryBrowser";

function mockBrowse(entries: unknown[]) {
  return vi.fn().mockResolvedValue({ ok: true, json: async () => ({ entries, roots: [] }) });
}

function deferredResponse() {
  let resolve!: (value: {
    ok: true;
    json: () => Promise<{ entries: never[]; roots: never[] }>;
  }) => void;
  const promise = new Promise<{
    ok: true;
    json: () => Promise<{ entries: never[]; roots: never[] }>;
  }>((res) => {
    resolve = res;
  });
  return {
    promise,
    resolve: () => resolve({ ok: true, json: async () => ({ entries: [], roots: [] }) }),
  };
}

describe("useDirectoryBrowser", () => {
  it("loads the initial path on reset and tracks history", async () => {
    vi.stubGlobal(
      "fetch",
      mockBrowse([{ name: "a", isDirectory: true, isGitRepo: false, hasLocalConfig: false }]),
    );
    const { result } = renderHook(() => useDirectoryBrowser());
    act(() => result.current.reset());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.browsePath).toBe("~");
    expect(result.current.canGoBack).toBe(false);

    await act(async () => {
      await result.current.browse("~/a");
    });
    expect(result.current.browsePath).toBe("~/a");
    expect(result.current.canGoBack).toBe(true);

    act(() => result.current.goBack());
    await waitFor(() => expect(result.current.browsePath).toBe("~"));
  });

  it("surfaces a browse error when the API fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "path is restricted" }) }),
    );
    const { result } = renderHook(() => useDirectoryBrowser());
    await act(async () => {
      await result.current.browse("~/secret");
    });
    expect(result.current.error).toBe("path is restricted");
  });

  it("ignores stale pending replace responses after newer navigation", async () => {
    const pendingRefresh = deferredResponse();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ entries: [], roots: [] }) })
      .mockReturnValueOnce(pendingRefresh.promise)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ entries: [], roots: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ entries: [], roots: [] }) });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useDirectoryBrowser());

    await act(async () => {
      await result.current.browse("~/a");
    });
    expect(result.current.browsePath).toBe("~/a");
    expect(result.current.canGoBack).toBe(true);

    act(() => result.current.refresh());
    act(() => result.current.goBack());
    await waitFor(() => expect(result.current.browsePath).toBe("~"));

    await act(async () => {
      pendingRefresh.resolve();
      await pendingRefresh.promise;
    });

    expect(result.current.browsePath).toBe("~");
    expect(result.current.locationInput).toBe("~");
    // History-replay navigation no longer carries a selection — selecting is an explicit
    // user action (click a row, type a path) so descend/back/forward leave selection clear.
    expect(result.current.selectedBrowsePath).toBe("");
    expect(result.current.canGoForward).toBe(true);
    act(() => result.current.goForward());
    await waitFor(() => expect(result.current.browsePath).toBe("~/a"));
  });
});
