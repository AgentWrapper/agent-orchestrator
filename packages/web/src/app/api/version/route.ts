/**
 * GET /api/version — current AO version, latest available, and channel state.
 *
 * Backed by the same cache file that the CLI's `update-check.ts` writes to
 * (`$XDG_CACHE_HOME/ao/update-check.json` or `~/.cache/ao/update-check.json`),
 * so the dashboard banner and the CLI startup notice always agree.
 *
 * Cache-only by design — never makes a network call inside a request handler.
 * The CLI keeps the cache fresh (24 h TTL) via `scheduleBackgroundRefresh()`,
 * and `ao update --check` forces a refresh on demand.
 */

import { NextResponse } from "next/server";
import {
  getInstalledAoVersion,
  isVersionOutdated,
  loadGlobalConfig,
  readUpdateCheckCacheRaw,
  type UpdateChannel,
} from "@aoagents/ao-core";

export const dynamic = "force-dynamic";

interface VersionResponse {
  current: string;
  latest: string | null;
  channel: UpdateChannel;
  isOutdated: boolean;
  checkedAt: string | null;
}

function resolveChannel(): UpdateChannel {
  try {
    const config = loadGlobalConfig();
    return config?.updateChannel ?? "manual";
  } catch {
    return "manual";
  }
}

export async function GET() {
  const current = getInstalledAoVersion();
  const channel = resolveChannel();
  const cache = readUpdateCheckCacheRaw();

  // Cache must match the active channel — otherwise we'd report a stale
  // @latest version to a user who recently switched to @nightly. Legacy
  // entries (no `channel` field, written before channel scoping landed) are
  // treated as misses, matching the CLI's `readCachedUpdateInfo` behavior.
  // Without this the dashboard would happily serve a stale 0.6.0 latestVersion
  // to a user who just switched to nightly until the 24h TTL expires.
  const cacheMatchesChannel = cache?.channel === channel;
  const latest = cache?.latestVersion && cacheMatchesChannel ? cache.latestVersion : null;

  // Git installs cache `latestVersion: "origin/main"` (a ref, not a semver),
  // so `isVersionOutdated(current, "origin/main")` would always return false.
  // The CLI works around this by trusting the precomputed `cached.isOutdated`
  // for git installs — mirror that here so the dashboard banner actually
  // appears when a git-installed user is behind origin/main.
  let isOutdated = false;
  if (latest && cacheMatchesChannel) {
    isOutdated =
      cache?.installMethod === "git"
        ? cache.isOutdated === true
        : isVersionOutdated(current, latest);
  }

  const body: VersionResponse = {
    current,
    latest,
    channel,
    isOutdated,
    checkedAt: cache?.checkedAt && cacheMatchesChannel ? cache.checkedAt : null,
  };

  return NextResponse.json(body);
}
