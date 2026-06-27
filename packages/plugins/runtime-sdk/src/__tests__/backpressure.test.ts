import { describe, it, expect } from "vitest";
import {
  makeSubscriberSink,
  SUBSCRIBER_BUFFER_CAP,
  type SubscriberSocket,
} from "../sdk-host.js";

/**
 * A fake socket that mimics Node's writable backpressure: `write` accumulates
 * into `writableLength` until the test "drains" it. `destroyed` flips on
 * destroy() so the sink stops writing — exactly the net.Socket contract.
 */
function fakeSocket(): SubscriberSocket & {
  written: string[];
  drain: () => void;
  setBacklog: (n: number) => void;
} {
  let _destroyed = false;
  let backlog = 0;
  const written: string[] = [];
  return {
    written,
    get destroyed() {
      return _destroyed;
    },
    get writableLength() {
      return backlog;
    },
    write(data: string): boolean {
      written.push(data);
      backlog += Buffer.byteLength(data);
      // Mirror net.Socket: returns false when the buffer is over the high-water mark.
      return backlog === 0;
    },
    destroy() {
      _destroyed = true;
    },
    drain() {
      backlog = 0;
    },
    setBacklog(n: number) {
      backlog = n;
    },
  };
}

describe("makeSubscriberSink backpressure", () => {
  it("never drops a fast subscriber that drains between writes", () => {
    const sock = fakeSocket();
    const send = makeSubscriberSink(sock);
    for (let i = 0; i < 1000; i++) {
      send(`line ${i}\n`);
      sock.drain(); // a healthy UI flushes immediately
    }
    expect(sock.destroyed).toBe(false);
    expect(sock.written).toHaveLength(1000);
  });

  it("drops a slow subscriber once its buffer exceeds the cap", () => {
    const sock = fakeSocket();
    const send = makeSubscriberSink(sock, 1024); // small cap for the test
    // Each line is ~100 bytes and the socket never drains → backlog climbs.
    const line = "x".repeat(100) + "\n";
    let writesBeforeDrop = 0;
    for (let i = 0; i < 100; i++) {
      send(line);
      if (!sock.destroyed) writesBeforeDrop++;
      else break;
    }
    expect(sock.destroyed).toBe(true);
    // Dropped after the buffer crossed 1024 bytes (~11 writes of 101 bytes),
    // not on the first write and not after all 100.
    expect(writesBeforeDrop).toBeGreaterThan(1);
    expect(writesBeforeDrop).toBeLessThan(100);
  });

  it("stops writing to an already-destroyed subscriber", () => {
    const sock = fakeSocket();
    const send = makeSubscriberSink(sock, 1024);
    sock.destroy();
    send("late line\n");
    expect(sock.written).toHaveLength(0);
  });

  it("uses an 8 MB default cap", () => {
    const sock = fakeSocket();
    const send = makeSubscriberSink(sock);
    // Comfortably under the default cap (write adds a few bytes) → kept.
    sock.setBacklog(SUBSCRIBER_BUFFER_CAP - 1000);
    send("ok\n");
    expect(sock.destroyed).toBe(false);
    // At the cap → the next write pushes writableLength over it → dropped.
    sock.setBacklog(SUBSCRIBER_BUFFER_CAP);
    send("over\n");
    expect(sock.destroyed).toBe(true);
  });
});
