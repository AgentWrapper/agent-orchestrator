/**
 * Direct WebSocket terminal server.
 * Hosts the multiplexed /mux WebSocket endpoint for all terminal connections.
 */

import { createServer, type Server } from "node:http";
import type { WebSocketServer } from "ws";
import { isWindows } from "@aoagents/ao-core";
import { findTmux } from "./tmux-utils.js";
import { createMuxWebSocket } from "./mux-websocket.js";
import {
  activeRemoteAuth,
  readConfiguredRemoteAuth,
  verifyRemoteWsToken,
  type RemoteAuthCredentials,
} from "./remote-auth.js";

export interface DirectTerminalServer {
  server: Server;
  shutdown: (onClosed?: () => void) => void;
}

function isRemoteAuthAllowed(url: URL, initialConfiguredAuth: RemoteAuthCredentials): boolean {
  const { username, password: expectedPassword } = activeRemoteAuth(initialConfiguredAuth);
  if (!expectedPassword) return true;

  return verifyRemoteWsToken(url.searchParams.get("auth_token"), {
    username,
    password: expectedPassword,
  });
}

/**
 * Create the direct terminal WebSocket server.
 * Separated from listen() so tests can control lifecycle.
 */
export function createDirectTerminalServer(tmuxPath?: string | null): DirectTerminalServer {
  const TMUX = tmuxPath ?? findTmux();
  const initialConfiguredAuth = readConfiguredRemoteAuth();

  let muxWss: WebSocketServer | null = null;

  const metrics = {
    totalConnections: 0,
    totalDisconnects: 0,
    totalErrors: 0,
  };

  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          clients: muxWss?.clients.size ?? 0,
          metrics,
        }),
      );
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  muxWss = createMuxWebSocket(TMUX);

  if (muxWss) {
    muxWss.on("connection", (ws) => {
      metrics.totalConnections++;
      ws.on("close", () => {
        metrics.totalDisconnects++;
      });
      ws.on("error", () => {
        metrics.totalErrors++;
      });
    });
  }

  // Manual upgrade routing — ws library doesn't support multiple WebSocketServer
  // instances with different `path` options on the same HTTP server.
  // `/ao-terminal-mux` is accepted as an alias of `/mux` so deployments fronted
  // by a path-routing reverse proxy (e.g. cloudflared, nginx) can forward the
  // dashboard's path-based mux URL straight at this port without needing a
  // path-rewrite rule. The dashboard's MuxProvider already constructs that
  // path when accessed on a standard HTTPS port; see `packages/web/src/providers/MuxProvider.tsx`.
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "ws://localhost");
    const pathname = url.pathname;

    if (
      (pathname === "/mux" || pathname === "/ao-terminal-mux") &&
      muxWss &&
      isRemoteAuthAllowed(url, initialConfiguredAuth)
    ) {
      muxWss.handleUpgrade(request, socket, head, (ws) => {
        muxWss!.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  let shuttingDown = false;

  function shutdown(onClosed?: () => void) {
    if (shuttingDown) return;
    shuttingDown = true;

    // Terminate all connected mux clients — this triggers their 'close' events
    // which unsubscribe terminal callbacks and kill PTY processes.
    if (muxWss) {
      for (const client of muxWss.clients) {
        client.terminate();
      }
      muxWss.close();
    }
    server.close((err?: Error & { code?: string }) => {
      if (err && err.code !== "ERR_SERVER_NOT_RUNNING") {
        console.error("[DirectTerminal] Error during shutdown:", err);
      }
      onClosed?.();
    });
  }

  return { server, shutdown };
}

// --- Run as standalone script ---
// Only start the server when executed directly (not imported by tests)
const isMainModule =
  process.argv[1]?.endsWith("direct-terminal-ws.ts") ||
  process.argv[1]?.endsWith("direct-terminal-ws.js");

if (isMainModule) {
  const PORT = parseInt(process.env.DIRECT_TERMINAL_PORT ?? "14801", 10);

  // On Windows, findTmux() returns null — mux-websocket.ts handles this by
  // using named pipe relay to PTY hosts instead of tmux attach.
  const TMUX = findTmux();
  if (TMUX) {
    console.log(`[DirectTerminal] Using tmux: ${TMUX}`);
  } else if (isWindows()) {
    console.log(`[DirectTerminal] Windows mode — using named pipe relay to PTY hosts`);
  } else {
    console.log(`[DirectTerminal] No tmux available — terminal relay may be limited`);
  }

  const { server, shutdown } = createDirectTerminalServer(TMUX);
  let shuttingDown = false;

  server.listen(PORT, () => {
    console.log(`[DirectTerminal] WebSocket server listening on port ${PORT}`);
  });

  function handleShutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`[DirectTerminal] Received ${signal}, shutting down...`);
    const forceExitTimer = setTimeout(() => {
      console.error("[DirectTerminal] Forced shutdown after timeout");
      process.exit(1);
    }, 5000);
    forceExitTimer.unref();

    shutdown(() => {
      clearTimeout(forceExitTimer);
      process.exit(0);
    });
  }

  process.on("SIGINT", () => handleShutdown("SIGINT"));
  process.on("SIGTERM", () => handleShutdown("SIGTERM"));
}
