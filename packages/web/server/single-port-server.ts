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
 */

import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";

const MUX_PATH = "/ao-terminal-mux";
const SHUTDOWN_TIMEOUT_MS = 5_000;

const port = parseInt(process.env.PORT ?? "3000", 10);
const directTerminalPort = parseInt(process.env.DIRECT_TERMINAL_PORT ?? "14801", 10);
const nextInternalPort = parseInt(process.env.NEXT_INTERNAL_PORT ?? "0", 10);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  console.error(`[single-port] Invalid PORT: ${process.env.PORT}`);
  process.exit(1);
}
if (!Number.isInteger(directTerminalPort) || directTerminalPort < 1 || directTerminalPort > 65_535) {
  console.error(`[single-port] Invalid DIRECT_TERMINAL_PORT: ${process.env.DIRECT_TERMINAL_PORT}`);
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

const server = createServer((req, res) => {
  const proxyReq = httpRequest(
    {
      host: "127.0.0.1",
      port: nextInternalPort,
      method: req.method,
      path: req.url,
      headers: req.headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
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
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  const target =
    pathname === MUX_PATH
      ? { host: "127.0.0.1", port: directTerminalPort, path: "/mux" }
      : { host: "127.0.0.1", port: nextInternalPort, path: req.url ?? "/" };

  tunnelUpgrade(req, socket as Socket, head, target);
});

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
    headers: req.headers,
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

  proxyReq.on("error", (err) => {
    console.error(
      `[single-port] upstream upgrade error (${target.host}:${target.port}${target.path}): ${err.message}`,
    );
    clientSocket.destroy();
  });

  proxyReq.end();
}

server.listen(port, () => {
  console.log(
    `[single-port] listening on ${port}; HTTP → 127.0.0.1:${nextInternalPort}; ${MUX_PATH} → 127.0.0.1:${directTerminalPort}/mux`,
  );
});

function shutdown(): void {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
