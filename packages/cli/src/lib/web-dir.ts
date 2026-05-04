/**
 * Web directory locator — finds the @aoagents/ao-web package.
 * Shared utility to avoid duplication between dashboard.ts and start.ts.
 */

import { spawn } from "node:child_process";
import { Socket } from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { formatCommandError } from "./cli-errors.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

/** Default terminal server base port (14800 range: zero IANA registrations, no dev tool conflicts) */
const DEFAULT_TERMINAL_PORT = 14800;

/**
 * Check if a TCP port is available by attempting to connect to it.
 * A successful connect means something is already listening (port in use).
 * ECONNREFUSED means nothing is listening (port free).
 *
 * Connect-based detection is more reliable than bind-based because it works
 * regardless of whether the occupying process is bound to 127.0.0.1, ::1,
 * 0.0.0.0, or :: (IPv6 wildcard).
 */
export function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = new Socket();
    s.setTimeout(300);
    s.once("connect", () => { s.destroy(); resolve(false); }); // something listening → in use
    s.once("error", () => { s.destroy(); resolve(true); });    // ECONNREFUSED → free
    s.once("timeout", () => { s.destroy(); resolve(true); });  // no response → free
    s.connect(port, "127.0.0.1");
  });
}

/** How many consecutive ports to scan before giving up. */
export const MAX_PORT_SCAN = 100;

/**
 * Find the first available port starting from `start`, scanning upward.
 * Returns `null` if no free port is found within `maxScan` attempts.
 * Shared between first-run setup and `ao start <url>`.
 */
export async function findFreePort(start: number, maxScan = MAX_PORT_SCAN): Promise<number | null> {
  for (let port = start; port < start + maxScan; port++) {
    if (await isPortAvailable(port)) return port;
  }
  return null;
}

/**
 * Open a URL in the user's browser without throwing back into the caller.
 */
export function openUrl(url: string): void {
  const [cmd, args]: [string, string[]] =
    process.platform === "win32"
      ? ["cmd.exe", ["/c", "start", "", url]]
      : [process.platform === "linux" ? "xdg-open" : "open", [url]];
  const browser = spawn(cmd, args, { stdio: "ignore" });
  browser.on("error", (err) => {
    console.warn(
      formatCommandError(err, {
        cmd,
        args,
        action: `open ${url} in a browser`,
        installHints:
          process.platform === "linux"
            ? ["Install xdg-utils so `xdg-open` is available on PATH."]
            : process.platform === "win32"
              ? []
              : [],
      }).message,
    );
  });
}

/**
 * Poll until a port is accepting connections, then open a URL in the browser.
 * Respects an AbortSignal so the caller can cancel if the dashboard process
 * exits early. Gives up silently after timeoutMs (default 30s).
 */
export async function waitForPortAndOpen(
  port: number,
  url: string,
  signal: AbortSignal,
  timeoutMs = 30_000,
): Promise<void> {
  const start = Date.now();
  while (!signal.aborted && Date.now() - start < timeoutMs) {
    const free = await isPortAvailable(port);
    if (!free) {
      openUrl(url);
      return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

/**
 * Find a pair of consecutive available ports starting from `base`.
 * Scans upward in steps of 2 (keeping ports paired) until both are free.
 * Returns [terminalPort, directTerminalPort].
 */
async function findAvailablePortPair(base: number): Promise<[number, number]> {
  const MAX_ATTEMPTS = 50;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const p1 = base + i * 2;
    const p2 = p1 + 1;
    const [free1, free2] = await Promise.all([isPortAvailable(p1), isPortAvailable(p2)]);
    if (free1 && free2) {
      return [p1, p2];
    }
  }
  // If all 50 pairs exhausted, fall back to the base (will fail at bind time with clear error)
  return [base, base + 1];
}

/**
 * Build environment variables for spawning the dashboard process.
 * Shared between `ao start` and `ao dashboard` to avoid duplication.
 *
 * Terminal server ports default to 14800/14801 but can be overridden via config.
 * When no explicit port is set, auto-detects available ports to allow multiple
 * dashboard instances to run simultaneously without EADDRINUSE conflicts.
 */
export async function buildDashboardEnv(
  port: number,
  configPath: string | null,
  terminalPort?: number,
  directTerminalPort?: number,
): Promise<Record<string, string>> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;

  // Pass config path so dashboard uses the same config as the CLI
  if (configPath) {
    env["AO_CONFIG_PATH"] = configPath;
  }

  env["PORT"] = String(port);

  // If explicit ports provided (config or env var), use them directly.
  // Otherwise, auto-detect an available pair starting from the default.
  const explicitTerminal = terminalPort ?? (env["TERMINAL_PORT"] ? parseInt(env["TERMINAL_PORT"], 10) : undefined);
  const explicitDirect = directTerminalPort ?? (env["DIRECT_TERMINAL_PORT"] ? parseInt(env["DIRECT_TERMINAL_PORT"], 10) : undefined);

  let resolvedTerminal: number;
  let resolvedDirect: number;

  if (explicitTerminal !== undefined && explicitDirect !== undefined) {
    // Both explicitly set — use as-is
    resolvedTerminal = explicitTerminal;
    resolvedDirect = explicitDirect;
  } else if (explicitTerminal !== undefined) {
    // Terminal port set, derive direct from it
    resolvedTerminal = explicitTerminal;
    resolvedDirect = explicitTerminal + 1;
  } else if (explicitDirect !== undefined) {
    // Direct port set, derive terminal from it
    resolvedTerminal = explicitDirect - 1;
    resolvedDirect = explicitDirect;
  } else {
    // Neither set — auto-detect available pair
    [resolvedTerminal, resolvedDirect] = await findAvailablePortPair(DEFAULT_TERMINAL_PORT);
  }

  env["TERMINAL_PORT"] = String(resolvedTerminal);
  env["DIRECT_TERMINAL_PORT"] = String(resolvedDirect);
  env["NEXT_PUBLIC_TERMINAL_PORT"] = String(resolvedTerminal);
  env["NEXT_PUBLIC_DIRECT_TERMINAL_PORT"] = String(resolvedDirect);

  return env;
}

/**
 * Locate the @aoagents/ao-web package directory.
 * Uses createRequire for ESM-compatible require.resolve, with fallback
 * to sibling package paths that work from both src/ and dist/.
 */
export function findWebDir(): string {
  // Try to resolve from node_modules first (installed as workspace dep)
  try {
    const pkgJson = require.resolve("@aoagents/ao-web/package.json");
    return resolve(pkgJson, "..");
  } catch {
    // Fallback: sibling package in monorepo (works both from src/ and dist/)
    // packages/cli/src/lib/ → packages/web
    // packages/cli/dist/lib/ → packages/web
    const candidates = [
      resolve(__dirname, "../../../web"),
      resolve(__dirname, "../../../../packages/web"),
    ];
    for (const candidate of candidates) {
      if (existsSync(resolve(candidate, "package.json"))) {
        return candidate;
      }
    }
    throw new Error(
      "Could not find @aoagents/ao-web package.\n" +
      "  If installed via npm:    npm install -g @aoagents/ao\n" +
      "  If cloned from source:   pnpm install && pnpm build",
    );
  }
}
