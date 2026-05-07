import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { SessionBroadcaster as SessionBroadcasterType } from "../mux-websocket";

// vi.mock factories run before module-level statements. Hoist the mock
// fns so the factories close over the same instances the tests use.
const { mockSpawn, mockPtySpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockPtySpawn: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const spawnFn = (...args: unknown[]) => mockSpawn(...args);
  return {
    ...actual,
    default: { ...(actual.default as object), spawn: spawnFn },
    spawn: spawnFn,
  };
});

vi.mock("node-pty", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    spawn: (...args: unknown[]) => mockPtySpawn(...args),
  };
});

// Mock tmux-utils so resolveTmuxSession returns a deterministic session id
// and we don't shell out to a real tmux binary.
vi.mock("../tmux-utils.js", () => ({
  findTmux: () => "/usr/bin/tmux",
  validateSessionId: () => true,
  resolveTmuxSession: () => "ao-177",
}));

const { SessionBroadcaster, TerminalManager } = await import("../mux-websocket");

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("SessionBroadcaster", () => {
  let broadcaster: SessionBroadcasterType;

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

describe("TerminalManager.open — tmux target args (regression for #1714)", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    mockPtySpawn.mockReset();

    // spawn() returns an object that emits "error" — we just need .on() to work.
    mockSpawn.mockImplementation(() => new EventEmitter());

    // ptySpawn() returns a minimal IPty-like stub so terminal wiring doesn't crash.
    mockPtySpawn.mockImplementation(() => ({
      onData: vi.fn(),
      onExit: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    }));
  });

  it("invokes set-option mouse on with the bare session id (no = prefix)", () => {
    const mgr = new TerminalManager("/usr/bin/tmux");
    mgr.open("ao-177");

    const mouseCall = mockSpawn.mock.calls.find(
      (call) => Array.isArray(call[1]) && call[1].includes("mouse"),
    );
    expect(mouseCall).toBeDefined();
    expect(mouseCall?.[1]).toEqual(["set-option", "-t", "ao-177", "mouse", "on"]);
  });

  it("invokes set-option status off with the bare session id (no = prefix)", () => {
    const mgr = new TerminalManager("/usr/bin/tmux");
    mgr.open("ao-177");

    const statusCall = mockSpawn.mock.calls.find(
      (call) => Array.isArray(call[1]) && call[1].includes("status"),
    );
    expect(statusCall).toBeDefined();
    expect(statusCall?.[1]).toEqual(["set-option", "-t", "ao-177", "status", "off"]);
  });

  it("still uses the = exact-match prefix for attach-session", () => {
    const mgr = new TerminalManager("/usr/bin/tmux");
    mgr.open("ao-177");

    expect(mockPtySpawn).toHaveBeenCalledTimes(1);
    const [, args] = mockPtySpawn.mock.calls[0];
    expect(args).toEqual(["attach-session", "-t", "=ao-177"]);
  });
});

describe("TerminalManager — PTY idle grace period (issue #1718)", () => {
  // Stable mock fns shared across spawns within a single test, reset per test.
  // The unit under test relies on `pty.kill()` being called exactly once on
  // grace expiry, so kill needs a stable identity to count against.
  let ptyKill: ReturnType<typeof vi.fn>;
  let ptyOnData: ReturnType<typeof vi.fn>;
  let ptyOnExit: ReturnType<typeof vi.fn>;
  let manager: InstanceType<typeof TerminalManager>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockSpawn.mockReset();
    mockPtySpawn.mockReset();

    ptyKill = vi.fn();
    ptyOnData = vi.fn();
    ptyOnExit = vi.fn();

    mockSpawn.mockImplementation(() => new EventEmitter());
    mockPtySpawn.mockImplementation(() => ({
      onData: ptyOnData,
      onExit: ptyOnExit,
      write: vi.fn(),
      resize: vi.fn(),
      kill: ptyKill,
    }));

    manager = new TerminalManager("/usr/bin/tmux");
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("does not kill the PTY immediately when the last subscriber unsubscribes", () => {
    const unsub = manager.subscribe("ao-177", undefined, vi.fn());
    expect(mockPtySpawn).toHaveBeenCalledTimes(1);

    unsub();

    // PTY must remain alive during the grace window — killing here would
    // burn a fresh ptmx slot on the next reconnect (issue #1718).
    expect(ptyKill).not.toHaveBeenCalled();
  });

  it("kills the PTY after the grace period expires with no reconnect", () => {
    const unsub = manager.subscribe("ao-177", undefined, vi.fn());
    unsub();

    // Just before the window closes — still alive.
    vi.advanceTimersByTime(29_999);
    expect(ptyKill).not.toHaveBeenCalled();

    // Window closes — kill fires.
    vi.advanceTimersByTime(1);
    expect(ptyKill).toHaveBeenCalledTimes(1);
  });

  it("preserves the PTY when a new subscriber arrives within the grace window", () => {
    const unsub1 = manager.subscribe("ao-177", undefined, vi.fn());
    expect(mockPtySpawn).toHaveBeenCalledTimes(1);
    unsub1();

    // A reconnect lands halfway through the grace window.
    vi.advanceTimersByTime(15_000);
    const unsub2 = manager.subscribe("ao-177", undefined, vi.fn());

    // No new PTY allocated and the original is still alive — reconnect
    // reused the existing slot, which is the whole point of the fix.
    expect(mockPtySpawn).toHaveBeenCalledTimes(1);
    expect(ptyKill).not.toHaveBeenCalled();

    // After the original timer's deadline passes, the cancelled timer must
    // not retroactively kill the still-subscribed PTY.
    vi.advanceTimersByTime(60_000);
    expect(ptyKill).not.toHaveBeenCalled();

    unsub2();
  });

  it("only kills once when last subscriber leaves and grace expires", () => {
    const unsub1 = manager.subscribe("ao-177", undefined, vi.fn());
    const unsub2 = manager.subscribe("ao-177", undefined, vi.fn());

    unsub1();
    // First unsubscribe is not the last subscriber — no timer scheduled.
    vi.advanceTimersByTime(60_000);
    expect(ptyKill).not.toHaveBeenCalled();

    unsub2();
    // Now we are at zero subscribers — schedule the grace timer.
    vi.advanceTimersByTime(30_000);
    expect(ptyKill).toHaveBeenCalledTimes(1);
  });

  it("buffer is preserved across an unsubscribe/resubscribe within grace", () => {
    const cb = vi.fn();
    const unsub = manager.subscribe("ao-177", undefined, cb);

    // Simulate the PTY emitting some output by invoking the captured handler.
    const onDataHandler = ptyOnData.mock.calls[0]?.[0] as (data: string) => void;
    onDataHandler("hello");

    unsub();
    vi.advanceTimersByTime(10_000);

    // The terminal entry must still exist — buffered output is still there.
    expect(manager.getBuffer("ao-177")).toBe("hello");

    // After full grace expiry, the entry is cleaned up.
    vi.advanceTimersByTime(20_001);
    expect(manager.getBuffer("ao-177")).toBe("");
  });
});
