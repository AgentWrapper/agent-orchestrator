/**
 * Single-port server (opt-in) — a thin HTTP + WebSocket proxy that puts
 * Next.js and the `/ao-terminal-mux` WebSocket upgrade on the same public
 * port. Spawned by start-all.ts when AO_PATH_BASED_MUX=1, in front of a
 * Next.js process that has shifted to an internal port.
 *
 *     ┌──────────────────────┐  HTTP  ┌──────────────────────┐
 *     │ proxy on PORT        │───────▶│ next start           │
 *     │ (this file)          │        │ on NEXT_INTERNAL_PORT │
 *     │                      │        └──────────────────────┘
 *     │                      │  WS upgrade /ao-terminal-mux
 *     │                      │───────▶┌──────────────────────┐
 *     │                      │        │ direct-terminal-ws   │
 *     │                      │        │ on DIRECT_TERMINAL   │
 *     │                      │        └──────────────────────┘
 *     └──────────────────────┘
 *
 * The default flow (AO_PATH_BASED_MUX unset) is unchanged: Next.js runs on
 * PORT directly, direct-terminal-ws runs on DIRECT_TERMINAL_PORT, and the
 * dashboard JS picks one of three URLs at connection time
 * (see `packages/web/src/providers/MuxProvider.tsx`):
 *
 *   1. proxyWsPath (TERMINAL_WS_PATH) — explicit path-based routing
 *   2. standard port (loc.port "" / 443 / 80) — `/ao-terminal-mux` on same host
 *   3. fallback — direct connection to `:DIRECT_TERMINAL_PORT/mux`
 *
 * Path #1 and #3 require the operator to do something at the proxy layer
 * (path rewrite or per-port routing). Path #2 only works if *something* is
 * listening for the `/ao-terminal-mux` upgrade on the dashboard port. Until
 * now, nothing was — Next.js doesn't handle upgrades, so the request fell
 * through to its 404 handler. This server is that something.
 *
 * Use this when the reverse proxy in front of AO can only forward one
 * hostname:port pair upstream (e.g. Cloudflare Tunnel pointed at one
 * `service:` URL with no path-based ingress). With this enabled, a single
 * proxy rule pointing at PORT is sufficient — the WS path is multiplexed
 * onto the same TCP port and demuxed here.
 *
 * `createSinglePortServer()` is exported so the proxy behaviour can be
 * exercised in tests; the bottom-of-file entrypoint wires it to env vars and
 * process signals when this file is run directly (as start-all.ts spawns it).
 */

import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
} from "node:http";
import type { Socket } from "node:net";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MUX_PATH = "/ao-terminal-mux";
const SHUTDOWN_TIMEOUT_MS = 5_000;

/**
 * Hop-by-hop headers (RFC 9110 §7.6.1) are meaningful only on a single
 * transport connection and must not be forwarded by an intermediary.
 * Forwarding e.g. a client's `Connection: close` would tear down the
 * keep-alive socket to the upstream; a stray `Transfer-Encoding` would
 * desync framing once the body is re-encoded.
 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface SinglePortConfig {
  /** Public-facing port this proxy listens on. */
  port: number;
  /** Internal port Next.js has been shifted to. */
  nextInternalPort: number;
  /** Port direct-terminal-ws listens on. */
  directTerminalPort: number;
}

export interface SinglePortServer {
  /** The underlying HTTP server — exposed for `.address()` in tests. */
  server: Server;
  /** Begin listening on the configured port; resolves once bound. */
  listen(): Promise<void>;
  /**
   * Stop listening and force-close every live connection, resolving once the
   * server is fully closed. `server.close()` alone waits for keep-alive HTTP
   * sockets and piped WS tunnels to drain on their own, which they never do.
   */
  shutdown(): Promise<void>;
}

/**
 * Build the header set for an upstream request: strip hop-by-hop headers
 * (including any extra ones named in the client's `Connection` header) and
 * append the standard `X-Forwarded-*` trio so the upstream still sees the
 * real client IP / proto / host instead of `127.0.0.1`.
 *
 * On the WebSocket upgrade path, `keepUpgrade` retains `Connection` and
 * `Upgrade` — the handshake is exactly the case where those headers are
 * load-bearing rather than hop-by-hop noise.
 */
function buildUpstreamHeaders(
  req: IncomingMessage,
  opts: { keepUpgrade: boolean },
): OutgoingHttpHeaders {
  const drop = new Set(HOP_BY_HOP);

  const connection = req.headers.connection;
  if (connection) {
    const tokens = Array.isArray(connection) ? connection : connection.split(",");
    for (const token of tokens) {
      const name = token.trim().toLowerCase();
      if (name) drop.add(name);
    }
  }
  if (opts.keepUpgrade) {
    drop.delete("connection");
    drop.delete("upgrade");
  }

  const headers: OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (drop.has(key.toLowerCase())) continue;
    headers[key] = value;
  }

  // X-Forwarded-*: preserve anything an outer proxy already set, then add ours.
  const clientIp = req.socket.remoteAddress ?? "";
  const priorFor = headers["x-forwarded-for"];
  headers["x-forwarded-for"] = priorFor
    ? `${Array.isArray(priorFor) ? priorFor.join(", ") : String(priorFor)}, ${clientIp}`
    : clientIp;
  // This proxy itself terminates plain HTTP; an outer TLS proxy would have
  // set x-forwarded-proto already, so only fill it in when absent.
  if (headers["x-forwarded-proto"] === undefined) {
    headers["x-forwarded-proto"] = "http";
  }
  if (headers["x-forwarded-host"] === undefined && req.headers.host) {
    headers["x-forwarded-host"] = req.headers.host;
  }
  return headers;
}

/**
 * Drop hop-by-hop headers from an upstream *response* before relaying it to
 * the client. Without this the upstream's `Connection`/`Keep-Alive` would
 * override the proxy↔client connection's own semantics — e.g. forwarding the
 * upstream's `Connection: keep-alive` ignores a client that asked for `close`.
 * Framing headers (`transfer-encoding`) are dropped here too so the client's
 * `ServerResponse` re-derives framing for its own hop.
 */
function filterResponseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

function tunnelUpgrade(
  req: IncomingMessage,
  clientSocket: Socket,
  clientHead: Buffer,
  target: { host: string; port: number; path: string },
): void {
  const proxyReq = httpRequest({
    host: target.host,
    port: target.port,
    method: "GET",
    path: target.path,
    headers: buildUpstreamHeaders(req, { keepUpgrade: true }),
  });

  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    const lines = [
      `HTTP/1.1 ${proxyRes.statusCode ?? 101} ${proxyRes.statusMessage ?? "Switching Protocols"}`,
    ];
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      if (value === undefined) continue;
      lines.push(`${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`);
    }
    lines.push("\r\n");
    clientSocket.write(lines.join("\r\n"));

    if (proxyHead.length > 0) clientSocket.write(proxyHead);
    if (clientHead.length > 0) proxySocket.write(clientHead);

    clientSocket.pipe(proxySocket);
    proxySocket.pipe(clientSocket);

    const teardown = (): void => {
      clientSocket.destroy();
      proxySocket.destroy();
    };
    proxySocket.on("error", teardown);
    proxySocket.on("close", teardown);
    clientSocket.on("error", teardown);
    clientSocket.on("close", teardown);
  });

  // Upstream answered the upgrade with an ordinary response (404, 502,
  // mid-restart, path not in its allow-list, …) instead of a 101. Without
  // this handler the `upgrade` event never fires and the client socket
  // hangs until its TCP timeout. Relay the response and close cleanly.
  proxyReq.on("response", (proxyRes) => {
    if (clientSocket.writableEnded || clientSocket.destroyed) {
      proxyRes.destroy();
      return;
    }
    const lines = [`HTTP/1.1 ${proxyRes.statusCode ?? 502} ${proxyRes.statusMessage ?? ""}`];
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      if (value === undefined) continue;
      const lower = key.toLowerCase();
      // Body is delimited by connection close below, so drop framing headers.
      if (HOP_BY_HOP.has(lower) || lower === "content-length") continue;
      lines.push(`${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`);
    }
    lines.push("connection: close");
    lines.push("\r\n");
    clientSocket.write(lines.join("\r\n"));
    proxyRes.pipe(clientSocket);
    proxyRes.on("end", () => clientSocket.end());
  });

  proxyReq.on("error", (err) => {
    console.error(
      `[single-port] upstream upgrade error (${target.host}:${target.port}${target.path}): ${err.message}`,
    );
    clientSocket.destroy();
  });

  proxyReq.end();
}

/**
 * Create the single-port proxy. The returned server is not yet listening —
 * call `listen()`.
 */
export function createSinglePortServer(config: SinglePortConfig): SinglePortServer {
  const { port, nextInternalPort, directTerminalPort } = config;

  // Sockets handed off via the 'upgrade' event are no longer tracked by the
  // HTTP server, so `server.closeAllConnections()` does not destroy them and
  // `server.close()`'s callback would wait on them forever. Track them here.
  const upgradedSockets = new Set<Socket>();

  const server = createServer((req, res) => {
    const proxyReq = httpRequest(
      {
        host: "127.0.0.1",
        port: nextInternalPort,
        method: req.method,
        path: req.url,
        headers: buildUpstreamHeaders(req, { keepUpgrade: false }),
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, filterResponseHeaders(proxyRes.headers));
        proxyRes.pipe(res);
      },
    );

    proxyReq.on("error", (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain" });
      }
      res.end(`Bad gateway: ${err.message}`);
    });

    req.pipe(proxyReq);
  });

  server.on("upgrade", (req, socket, head) => {
    const clientSocket = socket as Socket;
    upgradedSockets.add(clientSocket);
    clientSocket.once("close", () => upgradedSockets.delete(clientSocket));

    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const target =
      pathname === MUX_PATH
        ? { host: "127.0.0.1", port: directTerminalPort, path: "/mux" }
        : { host: "127.0.0.1", port: nextInternalPort, path: req.url ?? "/" };

    tunnelUpgrade(req, clientSocket, head, target);
  });

  return {
    server,
    listen() {
      return new Promise<void>((resolve) => server.listen(port, () => resolve()));
    },
    shutdown() {
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
        // closeAllConnections() handles keep-alive HTTP sockets; the upgraded
        // WS tunnels are tracked separately and destroyed here. Destroying the
        // client socket triggers tunnelUpgrade's teardown for the upstream side.
        server.closeAllConnections();
        for (const socket of upgradedSockets) socket.destroy();
      });
    },
  };
}

/** Parse and validate the proxy config from env vars, exiting on bad input. */
function configFromEnv(): SinglePortConfig {
  const port = parseInt(process.env.PORT ?? "3000", 10);
  const directTerminalPort = parseInt(process.env.DIRECT_TERMINAL_PORT ?? "14801", 10);
  const nextInternalPort = parseInt(process.env.NEXT_INTERNAL_PORT ?? "0", 10);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    console.error(`[single-port] Invalid PORT: ${process.env.PORT}`);
    process.exit(1);
  }
  if (
    !Number.isInteger(directTerminalPort) ||
    directTerminalPort < 1 ||
    directTerminalPort > 65_535
  ) {
    console.error(
      `[single-port] Invalid DIRECT_TERMINAL_PORT: ${process.env.DIRECT_TERMINAL_PORT}`,
    );
    process.exit(1);
  }
  if (
    !Number.isInteger(nextInternalPort) ||
    nextInternalPort < 1 ||
    nextInternalPort > 65_535 ||
    nextInternalPort === port
  ) {
    console.error(
      `[single-port] Invalid NEXT_INTERNAL_PORT (must differ from PORT): ${process.env.NEXT_INTERNAL_PORT}`,
    );
    process.exit(1);
  }
  return { port, nextInternalPort, directTerminalPort };
}

function main(): void {
  const config = configFromEnv();
  const proxy = createSinglePortServer(config);

  void proxy.listen().then(() => {
    console.log(
      `[single-port] listening on ${config.port}; HTTP → 127.0.0.1:${config.nextInternalPort}; ${MUX_PATH} → 127.0.0.1:${config.directTerminalPort}/mux`,
    );
  });

  const onSignal = (): void => {
    void proxy.shutdown().then(() => process.exit(0));
    setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

/** True when this file was run directly (`node single-port-server.js`). */
function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main();
}
