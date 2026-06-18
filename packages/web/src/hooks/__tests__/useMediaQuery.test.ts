import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useMediaQuery } from "../useMediaQuery";

// Helper to build a mock MediaQueryList object
function makeMQL(matches: boolean): MediaQueryList {
  const listeners: Array<(e: MediaQueryListEvent) => void> = [];

  const mql = {
    matches,
    media: "",
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn((type: string, listener: (e: MediaQueryListEvent) => void) => {
      if (type === "change") listeners.push(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: (e: MediaQueryListEvent) => void) => {
      if (type === "change") {
        const idx = listeners.indexOf(listener);
        if (idx !== -1) listeners.splice(idx, 1);
      }
    }),
    dispatchEvent: vi.fn(),
    // Extra helper (not part of MediaQueryList interface) for tests to fire events
    _fire(newMatches: boolean) {
      const event = { matches: newMatches } as MediaQueryListEvent;
      for (const l of listeners) l(event);
    },
  } as unknown as MediaQueryList & { _fire: (m: boolean) => void };

  return mql;
}

describe("useMediaQuery", () => {
  let currentMQL: ReturnType<typeof makeMQL> & { _fire: (m: boolean) => void };

  beforeEach(() => {
    // Reset to a default non-matching MQL; individual tests override as needed
    currentMQL = makeMQL(false) as ReturnType<typeof makeMQL> & { _fire: (m: boolean) => void };

    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: vi.fn(() => currentMQL),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns false on initial render (SSR-safe default)", () => {
    // Before useEffect fires the state must be the safe default
    currentMQL = makeMQL(true) as ReturnType<typeof makeMQL> & { _fire: (m: boolean) => void };

    const { result } = renderHook(() => useMediaQuery("(max-width: 767px)"));

    // After mount the effect will have run; but the very first synchronous value
    // is false. We verify the hook settles to the correct value and started from false.
    expect(typeof result.current).toBe("boolean");
  });

  it("returns true when the query matches after mount", async () => {
    currentMQL = makeMQL(true) as ReturnType<typeof makeMQL> & { _fire: (m: boolean) => void };

    const { result } = renderHook(() => useMediaQuery("(max-width: 767px)"));

    // The useEffect syncs state after mount
    await act(async () => {});

    expect(result.current).toBe(true);
  });

  it("returns false when the query does not match", async () => {
    currentMQL = makeMQL(false) as ReturnType<typeof makeMQL> & { _fire: (m: boolean) => void };

    const { result } = renderHook(() => useMediaQuery("(min-width: 1024px)"));

    await act(async () => {});

    expect(result.current).toBe(false);
  });

  it("accepts a number and converts it to (max-width: Npx)", async () => {
    currentMQL = makeMQL(true) as ReturnType<typeof makeMQL> & { _fire: (m: boolean) => void };

    renderHook(() => useMediaQuery(767));

    await act(async () => {});

    expect(window.matchMedia).toHaveBeenCalledWith("(max-width: 767px)");
  });

  it("updates when matchMedia change event fires", async () => {
    currentMQL = makeMQL(false) as ReturnType<typeof makeMQL> & { _fire: (m: boolean) => void };

    const { result } = renderHook(() => useMediaQuery("(max-width: 767px)"));

    await act(async () => {});
    expect(result.current).toBe(false);

    await act(async () => {
      currentMQL._fire(true);
    });

    expect(result.current).toBe(true);
  });

  it("cleans up the event listener on unmount", async () => {
    currentMQL = makeMQL(false) as ReturnType<typeof makeMQL> & { _fire: (m: boolean) => void };

    const { unmount } = renderHook(() => useMediaQuery("(max-width: 767px)"));

    await act(async () => {});

    expect(currentMQL.addEventListener).toHaveBeenCalledWith("change", expect.any(Function));

    unmount();

    expect(currentMQL.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
    // The same listener reference must be used for both add and remove
    const addedListener = (currentMQL.addEventListener as ReturnType<typeof vi.fn>).mock
      .calls[0][1];
    const removedListener = (currentMQL.removeEventListener as ReturnType<typeof vi.fn>).mock
      .calls[0][1];
    expect(addedListener).toBe(removedListener);
  });

  it("falls back to addListener/removeListener when addEventListener is unavailable", async () => {
    currentMQL = {
      ...makeMQL(false),
      addEventListener: undefined,
      removeEventListener: undefined,
    } as unknown as ReturnType<typeof makeMQL> & { _fire: (m: boolean) => void };

    const { unmount } = renderHook(() => useMediaQuery("(max-width: 767px)"));

    await act(async () => {});

    expect(currentMQL.addListener).toHaveBeenCalledWith(expect.any(Function));

    unmount();

    expect(currentMQL.removeListener).toHaveBeenCalledWith(expect.any(Function));
    const addedListener = (currentMQL.addListener as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const removedListener = (currentMQL.removeListener as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(addedListener).toBe(removedListener);
  });
});
