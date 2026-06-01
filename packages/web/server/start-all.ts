/**
 * Production entry point — starts Next.js + terminal servers.
 * Used by `ao start` when running from an npm install (no monorepo).
 * Replaces the dev-only `concurrently` setup.
 */

import { type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  isWindows,
  killProcessTree,
  markDaemonShutdownHandlerInstalled,
  spawnManagedDaemonChild,
} from "@aoagents/ao-core";
import { ensureRemoteAuthCredentials, ensureRemoteWsTokenSecret } from "./remote-auth.js";
import { proxyTerminalUpgrade } from "./terminal-proxy.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

type NextApp = {
  prepare: () => Promise<void>;
  getRequestHandler: () => (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
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

ensureRemoteAuthCredentials();
ensureRemoteWsTokenSecret();

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

const port = process.env["PORT"] || "3000";
const hostname = process.env["HOST"] || "0.0.0.0";
process.env["AO_TRUST_REMOTE_ADDRESS_HEADER"] = "1";
const pathBasedMux = process.env["AO_PATH_BASED_MUX"] === "1";

// When AO_PATH_BASED_MUX=1, single-port-server.js owns PORT and Next.js is
// shifted to PORT + 1000 (overridable via NEXT_INTERNAL_PORT). The proxy
// forwards HTTP to Next.js and tunnels `/ao-terminal-mux` WS upgrades to
// direct-terminal-ws. Default off — Next.js stays on PORT directly.
const NEXT_INTERNAL_OFFSET = 1000;
const nextPort = pathBasedMux
  ? (process.env["NEXT_INTERNAL_PORT"] ?? String(parseInt(port, 10) + NEXT_INTERNAL_OFFSET))
  : port;

if (pathBasedMux) {
  // Surface the internal port to the child so it doesn't have to re-derive
  // the offset; pin it explicitly.
  process.env["NEXT_INTERNAL_PORT"] = nextPort;
  spawnProcess("single-port", process.execPath, [resolve(__dirname, "single-port-server.js")]);
}

// Start direct terminal WebSocket server (auto-restart on crash)
spawnProcess("direct-terminal", "node", [resolve(__dirname, "direct-terminal-ws.js")], {
  restart: true,
});

async function startNextServer(): Promise<void> {
  const app = next({ dev: false, dir: pkgRoot, hostname, port: Number.parseInt(nextPort, 10) });
  const handle = app.getRequestHandler();
  await app.prepare();

  nextServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.headers["x-ao-remote-address"] = req.socket.remoteAddress ?? "";
    void handle(req, res);
  });

  nextServer.on("upgrade", (request, socket, head) => {
    if (!proxyTerminalUpgrade(request, socket, head)) {
      socket.destroy();
    }
  });

  nextServer.listen(Number.parseInt(nextPort, 10), hostname, () => {
    log("next", `ready on http://${hostname}:${nextPort}`);
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
