/**
 * Production entry point — starts Next.js + terminal servers.
 * Used by `ao start` when running from an npm install (no monorepo).
 * Replaces the dev-only `concurrently` setup.
 */

import { type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createConnection } from "node:net";
import { resolve, dirname } from "node:path";
import { type Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  isWindows,
  killProcessTree,
  markDaemonShutdownHandlerInstalled,
  spawnManagedDaemonChild,
} from "@aoagents/ao-core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

type NextApp = {
  prepare: () => Promise<void>;
  getRequestHandler: () => (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
  getUpgradeHandler?: () => (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => Promise<void> | void;
};

const next = require("next") as (options: {
  dev: boolean;
  dir: string;
  hostname: string;
  port: number;
}) => NextApp;

// Resolve paths relative to the package root (one level up from dist-server/)
const pkgRoot = resolve(__dirname, "..");

const children: ChildProcess[] = [];
markDaemonShutdownHandlerInstalled();
let nextServer: Server | null = null;
let shuttingDown = false;

function log(label: string, msg: string): void {
  process.stdout.write(`[${label}] ${msg}\n`);
}

function spawnProcess(
  label: string,
  command: string,
  args: string[],
  opts?: { restart?: boolean; maxRestarts?: number },
): ChildProcess {
  let restarts = 0;
  const maxRestarts = opts?.maxRestarts ?? 3;
  let slotIndex = -1;

  function launch(): ChildProcess {
    const child = spawnManagedDaemonChild(`dashboard:${label}`, command, args, {
      cwd: pkgRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      detached: !isWindows(),
    });

    child.stdout?.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n").filter(Boolean)) {
        log(label, line);
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n").filter(Boolean)) {
        log(label, line);
      }
    });

    child.on("exit", (code) => {
      log(label, `exited with code ${code}`);
      if (!shuttingDown && opts?.restart && code !== 0 && restarts < maxRestarts) {
        restarts++;
        log(label, `restarting (attempt ${restarts}/${maxRestarts})`);
        const replacement = launch();
        // Replace in-place — slot was assigned on first push
        children[slotIndex] = replacement;
      }
    });

    // Only push on first launch; restarts replace the existing slot
    if (slotIndex === -1) {
      slotIndex = children.length;
      children.push(child);
    }

    return child;
  }

  return launch();
}

function getTerminalProxyTarget(requestUrl: string | undefined): string | null {
  const url = new URL(requestUrl ?? "/", "ws://localhost");
  if (url.pathname === "/ao-terminal-mux") {
    url.pathname = "/mux";
    return `${url.pathname}${url.search}`;
  }
  if (url.pathname.startsWith("/ao-terminal/")) {
    url.pathname = url.pathname.slice("/ao-terminal".length);
    return `${url.pathname}${url.search}`;
  }
  return null;
}

const port = process.env["PORT"] || "3000";
const hostname = process.env["HOST"] || "0.0.0.0";

function proxyTerminalUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  const targetPath = getTerminalProxyTarget(request.url);
  if (!targetPath) return false;

  const directTerminalPort = Number.parseInt(process.env["DIRECT_TERMINAL_PORT"] ?? "14801", 10);
  const upstream = createConnection({ host: "127.0.0.1", port: directTerminalPort });

  upstream.on("connect", () => {
    const headers = Object.entries(request.headers)
      .flatMap(([name, value]) => {
        if (Array.isArray(value)) return value.map((item) => `${name}: ${item}`);
        return value === undefined ? [] : [`${name}: ${value}`];
      })
      .join("\r\n");
    upstream.write(`GET ${targetPath} HTTP/${request.httpVersion}\r\n${headers}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });

  upstream.on("error", () => {
    socket.destroy();
  });
  socket.on("error", () => {
    upstream.destroy();
  });

  return true;
}

// Start direct terminal WebSocket server (auto-restart on crash)
spawnProcess("direct-terminal", "node", [resolve(__dirname, "direct-terminal-ws.js")], {
  restart: true,
});

async function startNextServer(): Promise<void> {
  const app = next({ dev: false, dir: pkgRoot, hostname, port: Number.parseInt(port, 10) });
  const handle = app.getRequestHandler();
  await app.prepare();
  const handleUpgrade = app.getUpgradeHandler?.();

  nextServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res);
  });

  nextServer.on("upgrade", (request, socket, head) => {
    if (proxyTerminalUpgrade(request, socket, head)) {
      return;
    }
    if (handleUpgrade) {
      void handleUpgrade(request, socket, head);
    } else {
      socket.destroy();
    }
  });

  nextServer.listen(Number.parseInt(port, 10), hostname, () => {
    log("next", `ready on http://${hostname}:${port}`);
  });
}

startNextServer().catch((err: unknown) => {
  log("next", `failed to start: ${err instanceof Error ? err.message : String(err)}`);
  cleanup();
});

function cleanup(): void {
  if (shuttingDown) return;
  shuttingDown = true;

  let alive = children.length;
  if (alive === 0) {
    nextServer?.close();
    process.exit(0);
    return;
  }

  nextServer?.close();

  // Force exit after 5s if children don't exit cleanly
  const forceTimer = setTimeout(() => {
    log("start-all", "Children did not exit in time, forcing shutdown");
    process.exit(1);
  }, 5000);
  forceTimer.unref();

  for (const child of children) {
    child.on("exit", () => {
      alive--;
      if (alive <= 0) {
        clearTimeout(forceTimer);
        process.exit(0);
      }
    });
    const pid = child.pid;
    if (pid) {
      void killProcessTree(pid, "SIGTERM").catch(() => {
        child.kill("SIGTERM");
      });
    } else {
      child.kill("SIGTERM");
    }
  }
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
