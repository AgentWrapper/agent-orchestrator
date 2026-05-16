/**
 * OpenClaw gateway probing utilities.
 *
 * Used by `ao setup openclaw` and future TypeScript-based doctor checks.
 * Probes the OpenClaw gateway for reachability and validates auth tokens.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

export interface ProbeResult {
  reachable: boolean;
  httpStatus?: number;
  error?: string;
}

export interface TokenValidation {
  valid: boolean;
  error?: string;
}

export interface OpenClawInstallation {
  state: "missing" | "installed-but-stopped" | "running";
  gatewayUrl: string;
  binaryPath?: string;
  configPath?: string;
  probe: ProbeResult;
}

const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_OPENCLAW_URL = "http://127.0.0.1:18789";
const HOOKS_PATH = "/hooks/agent";

function normalizeGatewayBaseUrl(url: string): string {
  const normalized = url.trim().replace(/\/+$/, "");
  return normalized.endsWith(HOOKS_PATH)
    ? normalized.slice(0, -HOOKS_PATH.length)
    : normalized;
}

function resolveOpenClawBinaryPath(): string | undefined {
  let result: SpawnSyncReturns<string>;
  if (process.platform === "win32") {
    result = spawnSync("where", ["openclaw"], { encoding: "utf-8" });
  } else {
    const shell = process.env["SHELL"] ?? "/bin/sh";
    if (!shell.startsWith("/")) return undefined;
    result = spawnSync(shell, ["-lc", "command -v openclaw"], {
      encoding: "utf-8",
    });
  }

  if (result.status !== 0) return undefined;
  const path = result.stdout.trim();
  return path || undefined;
}

/**
 * Probe the OpenClaw gateway for reachability.
 * Sends a GET to the base URL (not /hooks/agent) with a short timeout.
 */
export async function probeGateway(
  baseUrl: string = DEFAULT_OPENCLAW_URL,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ProbeResult> {
  const url = normalizeGatewayBaseUrl(baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    });

    return { reachable: true, httpStatus: response.status };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (message.includes("ECONNREFUSED")) {
      return { reachable: false, error: `Gateway not reachable at ${url}` };
    }
    if (message.includes("abort") || message.includes("timeout")) {
      return { reachable: false, error: `Gateway timed out at ${url} (${timeoutMs}ms)` };
    }

    return { reachable: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

export async function detectOpenClawInstallation(
  baseUrl: string = DEFAULT_OPENCLAW_URL,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<OpenClawInstallation> {
  const gatewayUrl = normalizeGatewayBaseUrl(baseUrl);
  const binaryPath = resolveOpenClawBinaryPath();
  const configPath = join(homedir(), ".openclaw", "openclaw.json");
  const hasConfig = existsSync(configPath);
  const probe = await probeGateway(gatewayUrl, timeoutMs);

  return {
    state: probe.reachable
      ? "running"
      : binaryPath || hasConfig
        ? "installed-but-stopped"
        : "missing",
    gatewayUrl,
    binaryPath,
    configPath: hasConfig ? configPath : undefined,
    probe,
  };
}

/**
 * Validate an auth token against the OpenClaw hooks endpoint.
 * Sends a lightweight test payload and checks the response.
 */
export async function validateToken(
  url: string,
  token: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<TokenValidation> {
  const hooksUrl = url.includes(HOOKS_PATH) ? url : `${url.replace(/\/+$/, "")}${HOOKS_PATH}`;

  const payload = {
    message: "[AO Setup] Connection test — you can ignore this message.",
    name: "AO",
    sessionKey: "hook:ao:setup-test",
    wakeMode: "now",
    deliver: false,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(hooksUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (response.ok) {
      return { valid: true };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        valid: false,
        error:
          "Token rejected by OpenClaw. Check that hooks.token in your OpenClaw config matches this token.",
      };
    }

    const body = await response.text().catch(() => "");
    return {
      valid: false,
      error: `Unexpected response (HTTP ${response.status})${body ? `: ${body.trim()}` : ""}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (message.includes("ECONNREFUSED")) {
      return {
        valid: false,
        error: `Can't reach OpenClaw gateway. Is OpenClaw running?`,
      };
    }
    if (message.includes("abort") || message.includes("timeout")) {
      return {
        valid: false,
        error: `Connection timed out. Check the gateway URL and network.`,
      };
    }

    return { valid: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

export { DEFAULT_OPENCLAW_URL, HOOKS_PATH, normalizeGatewayBaseUrl };
