/**
 * Shared opencode-child plumbing.
 *
 * This module exists for two reasons:
 *
 * 1. **Bounded /tmp blast radius** (issue #1046, PR #1478 review).
 *    Bun-bundled binaries leak `.so`/`.dylib` files into the system temp
 *    directory and never unlink them. Rather than sweeping all of `/tmp`
 *    with a regex (which would touch other users' or other apps' Bun
 *    artifacts), we point every `opencode` child at an AO-owned temp dir
 *    via `TMPDIR`. The cli-side janitor then sweeps only that directory.
 *
 * 2. **Single shared cache for `opencode session list`.**
 *    Both `@aoagents/ao-core` and the `agent-opencode` plugin previously
 *    kept independent module-level caches. Per poll cycle the system
 *    therefore spawned at least two `opencode session list` processes
 *    instead of one. A single cache exported from core collapses them.
 */

import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { getAoBaseDir } from "./paths.js";
import { safeJsonParse } from "./utils/validation.js";
import { asValidOpenCodeSessionId } from "./opencode-session-id.js";

const execFileAsync = promisify(execFile);

// -----------------------------------------------------------------------------
// AO-owned temp dir for opencode children
// -----------------------------------------------------------------------------

let cachedOpenCodeTmpDir: string | null = null;

/**
 * Path that opencode children should treat as `TMPDIR`. Lives under the AO
 * base dir so a stray sweep cannot touch unrelated files.
 */
export function getOpenCodeTmpDir(): string {
  if (cachedOpenCodeTmpDir) return cachedOpenCodeTmpDir;
  cachedOpenCodeTmpDir = join(getAoBaseDir(), ".bun-tmp");
  return cachedOpenCodeTmpDir;
}

/**
 * Best-effort: create the AO-owned temp dir. Spawn paths call this before
 * launching opencode so the child sees a real directory at `TMPDIR`.
 *
 * Synchronous because the spawn helpers are themselves synchronous in their
 * env construction. Failures are swallowed — opencode will fall back to the
 * OS default temp dir, which is the pre-PR behavior.
 */
export function ensureOpenCodeTmpDir(): string {
  const dir = getOpenCodeTmpDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Best-effort. If creation fails opencode still works; we just leak to
    // the system temp dir as before.
  }
  return dir;
}

/**
 * Build the env passed to every spawned `opencode` child.
 *
 * Setting both `TMPDIR` and `TMP`/`TEMP` covers POSIX (TMPDIR) and Windows
 * fallbacks. Bun honors `TMPDIR` for its embedded shared-library extraction.
 */
export function getOpenCodeChildEnv(
  extra?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const dir = ensureOpenCodeTmpDir();
  return {
    ...process.env,
    TMPDIR: dir,
    TMP: dir,
    TEMP: dir,
    ...extra,
  };
}

// -----------------------------------------------------------------------------
// Shared `opencode session list` cache
// -----------------------------------------------------------------------------

export interface OpenCodeSessionListEntry {
  id: string;
  title: string;
  /** Raw `updated` field as emitted by opencode (string or number). */
  updated?: string | number;
  /** Normalized epoch ms, parsed from `updated`. */
  updatedAt?: number;
}

/**
 * TTL for the `opencode session list` cache.
 *
 * **Why 500ms.** The send-confirmation loop in `session-manager.sendMessage`
 * polls at 500ms intervals up to 6 times (~3s total). The original PR sized
 * the TTL to *cover* that window (3s), which made every loop iteration return
 * the same cached snapshot — the `updatedAt > baselineUpdatedAt` delivery
 * signal could not fire by construction. Sizing the TTL at 500ms means each
 * poll iteration sees fresh data while still collapsing tight bursts (e.g.
 * lifecycle poll + UI enrichment in the same tick) onto a single child.
 * Concurrent callers always share the in-flight promise regardless of TTL.
 */
export const OPENCODE_SESSION_LIST_CACHE_TTL_MS = 500;

const OPENCODE_SESSION_LIST_DEFAULT_TIMEOUT_MS = 30_000;

interface OpenCodeSessionListCache {
  entries: OpenCodeSessionListEntry[];
  timestamp: number;
  promise?: Promise<OpenCodeSessionListEntry[]>;
}

let sessionListCache: OpenCodeSessionListCache | null = null;

function parseUpdatedToEpochMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : undefined;
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function parseSessionListStdout(stdout: string): OpenCodeSessionListEntry[] {
  const parsed = safeJsonParse<unknown>(stdout);
  if (!Array.isArray(parsed)) return [];

  return parsed.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const id = asValidOpenCodeSessionId(record["id"]);
    if (!id) return [];
    const title = typeof record["title"] === "string" ? record["title"] : "";
    const rawUpdated = record["updated"];
    const updated =
      typeof rawUpdated === "string" || typeof rawUpdated === "number"
        ? rawUpdated
        : undefined;
    const updatedAt = parseUpdatedToEpochMs(rawUpdated);
    return [
      {
        id,
        title,
        ...(updated !== undefined ? { updated } : {}),
        ...(updatedAt !== undefined ? { updatedAt } : {}),
      },
    ];
  });
}

/**
 * Fetch the opencode session list, sharing both the cached snapshot and any
 * in-flight request across all callers in core and plugins.
 *
 * Pass `forceRefresh: true` to bypass the TTL when a write is known to have
 * just landed. Concurrent callers still collapse onto the in-flight promise.
 */
export async function getCachedOpenCodeSessionList(options?: {
  timeoutMs?: number;
  forceRefresh?: boolean;
}): Promise<OpenCodeSessionListEntry[]> {
  const timeoutMs = options?.timeoutMs ?? OPENCODE_SESSION_LIST_DEFAULT_TIMEOUT_MS;
  const forceRefresh = options?.forceRefresh ?? false;
  const now = Date.now();

  if (sessionListCache) {
    if (sessionListCache.promise) {
      // A fetch is already in flight — every caller waits on it, even if
      // they wanted a refresh.
      return sessionListCache.promise;
    }
    if (
      !forceRefresh &&
      now - sessionListCache.timestamp < OPENCODE_SESSION_LIST_CACHE_TTL_MS
    ) {
      return sessionListCache.entries;
    }
  }

  const promise: Promise<OpenCodeSessionListEntry[]> = execFileAsync(
    "opencode",
    ["session", "list", "--format", "json"],
    { timeout: timeoutMs, env: getOpenCodeChildEnv() },
  )
    .then(({ stdout }) => {
      const entries = parseSessionListStdout(stdout);
      if (sessionListCache?.promise === promise) {
        sessionListCache = { entries, timestamp: Date.now() };
      }
      return entries;
    })
    .catch(() => {
      if (sessionListCache?.promise === promise) {
        sessionListCache = null;
      }
      return [] as OpenCodeSessionListEntry[];
    });

  sessionListCache = { entries: [], timestamp: now, promise };
  return promise;
}

/**
 * Drop any cached snapshot. Call this immediately after any code path that
 * mutates opencode session state (delete, create) so that the next reader
 * does not observe a stale entry.
 */
export function invalidateOpenCodeSessionListCache(): void {
  // If a fetch is currently in flight we leave it alone — its result is
  // about to land and a fresh fetch on top of it would be wasted work.
  // Subsequent callers will see a stale snapshot for at most one tick;
  // this is acceptable because the in-flight result already reflects state
  // captured after the mutation began.
  if (sessionListCache?.promise) {
    sessionListCache = { ...sessionListCache, timestamp: 0 };
    return;
  }
  sessionListCache = null;
}

/** Test-only: clear the cache including any in-flight promise. */
export function resetOpenCodeSessionListCache(): void {
  sessionListCache = null;
}
