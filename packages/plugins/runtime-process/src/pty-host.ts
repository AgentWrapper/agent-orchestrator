/**
 * pty-host.ts
 *
 * Dual-purpose file:
 *   1. Module — exports protocol constants, encodeMessage(), and MessageParser
 *      (imported by pty-client.ts)
 *   2. Standalone script — when run as `node pty-host.js <args>` it owns a
 *      ConPTY session and exposes it over a Windows named pipe so multiple
 *      clients can attach/detach (analogous to the tmux daemon).
 *
 * Usage (standalone):
 *   node pty-host.js <sessionId> <pipePath> <cwd> <shellCmd> <shellArg1> [shellArg2...]
 *
 * Binary protocol over named pipe:
 *   [1-byte type][4-byte big-endian length][payload]
 *
 *   0x01  terminal data    host → client   raw PTY output bytes
 *   0x02  terminal input   client → host   raw keystrokes for PTY
 *   0x03  resize           client → host   JSON { cols, rows }
 *   0x04  get-output req   client → host   JSON { lines: number }
 *   0x05  get-output res   host → client   UTF-8 text (last N lines joined)
 *   0x06  status req       client → host   empty payload
 *   0x07  status res       host → client   JSON { alive, pid, exitCode? }
 *   0x08  kill req         client → host   empty payload
 */

import net from "node:net";

// ---------------------------------------------------------------------------
// Protocol constants (exported for pty-client.ts)
// ---------------------------------------------------------------------------

export const MSG_TERMINAL_DATA = 0x01;
export const MSG_TERMINAL_INPUT = 0x02;
export const MSG_RESIZE = 0x03;
export const MSG_GET_OUTPUT_REQ = 0x04;
export const MSG_GET_OUTPUT_RES = 0x05;
export const MSG_STATUS_REQ = 0x06;
export const MSG_STATUS_RES = 0x07;
export const MSG_KILL_REQ = 0x08;

// ---------------------------------------------------------------------------
// Protocol helpers (exported for pty-client.ts)
// ---------------------------------------------------------------------------

/**
 * Encode a message into the binary framing format.
 * @param type  One of the MSG_* constants.
 * @param payload  String (UTF-8 encoded) or raw Buffer.
 */
export function encodeMessage(type: number, payload: Buffer | string): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload, "utf-8") : payload;
  const frame = Buffer.allocUnsafe(5 + body.length);
  frame.writeUInt8(type, 0);
  frame.writeUInt32BE(body.length, 1);
  body.copy(frame, 5);
  return frame;
}

// ---------------------------------------------------------------------------
// MessageParser (exported for pty-client.ts)
// ---------------------------------------------------------------------------

/**
 * Streaming parser for the binary framing protocol.
 * Feed arbitrary-sized chunks from a TCP/pipe stream and receive complete
 * decoded messages via the onMessage callback.
 */
export class MessageParser {
  private _buf: Buffer = Buffer.alloc(0);
  private readonly _onMessage: (type: number, payload: Buffer) => void;

  constructor(onMessage: (type: number, payload: Buffer) => void) {
    this._onMessage = onMessage;
  }

  feed(chunk: Buffer): void {
    this._buf = Buffer.concat([this._buf, chunk]);

    // Process as many complete frames as are available
    while (this._buf.length >= 5) {
      const payloadLen = this._buf.readUInt32BE(1);
      const frameLen = 5 + payloadLen;
      if (this._buf.length < frameLen) break;

      const type = this._buf.readUInt8(0);
      const payload = this._buf.slice(5, frameLen);
      this._buf = this._buf.slice(frameLen);
      this._onMessage(type, payload);
    }
  }
}

// ---------------------------------------------------------------------------
// Standalone entry-point
// ---------------------------------------------------------------------------

const isMain =
  process.argv[1]?.endsWith("pty-host.js") || process.argv[1]?.endsWith("pty-host.ts");

if (isMain) {
  void runPtyHost();
}

async function runPtyHost(): Promise<void> {
  // Parse CLI arguments
  // argv: [node, pty-host.js, sessionId, pipePath, cwd, shellCmd, shellArg1, ...]
  const [, , sessionId, pipePath, cwd, shellCmd, ...shellArgs] = process.argv;

  if (!sessionId || !pipePath || !cwd || !shellCmd) {
    process.stderr.write(
      "Usage: node pty-host.js <sessionId> <pipePath> <cwd> <shellCmd> [shellArg...]\n",
    );
    process.exit(1);
  }

  // Dynamically import node-pty so the module side of this file can be
  // imported without requiring node-pty to be present on the client host.
  const { spawn: ptySpawn } = await import("node-pty");

  // node-pty on Windows requires the full executable name (with .exe).
  // getShell() may return bare "pwsh" or "powershell" — append .exe if needed.
  let resolvedShellCmd = shellCmd;
  if (
    process.platform === "win32" &&
    !shellCmd.includes("\\") &&
    !shellCmd.includes("/") &&
    !shellCmd.endsWith(".exe") &&
    !shellCmd.endsWith(".cmd")
  ) {
    resolvedShellCmd = shellCmd + ".exe";
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const MAX_OUTPUT_LINES = 1000;
  /** Raw terminal output lines (ANSI codes preserved for xterm.js replay). */
  const outputBuffer: string[] = [];
  let ptyExitCode: number | undefined;
  const clients = new Set<net.Socket>();

  // ---------------------------------------------------------------------------
  // Spawn the PTY
  // ---------------------------------------------------------------------------

  const pty = ptySpawn(resolvedShellCmd, shellArgs, {
    name: "xterm-256color",
    cols: 220,
    rows: 50,
    cwd,
    env: process.env as Record<string, string>,
    encoding: null, // receive raw Buffers
  });

  // Signal readiness to the parent process
  process.stdout.write(`READY:${pty.pid}\n`);

  // ---------------------------------------------------------------------------
  // Rolling output buffer
  // ---------------------------------------------------------------------------

  let partialLine = "";

  function appendOutput(raw: Buffer): void {
    // Store raw bytes in the buffer for ANSI-faithful replay
    const text = partialLine + raw.toString("utf-8");
    const lines = text.split("\n");
    // The last element is either "" (text ended with \n) or a partial line
    partialLine = lines.pop()!;
    for (const line of lines) {
      outputBuffer.push(line + "\n");
    }
    if (outputBuffer.length > MAX_OUTPUT_LINES) {
      outputBuffer.splice(0, outputBuffer.length - MAX_OUTPUT_LINES);
    }
  }

  // ---------------------------------------------------------------------------
  // Broadcast helpers
  // ---------------------------------------------------------------------------

  function broadcast(msg: Buffer): void {
    for (const sock of clients) {
      if (!sock.destroyed) {
        sock.write(msg);
      }
    }
  }

  function sendToSocket(sock: net.Socket, msg: Buffer): void {
    if (!sock.destroyed) {
      sock.write(msg);
    }
  }

  // ---------------------------------------------------------------------------
  // PTY event handlers
  // ---------------------------------------------------------------------------

  // node-pty emits data as string when encoding is set, Buffer when null.
  // We set encoding: null so we receive Buffers.
  pty.onData((data: string | Buffer) => {
    // Convert to Buffer if node-pty gave us a string (shouldn't happen with
    // encoding: null, but guard defensively).
    const buf: Buffer = typeof data === "string" ? Buffer.from(data, "utf-8") : Buffer.from(data);
    appendOutput(buf);
    broadcast(encodeMessage(MSG_TERMINAL_DATA, buf));
  });

  pty.onExit(({ exitCode }) => {
    ptyExitCode = exitCode;
    // Flush any trailing partial line
    if (partialLine) {
      outputBuffer.push(partialLine);
      partialLine = "";
    }

    const statusMsg = encodeMessage(
      MSG_STATUS_RES,
      JSON.stringify({ alive: false, pid: pty.pid, exitCode }),
    );
    broadcast(statusMsg);

    // Keep the PTY host alive after the agent exits — mirrors tmux behavior
    // where the shell session persists after the command finishes. This keeps
    // the named pipe reachable so:
    //   - isAlive() returns true (pipe connectable)
    //   - Clients can still connect and view scrollback output
    //   - The STATUS_RES reports alive:false so getActivityState sees "exited"
    //   - ao session kill / ao stop will destroy the pipe server via MSG_KILL_REQ
  });

  // ---------------------------------------------------------------------------
  // Named pipe server
  // ---------------------------------------------------------------------------

  const server = net.createServer((sock) => {
    clients.add(sock);

    // Send current output buffer to newly connected client (like tmux attach
    // showing scrollback).
    if (outputBuffer.length > 0) {
      const scrollback = Buffer.from(outputBuffer.join(""), "utf-8");
      sendToSocket(sock, encodeMessage(MSG_TERMINAL_DATA, scrollback));
    }

    const parser = new MessageParser((type, payload) => {
      handleClientMessage(sock, type, payload);
    });

    sock.on("data", (chunk: Buffer) => {
      parser.feed(chunk);
    });

    sock.on("close", () => {
      clients.delete(sock);
    });

    sock.on("error", () => {
      clients.delete(sock);
    });
  });

  // ---------------------------------------------------------------------------
  // Client message handler
  // ---------------------------------------------------------------------------

  function handleClientMessage(sock: net.Socket, type: number, payload: Buffer): void {
    switch (type) {
      case MSG_TERMINAL_INPUT: {
        if (ptyExitCode === undefined) {
          pty.write(payload.toString("utf-8"));
        }
        break;
      }

      case MSG_RESIZE: {
        if (ptyExitCode === undefined) {
          try {
            const { cols, rows } = JSON.parse(payload.toString("utf-8")) as {
              cols: number;
              rows: number;
            };
            if (typeof cols === "number" && typeof rows === "number") {
              pty.resize(cols, rows);
            }
          } catch {
            // Malformed resize — ignore
          }
        }
        break;
      }

      case MSG_GET_OUTPUT_REQ: {
        let lines = 50;
        try {
          const req = JSON.parse(payload.toString("utf-8")) as { lines?: number };
          if (typeof req.lines === "number") lines = req.lines;
        } catch {
          // Use default
        }
        const start = Math.max(0, outputBuffer.length - lines);
        const text = outputBuffer.slice(start).join("");
        sendToSocket(sock, encodeMessage(MSG_GET_OUTPUT_RES, text));
        break;
      }

      case MSG_STATUS_REQ: {
        const alive = ptyExitCode === undefined;
        const status: { alive: boolean; pid: number; exitCode?: number } = {
          alive,
          pid: pty.pid,
        };
        if (!alive) status.exitCode = ptyExitCode;
        sendToSocket(sock, encodeMessage(MSG_STATUS_RES, JSON.stringify(status)));
        break;
      }

      case MSG_KILL_REQ: {
        // Full teardown — dispose the ConPTY handle, drop clients, close the
        // pipe server, then exit. Previously we only called pty.kill() and
        // kept the pipe alive, which left a stale host lingering until the OS
        // reaped it (and caused the orphaned conpty_console_list_agent
        // helpers that show Windows Error Reporting dialogs).
        shutdown("MSG_KILL_REQ");
        break;
      }

      default:
        // Unknown message type — ignore
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Start listening
  // ---------------------------------------------------------------------------

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  // -------------------------------------------------------------------------
  // Graceful shutdown
  //
  // If this process dies without first disposing the ConPTY handle, node-pty's
  // `conpty_console_list_agent.exe` helper gets its pipe severed mid-operation
  // and Windows Error Reporting pops a "0x800700e8" dialog. Intercept every
  // common exit path and run the same teardown (pty.kill → close clients →
  // close server) so the helper can shut down cleanly.
  // -------------------------------------------------------------------------

  let shuttingDown = false;
  function shutdown(reason: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      if (ptyExitCode === undefined) {
        try { pty.kill(); } catch { /* already dead */ }
      }
    } catch { /* noop */ }
    for (const sock of clients) {
      try { sock.destroy(); } catch { /* noop */ }
    }
    clients.clear();
    try { server.close(); } catch { /* noop */ }
    // Give node-pty a tick to release the ConPTY handle before the event loop
    // exits. Without this, the conpty_console_list_agent helper may still be
    // mid-cleanup when the parent node process terminates.
    setTimeout(() => process.exit(0), 50).unref();
    process.stderr.write(`pty-host [${sessionId}] shutdown: ${reason}\n`);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGHUP", () => shutdown("SIGHUP"));
  process.on("SIGBREAK", () => shutdown("SIGBREAK"));
  process.on("beforeExit", () => shutdown("beforeExit"));
  process.on("uncaughtException", (err) => {
    process.stderr.write(`pty-host [${sessionId}] uncaught: ${String(err)}\n`);
    shutdown("uncaughtException");
  });
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`pty-host [${sessionId}] unhandled rejection: ${String(reason)}\n`);
  });
  // Last resort: dispose the PTY even on a clean exit before the event loop
  // unwinds so node-pty's native cleanup gets a chance to run.
  process.on("exit", () => {
    try {
      if (ptyExitCode === undefined) pty.kill();
    } catch { /* noop */ }
  });

}
