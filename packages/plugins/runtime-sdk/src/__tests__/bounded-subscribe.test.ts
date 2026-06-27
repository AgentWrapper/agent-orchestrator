import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Socket } from "node:net";
import {
  SessionHost,
  handleConnection,
  handleClientCommand,
  SUBSCRIBE_GRACE_MS,
} from "../sdk-host.js";

/**
 * A minimal fake of the slice of `net.Socket` that `handleConnection` touches:
 * setEncoding/on/write/destroy + the SubscriberSocket getters. It records written
 * lines and lets the test drive inbound `data`/`close` events.
 */
function fakeSocket() {
  let _destroyed = false;
  const handlers: Record<string, ((arg?: unknown) => void)[]> = {};
  const written: string[] = [];
  const sock = {
    setEncoding() {},
    on(event: string, cb: (arg?: unknown) => void) {
      (handlers[event] ??= []).push(cb);
      return sock;
    },
    write(data: string): boolean {
      written.push(data);
      return true;
    },
    destroy() {
      _destroyed = true;
    },
    get destroyed() {
      return _destroyed;
    },
    get writableLength() {
      return 0;
    },
    // test drivers
    written,
    feed(chunk: string) {
      for (const cb of handlers["data"] ?? []) cb(chunk);
    },
    parsed(): Array<Record<string, unknown>> {
      return written.flatMap((l) =>
        l
          .split("\n")
          .filter((s) => s.trim().length > 0)
          .map((s) => JSON.parse(s) as Record<string, unknown>),
      );
    },
  };
  return sock;
}

/** A host with three turns of two events each (seqs 0..5). */
function threeTurnHost(): SessionHost {
  const host = new SessionHost({
    aoSessionId: "s",
    permissionMode: "bypassPermissions",
    persist: () => {},
    now: () => new Date("2026-06-28T00:00:00.000Z"),
  });
  for (let turn = 1; turn <= 3; turn++) {
    for (let b = 0; b < 2; b++) host.emit({ type: "text-delta", block: 0, text: `t${turn}` }, turn);
  }
  return host;
}

describe("handleConnection — bounded-subscribe handshake (#1)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("OLD client (no subscribe command) gets the FULL snapshot after the grace", () => {
    const host = threeTurnHost();
    const sock = fakeSocket();
    handleConnection(host, sock as unknown as Socket);

    // Nothing sent yet — the snapshot is held during the grace window.
    expect(sock.written).toHaveLength(0);

    vi.advanceTimersByTime(SUBSCRIBE_GRACE_MS);
    const msgs = sock.parsed();
    expect(msgs[0]).toMatchObject({ type: "hello", seq_head: 5 });
    expect(msgs.filter((m) => m.type === "text-delta").map((m) => m.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(msgs[msgs.length - 1]).toMatchObject({ type: "snapshot-complete", seq: 5 });
  });

  it("NEW client gets a bounded, turn-aligned tail and NO full snapshot on timer", () => {
    const host = threeTurnHost();
    const sock = fakeSocket();
    handleConnection(host, sock as unknown as Socket);

    // Opt-in command arrives before the grace fires.
    sock.feed(JSON.stringify({ cmd: "subscribe", tail_events: 1 }) + "\n");
    const msgs = sock.parsed();
    expect(msgs[0]).toMatchObject({ type: "hello", seq_head: 5 });
    // tail_events:1 → naive last event seq 5 (turn 3); turn-align pulls in seq 4 too.
    expect(msgs.filter((m) => m.type === "text-delta").map((m) => m.seq)).toEqual([4, 5]);
    expect(msgs[msgs.length - 1]).toMatchObject({ type: "snapshot-complete", seq: 5 });

    // The grace timer must NOT re-send a second (full) snapshot.
    const helloCount = () => sock.parsed().filter((m) => m.type === "hello").length;
    vi.advanceTimersByTime(SUBSCRIBE_GRACE_MS * 2);
    expect(helloCount()).toBe(1);
  });

  it("a subscribe command AFTER the grace (already armed) is ignored, no double snapshot", () => {
    const host = threeTurnHost();
    const sock = fakeSocket();
    handleConnection(host, sock as unknown as Socket);
    vi.advanceTimersByTime(SUBSCRIBE_GRACE_MS); // armed full
    const before = sock.parsed().filter((m) => m.type === "hello").length;
    sock.feed(JSON.stringify({ cmd: "subscribe", tail_events: 1 }) + "\n");
    expect(sock.parsed().filter((m) => m.type === "hello").length).toBe(before);
  });

  it("a bounded subscriber receives live events after its snapshot", () => {
    const host = threeTurnHost();
    const sock = fakeSocket();
    handleConnection(host, sock as unknown as Socket);
    sock.feed(JSON.stringify({ cmd: "subscribe", tail_events: 1 }) + "\n");
    host.emit({ type: "text-delta", block: 0, text: "live" }, 3);
    const msgs = sock.parsed();
    expect(msgs[msgs.length - 1]).toMatchObject({ type: "text-delta", text: "live", seq: 6 });
  });
});

describe("control-command ACK (#2)", () => {
  function freshHost(): SessionHost {
    return new SessionHost({
      aoSessionId: "s",
      permissionMode: "bypassPermissions",
      persist: () => {},
      now: () => new Date("2026-06-28T00:00:00.000Z"),
    });
  }

  it("acks send ok:true with NO top-level seq (inert to an old client)", () => {
    const host = freshHost();
    const sock = fakeSocket();
    handleClientCommand(host, sock as unknown as Socket, { cmd: "send", text: "hi" });
    const ack = sock.parsed().find((m) => m.type === "ack");
    expect(ack).toMatchObject({ type: "ack", cmd: "send", ok: true });
    expect(ack).not.toHaveProperty("seq");
  });

  it("acks send ok:false once the host has ended", () => {
    const host = freshHost();
    host.end();
    const sock = fakeSocket();
    handleClientCommand(host, sock as unknown as Socket, { cmd: "send", text: "late" });
    expect(sock.parsed().find((m) => m.type === "ack")).toMatchObject({ cmd: "send", ok: false });
  });

  it("acks permission ok:true for a pending request, carrying request_id", () => {
    const host = freshHost();
    void host.canUseTool("Bash", { command: "ls" }); // creates perm-1
    const sock = fakeSocket();
    handleClientCommand(host, sock as unknown as Socket, {
      cmd: "permission",
      request_id: "perm-1",
      behavior: "allow",
    });
    expect(sock.parsed().find((m) => m.type === "ack")).toMatchObject({
      type: "ack",
      cmd: "permission",
      ok: true,
      request_id: "perm-1",
    });
  });

  it("acks permission ok:false for an unknown / already-resolved request", () => {
    const host = freshHost();
    const sock = fakeSocket();
    handleClientCommand(host, sock as unknown as Socket, {
      cmd: "permission",
      request_id: "perm-404",
      behavior: "deny",
    });
    expect(sock.parsed().find((m) => m.type === "ack")).toMatchObject({
      cmd: "permission",
      ok: false,
      request_id: "perm-404",
    });
  });
});
