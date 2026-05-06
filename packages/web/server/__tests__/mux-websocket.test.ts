import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SessionBroadcaster } from "../mux-websocket";

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("SessionBroadcaster", () => {
  let broadcaster: SessionBroadcaster;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
    broadcaster = new SessionBroadcaster("3000");
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const makePatch = (id: string) => ({
    id,
    status: "working",
    activity: "active",
    attentionLevel: "working" as const,
    lastActivityAt: new Date().toISOString(),
  });

  describe("subscribe", () => {
    it("sends an immediate snapshot to a new subscriber", async () => {
      const patches = [makePatch("s1")];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessions: patches }),
      });

      const callback = vi.fn();
      broadcaster.subscribe(callback);

      // Let the snapshot fetch resolve
      await vi.advanceTimersByTimeAsync(0);

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/sessions/patches",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(callback).toHaveBeenCalledWith(patches);
    });

    it("starts polling interval on first subscriber", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessions: [] }),
      });

      broadcaster.subscribe(vi.fn());
      await vi.advanceTimersByTimeAsync(0);

      // Snapshot fetch is called once on subscribe
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // After 3 seconds, polling interval should trigger a second fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessions: [] }),
      });
      await vi.advanceTimersByTimeAsync(3000);

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("does not start a second polling interval for additional subscribers", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ sessions: [] }),
      });

      broadcaster.subscribe(vi.fn());
      broadcaster.subscribe(vi.fn());
      await vi.advanceTimersByTimeAsync(0);

      // 1 snapshot for sub1 + 1 snapshot for sub2 = 2
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // After 3 seconds, only one polling fetch happens
      await vi.advanceTimersByTimeAsync(3000);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("returns an unsubscribe function that stops polling when last subscriber leaves", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessions: [] }),
      });

      const unsub = broadcaster.subscribe(vi.fn());
      await vi.advanceTimersByTimeAsync(0);

      // Unsubscribe triggers disconnect
      unsub();

      // Reset and advance past polling interval
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessions: [] }),
      });
      await vi.advanceTimersByTimeAsync(3000);

      // Should not have called fetch again after unsubscribe
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("broadcast", () => {
    it("delivers patches to all subscribers on each poll", async () => {
      const patches = [makePatch("s1"), makePatch("s2")];

      // Initial snapshot for first subscriber
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessions: patches }),
      });
      // Initial snapshot for second subscriber
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessions: patches }),
      });
      // Polling fetch after 3s
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessions: patches }),
      });

      const cb1 = vi.fn();
      const cb2 = vi.fn();
      broadcaster.subscribe(cb1);
      broadcaster.subscribe(cb2);

      await vi.advanceTimersByTimeAsync(10);

      // Both callbacks should have received initial snapshot
      expect(cb1).toHaveBeenCalledWith(patches);
      expect(cb2).toHaveBeenCalledWith(patches);

      // Advance past poll interval (3s) and add buffer for promise resolution
      await vi.advanceTimersByTimeAsync(3010);

      // Should be called again from polling
      expect(cb1).toHaveBeenCalledTimes(2);
      expect(cb2).toHaveBeenCalledTimes(2);
    });

    it("isolates subscriber errors — one throw does not skip others", async () => {
      const patches = [makePatch("s1")];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessions: patches }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessions: patches }),
      });

      const throwingCb = vi.fn().mockImplementation(() => {
        throw new Error("ws.send failed");
      });
      const goodCb = vi.fn();
      broadcaster.subscribe(throwingCb);
      broadcaster.subscribe(goodCb);

      await vi.advanceTimersByTimeAsync(10);

      // goodCb should have received patches despite throwingCb error
      expect(goodCb).toHaveBeenCalledWith(patches);
    });
  });

  describe("fetchSnapshot", () => {
    it("returns null on fetch failure", async () => {
      mockFetch.mockRejectedValueOnce(new Error("network error"));

      const callback = vi.fn();
      broadcaster.subscribe(callback);
      await vi.advanceTimersByTimeAsync(10);

      // callback should not have been called (snapshot returned null)
      expect(callback).not.toHaveBeenCalled();
    });

    it("returns null on non-OK response", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      const callback = vi.fn();
      broadcaster.subscribe(callback);
      await vi.advanceTimersByTimeAsync(10);

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe("disconnect", () => {
    it("stops polling when last subscriber unsubscribes", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessions: [] }),
      });

      const unsub = broadcaster.subscribe(vi.fn());
      await vi.advanceTimersByTimeAsync(0);

      // Unsubscribe triggers disconnect
      unsub();

      // Advance past polling interval
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessions: [] }),
      });
      await vi.advanceTimersByTimeAsync(3000);

      // Should only have 1 fetch (initial snapshot)
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});
