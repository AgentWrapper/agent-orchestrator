/**
 * Shared credential resolver — resolves API keys from multiple sources.
 *
 * Resolution order per key:
 *   1. Environment variable (already set in process.env)
 *   2. OpenClaw config (~/.openclaw/openclaw.json → keys section)
 *
 * Call `applyOpenClawCredentials()` early in CLI startup so spawned agent
 * sessions inherit the resolved values via the parent process environment.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { recordActivityEvent } from "@aoagents/ao-core";

/** Keys that AO agents commonly need and OpenClaw may already store. */
const RESOLVABLE_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GITHUB_TOKEN",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
] as const;

type ResolvableKey = (typeof RESOLVABLE_KEYS)[number];

interface ResolvedCredential {
  key: ResolvableKey;
  value: string;
  source: "env" | "openclaw";
}

interface AppliedCredential {
  key: ResolvableKey;
  source: "openclaw";
}

function readOpenClawKeys(): Record<string, string> {
  const keys: Record<string, string> = {};

  const configPath = join(homedir(), ".openclaw", "openclaw.json");
  if (!existsSync(configPath)) return keys;

  try {
    const raw = readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw) as Record<string, unknown>;

    // OpenClaw stores keys in a top-level "keys" object:
    //   { "keys": { "ANTHROPIC_API_KEY": "sk-ant-...", ... } }
    const keysSection = config.keys;
    if (keysSection && typeof keysSection === "object") {
      for (const [k, v] of Object.entries(keysSection as Record<string, unknown>)) {
        if (typeof v === "string" && v.length > 0) {
          keys[k] = v;
        }
      }
    }

    // Also check top-level env / environment block (some OpenClaw setups):
    //   { "env": { "ANTHROPIC_API_KEY": "sk-ant-..." } }
    const envSection = config.env ?? config.environment;
    if (envSection && typeof envSection === "object") {
      for (const [k, v] of Object.entries(envSection as Record<string, unknown>)) {
        if (typeof v === "string" && v.length > 0 && !(k in keys)) {
          keys[k] = v;
        }
      }
    }
  } catch (err) {
    recordActivityEvent({
      source: "cli",
      kind: "cli.credential_load_failed",
      level: "warn",
      summary: `failed to read or parse ~/.openclaw/openclaw.json`,
      data: {
        configPath,
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    });
    // Malformed config — silently skip (event surfaces it).
  }

  return keys;
}

/**
 * Resolve a single credential from all available sources.
 * Returns the value and where it came from, or null if not found anywhere.
 */
export function resolveCredential(key: ResolvableKey): ResolvedCredential | null {
  const envValue = process.env[key];
  if (envValue && envValue.length > 0) {
    return { key, value: envValue, source: "env" };
  }

  const openclawKeys = readOpenClawKeys();
  const openclawValue = openclawKeys[key];
  if (openclawValue) {
    return { key, value: openclawValue, source: "openclaw" };
  }

  return null;
}

/**
 * Populate `process.env` with API keys found in OpenClaw config that are
 * not already set in the environment. This makes them available to all
 * spawned agent sessions (tmux inherits the parent env).
 *
 * Returns the list of keys that were injected from OpenClaw.
 */
export function applyOpenClawCredentials(): AppliedCredential[] {
  const openclawKeys = readOpenClawKeys();
  const applied: AppliedCredential[] = [];

  for (const key of RESOLVABLE_KEYS) {
    if (process.env[key] && process.env[key]!.length > 0) continue;

    const value = openclawKeys[key];
    if (value) {
      process.env[key] = value;
      applied.push({ key, source: "openclaw" });
    }
  }

  return applied;
}

export { RESOLVABLE_KEYS, type ResolvableKey, type ResolvedCredential, type AppliedCredential };
