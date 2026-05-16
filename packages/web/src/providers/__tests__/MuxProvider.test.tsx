import React from "react";
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MuxProvider, useMux, useMuxOptional } from "../MuxProvider";

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState: number = MockWebSocket.CONNECTING;
  url: string;
  sentMessages: string[] = [];

  private _listeners: Map<string, Set<(e: Event) => void>> = new Map();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (e: Event) => void) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: (e: Event) => void) {
    this._listeners.get(type)?.delete(listener);
  }

  send(data: string) {
    this.sentMessages.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this._dispatch("close", new CloseEvent("close", { code: 1000, wasClean: true }));
  }

  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this._dispatch("open", new Event("open"));
  }

  simulateMessage(data: object) {
    this._dispatch("message", new MessageEvent("message", { data: JSON.stringify(data) }));
  }

  simulateClose(code = 1006) {
    this.readyState = MockWebSocket.CLOSED;
    this._dispatch("close", new CloseEvent("close", { code }));
  }

  simulateError() {
    this._dispatch("error", new Event("error"));
  }

  private _dispatch(type: string, event: Event) {
    for (const listener of this._listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wrapper({ children }: { children: React.ReactNode }) {
  return <MuxProvider>{children}</MuxProvider>;
}

/**
 * Flush the MuxProvider's async init (fetch → connect).
 * Two promise ticks: one for `await fetch(...)`, one for `await res.json()`.
 */
async function flushInit() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve(); // extra flush for connect() state updates
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.stubGlobal("WebSocket", MockWebSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ proxyWsPath: "/ao-terminal-ws" }),
    })),
  );
});

afterEach(() => {
  vi.useRealTimers(); // always restore timers even if a test fails mid-way
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// useMux — outside provider
// ---------------------------------------------------------------------------

describe("useMux outside provider", () => {
  it("throws when used outside MuxProvider", () => {
    expect(() => renderHook(() => useMux())).toThrow("useMux() must be used within <MuxProvider>");
  });
});

describe("useMuxOptional", () => {
  it("returns undefined outside MuxProvider", () => {
    const { result } = renderHook(() => useMuxOptional());
    expect(result.current).toBeUndefined();
  });

  it("returns context value inside MuxProvider", async () => {
    const { result } = renderHook(() => useMuxOptional(), { wrapper });
    await flushInit();
    expect(result.current).toBeDefined();
    expect(result.current!.status).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

describe("MuxProvider connection lifecycle", () => {
  it("starts with connecting status", () => {
    const { result } = renderHook(() => useMux(), { wrapper });
    expect(result.current.status).toBe("connecting");
  });

  it("transitions to connected when WebSocket opens", async () => {
    const { result } = renderHook(() => useMux(), { wrapper });
    await flushInit();

    expect(MockWebSocket.instances.length).toBeGreaterThan(0);
    const ws = MockWebSocket.instances[0];

    act(() => ws.simulateOpen());
    expect(result.current.status).toBe("connected");
  });

  it("sends session subscribe message on open", async () => {
    renderHook(() => useMux(), { wrapper });
    await flushInit();

    const ws = MockWebSocket.instances[0];
    act(() => ws.simulateOpen());

    const subMsg = ws.sentMessages.find((m) => {
      const p = JSON.parse(m) as Record<string, unknown>;
      return p.ch === "subscribe";
    });
    expect(subMsg).toBeDefined();
    expect((JSON.parse(subMsg!) as Record<string, unknown>).topics).toContain("sessions");
  });

  it("transitions to reconnecting on close", async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useMux(), { wrapper });
      await flushInit();

      expect(MockWebSocket.instances.length).toBeGreaterThan(0);
      const ws = MockWebSocket.instances[0];
      act(() => ws.simulateOpen());
      expect(result.current.status).toBe("connected");

      act(() => ws.simulateClose());
      expect(result.current.status).toBe("reconnecting");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconnects after backoff delay", async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useMux(), { wrapper });
      await flushInit();

      const ws = MockWebSocket.instances[0];
      act(() => ws.simulateOpen());
      expect(result.current.status).toBe("connected");

      act(() => ws.simulateClose());
      expect(result.current.status).toBe("reconnecting");

      // First reconnect fires after 1000ms
      act(() => vi.advanceTimersByTime(1100));
      await flushInit();

      expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reconnect after unmount", async () => {
    vi.useFakeTimers();
    try {
      const { result, unmount } = renderHook(() => useMux(), { wrapper });
      await flushInit();

      const ws = MockWebSocket.instances[0];
      act(() => ws.simulateOpen());
      expect(result.current.status).toBe("connected");

      unmount();
      const countAtUnmount = MockWebSocket.instances.length;

      act(() => ws.simulateClose());
      act(() => vi.advanceTimersByTime(5000));
      await flushInit();

      expect(MockWebSocket.instances.length).toBe(countAtUnmount);
    } finally {
      vi.useRealTimers();
    }
  });

  it("builds proxyWsPath URL from runtime config", async () => {
    renderHook(() => useMux(), { wrapper });
    await flushInit();

    expect(MockWebSocket.instances.length).toBeGreaterThan(0);
    // proxyWsPath "/ao-terminal-ws" → basePath "/ao-terminal-ws" → URL ends with /ao-terminal-ws/mux
    expect(MockWebSocket.instances[0].url).toContain("/mux");
  });

  it("falls back gracefully when fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network");
      }),
    );
    renderHook(() => useMux(), { wrapper });
    await flushInit();
    // Still creates a WebSocket (using defaults)
    expect(MockWebSocket.instances.length).toBeGreaterThan(0);
  });

  it("sets disconnected status when WebSocket constructor throws", async () => {
    vi.stubGlobal(
      "WebSocket",
      vi.fn(() => {
        throw new Error("unavailable");
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false })),
    );
    const { result } = renderHook(() => useMux(), { wrapper });
    await flushInit();
    expect(result.current.status).toBe("disconnected");
  });

  it("re-opens previously opened terminals on reconnect", async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useMux(), { wrapper });
      await flushInit();

      const ws1 = MockWebSocket.instances[0];
      act(() => ws1.simulateOpen());
      expect(result.current.status).toBe("connected");

      act(() => result.current.openTerminal("session-abc", "project-a", "tmux.session abc"));
      // Confirm open message sent on ws1
      expect(
        ws1.sentMessages.some((m) => {
          const p = JSON.parse(m) as Record<string, unknown>;
          return (
            p.ch === "terminal" &&
            p.type === "open" &&
            p.id === "session-abc" &&
            p.projectId === "project-a" &&
            p.tmuxName === "tmux.session abc"
          );
        }),
      ).toBe(true);

      // Disconnect + reconnect
      act(() => ws1.simulateClose());
      act(() => vi.advanceTimersByTime(1100));
      await flushInit();

      expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);
      const ws2 = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      act(() => ws2.simulateOpen());

      // session-abc should be re-opened on ws2
      expect(
        ws2.sentMessages.some((m) => {
          const p = JSON.parse(m) as Record<string, unknown>;
          return (
            p.ch === "terminal" &&
            p.type === "open" &&
            p.id === "session-abc" &&
            p.projectId === "project-a" &&
            p.tmuxName === "tmux.session abc"
          );
        }),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores open event after unmount (isDestroyedRef guard)", async () => {
    const { unmount } = renderHook(() => useMux(), { wrapper });
    await flushInit();

    expect(MockWebSocket.instances.length).toBeGreaterThan(0);
    const ws = MockWebSocket.instances[0];

    unmount();
    // Simulate late open after unmount — provider should close the socket
    act(() => ws.simulateOpen());

    // The guard closes it
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
  });
});

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

describe("MuxProvider message handling", () => {
  async function setupConnected() {
    const { result } = renderHook(() => useMux(), { wrapper });
    await flushInit();
    const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    act(() => ws.simulateOpen());
    expect(result.current.status).toBe("connected");
    return { result, ws };
  }

  it("dispatches terminal data to subscribers", async () => {
    const { result, ws } = await setupConnected();

    const received: string[] = [];
    act(() => {
      result.current.subscribeTerminal("s1", (d) => received.push(d), "project-a");
    });
    act(() =>
      ws.simulateMessage({
        ch: "terminal",
        id: "s1",
        projectId: "project-a",
        type: "data",
        data: "hello",
      }),
    );

    expect(received).toContain("hello");
  });

  it("tracks opened terminals on 'opened' message", async () => {
    vi.useFakeTimers();
    try {
      renderHook(() => useMux(), { wrapper });
      await flushInit();

      const ws1 = MockWebSocket.instances[0];
      act(() => ws1.simulateOpen());

      act(() =>
        ws1.simulateMessage({ ch: "terminal", id: "s1", projectId: "project-a", type: "opened" }),
      );

      // Reconnect → s1 should be re-opened
      act(() => ws1.simulateClose());
      act(() => vi.advanceTimersByTime(1100));
      await flushInit();

      const ws2 = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      act(() => ws2.simulateOpen());

      expect(
        ws2.sentMessages.some((m) => {
          const p = JSON.parse(m) as Record<string, unknown>;
          return p.ch === "terminal" && p.id === "s1" && p.projectId === "project-a";
        }),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispatches exit notice to subscribers on 'exited' message", async () => {
    const { result, ws } = await setupConnected();

    const received: string[] = [];
    act(() => {
      result.current.subscribeTerminal("s1", (d) => received.push(d), "project-a");
    });
    act(() =>
      ws.simulateMessage({
        ch: "terminal",
        id: "s1",
        projectId: "project-a",
        type: "exited",
        code: 1,
      }),
    );

    expect(received.some((m) => m.includes("exited"))).toBe(true);
  });

  it("removes exited terminal from opened set", async () => {
    vi.useFakeTimers();
    try {
      renderHook(() => useMux(), { wrapper });
      await flushInit();

      const ws1 = MockWebSocket.instances[0];
      act(() => ws1.simulateOpen());

      act(() =>
        ws1.simulateMessage({ ch: "terminal", id: "s-x", projectId: "project-a", type: "opened" }),
      );
      act(() =>
        ws1.simulateMessage({
          ch: "terminal",
          id: "s-x",
          projectId: "project-a",
          type: "exited",
          code: 0,
        }),
      );

      // Reconnect — s-x should NOT be re-opened
      act(() => ws1.simulateClose());
      act(() => vi.advanceTimersByTime(1100));
      await flushInit();

      const ws2 = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      act(() => ws2.simulateOpen());

      const reopened = ws2.sentMessages.some((m) => {
        const p = JSON.parse(m) as Record<string, unknown>;
        return (
          p.ch === "terminal" && p.id === "s-x" && p.projectId === "project-a" && p.type === "open"
        );
      });
      expect(reopened).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs terminal error without crashing", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result, ws } = await setupConnected();

    act(() =>
      ws.simulateMessage({
        ch: "terminal",
        id: "s1",
        projectId: "project-a",
        type: "error",
        message: "PTY failed",
      }),
    );
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Terminal error"), expect.any(String));
    expect(result.current.status).toBe("connected");
    spy.mockRestore();
  });

  it("updates sessions on snapshot message", async () => {
    const { result, ws } = await setupConnected();

    act(() =>
      ws.simulateMessage({
        ch: "sessions",
        type: "snapshot",
        sessions: [
          {
            id: "s1",
            status: "working",
            activity: null,
            attentionLevel: "working",
            lastActivityAt: "",
          },
        ],
      }),
    );

    expect(result.current.sessions.length).toBe(1);
    expect(result.current.sessions[0].id).toBe("s1");
  });

  it("handles malformed JSON message without crashing", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = await setupConnected();

    // Manually dispatch a bad MessageEvent
    act(() => {
      const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      const bad = new MessageEvent("message", { data: "not-json{{" });
      (ws as unknown as { _dispatch: (t: string, e: Event) => void })._dispatch("message", bad);
    });

    expect(result.current.status).toBe("connected");
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Terminal operations
// ---------------------------------------------------------------------------

describe("MuxProvider terminal operations", () => {
  async function setupConnected() {
    const { result } = renderHook(() => useMux(), { wrapper });
    await flushInit();
    const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    act(() => ws.simulateOpen());
    return { result, ws };
  }

  it("writeTerminal sends data message", async () => {
    const { result, ws } = await setupConnected();
    act(() => result.current.writeTerminal("s1", "hello\n", "project-a"));
    expect(
      ws.sentMessages.some((m) => {
        const p = JSON.parse(m) as Record<string, unknown>;
        return (
          p.ch === "terminal" &&
          p.type === "data" &&
          p.id === "s1" &&
          p.projectId === "project-a" &&
          p.data === "hello\n"
        );
      }),
    ).toBe(true);
  });

  it("writeTerminal is no-op when WebSocket is not open", async () => {
    const { result } = renderHook(() => useMux(), { wrapper });
    // Don't flush init or open the WebSocket
    act(() => result.current.writeTerminal("s1", "hello\n", "project-a"));
    // No crash
    expect(result.current.status).toBe("connecting");
  });

  it("openTerminal sends open message when connected", async () => {
    const { result, ws } = await setupConnected();
    act(() => result.current.openTerminal("session-abc", "project-a", "tmux.session abc"));
    expect(
      ws.sentMessages.some((m) => {
        const p = JSON.parse(m) as Record<string, unknown>;
        return (
          p.ch === "terminal" &&
          p.type === "open" &&
          p.id === "session-abc" &&
          p.projectId === "project-a" &&
          p.tmuxName === "tmux.session abc"
        );
      }),
    ).toBe(true);
  });

  it("closeTerminal sends close message", async () => {
    const { result, ws } = await setupConnected();
    act(() => result.current.openTerminal("session-abc", "project-a", "tmux.session abc"));
    act(() => result.current.closeTerminal("session-abc", "project-a"));
    expect(
      ws.sentMessages.some((m) => {
        const p = JSON.parse(m) as Record<string, unknown>;
        return (
          p.ch === "terminal" &&
          p.type === "close" &&
          p.id === "session-abc" &&
          p.projectId === "project-a"
        );
      }),
    ).toBe(true);
  });

  it("resizeTerminal sends resize message with cols and rows", async () => {
    const { result, ws } = await setupConnected();
    act(() => result.current.resizeTerminal("session-abc", 120, 40, "project-a"));
    expect(
      ws.sentMessages.some((m) => {
        const p = JSON.parse(m) as Record<string, unknown>;
        return (
          p.ch === "terminal" &&
          p.type === "resize" &&
          p.id === "session-abc" &&
          p.projectId === "project-a" &&
          p.cols === 120 &&
          p.rows === 40
        );
      }),
    ).toBe(true);
  });

  it("subscribeTerminal sends open for untracked terminal", async () => {
    const { result, ws } = await setupConnected();
    act(() => {
      result.current.subscribeTerminal("session-new", () => {}, "project-a");
    });
    expect(
      ws.sentMessages.some((m) => {
        const p = JSON.parse(m) as Record<string, unknown>;
        return (
          p.ch === "terminal" &&
          p.type === "open" &&
          p.id === "session-new" &&
          p.projectId === "project-a"
        );
      }),
    ).toBe(true);
  });

  it("subscribeTerminal unsubscribe stops data delivery", async () => {
    const { result, ws } = await setupConnected();
    const received: string[] = [];
    let unsub!: () => void;

    act(() => {
      unsub = result.current.subscribeTerminal("s1", (d) => received.push(d), "project-a");
    });
    act(() =>
      ws.simulateMessage({
        ch: "terminal",
        id: "s1",
        projectId: "project-a",
        type: "data",
        data: "before",
      }),
    );
    act(() => unsub());
    act(() =>
      ws.simulateMessage({
        ch: "terminal",
        id: "s1",
        projectId: "project-a",
        type: "data",
        data: "after",
      }),
    );

    expect(received).toContain("before");
    expect(received).not.toContain("after");
  });

  it("keeps terminal subscribers scoped by project id", async () => {
    const { result, ws } = await setupConnected();
    const alpha: string[] = [];
    const beta: string[] = [];

    act(() => {
      result.current.subscribeTerminal("app-1", (data) => alpha.push(data), "alpha");
      result.current.subscribeTerminal("app-1", (data) => beta.push(data), "beta");
    });

    act(() =>
      ws.simulateMessage({
        ch: "terminal",
        id: "app-1",
        projectId: "alpha",
        type: "data",
        data: "a",
      }),
    );
    act(() =>
      ws.simulateMessage({
        ch: "terminal",
        id: "app-1",
        projectId: "beta",
        type: "data",
        data: "b",
      }),
    );

    expect(alpha).toEqual(["a"]);
    expect(beta).toEqual(["b"]);
    expect(
      ws.sentMessages.some((m) => {
        const p = JSON.parse(m) as Record<string, unknown>;
        return (
          p.ch === "terminal" && p.type === "open" && p.id === "app-1" && p.projectId === "alpha"
        );
      }),
    ).toBe(true);
    expect(
      ws.sentMessages.some((m) => {
        const p = JSON.parse(m) as Record<string, unknown>;
        return (
          p.ch === "terminal" && p.type === "open" && p.id === "app-1" && p.projectId === "beta"
        );
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildMuxWsUrl — via provider behaviour
// ---------------------------------------------------------------------------

describe("buildMuxWsUrl", () => {
  it("uses directTerminalPort from runtime config when on a custom port", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ directTerminalPort: 14802 }) })),
    );
    Object.defineProperty(window, "location", {
      writable: true,
      value: { protocol: "http:", host: "localhost:3000", hostname: "localhost", port: "3000" },
    });
    renderHook(() => useMux(), { wrapper });
    await flushInit();
    expect(MockWebSocket.instances[0].url).toContain(":14802/mux");
    Object.defineProperty(window, "location", {
      writable: true,
      value: { protocol: "http:", host: "localhost", hostname: "localhost", port: "" },
    });
  });

  it("uses path-based URL when port is empty (reverse proxy)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false })),
    );
    Object.defineProperty(window, "location", {
      writable: true,
      value: { protocol: "http:", host: "localhost", hostname: "localhost", port: "" },
    });
    renderHook(() => useMux(), { wrapper });
    await flushInit();
    expect(MockWebSocket.instances[0].url).toMatch(/\/ao-terminal-mux$/);
  });
});
