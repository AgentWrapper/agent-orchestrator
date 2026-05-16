/**
 * Tests for handleWindowsPipeMessage — the Windows named pipe relay logic.
 * Dependencies (net.connect, resolvePipePath) are injected, no module mocking needed.
 */

import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { handleWindowsPipeMessage, type WsSink, type PipeRelayDeps } from "../mux-websocket.js";

function makeWs(): WsSink & { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn(), readyState: 1 /* OPEN */ };
}

function makePipeSocket(): Socket & EventEmitter {
  const sock = new EventEmitter() as Socket & EventEmitter;
  Object.assign(sock, { write: vi.fn(), end: vi.fn(), destroy: vi.fn() });
  return sock;
}

function makeDeps(pipeSocket: Socket & EventEmitter): PipeRelayDeps {
  return {
    connect: vi.fn(() => pipeSocket),
    resolvePipePath: vi.fn((id: string) => `\\\\.\\pipe\\ao-pty-${id}`),
  };
}

function frame(type: number, payload: Buffer): Buffer {
  const f = Buffer.alloc(5 + payload.length);
  f.writeUInt8(type, 0);
  f.writeUInt32BE(payload.length, 1);
  payload.copy(f, 5);
  return f;
}

describe("handleWindowsPipeMessage", () => {
  it("connects to pipe and sends opened on open", () => {
    const ws = makeWs();
    const sock = makePipeSocket();
    const deps = makeDeps(sock);
    const pipes = new Map<string, Socket>();
    const bufs = new Map<string, Buffer>();

    handleWindowsPipeMessage({ id: "s1", type: "open" }, ws, pipes, bufs, deps);

    expect(deps.connect).toHaveBeenCalledWith("\\\\.\\pipe\\ao-pty-s1");
    expect(pipes.has("s1")).toBe(true);

    // Simulate connect
    sock.emit("connect");
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ ch: "terminal", id: "s1", type: "opened" }));
  });

  it("confirms opened for already-connected session", () => {
    const ws = makeWs();
    const sock = makePipeSocket();
    const deps = makeDeps(sock);
    const pipes = new Map<string, Socket>([["s1", sock]]);
    const bufs = new Map<string, Buffer>();

    handleWindowsPipeMessage({ id: "s1", type: "open" }, ws, pipes, bufs, deps);

    expect(deps.connect).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ ch: "terminal", id: "s1", type: "opened" }));
  });

  it("rejects malformed session ids before touching the pipe path", () => {
    const ws = makeWs();
    const deps: PipeRelayDeps = {
      connect: vi.fn(),
      resolvePipePath: vi.fn(),
    };

    handleWindowsPipeMessage(
      { id: "../../../etc/passwd", type: "open" },
      ws,
      new Map(),
      new Map(),
      deps,
    );

    expect(deps.connect).not.toHaveBeenCalled();
    expect(deps.resolvePipePath).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        ch: "terminal",
        id: "../../../etc/passwd",
        type: "error",
        message: "invalid session id",
      }),
    );
  });

  it("throws when pipe path cannot be resolved", () => {
    const ws = makeWs();
    const deps: PipeRelayDeps = {
      connect: vi.fn(),
      resolvePipePath: vi.fn(() => null),
    };

    expect(() =>
      handleWindowsPipeMessage({ id: "bad", type: "open" }, ws, new Map(), new Map(), deps),
    ).toThrow("No PTY host pipe found");
  });

  it("relays terminal data (0x01) from pipe to WebSocket", () => {
    const ws = makeWs();
    const sock = makePipeSocket();
    const deps = makeDeps(sock);
    const pipes = new Map<string, Socket>();
    const bufs = new Map<string, Buffer>();

    handleWindowsPipeMessage({ id: "s1", type: "open" }, ws, pipes, bufs, deps);
    sock.emit("connect");
    ws.send.mockClear();

    sock.emit("data", frame(0x01, Buffer.from("hello")));

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ ch: "terminal", id: "s1", type: "data", data: "hello" }),
    );
  });

  it("sends exited on PTY status (0x07) alive=false", () => {
    const ws = makeWs();
    const sock = makePipeSocket();
    const deps = makeDeps(sock);
    const pipes = new Map<string, Socket>();
    const bufs = new Map<string, Buffer>();

    handleWindowsPipeMessage({ id: "s1", type: "open" }, ws, pipes, bufs, deps);
    sock.emit("connect");
    ws.send.mockClear();

    sock.emit("data", frame(0x07, Buffer.from(JSON.stringify({ alive: false }))));

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ ch: "terminal", id: "s1", type: "exited", code: 0 }),
    );
  });

  it("sends exited when pipe closes", () => {
    const ws = makeWs();
    const sock = makePipeSocket();
    const deps = makeDeps(sock);
    const pipes = new Map<string, Socket>();
    const bufs = new Map<string, Buffer>();

    handleWindowsPipeMessage({ id: "s1", type: "open" }, ws, pipes, bufs, deps);
    sock.emit("connect");
    ws.send.mockClear();

    sock.emit("close");

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ ch: "terminal", id: "s1", type: "exited", code: 0 }),
    );
    expect(pipes.has("s1")).toBe(false);
  });

  it("sends error when pipe connection fails", () => {
    const ws = makeWs();
    const sock = makePipeSocket();
    const deps = makeDeps(sock);
    const pipes = new Map<string, Socket>();
    const bufs = new Map<string, Buffer>();

    handleWindowsPipeMessage({ id: "s1", type: "open" }, ws, pipes, bufs, deps);

    sock.emit("error", new Error("connect ENOENT"));

    const sent = JSON.parse(ws.send.mock.calls.at(-1)![0] as string);
    expect(sent).toMatchObject({ ch: "terminal", id: "s1", type: "error" });
    expect(pipes.has("s1")).toBe(false);
  });

  it("relays input data (0x02) from WebSocket to pipe", () => {
    const ws = makeWs();
    const sock = makePipeSocket();
    const deps = makeDeps(sock);
    const pipes = new Map<string, Socket>([["s1", sock]]);
    const bufs = new Map<string, Buffer>();

    handleWindowsPipeMessage({ id: "s1", type: "data", data: "ls\r" }, ws, pipes, bufs, deps);

    const write = (sock as unknown as { write: ReturnType<typeof vi.fn> }).write;
    expect(write).toHaveBeenCalled();
    const written = write.mock.calls[0][0] as Buffer;
    expect(written.readUInt8(0)).toBe(0x02);
    expect(written.subarray(5).toString()).toBe("ls\r");
  });

  it("relays resize (0x03) from WebSocket to pipe", () => {
    const ws = makeWs();
    const sock = makePipeSocket();
    const deps = makeDeps(sock);
    const pipes = new Map<string, Socket>([["s1", sock]]);
    const bufs = new Map<string, Buffer>();

    handleWindowsPipeMessage({ id: "s1", type: "resize", cols: 120, rows: 40 }, ws, pipes, bufs, deps);

    const write = (sock as unknown as { write: ReturnType<typeof vi.fn> }).write;
    expect(write).toHaveBeenCalled();
    const written = write.mock.calls[0][0] as Buffer;
    expect(written.readUInt8(0)).toBe(0x03);
    expect(JSON.parse(written.subarray(5).toString())).toEqual({ cols: 120, rows: 40 });
  });

  it("closes pipe and cleans up on close message", () => {
    const ws = makeWs();
    const sock = makePipeSocket();
    const deps = makeDeps(sock);
    const pipes = new Map<string, Socket>([["s1", sock]]);
    const bufs = new Map<string, Buffer>([["s1", Buffer.alloc(0)]]);

    handleWindowsPipeMessage({ id: "s1", type: "close" }, ws, pipes, bufs, deps);

    expect((sock as unknown as { end: ReturnType<typeof vi.fn> }).end).toHaveBeenCalled();
    expect(pipes.has("s1")).toBe(false);
    expect(bufs.has("s1")).toBe(false);
  });

  it("scopes pipe maps and resolution by projectId so two projects can share a sessionId", () => {
    const ws = makeWs();
    const sockA = makePipeSocket();
    const sockB = makePipeSocket();
    const connect = vi.fn((path: string) => (path.includes("projA") ? sockA : sockB));
    const resolvePipePath = vi.fn(
      (id: string, projectId?: string) => `\\\\.\\pipe\\ao-pty-${projectId}-${id}`,
    );
    const deps: PipeRelayDeps = { connect, resolvePipePath };
    const pipes = new Map<string, Socket>();
    const bufs = new Map<string, Buffer>();

    handleWindowsPipeMessage({ id: "s1", type: "open", projectId: "projA" }, ws, pipes, bufs, deps);
    handleWindowsPipeMessage({ id: "s1", type: "open", projectId: "projB" }, ws, pipes, bufs, deps);

    expect(resolvePipePath).toHaveBeenNthCalledWith(1, "s1", "projA");
    expect(resolvePipePath).toHaveBeenNthCalledWith(2, "s1", "projB");
    expect(connect).toHaveBeenNthCalledWith(1, "\\\\.\\pipe\\ao-pty-projA-s1");
    expect(connect).toHaveBeenNthCalledWith(2, "\\\\.\\pipe\\ao-pty-projB-s1");
    expect(pipes.get("projA:s1")).toBe(sockA);
    expect(pipes.get("projB:s1")).toBe(sockB);

    sockA.emit("connect");
    sockA.emit("data", frame(0x01, Buffer.from("from-A")));
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ ch: "terminal", id: "s1", type: "data", data: "from-A", projectId: "projA" }),
    );

    sockB.emit("connect");
    sockB.emit("data", frame(0x01, Buffer.from("from-B")));
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ ch: "terminal", id: "s1", type: "data", data: "from-B", projectId: "projB" }),
    );
  });

  it("handles partial frames across multiple data chunks", () => {
    const ws = makeWs();
    const sock = makePipeSocket();
    const deps = makeDeps(sock);
    const pipes = new Map<string, Socket>();
    const bufs = new Map<string, Buffer>();

    handleWindowsPipeMessage({ id: "s1", type: "open" }, ws, pipes, bufs, deps);
    sock.emit("connect");
    ws.send.mockClear();

    // Send frame in two chunks
    const fullFrame = frame(0x01, Buffer.from("split"));
    sock.emit("data", fullFrame.subarray(0, 3)); // partial header
    expect(ws.send).not.toHaveBeenCalled();

    sock.emit("data", fullFrame.subarray(3)); // rest of frame
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ ch: "terminal", id: "s1", type: "data", data: "split" }),
    );
  });
});
