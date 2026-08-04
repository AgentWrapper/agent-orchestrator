import { afterEach, expect, it, vi } from "vitest";

import {
  clearCloudTerminalConnections,
  ensureCloudTerminalConnection,
  syncCloudTerminalConnections,
} from "./cloud-terminal-pool";

afterEach(() => {
  clearCloudTerminalConnections();
  vi.unstubAllGlobals();
});

it("does not attach hidden runtime terminals during status sync", () => {
  const api = {
    terminalTicket: vi.fn(),
  };

  syncCloudTerminalConnections(api as never, "org-one", ["session-one"]);

  expect(api.terminalTicket).not.toHaveBeenCalled();
});

it("sends resize but not input for a read-only shared terminal", async () => {
  class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;

    static instance: FakeWebSocket;

    readyState = FakeWebSocket.CONNECTING;
    send = vi.fn();
    close = vi.fn();
    private readonly listeners = new Map<string, EventListener[]>();

    constructor() {
      FakeWebSocket.instance = this;
    }

    addEventListener(type: string, listener: EventListener) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    open() {
      this.readyState = FakeWebSocket.OPEN;
      for (const listener of this.listeners.get("open") ?? []) {
        listener(new Event("open"));
      }
    }

    message(message: object) {
      for (const listener of this.listeners.get("message") ?? []) {
        listener(
          new MessageEvent("message", {
            data: JSON.stringify(message),
          }),
        );
      }
    }
  }
  vi.stubGlobal("WebSocket", FakeWebSocket);
  const api = {
    terminalTicket: vi.fn().mockResolvedValue({
      ticket: "ticket-one",
      scopes: ["terminal:read"],
    }),
    terminalURL: vi.fn().mockReturnValue("wss://example.test/terminal"),
  };

  const connection = ensureCloudTerminalConnection(
    api as never,
    "org-one",
    "session-one",
  );
  const events: string[] = [];
  connection.subscribe((event) => events.push(event.type));
  connection.resize(40, 120);
  await vi.waitFor(() => expect(FakeWebSocket.instance).toBeDefined());

  FakeWebSocket.instance.open();
  FakeWebSocket.instance.message({
    type: "output",
    data: window.btoa("stale terminal history"),
    sequence: 1,
  });
  FakeWebSocket.instance.message({
    type: "replay_complete",
    sequence: 1,
  });
  connection.sendInput("x");

  expect(events).toContain("reset");
  expect(FakeWebSocket.instance.send).toHaveBeenCalledTimes(3);
  expect(FakeWebSocket.instance.send).toHaveBeenNthCalledWith(
    1,
    JSON.stringify({ type: "resize", rows: 40, cols: 120 }),
  );
  expect(FakeWebSocket.instance.send).toHaveBeenNthCalledWith(
    2,
    JSON.stringify({ type: "resize", rows: 40, cols: 119 }),
  );
  expect(FakeWebSocket.instance.send).toHaveBeenNthCalledWith(
    3,
    JSON.stringify({ type: "resize", rows: 40, cols: 120 }),
  );
});
