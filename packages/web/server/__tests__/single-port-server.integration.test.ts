/**
 * Integration tests for single-port-server — the opt-in HTTP + WebSocket
 * proxy used when AO_PATH_BASED_MUX=1.
 *
 * These pin the four behaviours surfaced in review of PR #1757:
 *   1. Hop-by-hop request headers are stripped before reaching the upstream.
 *   2. X-Forwarded-For/-Proto/-Host are added so the upstream sees the client.
 *   3. A non-101 response on the WS upgrade path is relayed, not left to hang.
 *   4. shutdown() closes promptly even with a live connection open.
 *
 * The proxy is pointed at lightweight fake upstreams, so no tmux / Next.js is
 * needed — these run everywhere, including CI on Windows.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  createServer as createHttpServer,
  request,
  type Server,
  type IncomingMessage,
} from "node:http";
import { connect as netConnect, type AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { createSinglePortServer, type SinglePortServer } from "../single-port-server.js";

// =============================================================================
// Teardown registry — every server/proxy created by a test is closed here.
// =============================================================================

const closers: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) {
    const close = closers.pop();
    if (close) await close();
  }
});

function portOf(server: Server): number {
  const addr = server.address() as AddressInfo | null;
  return addr ? addr.port : 0;
}

/** A fake "Next.js" upstream that echoes the request it received as JSON. */
async function startEchoUpstream(): Promise<number> {
  const server = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      // Set an explicit Content-Length (not chunked) so the raw-socket test
      // can read the body without decoding chunk framing.
      const payload = JSON.stringify({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      });
      res.end(payload);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise<void>((r) => server.close(() => r())));
  return portOf(server);
}

/** A fake direct-terminal-ws upstream: real WS server on /mux that echoes. */
async function startWsUpstream(): Promise<number> {
  const server = createHttpServer();
  const wss = new WebSocketServer({ server, path: "/mux" });
  wss.on("connection", (socket) => {
    socket.on("message", (data) => socket.send(data));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => {
    wss.close();
    return new Promise<void>((r) => server.close(() => r()));
  });
  return portOf(server);
}

/**
 * A fake upstream that answers a WS upgrade with a plain non-101 response —
 * the case fix #3 exists for.
 */
async function startNon101Upstream(): Promise<number> {
  const server = createHttpServer();
  server.on("upgrade", (_req, socket) => {
    socket.end(
      "HTTP/1.1 503 Service Unavailable\r\n" +
        "content-type: text/plain\r\n" +
        "content-length: 11\r\n" +
        "connection: close\r\n\r\n" +
        "unavailable",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise<void>((r) => server.close(() => r())));
  return portOf(server);
}

/** Start the proxy in front of the given upstream ports. */
async function startProxy(opts: {
  nextInternalPort: number;
  directTerminalPort: number;
}): Promise<{ proxy: SinglePortServer; port: number }> {
  const proxy = createSinglePortServer({
    port: 0,
    nextInternalPort: opts.nextInternalPort,
    directTerminalPort: opts.directTerminalPort,
  });
  await proxy.listen();
  closers.push(() => proxy.shutdown());
  return { proxy, port: portOf(proxy.server) };
}

/**
 * Write a raw HTTP request and collect the full raw response. `closedByPeer`
 * reports whether the server closed the connection on its own — used to prove
 * the proxy honoured the client's `Connection: close` instead of forwarding
 * the upstream's keep-alive.
 */
function rawHttpRequest(
  port: number,
  requestLines: string[],
): Promise<{ raw: string; closedByPeer: boolean }> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ port, host: "127.0.0.1" }, () => {
      socket.write(requestLines.join("\r\n") + "\r\n\r\n");
    });
    let raw = "";
    let closedByPeer = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (raw += chunk));
    socket.on("error", reject);
    socket.on("end", () => {
      closedByPeer = true;
      resolve({ raw, closedByPeer });
    });
    setTimeout(() => {
      socket.destroy();
      resolve({ raw, closedByPeer });
    }, 2000);
  });
}

// =============================================================================
// HTTP forwarding — header sanitisation
// =============================================================================

describe("single-port HTTP forwarding", () => {
  it("strips hop-by-hop headers and adds X-Forwarded-* before reaching upstream", async () => {
    const nextPort = await startEchoUpstream();
    const { port } = await startProxy({ nextInternalPort: nextPort, directTerminalPort: 1 });

    const { raw, closedByPeer } = await rawHttpRequest(port, [
      "GET /echo HTTP/1.1",
      "Host: dashboard.example",
      // "close" ends our client connection; "x-custom-hop" is named in
      // Connection so it is hop-by-hop too — both must be stripped.
      "Connection: close, X-Custom-Hop",
      "X-Custom-Hop: should-be-stripped",
      "Keep-Alive: timeout=99",
      "X-Forwarded-For: 1.2.3.4",
    ]);

    // The proxy must honour the client's Connection: close and not forward
    // the upstream's keep-alive — otherwise the connection lingers.
    expect(closedByPeer).toBe(true);

    const body = raw.slice(raw.indexOf("\r\n\r\n") + 4);
    const seen = JSON.parse(body) as { headers: Record<string, string> };

    // The client's hop-by-hop headers must not leak to the upstream.
    // X-Custom-Hop is listed in the client's Connection header, marking it
    // hop-by-hop — its absence proves Connection-token parsing works.
    expect(seen.headers["x-custom-hop"]).toBeUndefined();
    // The standard hop-by-hop Keep-Alive header is dropped.
    expect(seen.headers["keep-alive"]).not.toBe("timeout=99");
    // The client's Connection value ("close") must not propagate. The
    // proxy↔upstream hop has its own Connection header, managed by Node —
    // that is correct and expected, so only assert the client's value is gone.
    expect(String(seen.headers.connection ?? "")).not.toMatch(/close|x-custom-hop/);

    // X-Forwarded-For preserves the prior value and appends the proxy client.
    expect(seen.headers["x-forwarded-for"]).toMatch(/^1\.2\.3\.4, /);
    expect(seen.headers["x-forwarded-proto"]).toBe("http");
    expect(seen.headers["x-forwarded-host"]).toBe("dashboard.example");
  });

  it("returns 502 when the Next.js upstream is unreachable", async () => {
    // Point at a port nothing is listening on.
    const { port } = await startProxy({ nextInternalPort: 1, directTerminalPort: 1 });

    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port, path: "/", method: "GET" },
        (res: IncomingMessage) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });

    expect(status).toBe(502);
  });
});

// =============================================================================
// WebSocket upgrade path
// =============================================================================

describe("single-port WebSocket upgrade", () => {
  it("tunnels /ao-terminal-mux to the terminal upstream's /mux", async () => {
    const wsPort = await startWsUpstream();
    const { port } = await startProxy({ nextInternalPort: 1, directTerminalPort: wsPort });

    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const sock = new WebSocket(`ws://127.0.0.1:${port}/ao-terminal-mux`);
      sock.on("open", () => resolve(sock));
      sock.on("error", reject);
      setTimeout(() => reject(new Error("WS connect timeout")), 3000);
    });

    const echoed = await new Promise<string>((resolve, reject) => {
      ws.on("message", (data) => resolve(data.toString()));
      ws.on("error", reject);
      ws.send("ping-through-proxy");
      setTimeout(() => reject(new Error("WS echo timeout")), 3000);
    });

    expect(echoed).toBe("ping-through-proxy");
    ws.close();
  });

  it("relays a non-101 upstream response instead of hanging the client", async () => {
    // Regression test for the WS-upgrade hang: before the `response` handler,
    // a non-101 upstream answer left the client socket open until TCP timeout.
    const badPort = await startNon101Upstream();
    const { port } = await startProxy({ nextInternalPort: 1, directTerminalPort: badPort });

    const result = await new Promise<{ type: string; status?: number }>((resolve) => {
      const req = request({
        host: "127.0.0.1",
        port,
        path: "/ao-terminal-mux",
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          // Generated rather than hardcoded — a literal base64 nonce trips
          // the repo's gitleaks pre-commit hook as a high-entropy string.
          "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        },
      });
      req.on("upgrade", (res) => resolve({ type: "upgrade", status: res.statusCode }));
      req.on("response", (res) => {
        res.resume();
        resolve({ type: "response", status: res.statusCode });
      });
      req.on("error", () => resolve({ type: "error" }));
      // If the proxy hangs, none of the above fire and this surfaces it.
      setTimeout(() => resolve({ type: "hang" }), 3000);
      req.end();
    });

    expect(result.type).toBe("response");
    expect(result.status).toBe(503);
  });
});

// =============================================================================
// Shutdown
// =============================================================================

describe("single-port shutdown", () => {
  it("closes promptly with a live WebSocket connection open", async () => {
    // Regression test for shutdown hitting the force-exit timer: server.close()
    // alone waits forever for the piped WS tunnel; closeAllConnections() fixes it.
    const wsPort = await startWsUpstream();
    const { proxy, port } = await startProxy({
      nextInternalPort: 1,
      directTerminalPort: wsPort,
    });

    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const sock = new WebSocket(`ws://127.0.0.1:${port}/ao-terminal-mux`);
      sock.on("open", () => resolve(sock));
      sock.on("error", reject);
      setTimeout(() => reject(new Error("WS connect timeout")), 3000);
    });

    const start = Date.now();
    await proxy.shutdown();
    const elapsed = Date.now() - start;

    // Comfortably under the 5s force-exit timer the entrypoint arms.
    expect(elapsed).toBeLessThan(1000);

    ws.close();
  });
});
