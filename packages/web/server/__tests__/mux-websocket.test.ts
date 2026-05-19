import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { WebSocket } from "ws";
import type { SessionBroadcaster as SessionBroadcasterType } from "../mux-websocket";

// vi.mock factories run before module-level statements. Hoist the mock
// fns so the factories close over the same instances the tests use.
const { mockSpawn, mockPtySpawn, mockTmuxHasSession, recordActivityEvent } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockPtySpawn: vi.fn(),
  mockTmuxHasSession: vi.fn(),
  recordActivityEvent: vi.fn(),
}));

vi.mock("@aoagents/ao-core", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    recordActivityEvent: (event: unknown) => recordActivityEvent(event),
  };
});

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
  resolvePipePath: () => null,
  tmuxHasSession: (...args: unknown[]) => mockTmuxHasSession(...args),
}));

const { SessionBroadcaster, TerminalManager, createMuxWebSocket, handleWindowsPipeMessage } =
  await import("../mux-websocket");

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

type MockPty = {
  dataHandlers: Array<(data: string) => void>;
  exitHandlers: Array<(event: { exitCode: number }) => void>;
  onData: ReturnType<typeof vi.fn>;
  onExit: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  emitData: (data: string) => void;
  emitExit: (exitCode: number) => Promise<void>;
};

const ptyInstances: MockPty[] = [];

function createMockPty(): MockPty {
  const pty = {} as MockPty;
  pty.dataHandlers = [];
  pty.exitHandlers = [];
  pty.onData = vi.fn((handler: (data: string) => void) => {
    pty.dataHandlers.push(handler);
  });
  pty.onExit = vi.fn((handler: (event: { exitCode: number }) => void) => {
    pty.exitHandlers.push(handler);
  });
  pty.write = vi.fn();
  pty.resize = vi.fn();
  pty.kill = vi.fn();
  pty.emitData = (data: string) => {
    for (const handler of pty.dataHandlers) handler(data);
  };
  pty.emitExit = async (exitCode: number) => {
    await Promise.all([...pty.exitHandlers].map((handler) => handler({ exitCode })));
  };
  ptyInstances.push(pty);
  return pty;
}

function resetPtyMock(): void {
  ptyInstances.length = 0;
  mockSpawn.mockReset();
  mockPtySpawn.mockReset();
  mockTmuxHasSession.mockReset();
  mockTmuxHasSession.mockResolvedValue(true);
  mockSpawn.mockImplementation(() => new EventEmitter());
  mockPtySpawn.mockImplementation(createMockPty);
}

describe("SessionBroadcaster", () => {
  let broadcaster: SessionBroadcasterType;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch.mockReset();
    recordActivityEvent.mockClear();
    resetPtyMock();
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

  describe("ui.session_broadcast_failed activity events", () => {
    function failedKinds(): string[] {
      return recordActivityEvent.mock.calls
        .map(([e]) => (e as { kind: string }).kind)
        .filter((k) => k === "ui.session_broadcast_failed");
    }

    it("emits exactly once on the healthy→failing transition", async () => {
      // First fetch fails — triggers emission
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      // Second fetch (3s later) also fails — should NOT emit again
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      broadcaster.subscribe(vi.fn());
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(3010);

      expect(failedKinds()).toEqual(["ui.session_broadcast_failed"]);
    });

    it("re-arms after recovery (success → failure emits again)", async () => {
      // fail → succeed → fail
      mockFetch.mockRejectedValueOnce(new Error("net down"));
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ sessions: [] }) });
      mockFetch.mockRejectedValueOnce(new Error("net down again"));

      broadcaster.subscribe(vi.fn());
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(3010); // poll #1 → success
      await vi.advanceTimersByTimeAsync(3010); // poll #2 → failure

      expect(failedKinds().length).toBe(2);
    });

    it("emits with source=ui, level=warn, and the failure URL in data", async () => {
      mockFetch.mockRejectedValueOnce(new Error("ETIMEDOUT"));

      broadcaster.subscribe(vi.fn());
      await vi.advanceTimersByTimeAsync(10);

      expect(recordActivityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "ui",
          kind: "ui.session_broadcast_failed",
          level: "warn",
        }),
      );
      const call = recordActivityEvent.mock.calls.find(
        ([e]) => (e as { kind: string }).kind === "ui.session_broadcast_failed",
      )![0] as { data: Record<string, unknown> };
      expect(call.data["url"]).toContain("/api/sessions/patches");
      expect(call.data["errorMessage"]).toContain("ETIMEDOUT");
    });

    it("includes httpStatus when fetch returns non-OK response", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });

      broadcaster.subscribe(vi.fn());
      await vi.advanceTimersByTimeAsync(10);

      const call = recordActivityEvent.mock.calls.find(
        ([e]) => (e as { kind: string }).kind === "ui.session_broadcast_failed",
      )![0] as { data: Record<string, unknown> };
      expect(call.data["httpStatus"]).toBe(503);
    });
  });
});

// ── Connection-level activity events ──────────────────────────────────
// These verify ui.terminal_* events fire at the right WS lifecycle points.
// We exercise the connection handler directly by emitting "connection" on
// the WebSocketServer and feeding a fake ws + IncomingMessage stand-in.

class FakeWS extends EventEmitter {
  readyState: 0 | 1 | 2 | 3 = WebSocket.OPEN;
  bufferedAmount = 0;
  ping = vi.fn();
  terminate = vi.fn(() => {
    this.readyState = WebSocket.CLOSED;
  });
  send = vi.fn();
}

class FakePipeSocket extends EventEmitter {
  write = vi.fn();
  end = vi.fn(() => {
    this.emit("close");
  });
  destroy = vi.fn(() => {
    this.emit("close");
  });
}

function makeFakeRequest(opts?: { remoteAddress?: string; xff?: string }) {
  return {
    headers: opts?.xff ? { "x-forwarded-for": opts.xff } : {},
    socket: { remoteAddress: opts?.remoteAddress ?? "127.0.0.1" },
  };
}

describe("mux WebSocket connection events", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    recordActivityEvent.mockClear();
    resetPtyMock();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function emitConnection(opts?: Parameters<typeof makeFakeRequest>[0]) {
    const wss = createMuxWebSocket();
    if (!wss) {
      throw new Error("mux WS server not created — node-pty unavailable");
    }
    const ws = new FakeWS();
    wss.emit("connection", ws as unknown as WebSocket, makeFakeRequest(opts));
    return { wss, ws };
  }

  function findEvent(kind: string): { data: Record<string, unknown> } | undefined {
    const found = recordActivityEvent.mock.calls.find(
      ([e]) => (e as { kind: string }).kind === kind,
    );
    return found?.[0] as { data: Record<string, unknown> } | undefined;
  }

  it("emits ui.terminal_connected on a new mux connection (with remoteAddr)", () => {
    emitConnection({ xff: "198.51.100.5, 10.0.0.1" });

    expect(recordActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ source: "ui", kind: "ui.terminal_connected" }),
    );
    const evt = findEvent("ui.terminal_connected")!;
    expect(evt.data["remoteAddr"]).toBe("198.51.100.5");
  });

  it("emits ui.terminal_disconnected exactly once on close", () => {
    const { ws } = emitConnection();
    recordActivityEvent.mockClear();

    ws.emit("close", 1000, Buffer.from("normal"));

    const calls = recordActivityEvent.mock.calls.filter(
      ([e]) => (e as { kind: string }).kind === "ui.terminal_disconnected",
    );
    expect(calls.length).toBe(1);
    const evt = findEvent("ui.terminal_disconnected")!;
    expect(evt.data["code"]).toBe(1000);
    expect(evt.data["reason"]).toBe("normal");
  });

  it("emits ui.terminal_heartbeat_lost once on 3 missed pongs and terminates", () => {
    const { ws } = emitConnection();
    recordActivityEvent.mockClear();

    // Each 15s interval sends a ping and increments missedPongs by 1.
    // After 3 ticks (45s) it should hit MAX_MISSED_PONGS=3 and terminate.
    vi.advanceTimersByTime(15_000);
    vi.advanceTimersByTime(15_000);
    vi.advanceTimersByTime(15_000);

    const calls = recordActivityEvent.mock.calls.filter(
      ([e]) => (e as { kind: string }).kind === "ui.terminal_heartbeat_lost",
    );
    expect(calls.length).toBe(1);
    expect(ws.terminate).toHaveBeenCalled();

    // Issue invariant: at most one emit per state change — extra ticks must not
    // produce another event.
    vi.advanceTimersByTime(15_000);
    expect(
      recordActivityEvent.mock.calls.filter(
        ([e]) => (e as { kind: string }).kind === "ui.terminal_heartbeat_lost",
      ).length,
    ).toBe(1);
  });

  it("does NOT emit heartbeat_lost when pong arrives before 3 missed pings", () => {
    const { ws } = emitConnection();
    recordActivityEvent.mockClear();

    vi.advanceTimersByTime(15_000); // missedPongs=1
    ws.emit("pong"); // resets to 0
    vi.advanceTimersByTime(15_000); // missedPongs=1
    vi.advanceTimersByTime(15_000); // missedPongs=2

    expect(
      recordActivityEvent.mock.calls.filter(
        ([e]) => (e as { kind: string }).kind === "ui.terminal_heartbeat_lost",
      ).length,
    ).toBe(0);
    expect(ws.terminate).not.toHaveBeenCalled();
  });

  it("emits ui.terminal_protocol_error on malformed client message", () => {
    const { ws } = emitConnection();
    recordActivityEvent.mockClear();

    ws.emit("message", Buffer.from("not-json{{{"));

    const calls = recordActivityEvent.mock.calls.filter(
      ([e]) => (e as { kind: string }).kind === "ui.terminal_protocol_error",
    );
    expect(calls.length).toBe(1);
    const evt = findEvent("ui.terminal_protocol_error")!;
    expect(evt.data["errorMessage"]).toBeTruthy();
  });
});

describe("Windows pipe ui.terminal_pty_lost activity events", () => {
  beforeEach(() => {
    recordActivityEvent.mockClear();
  });

  function framedMessage(type: number, payload: unknown): Buffer {
    const body = Buffer.from(JSON.stringify(payload), "utf-8");
    const header = Buffer.alloc(5);
    header.writeUInt8(type, 0);
    header.writeUInt32BE(body.length, 1);
    return Buffer.concat([header, body]);
  }

  function openPipe() {
    const ws = new FakeWS();
    const pipe = new FakePipeSocket();
    const winPipes = new Map<string, Socket>();
    const winPipeBuffers = new Map<string, Buffer>();
    const deps = {
      connect: vi.fn(() => pipe as unknown as Socket),
      resolvePipePath: vi.fn(() => "\\\\.\\pipe\\ao-pty-app-1"),
    };

    handleWindowsPipeMessage(
      { id: "app-1", type: "open", projectId: "proj-1" },
      ws,
      winPipes,
      winPipeBuffers,
      deps,
    );
    pipe.emit("connect");
    recordActivityEvent.mockClear();
    ws.send.mockClear();

    return { ws, pipe, winPipes, winPipeBuffers, deps };
  }

  function ptyLostEvents(): Array<{ data: Record<string, unknown>; sessionId?: string }> {
    return recordActivityEvent.mock.calls
      .map(([e]) => e as { kind: string; data: Record<string, unknown>; sessionId?: string })
      .filter((event) => event.kind === "ui.terminal_pty_lost");
  }

  it("emits ui.terminal_pty_lost when the PTY host pipe closes while the socket is open", () => {
    const { ws, pipe } = openPipe();

    pipe.emit("close");

    expect(ptyLostEvents()).toEqual([
      expect.objectContaining({
        sessionId: "app-1",
        data: expect.objectContaining({
          sessionId: "app-1",
          transport: "windows_pipe",
          reason: "pipe_closed",
        }),
      }),
    ]);
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ ch: "terminal", id: "app-1", type: "exited", code: 0, projectId: "proj-1" }),
    );
  });

  it("emits ui.terminal_pty_lost when the PTY host reports not alive", () => {
    const { ws, pipe } = openPipe();

    pipe.emit("data", framedMessage(0x07, { alive: false }));
    pipe.emit("close");

    const events = ptyLostEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(
      expect.objectContaining({
        sessionId: "app-1",
        data: expect.objectContaining({
          sessionId: "app-1",
          transport: "windows_pipe",
          reason: "host_not_alive",
        }),
      }),
    );
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ ch: "terminal", id: "app-1", type: "exited", code: 0, projectId: "proj-1" }),
    );
  });

  it("does not emit ui.terminal_pty_lost for an intentional client close", () => {
    const { ws, winPipes, winPipeBuffers, deps } = openPipe();

    handleWindowsPipeMessage(
      { id: "app-1", type: "close", projectId: "proj-1" },
      ws,
      winPipes,
      winPipeBuffers,
      deps,
    );

    expect(ptyLostEvents()).toEqual([]);
  });
});

describe("TerminalManager ui.terminal_pty_lost activity events", () => {
  beforeEach(() => {
    recordActivityEvent.mockClear();
    resetPtyMock();
  });

  function ptyLostEvents(): Array<{ data: Record<string, unknown>; sessionId?: string }> {
    return recordActivityEvent.mock.calls
      .map(([e]) => e as { kind: string; data: Record<string, unknown>; sessionId?: string })
      .filter((event) => event.kind === "ui.terminal_pty_lost");
  }

  it("emits ui.terminal_pty_lost when a subscribed PTY exits and reattach fails", async () => {
    const manager = new TerminalManager("/usr/bin/tmux");
    manager.open("app-1", "proj-1", "tmux-app-1");
    const pty = ptyInstances[0];
    expect(pty).toBeDefined();

    manager.subscribe("app-1", "proj-1", vi.fn(), vi.fn());
    mockPtySpawn.mockImplementationOnce(() => {
      throw new Error("reattach unavailable");
    });

    await pty!.emitExit(9);

    const events = ptyLostEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(
      expect.objectContaining({
        sessionId: "app-1",
        data: expect.objectContaining({
          sessionId: "app-1",
          exitCode: 9,
          subscriberCount: 1,
          reattachError: "reattach unavailable",
        }),
      }),
    );
  });

  it("emits ui.terminal_pty_lost when a subscribed PTY exits and reattach succeeds", async () => {
    const manager = new TerminalManager("/usr/bin/tmux");
    manager.open("app-1", "proj-1", "tmux-app-1");
    const pty = ptyInstances[0];
    expect(pty).toBeDefined();

    manager.subscribe("app-1", "proj-1", vi.fn(), vi.fn());

    await pty!.emitExit(9);

    const events = ptyLostEvents();
    expect(mockPtySpawn).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(
      expect.objectContaining({
        sessionId: "app-1",
        data: expect.objectContaining({
          sessionId: "app-1",
          exitCode: 9,
          subscriberCount: 1,
          reattachRecovered: true,
          reattachExhausted: false,
        }),
      }),
    );
  });

  it("does not emit ui.terminal_pty_lost when the last subscriber already left", async () => {
    const manager = new TerminalManager("/usr/bin/tmux");
    manager.open("app-1", "proj-1", "tmux-app-1");
    const pty = ptyInstances[0];
    expect(pty).toBeDefined();

    const unsubscribe = manager.subscribe("app-1", "proj-1", vi.fn(), vi.fn());
    unsubscribe();

    await pty!.emitExit(0);

    expect(ptyLostEvents()).toEqual([]);
  });

  it("emits ui.terminal_pty_lost at most once across reattach cycles", async () => {
    const manager = new TerminalManager("/usr/bin/tmux");
    manager.open("app-1", "proj-1", "tmux-app-1");
    const firstPty = ptyInstances[0];
    expect(firstPty).toBeDefined();

    manager.subscribe("app-1", "proj-1", vi.fn(), vi.fn());
    mockPtySpawn.mockImplementationOnce(() => {
      throw new Error("first reattach unavailable");
    });
    await firstPty!.emitExit(7);
    expect(ptyLostEvents()).toHaveLength(1);

    // A client may try to re-open the terminal after the first PTY loss.
    // A second failed reattach should not produce another activity event for
    // the same terminal entry.
    manager.open("app-1", "proj-1", "tmux-app-1");
    const secondPty = ptyInstances[1];
    expect(secondPty).toBeDefined();
    mockPtySpawn.mockImplementationOnce(() => {
      throw new Error("second reattach unavailable");
    });
    await secondPty!.emitExit(8);

    expect(ptyLostEvents()).toHaveLength(1);
  });

  it("re-arms ui.terminal_pty_lost after a successful reattach survives the grace period", async () => {
    vi.useFakeTimers();
    try {
      const manager = new TerminalManager("/usr/bin/tmux");
      manager.open("app-1", "proj-1", "tmux-app-1");
      const firstPty = ptyInstances[0];
      expect(firstPty).toBeDefined();

      manager.subscribe("app-1", "proj-1", vi.fn(), vi.fn());
      await firstPty!.emitExit(7);
      expect(ptyLostEvents()).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(5_000);

      const secondPty = ptyInstances[1];
      expect(secondPty).toBeDefined();
      await secondPty!.emitExit(8);

      expect(ptyLostEvents()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
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

describe("TerminalManager.open — re-attach skipped when tmux session is gone (regression for #1756)", () => {
  // Captures the latest onExit callback registered by ptySpawn so tests can
  // synthesise a PTY exit without spawning a real process. The handler is
  // async (so it can await the promisified has-session probe), so tests
  // await its return value before asserting.
  let capturedOnExit: ((evt: { exitCode: number }) => Promise<void> | void) | undefined;

  beforeEach(() => {
    mockSpawn.mockReset();
    mockPtySpawn.mockReset();
    mockTmuxHasSession.mockReset();
    recordActivityEvent.mockClear();
    capturedOnExit = undefined;

    mockSpawn.mockImplementation(() => new EventEmitter());
    mockPtySpawn.mockImplementation(() => ({
      onData: vi.fn(),
      onExit: vi.fn((cb: (evt: { exitCode: number }) => Promise<void> | void) => {
        capturedOnExit = cb;
      }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    }));
  });

  it("skips re-attach and notifies subscribers when has-session reports the tmux session is gone", async () => {
    const mgr = new TerminalManager("/usr/bin/tmux");
    const exitCb = vi.fn();
    mgr.subscribe("ao-177", undefined, vi.fn(), exitCb);

    expect(mockPtySpawn).toHaveBeenCalledTimes(1);
    expect(capturedOnExit).toBeDefined();

    mockTmuxHasSession.mockResolvedValueOnce(false);
    await capturedOnExit!({ exitCode: 0 });

    // No second attach-session was spawned — the re-attach loop was skipped.
    expect(mockPtySpawn).toHaveBeenCalledTimes(1);
    // Subscribers were notified with the original exit code.
    expect(exitCb).toHaveBeenCalledTimes(1);
    expect(exitCb).toHaveBeenCalledWith(0);
    expect(recordActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "ui",
        kind: "ui.terminal_pty_lost",
        level: "warn",
        sessionId: "ao-177",
        data: expect.objectContaining({
          sessionId: "ao-177",
          exitCode: 0,
          reattachSkipped: true,
          tmuxSessionPresent: false,
        }),
      }),
    );
  });

  it("still re-attaches when has-session reports the tmux session is alive", async () => {
    const mgr = new TerminalManager("/usr/bin/tmux");
    const exitCb = vi.fn();
    mgr.subscribe("ao-177", undefined, vi.fn(), exitCb);

    expect(mockPtySpawn).toHaveBeenCalledTimes(1);

    mockTmuxHasSession.mockResolvedValueOnce(true);
    await capturedOnExit!({ exitCode: 1 });

    // Re-attach happened: ptySpawn called a second time, exit not yet notified.
    expect(mockPtySpawn).toHaveBeenCalledTimes(2);
    expect(exitCb).not.toHaveBeenCalled();
  });
});
