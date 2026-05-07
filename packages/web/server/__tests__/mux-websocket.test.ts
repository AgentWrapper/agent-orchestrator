import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type * as ChildProcess from "node:child_process";

// node-pty is loaded via top-level await in mux-websocket.ts. Mock it BEFORE
// importing the module so the dynamic import resolves to the fake spawn.
// vi.mock is hoisted above all imports, so the import below picks up the mock.
interface MockPty {
  pid: number;
  dataHandlers: Array<(data: string) => void>;
  exitHandlers: Array<(info: { exitCode: number; signal?: number }) => void>;
  killed: boolean;
  onData: (cb: (data: string) => void) => { dispose: () => void };
  onExit: (cb: (info: { exitCode: number; signal?: number }) => void) => { dispose: () => void };
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
  /** Test helper — synchronously fan out a data event to subscribers + buffer. */
  emitData: (data: string) => void;
  /** Test helper — synchronously fan out an exit event. */
  emitExit: (code: number) => void;
}

const ptyInstances: MockPty[] = [];

function makeMockPty(): MockPty {
  const pty: MockPty = {
    pid: 12345,
    dataHandlers: [],
    exitHandlers: [],
    killed: false,
    onData(cb) {
      this.dataHandlers.push(cb);
      return { dispose: () => {} };
    },
    onExit(cb) {
      this.exitHandlers.push(cb);
      return { dispose: () => {} };
    },
    write: () => {},
    resize: () => {},
    kill() {
      this.killed = true;
    },
    emitData(data: string) {
      for (const cb of this.dataHandlers) cb(data);
    },
    emitExit(code: number) {
      for (const cb of this.exitHandlers) cb({ exitCode: code });
    },
  };
  return pty;
}

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => {
    const pty = makeMockPty();
    ptyInstances.push(pty);
    return pty;
  }),
}));

// Mock child_process.spawn — used by TerminalManager for `tmux set-option`
// (mouse mode, status bar). Returns an object with the minimum surface
// node-pty's caller needs (the .on("error") listener).
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn(() => ({
      on: vi.fn(),
    })),
  };
});

import { SessionBroadcaster, TerminalManager } from "../mux-websocket";

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

// ────────────────────────────────────────────────────────────────────
// TerminalManager — buffer replay & re-open behaviour
//
// Regression coverage for issue #1689 ("Dashboard terminal renders blank
// on connect after upgrading to v0.4.0"). The bug was that the buffer
// was wrapped in a `if (!subscriptions.has(id))` guard in the WS handler,
// which silently skipped buffer replay when a same-connection re-open
// happened. The fix is to always send the buffer on open and only guard
// the subscribe call. These tests pin the supporting TerminalManager
// behaviour so the fix can't regress.
// ────────────────────────────────────────────────────────────────────
describe("TerminalManager", () => {
  const TMUX = "/usr/bin/tmux";
  const SESSION_ID = "ao-test-1";
  const TMUX_NAME = "abc123abcabc-ao-test-1";

  beforeEach(() => {
    ptyInstances.length = 0;
  });

  describe("open + getBuffer", () => {
    it("returns empty buffer immediately after open (PTY data is async)", () => {
      const tm = new TerminalManager(TMUX);
      tm.open(SESSION_ID, undefined, TMUX_NAME);

      // PTY data hasn't fired yet — buffer must be empty. This is what
      // makes the WS handler's "always send buffer" change safe on a fresh
      // open: the empty buffer just produces no-op ws.send.
      expect(tm.getBuffer(SESSION_ID)).toBe("");
      expect(ptyInstances).toHaveLength(1);
    });

    it("accumulates PTY data into the buffer", () => {
      const tm = new TerminalManager(TMUX);
      tm.open(SESSION_ID, undefined, TMUX_NAME);

      const pty = ptyInstances[0];
      pty.emitData("hello ");
      pty.emitData("world");

      expect(tm.getBuffer(SESSION_ID)).toBe("hello world");
    });

    it("rejects invalid session ids", () => {
      const tm = new TerminalManager(TMUX);
      expect(() => tm.open("../etc/passwd", undefined, TMUX_NAME)).toThrow(/Invalid session ID/);
    });

    it("does not respawn the PTY on a second open call", () => {
      const tm = new TerminalManager(TMUX);
      tm.open(SESSION_ID, undefined, TMUX_NAME);
      tm.open(SESSION_ID, undefined, TMUX_NAME);

      // Reusing the existing PTY across opens is what allows the buffer
      // to retain its history for a same-connection re-open.
      expect(ptyInstances).toHaveLength(1);
    });

    it("scopes buffers per (id, projectId) pair", () => {
      // Two sessions sharing the same id under different projects must
      // keep their PTY data isolated — this is the project-scoping
      // invariant added in #1551 that the issue #1689 fix must preserve.
      const tm = new TerminalManager(TMUX);
      tm.open(SESSION_ID, "projA", `projA-${SESSION_ID}`);
      tm.open(SESSION_ID, "projB", `projB-${SESSION_ID}`);

      expect(ptyInstances).toHaveLength(2);
      ptyInstances[0].emitData("from-A");
      ptyInstances[1].emitData("from-B");

      expect(tm.getBuffer(SESSION_ID, "projA")).toBe("from-A");
      expect(tm.getBuffer(SESSION_ID, "projB")).toBe("from-B");
      // Cross-project lookups must not leak buffer contents
      expect(tm.getBuffer(SESSION_ID)).toBe("");
    });
  });

  describe("subscribe + buffer replay across close→re-open", () => {
    it("delivers live data to subscribers", () => {
      const tm = new TerminalManager(TMUX);
      const received: string[] = [];

      // Seed the entry with a tmuxName via open() so subscribe()'s
      // internal open() reuses the cached tmuxSessionId instead of
      // trying (and failing) to resolveTmuxSession on the test box.
      tm.open(SESSION_ID, undefined, TMUX_NAME);
      const unsub = tm.subscribe(SESSION_ID, undefined, (data) => received.push(data));

      const pty = ptyInstances[0];
      pty.emitData("live-1");
      pty.emitData("live-2");

      expect(received).toEqual(["live-1", "live-2"]);
      unsub();
    });

    it("kills the PTY and drops the entry when the last subscriber leaves", () => {
      const tm = new TerminalManager(TMUX);
      tm.open(SESSION_ID, undefined, TMUX_NAME);
      const unsub = tm.subscribe(SESSION_ID, undefined, () => {});

      const pty = ptyInstances[0];
      expect(pty.killed).toBe(false);

      unsub();

      // PTY killed and entry deleted — getBuffer returns "" because the
      // map no longer has the id. This is the v0.4.0 lifecycle: on
      // close→re-open, a fresh terminal is created.
      expect(pty.killed).toBe(true);
      expect(tm.getBuffer(SESSION_ID)).toBe("");
    });

    it("creates a fresh PTY on re-open after the previous one was killed", () => {
      const tm = new TerminalManager(TMUX);
      tm.open(SESSION_ID, undefined, TMUX_NAME);
      const unsub1 = tm.subscribe(SESSION_ID, undefined, () => {});

      ptyInstances[0].emitData("first-attach-redraw");
      // First subscriber leaves → PTY killed, entry dropped
      unsub1();

      // Re-open: fresh PTY, fresh buffer
      tm.open(SESSION_ID, undefined, TMUX_NAME);
      expect(ptyInstances).toHaveLength(2);
      // Buffer is empty until the new PTY emits data
      expect(tm.getBuffer(SESSION_ID)).toBe("");

      ptyInstances[1].emitData("second-attach-redraw");
      // The new buffer reflects only the new PTY's output (no stale
      // history from the killed PTY) — confirms the re-open path is
      // a clean slate.
      expect(tm.getBuffer(SESSION_ID)).toBe("second-attach-redraw");
    });

    it("retains multiple subscribers when one of them leaves", () => {
      const tm = new TerminalManager(TMUX);
      tm.open(SESSION_ID, undefined, TMUX_NAME);
      const a: string[] = [];
      const b: string[] = [];
      const unsubA = tm.subscribe(SESSION_ID, undefined, (d) => a.push(d));
      tm.subscribe(SESSION_ID, undefined, (d) => b.push(d));

      const pty = ptyInstances[0];
      pty.emitData("x");
      unsubA();
      pty.emitData("y");

      // Subscriber A only saw x; subscriber B saw both. PTY stays alive.
      expect(a).toEqual(["x"]);
      expect(b).toEqual(["x", "y"]);
      expect(pty.killed).toBe(false);
    });
  });
});
