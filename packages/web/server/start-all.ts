/**
 * Production entry point — starts Next.js + terminal servers.
 * Used by `ao start` when running from an npm install (no monorepo).
 * Replaces the dev-only `concurrently` setup.
 */

import { type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
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

// Resolve paths relative to the package root (one level up from dist-server/)
const pkgRoot = resolve(__dirname, "..");

const children: ChildProcess[] = [];
markDaemonShutdownHandlerInstalled();

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

/**
 * Resolve the `next` CLI binary path.
 * Tries the local .bin shim first (fast), then falls back to require.resolve (hoisted deps).
 */
function resolveNextBin(): string {
  // On Windows, .bin/next is a POSIX shell shim that spawn() cannot execute.
  // Skip it and go straight to the JS entry point.
  if (!isWindows()) {
    const localBin = resolve(pkgRoot, "node_modules", ".bin", "next");
    if (existsSync(localBin)) return localBin;
  }

  // Resolve the actual Next.js CLI JS entry point
  const require = createRequire(resolve(pkgRoot, "package.json"));
  try {
    const nextPkg = require.resolve("next/package.json");
    return resolve(dirname(nextPkg), "dist", "bin", "next");
  } catch {
    // Last resort — rely on PATH
    return "next";
  }
}

// Start Next.js production server
const port = process.env["PORT"] || "3000";
const nextBin = resolveNextBin();

if (isWindows() && nextBin !== "next") {
  // On Windows, run the JS entry point via the current node binary.
  // spawn() can't execute .js files directly on Windows.
  spawnProcess("next", process.execPath, [nextBin, "start", "-p", port]);
} else {
  spawnProcess("next", nextBin, ["start", "-p", port]);
}

// Start direct terminal WebSocket server (auto-restart on crash)
spawnProcess("direct-terminal", "node", [resolve(__dirname, "direct-terminal-ws.js")], {
  restart: true,
});

// Graceful shutdown — send SIGTERM to children and wait for them to exit
let shuttingDown = false;

function cleanup(): void {
  if (shuttingDown) return;
  shuttingDown = true;

  let alive = children.length;
  if (alive === 0) {
    process.exit(0);
    return;
  }

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
