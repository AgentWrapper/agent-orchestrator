/**
 * Integration tests for direct-terminal-ws.
 *
 * Verifies the HTTP server and /mux WebSocket endpoint behaviour.
 * The per-terminal PTY logic (session validation, I/O, resize) is tested
 * via the mux protocol — send { ch:"terminal", type:"open" } and assert the
 * response, mirroring what the browser's MuxProvider does.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { request, type IncomingMessage } from "node:http";
import { WebSocket } from "ws";
import { findTmux } from "../tmux-utils.js";
import { createDirectTerminalServer, type DirectTerminalServer } from "../direct-terminal-ws.js";

const TMUX = findTmux();
const TEST_SESSION = `ao-test-integration-${process.pid}`;
const TEST_HASH_SESSION = `abcdef123456-ao-test-hash-${process.pid}`;
const TEST_SPACED_TARGET = `abcdef123456-my project-${process.pid}`;

// These integration tests require a running tmux — skip on Windows where tmux is unavailable
const describeWithTmux = TMUX ? describe : describe.skip;

let terminal: DirectTerminalServer;
let port: number;

// =============================================================================
// Helpers
// =============================================================================

function httpGet(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: "localhost", port, path, method: "GET", timeout: 3000 },
      (res: IncomingMessage) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Open a raw WebSocket to /mux and wait for the connection to be established. */
function connectMux(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/mux`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
    setTimeout(() => reject(new Error("WebSocket connect timeout")), 5000);
  });
}

type MuxMessage = Record<string, unknown>;

/** Send a message and wait for the next message matching a predicate. */
function waitForMessage(
  ws: WebSocket,
  predicate: (msg: MuxMessage) => boolean,
  timeoutMs = 3000,
): Promise<MuxMessage> {
  return new Promise((resolve, reject) => {
    const handler = (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString()) as MuxMessage;
        if (predicate(msg)) {
          ws.off("message", handler);
          resolve(msg);
        }
      } catch {
        /* ignore parse errors */
      }
    };
    ws.on("message", handler);
    setTimeout(() => {
      ws.off("message", handler);
      reject(new Error("Timed out waiting for matching message"));
    }, timeoutMs);
  });
}

// =============================================================================
// Lifecycle
// =============================================================================

beforeAll(() => {
  if (!TMUX) return; // skip setup on Windows — tests are wrapped in describeWithTmux
  execFileSync(TMUX, ["new-session", "-d", "-s", TEST_SESSION, "-x", "80", "-y", "24"], {
    timeout: 5000,
  });
  execFileSync(TMUX, ["new-session", "-d", "-s", TEST_HASH_SESSION, "-x", "80", "-y", "24"], {
    timeout: 5000,
  });
  execFileSync(TMUX, ["new-session", "-d", "-s", TEST_SPACED_TARGET, "-x", "80", "-y", "24"], {
    timeout: 5000,
  });

  terminal = createDirectTerminalServer(TMUX);
  terminal.server.listen(0);
  const addr = terminal.server.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
});

afterAll(() => {
  if (!TMUX || !terminal) return; // skip teardown on Windows
  terminal.shutdown();
  try {
    execFileSync(TMUX, ["kill-session", "-t", TEST_SESSION], { timeout: 5000 });
  } catch {
    /* */
  }
  try {
    execFileSync(TMUX, ["kill-session", "-t", TEST_HASH_SESSION], { timeout: 5000 });
  } catch {
    /* */
  }
  try {
    execFileSync(TMUX, ["kill-session", "-t", TEST_SPACED_TARGET], { timeout: 5000 });
  } catch {
    /* */
  }
});

// =============================================================================
// Health endpoint
// =============================================================================

describeWithTmux("health endpoint", () => {
  it("GET /health returns 200 with JSON body", async () => {
    const res = await httpGet("/health");
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data).toHaveProperty("status", "ok");
    expect(data).toHaveProperty("clients");
    expect(typeof data.clients).toBe("number");
  });

  it("reflects connected mux clients count", async () => {
    const ws = await connectMux();

    const res = await httpGet("/health");
    const data = JSON.parse(res.body);
    expect(data.clients).toBeGreaterThanOrEqual(1);

    ws.close();
  });
});

// =============================================================================
// HTTP routing
// =============================================================================

describeWithTmux("HTTP routing", () => {
  it("returns 404 for unknown path", async () => {
    expect((await httpGet("/unknown")).status).toBe(404);
  });

  it("returns 404 for root path", async () => {
    expect((await httpGet("/")).status).toBe(404);
  });

  it("returns 404 for /ws via HTTP (not WebSocket upgrade)", async () => {
    expect((await httpGet("/ws")).status).toBe(404);
  });
});

// =============================================================================
// WebSocket upgrade routing
// =============================================================================

describeWithTmux("WebSocket upgrade routing", () => {
  it("accepts connections on /mux", async () => {
    const ws = await connectMux();
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("destroys connections on unknown paths", async () => {
    const result = await new Promise<{ code: number }>((resolve) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      ws.on("close", (code) => resolve({ code }));
      ws.on("error", () => resolve({ code: -1 }));
      setTimeout(() => resolve({ code: -1 }), 3000);
    });
    // socket.destroy() causes the client to see a non-1000 close or error
    expect(result.code).not.toBe(1000);
  });
});

// =============================================================================
// Mux protocol — session open/validation
// =============================================================================

describeWithTmux("mux terminal open", () => {
  it("sends 'opened' response for a valid tmux session", async () => {
    const ws = await connectMux();

    ws.send(
      JSON.stringify({ ch: "terminal", id: "test-session", tmuxName: TEST_SESSION, type: "open" }),
    );

    const msg = await waitForMessage(ws, (m) => m.ch === "terminal" && m.type === "opened");
    expect(msg.id).toBe("test-session");

    ws.close();
  });

  it("sends error response for nonexistent tmux session", async () => {
    const ws = await connectMux();

    ws.send(JSON.stringify({ ch: "terminal", id: `nonexistent-${Date.now()}`, type: "open" }));

    const msg = await waitForMessage(ws, (m) => m.ch === "terminal" && m.type === "error");
    expect(typeof msg.message).toBe("string");

    ws.close();
  });

  it("sends error for invalid session ID (path traversal)", async () => {
    const ws = await connectMux();

    ws.send(
      JSON.stringify({
        ch: "terminal",
        id: "../../../etc/passwd",
        tmuxName: TEST_SESSION,
        type: "open",
      }),
    );

    const msg = await waitForMessage(ws, (m) => m.ch === "terminal" && m.type === "error");
    expect(msg.message).toMatch(/invalid session/i);

    ws.close();
  });

  it("sends error for shell injection in session ID", async () => {
    const ws = await connectMux();

    ws.send(
      JSON.stringify({
        ch: "terminal",
        id: "test;rm -rf /",
        tmuxName: TEST_SESSION,
        type: "open",
      }),
    );

    const msg = await waitForMessage(ws, (m) => m.ch === "terminal" && m.type === "error");
    expect(msg.message).toMatch(/invalid session/i);

    ws.close();
  });

  it("uses an explicit exact tmuxName for hash-prefixed sessions", async () => {
    const hashOnlyId = `ao-test-hash-${process.pid}`;
    const ws = await connectMux();

    ws.send(
      JSON.stringify({ ch: "terminal", id: hashOnlyId, tmuxName: TEST_HASH_SESSION, type: "open" }),
    );

    const exactMsg = await waitForMessage(ws, (m) => m.ch === "terminal" && m.type === "opened");
    expect(exactMsg.id).toBe(hashOnlyId);

    ws.close();
  });

  it("allows a legacy tmuxName that is not a valid AO session id", async () => {
    const ws = await connectMux();

    ws.send(
      JSON.stringify({
        ch: "terminal",
        id: "legacy-session",
        tmuxName: TEST_SPACED_TARGET,
        type: "open",
      }),
    );

    const msg = await waitForMessage(ws, (m) => m.ch === "terminal" && m.type === "opened");
    expect(msg.id).toBe("legacy-session");

    ws.close();
  });

  it("retry budget recovers after PTY survives the grace period (issue #1639)", async () => {
    // Complements the runaway-loop test below. That one proves the counter
    // does NOT reset when the PTY crashes inside REATTACH_RESET_GRACE_MS.
    // This one proves the counter DOES reset once the PTY survives the
    // grace period — without which a transient blip during startup would
    // permanently consume the retry budget and prevent any later recovery.
    //
    // Test shape:
    //   1. Open a terminal against a healthy tmux session (PTY 1 attaches).
    //   2. Wait > REATTACH_RESET_GRACE_MS so the grace timer fires and
    //      resets reattachAttempts to 0 on the still-attached PTY 1.
    //   3. Kill the tmux session — PTY 1 exits, the server burns the full
    //      MAX_REATTACH_ATTEMPTS=3 budget trying to re-attach, then emits
    //      "exited". A 2 s window is comfortably more than 3 × ~50 ms.
    //   4. Per-test timeout raised to 15 s to accommodate the 5+ s wait.
    //
    // If the grace timer or its closure guard ever regresses (e.g. is
    // unref'd in a way that prevents firing, or the wrong reference is
    // compared, or a future change clears it too eagerly), step 3 will
    // either time out waiting for "exited" or never reach the cap.
    const RECOVERY_TEST_SESSION = `ao-test-recovery-${process.pid}`;
    if (!TMUX) return; // describeWithTmux already skips on Windows; this narrows the type
    execFileSync(TMUX, ["new-session", "-d", "-s", RECOVERY_TEST_SESSION, "-x", "80", "-y", "24"], {
      timeout: 5000,
    });

    try {
      const ws = await connectMux();
      ws.send(JSON.stringify({ ch: "terminal", id: RECOVERY_TEST_SESSION, type: "open" }));
      await waitForMessage(ws, (m) => m.ch === "terminal" && m.type === "opened");

      // Sleep past REATTACH_RESET_GRACE_MS (5 s in production).
      await new Promise((r) => setTimeout(r, 5500));

      execFileSync(TMUX, ["kill-session", "-t", RECOVERY_TEST_SESSION], { timeout: 5000 });

      const exitedMsg = await waitForMessage(
        ws,
        (m) => m.ch === "terminal" && m.type === "exited",
        2000,
      );
      expect(exitedMsg.id).toBe(RECOVERY_TEST_SESSION);

      ws.close();
    } finally {
      try {
        execFileSync(TMUX, ["kill-session", "-t", RECOVERY_TEST_SESSION], { timeout: 5000 });
      } catch {
        /* already gone */
      }
    }
  }, 15_000);

  it("bounds re-attach attempts when tmux session dies mid-subscription (issue #1639)", async () => {
    // Reproduces the runaway re-attach loop that exhausts the system PTY
    // pool in seconds when `ao stop` kills the tmux session out from
    // under a still-subscribed dashboard.
    //
    // Pre-fix behaviour: each "successful" re-attach reset reattachAttempts
    // to 0, so MAX_REATTACH_ATTEMPTS=3 never engaged; the loop ran at
    // ~80 spawns/sec and "exited" was never emitted, so this test would
    // hang until the 2-second timeout.
    //
    // Post-fix: the counter is only reset by a 5-second grace timer, so a
    // PTY that exits in ~40 ms can never reset it. After 3 attempts the
    // server gives up and emits "exited".
    const RUNAWAY_TEST_SESSION = `ao-test-runaway-${process.pid}`;
    if (!TMUX) return; // describeWithTmux already skips on Windows; this narrows the type
    execFileSync(TMUX, ["new-session", "-d", "-s", RUNAWAY_TEST_SESSION, "-x", "80", "-y", "24"], {
      timeout: 5000,
    });

    try {
      const ws = await connectMux();

      ws.send(JSON.stringify({ ch: "terminal", id: RUNAWAY_TEST_SESSION, type: "open" }));
      await waitForMessage(ws, (m) => m.ch === "terminal" && m.type === "opened");

      // Kill the tmux session externally — the attached PTY now has nothing
      // to attach to and will exit ~40 ms after each re-attach attempt.
      execFileSync(TMUX, ["kill-session", "-t", RUNAWAY_TEST_SESSION], { timeout: 5000 });

      // 3 re-attach attempts × ~50 ms each = ~150 ms; allow generous margin.
      const exitedMsg = await waitForMessage(
        ws,
        (m) => m.ch === "terminal" && m.type === "exited",
        2000,
      );
      expect(exitedMsg.id).toBe(RUNAWAY_TEST_SESSION);

      ws.close();
    } finally {
      // Best-effort cleanup if test fails before kill-session ran
      try {
        execFileSync(TMUX, ["kill-session", "-t", RUNAWAY_TEST_SESSION], { timeout: 5000 });
      } catch {
        /* already gone */
      }
    }
  });
});

// =============================================================================
// Mux protocol — terminal I/O
// =============================================================================

describeWithTmux("mux terminal I/O", () => {
  it("receives terminal data after open", async () => {
    const ws = await connectMux();

    ws.send(
      JSON.stringify({ ch: "terminal", id: "test-session", tmuxName: TEST_SESSION, type: "open" }),
    );
    await waitForMessage(ws, (m) => m.ch === "terminal" && m.type === "opened");

    // tmux sends terminal init sequences on attach — wait for any data
    const dataMsg = await waitForMessage(ws, (m) => m.ch === "terminal" && m.type === "data", 5000);
    expect(typeof dataMsg.data).toBe("string");
    expect((dataMsg.data as string).length).toBeGreaterThan(0);

    ws.close();
  });

  it("can send input and receive echo", async () => {
    const ws = await connectMux();

    ws.send(
      JSON.stringify({ ch: "terminal", id: "test-session", tmuxName: TEST_SESSION, type: "open" }),
    );
    await waitForMessage(ws, (m) => m.ch === "terminal" && m.type === "opened");
    // Drain initial output
    await new Promise((r) => setTimeout(r, 300));

    const marker = `MUX_IO_${Date.now()}`;
    ws.send(
      JSON.stringify({
        ch: "terminal",
        id: "test-session",
        type: "data",
        data: `echo ${marker}\n`,
      }),
    );

    let received = "";
    await new Promise<void>((resolve) => {
      const handler = (raw: Buffer | string) => {
        try {
          const msg = JSON.parse(raw.toString()) as MuxMessage;
          if (msg.ch === "terminal" && msg.type === "data") {
            received += msg.data as string;
            if (received.includes(marker)) {
              ws.off("message", handler);
              resolve();
            }
          }
        } catch {
          /* */
        }
      };
      ws.on("message", handler);
      setTimeout(() => {
        ws.off("message", handler);
        resolve();
      }, 4000);
    });

    expect(received).toContain(marker);
    ws.close();
  });

  it("handles resize without error", async () => {
    const ws = await connectMux();

    ws.send(
      JSON.stringify({ ch: "terminal", id: "test-session", tmuxName: TEST_SESSION, type: "open" }),
    );
    await waitForMessage(ws, (m) => m.ch === "terminal" && m.type === "opened");

    ws.send(
      JSON.stringify({
        ch: "terminal",
        id: "test-session",
        type: "resize",
        cols: 120,
        rows: 40,
      }),
    );

    // No error message expected
    await new Promise((r) => setTimeout(r, 200));

    const marker = `RESIZE_${Date.now()}`;
    ws.send(
      JSON.stringify({
        ch: "terminal",
        id: "test-session",
        type: "data",
        data: `echo ${marker}\n`,
      }),
    );

    let received = "";
    await new Promise<void>((resolve) => {
      const handler = (raw: Buffer | string) => {
        try {
          const msg = JSON.parse(raw.toString()) as MuxMessage;
          if (msg.ch === "terminal" && msg.type === "data") {
            received += msg.data as string;
            if (received.includes(marker)) {
              ws.off("message", handler);
              resolve();
            }
          }
        } catch {
          /* */
        }
      };
      ws.on("message", handler);
      setTimeout(() => {
        ws.off("message", handler);
        resolve();
      }, 4000);
    });

    expect(received).toContain(marker);
    ws.close();
  });
});

// =============================================================================
// Mux protocol — system channel
// =============================================================================

describeWithTmux("mux system channel", () => {
  it("responds to ping with pong", async () => {
    const ws = await connectMux();

    ws.send(JSON.stringify({ ch: "system", type: "ping" }));

    const msg = await waitForMessage(ws, (m) => m.ch === "system" && m.type === "pong");
    expect(msg.ch).toBe("system");

    ws.close();
  });
});

// =============================================================================
// Server creation
// =============================================================================

describeWithTmux("server creation", () => {
  it("createDirectTerminalServer returns expected properties", () => {
    expect(terminal).toHaveProperty("server");
    expect(terminal).toHaveProperty("shutdown");
    expect(typeof terminal.shutdown).toBe("function");
  });

  it("can create multiple independent servers", () => {
    const server2 = createDirectTerminalServer(TMUX);
    server2.server.listen(0);
    const addr = server2.server.address();
    const port2 = typeof addr === "object" && addr ? addr.port : 0;

    expect(port2).toBeGreaterThan(0);
    expect(port2).not.toBe(port);

    server2.shutdown();
  });
});
