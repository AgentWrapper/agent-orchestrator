/**
 * Shared update service — install detection, version checking, cache management.
 *
 * Single source of truth consumed by:
 *   - `ao update` (install-aware routing)
 *   - Startup notifier (synchronous cache read)
 *   - `ao doctor` (version freshness check)
 *   - Dashboard (`/api/version` route)
 */

import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  getInstalledAoVersion,
  getUpdateCheckCachePath,
  isVersionOutdated as coreIsVersionOutdated,
  loadGlobalConfig,
  type UpdateChannel,
  type InstallMethodOverride,
} from "@aoagents/ao-core";
import { getCliVersion } from "../options/version.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InstallMethod =
  | "git"
  | "npm-global"
  | "pnpm-global"
  | "bun-global"
  | "homebrew"
  | "unknown";

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string | null;
  isOutdated: boolean;
  installMethod: InstallMethod;
  recommendedCommand: string;
  checkedAt: string | null;
  channel: UpdateChannel;
}

export interface CacheData {
  latestVersion: string;
  checkedAt: string;
  currentVersionAtCheck: string;
  /**
   * Cache scoping. The cache stores exactly one entry — entries for a
   * different install method or channel are treated as misses, forcing a
   * refresh against the relevant source (git fetch / npm registry).
   */
  installMethod?: InstallMethod;
  channel?: UpdateChannel;
  /** For non-git installs, derived from `isVersionOutdated(current, latest)`. */
  isOutdated?: boolean;
  /** For git installs, lets us cheaply detect a manual `git pull` since the last check. */
  currentRevisionAtCheck?: string;
  latestRevisionAtCheck?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Full package document — includes `dist-tags` for channel resolution. */
const REGISTRY_PACKAGE_URL = "https://registry.npmjs.org/@aoagents%2Fao";
const FETCH_TIMEOUT_MS = 3000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_GIT_REMOTE = "origin";
const DEFAULT_GIT_BRANCH = "main";
const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Channel resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the user's chosen update channel from global config.
 *
 * Defaults to "manual" when:
 *   - The global config does not exist yet (first run).
 *   - The user has not set `updateChannel` (existing user, pre-onboarding).
 *
 * "manual" is intentionally conservative: surprise auto-installs are bad,
 * and the onboarding flow promotes users to "stable" or "nightly" explicitly.
 */
export function resolveUpdateChannel(): UpdateChannel {
  try {
    const config = loadGlobalConfig();
    return config?.updateChannel ?? "manual";
  } catch {
    return "manual";
  }
}

/** Read the install-method override from global config (if any). */
export function resolveInstallMethodOverride(): InstallMethodOverride | undefined {
  try {
    const config = loadGlobalConfig();
    return config?.installMethod;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Install detection
// ---------------------------------------------------------------------------

export function hasNodeModulesAncestor(resolvedPath: string): boolean {
  return resolvedPath.includes("/node_modules/") || resolvedPath.includes("\\node_modules\\");
}

function readPackageName(packageJsonPath: string): string | null {
  try {
    const raw = readFileSync(packageJsonPath, "utf-8");
    const parsed = JSON.parse(raw) as { name?: unknown };
    return typeof parsed.name === "string" ? parsed.name : null;
  } catch {
    return null;
  }
}

function getSourceRepoRoot(resolvedPath: string): string {
  return resolve(dirname(resolvedPath), "../../../../");
}

export function getCurrentRepoRoot(): string {
  return getSourceRepoRoot(fileURLToPath(import.meta.url));
}

export function isAgentOrchestratorRepoRoot(root: string): boolean {
  if (!existsSync(resolve(root, ".git"))) {
    return false;
  }

  return readPackageName(resolve(root, "packages", "ao", "package.json")) === "@aoagents/ao";
}

export function isAoCliPackageRoot(root: string): boolean {
  if (!existsSync(resolve(root, "dist", "index.js"))) {
    return false;
  }

  return readPackageName(resolve(root, "package.json")) === "@aoagents/ao-cli";
}

/**
 * Classify a resolved file path as one of the known install methods.
 *
 * Order matters — Homebrew installs typically nest the npm tree under
 * `/Cellar/ao/.../libexec/lib/node_modules/`, so we check for `/Cellar/ao/`
 * BEFORE classifying as `npm-global`. Bun's global store sits under
 * `~/.bun/install/global/` and is detected the same way.
 */
export function classifyInstallPath(resolvedPath: string): InstallMethod {
  // Homebrew installs of the `ao` formula land under /Cellar/ao/<version>/.
  // Detect this BEFORE the generic node_modules walk, because brew installs
  // also live under .../lib/node_modules/. We don't auto-install for brew —
  // that would clobber the symlinks brew owns.
  if (resolvedPath.includes("/Cellar/ao/") || resolvedPath.includes("\\Cellar\\ao\\")) {
    return "homebrew";
  }

  // Bun's global install layout: ~/.bun/install/global/node_modules/...
  if (
    resolvedPath.includes("/.bun/install/global/") ||
    resolvedPath.includes("\\.bun\\install\\global\\")
  ) {
    return "bun-global";
  }

  if (hasNodeModulesAncestor(resolvedPath)) {
    const isPnpmGlobal =
      resolvedPath.includes("/pnpm/global/") || resolvedPath.includes("\\pnpm\\global\\");
    if (isPnpmGlobal) return "pnpm-global";

    const isNpmGlobal =
      resolvedPath.includes("/lib/node_modules/") ||
      resolvedPath.includes("\\lib\\node_modules\\");
    if (isNpmGlobal) return "npm-global";

    return "unknown";
  }

  // Running from a source checkout → git install
  // Walk up from packages/cli/dist/lib/ (or src/lib/) to repo root
  const repoRoot = getSourceRepoRoot(resolvedPath);
  if (isAgentOrchestratorRepoRoot(repoRoot)) {
    return "git";
  }

  return "unknown";
}

/** Detect how the running `ao` binary was installed. Honors `installMethod` override. */
export function detectInstallMethod(): InstallMethod {
  const override = resolveInstallMethodOverride();
  if (override) return override;
  return classifyInstallPath(fileURLToPath(import.meta.url));
}

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

/**
 * Resolve the currently-installed `@aoagents/ao` version.
 *
 * Delegates to core's `getInstalledAoVersion` (single source of truth shared
 * with the dashboard) and falls back to the CLI's own embedded version when
 * neither package is in `node_modules` (test/dev edge case).
 */
export function getCurrentVersion(): string {
  const fromCore = getInstalledAoVersion();
  if (fromCore !== "0.0.0") return fromCore;
  return getCliVersion();
}

// ---------------------------------------------------------------------------
// Git update target (#1595)
// ---------------------------------------------------------------------------

export interface GitUpdateTarget {
  remote: string;
  branch: string;
  ref: string;
}

export function getGitUpdateTarget(): GitUpdateTarget {
  const remote = process.env["AO_UPDATE_GIT_REMOTE"] || DEFAULT_GIT_REMOTE;
  const branch = process.env["AO_UPDATE_GIT_BRANCH"] || DEFAULT_GIT_BRANCH;
  return { remote, branch, ref: `${remote}/${branch}` };
}

export function getGitUpdateRef(): string {
  return getGitUpdateTarget().ref;
}

// ---------------------------------------------------------------------------
// Update command mapping
// ---------------------------------------------------------------------------

/**
 * Map an install method + channel to the command the user should run.
 *
 * Git installs always run `ao update` (which delegates to `ao-update.sh`)
 * regardless of channel — the channel only affects npm-published builds.
 *
 * Homebrew is special: we never auto-install. We surface the brew command as
 * a notice so the user runs it themselves — auto-running `npm install -g`
 * inside a brew prefix overwrites brew's symlinks.
 */
export function getUpdateCommand(
  method: InstallMethod,
  channel: UpdateChannel = "stable",
): string {
  // "manual" channel maps to "stable" for the install command — the channel
  // affects when we check, not which tag manual installers should pick.
  const tag = channel === "nightly" ? "nightly" : "latest";
  switch (method) {
    case "git":
      return "ao update";
    case "npm-global":
      return `npm install -g @aoagents/ao@${tag}`;
    case "pnpm-global":
      return `pnpm add -g @aoagents/ao@${tag}`;
    case "bun-global":
      return `bun add -g @aoagents/ao@${tag}`;
    case "homebrew":
      return "brew upgrade ao";
    case "unknown":
      return `npm install -g @aoagents/ao@${tag}`;
  }
}

/** True when the install method requires a manual user action (no auto-install). */
export function isManualOnlyInstall(method: InstallMethod): boolean {
  return method === "homebrew";
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/** Directory holding the update cache. Re-exported for ao doctor / CLI smoke tests. */
export function getCacheDir(): string {
  // dirname(getUpdateCheckCachePath()) keeps this in lock-step with core's
  // canonical path resolver.
  return dirname(getUpdateCheckCachePath());
}

function getCachePath(): string {
  return getUpdateCheckCachePath();
}

/**
 * Read cached update info. Returns null if missing, expired, corrupt,
 * version-mismatched, install-method-mismatched, or channel-mismatched.
 *
 * The cache is keyed by both `installMethod` and `channel` because the
 * `latestVersion` stored at each tuple is meaningfully different (stable
 * 0.5.0 vs nightly 0.5.0-nightly-abc; git's `origin/main` ref vs npm tag).
 */
export function readCachedUpdateInfo(
  installMethod: InstallMethod = detectInstallMethod(),
  channel?: UpdateChannel,
): CacheData | null {
  try {
    const raw = readFileSync(getCachePath(), "utf-8");
    const data = JSON.parse(raw) as CacheData;

    if (!data.latestVersion || !data.checkedAt) return null;

    // Legacy cache entries predate install-method scoping — treat as unsafe.
    if (!data.installMethod) return null;
    if (data.installMethod !== installMethod) return null;

    // Channel scoping. When the caller passes an explicit channel, the cache
    // entry MUST advertise its own channel and that channel MUST match. A
    // legacy entry without a `channel` field (written before channel scoping
    // landed) is treated as a miss — otherwise a stable→nightly switch would
    // keep returning the pre-switch latestVersion until the TTL expired.
    if (channel) {
      if (!data.channel) return null;
      if (data.channel !== channel) return null;
    }

    // Cache is stale if user upgraded since the check
    const currentVersion = getCurrentVersion();
    if (data.currentVersionAtCheck && data.currentVersionAtCheck !== currentVersion) {
      return null;
    }

    if (installMethod === "git" && data.currentRevisionAtCheck) {
      try {
        if (runGit(["rev-parse", "HEAD"], getCurrentRepoRoot()) !== data.currentRevisionAtCheck) {
          return null;
        }
      } catch {
        return null;
      }
    }

    // Cache expired
    const age = Date.now() - new Date(data.checkedAt).getTime();
    if (age > CACHE_TTL_MS) return null;

    return data;
  } catch {
    return null;
  }
}

export function writeCache(data: CacheData): void {
  try {
    const dir = getCacheDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(getCachePath(), JSON.stringify(data, null, 2));
  } catch {
    // Best-effort — don't crash if cache dir is unwritable
  }
}

export function invalidateCache(): void {
  try {
    unlinkSync(getCachePath());
  } catch {
    // File might not exist — that's fine
  }
}

// ---------------------------------------------------------------------------
// Git fetch (#1595)
// ---------------------------------------------------------------------------

export interface GitLatestState {
  ref: string;
  headRevision: string;
  latestRevision: string;
  isBehind: boolean;
}

function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

export async function fetchGitLatestState(
  repoRoot = getCurrentRepoRoot(),
): Promise<GitLatestState | null> {
  try {
    const { remote, branch, ref } = getGitUpdateTarget();

    await execFileAsync("git", ["fetch", remote, branch], { cwd: repoRoot });
    const headRevision = runGit(["rev-parse", "HEAD"], repoRoot);
    const latestRevision = runGit(["rev-parse", ref], repoRoot);

    let isBehind = false;
    try {
      runGit(["merge-base", "--is-ancestor", "HEAD", ref], repoRoot);
      isBehind = headRevision !== latestRevision;
    } catch {
      isBehind = false;
    }

    return { ref, headRevision, latestRevision, isBehind };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Registry fetch
// ---------------------------------------------------------------------------

/**
 * Fetch the latest version of @aoagents/ao for the given dist-tag.
 *
 * Hits the full package document (not the per-tag URL) so we get all dist-tags
 * in one round trip. Channels:
 *   stable / manual → dist-tags.latest
 *   nightly         → dist-tags.nightly  (falls back to latest if no nightly tag)
 */
export async function fetchLatestVersion(
  channel: UpdateChannel = "stable",
): Promise<string | null> {
  try {
    const response = await fetch(REGISTRY_PACKAGE_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { "dist-tags"?: Record<string, unknown> };
    const tags = data["dist-tags"];
    if (!tags || typeof tags !== "object") return null;

    const tag = channel === "nightly" ? "nightly" : "latest";
    const value = tags[tag];
    if (typeof value === "string") return value;

    // Nightly tag missing? Fall back to latest so the dashboard isn't broken
    // before the first nightly publishes.
    if (tag === "nightly" && typeof tags["latest"] === "string") {
      return tags["latest"];
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Check for updates, using cache when fresh and fetching when stale.
 *
 * Source of truth depends on install method:
 *   - git installs        → `git fetch <remote> <branch>` + `merge-base`
 *   - npm/pnpm/bun/...    → npm registry, dist-tags[channel]
 *
 * When the channel is "manual" the function still runs (so `--check` works
 * and the dashboard can show current state) but the startup notice and the
 * background refresh respect the channel and stay quiet.
 */
export async function checkForUpdate(opts?: {
  force?: boolean;
  channel?: UpdateChannel;
  installMethod?: InstallMethod;
  repoRoot?: string;
}): Promise<UpdateInfo> {
  const channel = opts?.channel ?? resolveUpdateChannel();
  const currentVersion = getCurrentVersion();
  const installMethod = opts?.installMethod ?? detectInstallMethod();
  const recommendedCommand = getUpdateCommand(installMethod, channel);

  if (!opts?.force) {
    const cached = readCachedUpdateInfo(installMethod, channel);
    if (cached) {
      return {
        currentVersion,
        latestVersion: cached.latestVersion,
        isOutdated:
          cached.installMethod === "git"
            ? cached.isOutdated === true
            : isVersionOutdated(currentVersion, cached.latestVersion),
        installMethod,
        recommendedCommand,
        checkedAt: cached.checkedAt,
        channel,
      };
    }
  }

  const now = new Date().toISOString();

  if (installMethod === "git") {
    const gitState = await fetchGitLatestState(opts?.repoRoot);
    if (gitState) {
      writeCache({
        latestVersion: gitState.ref,
        checkedAt: now,
        currentVersionAtCheck: currentVersion,
        installMethod,
        channel,
        isOutdated: gitState.isBehind,
        currentRevisionAtCheck: gitState.headRevision,
        latestRevisionAtCheck: gitState.latestRevision,
      });
    }

    return {
      currentVersion,
      latestVersion: gitState?.ref ?? null,
      isOutdated: gitState?.isBehind ?? false,
      installMethod,
      recommendedCommand,
      checkedAt: gitState ? now : null,
      channel,
    };
  }

  // npm/pnpm/bun/unknown installs use the npm registry as their update channel.
  const latestVersion = await fetchLatestVersion(channel);

  if (latestVersion) {
    writeCache({
      latestVersion,
      checkedAt: now,
      currentVersionAtCheck: currentVersion,
      installMethod,
      channel,
      isOutdated: isVersionOutdated(currentVersion, latestVersion),
    });
  }

  return {
    currentVersion,
    latestVersion,
    isOutdated: latestVersion ? isVersionOutdated(currentVersion, latestVersion) : false,
    installMethod,
    recommendedCommand,
    checkedAt: latestVersion ? now : null,
    channel,
  };
}

// ---------------------------------------------------------------------------
// Startup notifier (synchronous, cache-only)
// ---------------------------------------------------------------------------

/**
 * Print an update notice to stderr if a newer version is cached.
 *
 * Skipped entirely when channel is "manual" — the user opted out of nudges.
 * Stable users see "Run: ao update". Nightly users get the same nudge but
 * the suggested install command picks `@nightly` instead of `@latest`.
 */
export function maybeShowUpdateNotice(): void {
  if (!process.stderr.isTTY) return;
  if (process.env["AO_NO_UPDATE_NOTIFIER"] === "1") return;
  if (process.env["CI"] || process.env["AGENT_ORCHESTRATOR_CI"]) return;

  const skipArgs = ["update", "doctor", "--version", "-V", "--help", "-h"];
  if (process.argv.some((arg) => skipArgs.includes(arg))) return;

  const channel = resolveUpdateChannel();
  if (channel === "manual") return;

  const installMethod = detectInstallMethod();
  const cached = readCachedUpdateInfo(installMethod, channel);
  if (!cached) return;

  const currentVersion = getCurrentVersion();
  const isOutdated =
    installMethod === "git"
      ? cached.isOutdated === true
      : isVersionOutdated(currentVersion, cached.latestVersion);
  if (!isOutdated) return;

  const channelSuffix = channel === "nightly" ? " (nightly)" : "";
  const command = getUpdateCommand(installMethod, channel);
  const message =
    installMethod === "git"
      ? `\nUpdate available${channelSuffix} from ${cached.latestVersion} — Run: ${command}\n\n`
      : `\nUpdate available${channelSuffix}: ${currentVersion} → ${cached.latestVersion} — Run: ${command}\n\n`;
  process.stderr.write(message);
}

/**
 * Kick off a background cache refresh. Skips entirely on `manual` channel
 * so users who opted out don't generate any registry traffic.
 */
export function scheduleBackgroundRefresh(): void {
  if (resolveUpdateChannel() === "manual") return;
  const timer = setTimeout(() => {
    checkForUpdate().catch(() => {});
  }, 0);
  timer.unref();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Re-export the core implementation so CLI consumers (and the existing test
 * suite) keep importing from this module while the dashboard imports the same
 * function from `@aoagents/ao-core` — single source of truth for the prerelease
 * comparison rules.
 */
export const isVersionOutdated = coreIsVersionOutdated;
