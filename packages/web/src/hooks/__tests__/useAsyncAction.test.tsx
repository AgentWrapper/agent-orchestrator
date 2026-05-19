import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAsyncAction, useAsyncActionMap } from "../useAsyncAction";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = () => res();
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useAsyncAction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts in an idle state", () => {
    const { result } = renderHook(() =>
      useAsyncAction(async () => {
        /* noop */
      }),
    );

    expect(result.current.state).toEqual({ sending: false, sent: false, error: null });
  });

  it("flashes sending → sent and returns true on success", async () => {
    const d = deferred();
    const { result } = renderHook(() => useAsyncAction(async () => d.promise, { sentMs: 1000 }));

    let runPromise: Promise<boolean> | undefined;
    act(() => {
      runPromise = result.current.run();
    });

    expect(result.current.state).toEqual({ sending: true, sent: false, error: null });

    let finalVal: boolean | undefined;
    await act(async () => {
      d.resolve();
      finalVal = await runPromise;
    });

    expect(finalVal).toBe(true);
    expect(result.current.state).toEqual({ sending: false, sent: true, error: null });

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    expect(result.current.state).toEqual({ sending: false, sent: false, error: null });
  });

  it("surfaces error message and clears after errorMs", async () => {
    const d = deferred();
    const { result } = renderHook(() =>
      useAsyncAction(async () => d.promise, { sentMs: 1000, errorMs: 2000 }),
    );

    let finalVal: boolean | undefined;
    await act(async () => {
      const p = result.current.run();
      d.reject(new Error("boom"));
      finalVal = await p;
    });

    expect(finalVal).toBe(false);
    expect(result.current.state).toEqual({ sending: false, sent: false, error: "boom" });

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    expect(result.current.state).toEqual({ sending: false, sent: false, error: null });
  });

  it("cancels the pending flash when run() is called again", async () => {
    const calls: Array<ReturnType<typeof deferred>> = [];
    const { result } = renderHook(() =>
      useAsyncAction(
        async () => {
          const d = deferred();
          calls.push(d);
          return d.promise;
        },
        { sentMs: 5000 },
      ),
    );

    await act(async () => {
      void result.current.run();
      await Promise.resolve();
      calls[0].resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.state.sent).toBe(true);

    // Re-run before the 5s sent timer fires.
    await act(async () => {
      vi.advanceTimersByTime(1000);
      void result.current.run();
      await Promise.resolve();
    });

    // Old sent timer should be cancelled; state flips to sending.
    expect(result.current.state).toEqual({ sending: true, sent: false, error: null });

    // Advancing past the old timer must NOT clear anything (already cleared).
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(result.current.state.sending).toBe(true);

    // Finish second call.
    await act(async () => {
      calls[1].resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.state.sent).toBe(true);
  });

  it("ignores stale timer from an overlapping in-flight run (no early reset)", async () => {
    const calls: Array<ReturnType<typeof deferred>> = [];
    const { result } = renderHook(() =>
      useAsyncAction(async () => {
        const d = deferred();
        calls.push(d);
        return d.promise;
      }, { sentMs: 5000 }),
    );

    // Two overlapping runs: both start, neither has scheduled a sent-timer yet.
    await act(async () => {
      void result.current.run();
      void result.current.run();
      await Promise.resolve();
    });

    // Resolve call #1 first → its sent-timer is scheduled but stale.
    await act(async () => {
      calls[0].resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Then resolve call #2 → this is the live run; its sent-timer is current.
    await act(async () => {
      calls[1].resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.state.sent).toBe(true);

    // Fire timer #1 (stale). It must NOT reset state.
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    // We've advanced exactly the sent window from call #2's resolution moment;
    // either the live timer fired (idle) or hasn't (still sent). What MUST
    // not happen is "sent then idle then sent again" caused by stale timer.
    // The key invariant: the stale timer didn't yank state mid-flash.
    // After full window the live timer has cleared state to idle.
    expect(result.current.state).toEqual({ sending: false, sent: false, error: null });
  });

  it("reset() clears state and pending timer immediately", async () => {
    const { result } = renderHook(() =>
      useAsyncAction(
        async () => {
          /* resolves */
        },
        { sentMs: 5000 },
      ),
    );

    await act(async () => {
      await result.current.run();
    });
    expect(result.current.state.sent).toBe(true);

    act(() => {
      result.current.reset();
    });
    expect(result.current.state).toEqual({ sending: false, sent: false, error: null });
  });

  it("clears pending timers on unmount (no state updates after)", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result, unmount } = renderHook(() =>
      useAsyncAction(
        async () => {
          /* resolves */
        },
        { sentMs: 5000 },
      ),
    );

    await act(async () => {
      await result.current.run();
    });

    unmount();

    // If the timer wasn't cleared, this would try to setState on an unmounted
    // hook. The guard prevents it; no React warnings should surface.
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("passes args through to the action", async () => {
    const spy = vi.fn(async (_a: number, _b: string) => {
      /* noop */
    });
    const { result } = renderHook(() => useAsyncAction(spy));

    await act(async () => {
      await result.current.run(42, "hi");
    });

    expect(spy).toHaveBeenCalledWith(42, "hi");
  });
});

describe("useAsyncActionMap", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("tracks state independently per key", async () => {
    const ds: Record<string, ReturnType<typeof deferred>> = {};
    const { result } = renderHook(() =>
      useAsyncActionMap<[string]>(
        async (key) => {
          const d = deferred();
          ds[key] = d;
          return d.promise;
        },
        { sentMs: 1000, errorMs: 1000 },
      ),
    );

    await act(async () => {
      void result.current.run("a", "a");
      void result.current.run("b", "b");
      await Promise.resolve();
    });

    expect(result.current.getState("a")).toEqual({ sending: true, sent: false, error: null });
    expect(result.current.getState("b")).toEqual({ sending: true, sent: false, error: null });
    expect(result.current.anySending).toBe(true);

    await act(async () => {
      ds["a"].resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.getState("a")).toEqual({ sending: false, sent: true, error: null });
    expect(result.current.getState("b").sending).toBe(true);

    await act(async () => {
      ds["b"].reject(new Error("nope"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.getState("b")).toEqual({ sending: false, sent: false, error: "nope" });
    expect(result.current.anySending).toBe(false);
  });

  it("returns idle state for unknown keys", () => {
    const { result } = renderHook(() =>
      useAsyncActionMap(async () => {
        /* noop */
      }),
    );
    expect(result.current.getState("never-ran")).toEqual({
      sending: false,
      sent: false,
      error: null,
    });
  });

  it("cancels a pending flash timer when the same key re-runs", async () => {
    const calls: Array<ReturnType<typeof deferred>> = [];
    const { result } = renderHook(() =>
      useAsyncActionMap<[]>(
        async () => {
          const d = deferred();
          calls.push(d);
          return d.promise;
        },
        { sentMs: 5000 },
      ),
    );

    await act(async () => {
      void result.current.run("k");
      await Promise.resolve();
      calls[0].resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.getState("k").sent).toBe(true);

    await act(async () => {
      void result.current.run("k");
      await Promise.resolve();
    });
    expect(result.current.getState("k")).toEqual({ sending: true, sent: false, error: null });

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    // Old sent timer would have idled state; since it was cancelled, we're still sending.
    expect(result.current.getState("k").sending).toBe(true);

    await act(async () => {
      calls[1].resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.getState("k").sent).toBe(true);
  });

  it("ignores stale per-key timer from an overlapping in-flight run", async () => {
    const calls: Array<ReturnType<typeof deferred>> = [];
    const { result } = renderHook(() =>
      useAsyncActionMap<[]>(
        async () => {
          const d = deferred();
          calls.push(d);
          return d.promise;
        },
        { sentMs: 5000 },
      ),
    );

    // Two overlapping runs for the same key — both started before either resolves.
    await act(async () => {
      void result.current.run("k");
      void result.current.run("k");
      await Promise.resolve();
    });

    await act(async () => {
      calls[0].resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      calls[1].resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.getState("k").sent).toBe(true);

    // Advance past the live sent window. The stale timer (from call #1's
    // resolution) must not have prematurely reset state mid-flash.
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current.getState("k")).toEqual({ sending: false, sent: false, error: null });
  });

  it("reset() clears a single key without affecting others", async () => {
    const { result } = renderHook(() =>
      useAsyncActionMap<[]>(
        async () => {
          /* resolves */
        },
        { sentMs: 5000 },
      ),
    );

    await act(async () => {
      await result.current.run("a");
      await result.current.run("b");
    });

    expect(result.current.getState("a").sent).toBe(true);
    expect(result.current.getState("b").sent).toBe(true);

    act(() => {
      result.current.reset("a");
    });

    expect(result.current.getState("a")).toEqual({ sending: false, sent: false, error: null });
    expect(result.current.getState("b").sent).toBe(true);
  });

  it("reset() with no arg clears every key and pending timer", async () => {
    const { result } = renderHook(() =>
      useAsyncActionMap<[]>(
        async () => {
          /* resolves */
        },
        { sentMs: 5000 },
      ),
    );

    await act(async () => {
      await result.current.run("a");
      await result.current.run("b");
    });

    act(() => {
      result.current.reset();
    });

    expect(result.current.getState("a")).toEqual({ sending: false, sent: false, error: null });
    expect(result.current.getState("b")).toEqual({ sending: false, sent: false, error: null });
    expect(result.current.anySending).toBe(false);
  });

  it("clears every pending timer on unmount", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result, unmount } = renderHook(() =>
      useAsyncActionMap<[]>(
        async () => {
          /* resolves */
        },
        { sentMs: 5000 },
      ),
    );

    await act(async () => {
      await result.current.run("a");
      await result.current.run("b");
    });

    unmount();

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("anySending reflects in-flight runs across keys", async () => {
    const ds: Record<string, ReturnType<typeof deferred>> = {};
    const { result } = renderHook(() =>
      useAsyncActionMap<[string]>(async (key) => {
        const d = deferred();
        ds[key] = d;
        return d.promise;
      }),
    );

    expect(result.current.anySending).toBe(false);

    await act(async () => {
      void result.current.run("x", "x");
      await Promise.resolve();
    });
    expect(result.current.anySending).toBe(true);

    await act(async () => {
      ds["x"].resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.anySending).toBe(false);
  });
});
