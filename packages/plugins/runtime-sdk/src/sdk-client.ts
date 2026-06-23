/**
 * sdk-client.ts — client library for talking to a running sdk-host over its
 * Unix socket / named pipe.
 *
 * Used by:
 *   - index.ts (the Runtime plugin: sendMessage / getOutput / isAlive / destroy)
 *   - any live subscriber (Maestro) via subscribeSession()
 */

import { connect, type Socket } from "node:net";
import type { NormalizedEvent } from "./event-schema.js";
import { encodeLine, LineParser } from "./protocol.js";

/** Connect to a host socket; reject on error/timeout. */
export function connectHost(socketPath: string, timeoutMs = 3000): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    let settled = false;
    const sock = connect(socketPath);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(new Error(`Timed out connecting to sdk-host at ${socketPath} (${timeoutMs}ms)`));
    }, timeoutMs);
    sock.once("connect", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(sock);
    });
    sock.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Push a user turn into the session. */
export async function hostSend(socketPath: string, text: string): Promise<void> {
  const sock = await connectHost(socketPath);
  await new Promise<void>((resolve, reject) => {
    sock.once("error", reject);
    sock.write(encodeLine({ cmd: "send", text }), () => {
      sock.end();
      resolve();
    });
  });
}

/** Generic request/response over a short-lived connection. */
async function hostRequest<T>(
  socketPath: string,
  command: Record<string, unknown>,
  matchType: string,
  fallback: T,
  timeoutMs = 3000,
): Promise<T> {
  let sock: Socket;
  try {
    sock = await connectHost(socketPath, timeoutMs);
  } catch {
    return fallback;
  }
  return new Promise<T>((resolve) => {
    let settled = false;
    const finish = (val: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(val);
    };
    const timer = setTimeout(() => finish(fallback), timeoutMs);
    sock.setEncoding("utf-8");
    const parser = new LineParser((obj) => {
      if (typeof obj === "object" && obj !== null && (obj as { type?: string }).type === matchType) {
        finish(obj as T);
      }
    });
    sock.on("data", (chunk) => parser.feed(chunk));
    sock.once("error", () => finish(fallback));
    sock.once("close", () => finish(fallback));
    sock.write(encodeLine(command));
  });
}

export interface HostStatus {
  type: "status";
  alive: boolean;
  session_id: string | null;
  seq: number;
  turns: number;
}

/** Query host status. Returns null if the host is unreachable. */
export async function hostStatus(socketPath: string): Promise<HostStatus | null> {
  const res = await hostRequest<HostStatus | null>(
    socketPath,
    { cmd: "status" },
    "status",
    null,
    2000,
  );
  return res;
}

/** Whether the host process is reachable (the pipe answers). */
export async function hostIsAlive(socketPath: string): Promise<boolean> {
  const status = await hostStatus(socketPath);
  return status !== null;
}

/** Render a tail of recent output as text. */
export async function hostGetOutput(socketPath: string, lines = 50): Promise<string> {
  const res = await hostRequest<{ type: "output"; text: string } | { text: string }>(
    socketPath,
    { cmd: "output", lines },
    "output",
    { text: "" },
    3000,
  );
  return res.text ?? "";
}

/** Answer a pending permission request. */
export async function hostResolvePermission(
  socketPath: string,
  requestId: string,
  behavior: "allow" | "deny",
  message?: string,
): Promise<void> {
  const sock = await connectHost(socketPath);
  await new Promise<void>((resolve) => {
    sock.once("error", () => resolve());
    sock.write(
      encodeLine({ cmd: "permission", request_id: requestId, behavior, message }),
      () => {
        sock.end();
        resolve();
      },
    );
  });
}

/** Ask the host to shut down. Silently ignores an unreachable pipe. */
export async function hostKill(socketPath: string): Promise<void> {
  let sock: Socket;
  try {
    sock = await connectHost(socketPath, 2000);
  } catch {
    return;
  }
  await new Promise<void>((resolve) => {
    sock.once("error", () => resolve());
    sock.write(encodeLine({ cmd: "kill" }), () => {
      sock.end();
      resolve();
    });
  });
}

export interface Subscription {
  /** Close the subscription. */
  close: () => void;
}

/**
 * Subscribe to a session's live event stream. `onEvent` receives each
 * NormalizedEvent (after the snapshot replay and continuing live). The
 * `hello` / `snapshot-complete` control frames are delivered to `onControl`.
 */
export async function subscribeSession(
  socketPath: string,
  onEvent: (event: NormalizedEvent) => void,
  onControl?: (msg: { type: string; [k: string]: unknown }) => void,
): Promise<Subscription> {
  const sock = await connectHost(socketPath, 5000);
  sock.setEncoding("utf-8");
  const parser = new LineParser((obj) => {
    if (typeof obj !== "object" || obj === null) return;
    const type = (obj as { type?: string }).type;
    if (type === "hello" || type === "snapshot-complete") {
      onControl?.(obj as { type: string });
      return;
    }
    onEvent(obj as NormalizedEvent);
  });
  sock.on("data", (chunk) => parser.feed(chunk));
  return {
    close: () => sock.destroy(),
  };
}
