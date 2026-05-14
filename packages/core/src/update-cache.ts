/**
 * Shared cache-layer primitives for the AO update pipeline.
 *
 * Single source of truth for:
 *   - the on-disk path of the update-check cache
 *   - a raw (no-validation) read of that cache file
 *   - the currently-installed `@aoagents/ao` version
 *
 * Both the CLI's `update-check.ts` and the dashboard's `/api/version` route
 * consume these. Without this module, both sides would reimplement the cache
 * path resolution and drift over time — a renamed file or relocated XDG dir
 * would silently de-sync the CLI's startup notice from the dashboard banner.
 *
 * The CLI keeps its richer `readCachedUpdateInfo` (which layers on
 * install-method / channel / git-rev validation) on top of the raw read here.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Wire-format of `~/.cache/ao/update-check.json`.
 *
 * Kept loose (all fields optional) because:
 *   1. Legacy entries predate install-method scoping and lack `installMethod`.
 *   2. The CLI's stricter `readCachedUpdateInfo` enforces the per-call
 *      invariants (channel match, install-method match, freshness, git-rev
 *      currency) — this raw shape is what's on disk, not what's safe to use.
 */
export interface UpdateCheckCacheRaw {
  latestVersion?: string;
  checkedAt?: string;
  currentVersionAtCheck?: string;
  /** "stable" | "nightly" | "manual"; kept as string here so core doesn't import the enum. */
  channel?: string;
  /** "git" | "npm-global" | "pnpm-global" | "bun-global" | "homebrew" | "unknown". */
  installMethod?: string;
  /** Set by `checkForUpdate` when computing `isOutdated` for non-git entries. */
  isOutdated?: boolean;
  /** Git installs only — used to invalidate the cache when the user runs `git pull` manually. */
  currentRevisionAtCheck?: string;
  latestRevisionAtCheck?: string;
}

/**
 * Resolve the canonical path of `update-check.json`. Honors `$XDG_CACHE_HOME`,
 * falling back to `~/.cache/ao/update-check.json`.
 */
export function getUpdateCheckCachePath(): string {
  const xdg = process.env["XDG_CACHE_HOME"];
  const base = xdg || join(homedir(), ".cache");
  return join(base, "ao", "update-check.json");
}

/** Raw cache read with no semantic validation. Returns null on missing/corrupt. */
export function readUpdateCheckCacheRaw(): UpdateCheckCacheRaw | null {
  const path = getUpdateCheckCachePath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as UpdateCheckCacheRaw;
  } catch {
    return null;
  }
}

/**
 * The currently-installed `@aoagents/ao` version.
 *
 * Tries the wrapper package first (the canonical version users see). Falls
 * back to `@aoagents/ao-web` for dev mode where the wrapper isn't always in
 * `node_modules` — the dashboard ships in lockstep with `@aoagents/ao` (the
 * changeset linked group), so the web version is a safe proxy.
 *
 * Final fallback returns `"0.0.0"` so callers always have a string to
 * `isVersionOutdated` against.
 */
export function getInstalledAoVersion(): string {
  const require = createRequire(fileURLToPath(import.meta.url));
  const candidates = ["@aoagents/ao/package.json", "@aoagents/ao-web/package.json"];
  for (const candidate of candidates) {
    try {
      const pkg = require(candidate) as { version?: unknown };
      if (typeof pkg.version === "string") return pkg.version;
    } catch {
      // try next candidate
    }
  }
  return "0.0.0";
}
