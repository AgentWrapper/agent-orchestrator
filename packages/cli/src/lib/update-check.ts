/**
 * Shared update service — install detection, version checking, cache management.
 *
 * Single source of truth consumed by:
 *   - `ao update` (install-aware routing)
 *   - Startup notifier (synchronous cache read)
 *   - `ao doctor` (version freshness check)
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getCliVersion } from "../options/version.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InstallMethod = "git" | "npm-global" | "pnpm-global" | "unknown";

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string | null;
  isOutdated: boolean;
  installMethod: InstallMethod;
  recommendedCommand: string;
  checkedAt: string | null;
}

interface CacheData {
  latestVersion: string;
  checkedAt: string;
  currentVersionAtCheck: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REGISTRY_URL = "https://registry.npmjs.org/@aoagents%2Fao/latest";
const FETCH_TIMEOUT_MS = 3000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------------------------------------------------------------------------
// Install detection
// ---------------------------------------------------------------------------

/**
 * Classify a resolved file path as npm-global, git source, or unknown.
 * Extracted for testability — `detectInstallMethod` calls this with
 * the resolved `import.meta.url` path.
 *
 * Distinguishes global npm installs (e.g. /usr/local/lib/node_modules,
 * ~/.nvm/.../lib/node_modules, pnpm global store) from local project
 * node_modules by checking for `lib/node_modules` (global) vs a bare
 * `node_modules` that sits inside a project directory (local/npx).
 */
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

export function classifyInstallPath(resolvedPath: string): InstallMethod {
  if (hasNodeModulesAncestor(resolvedPath)) {
    // Global installs live under .../lib/node_modules/... (npm/nvm/fnm/volta)
    // or pnpm's global store (.../pnpm/global/.../node_modules/...).
    // Local project installs have node_modules directly inside a project dir.
    // Note: /.pnpm/ alone is NOT a global signal — pnpm creates node_modules/.pnpm/
    // for local installs too. Only pnpm/global paths indicate a global install.
    const isPnpmGlobal =
      resolvedPath.includes("/pnpm/global/") ||
      resolvedPath.includes("\\pnpm\\global\\");

    if (isPnpmGlobal) {
      return "pnpm-global";
    }

    const isNpmGlobal =
      resolvedPath.includes("/lib/node_modules/") ||
      resolvedPath.includes("\\lib\\node_modules\\");

    if (isNpmGlobal) {
      return "npm-global";
    }
    // Local node_modules (e.g. npx, project-local install) — treat as unknown
    // so we don't suggest "npm install -g" to someone using npx
    return "unknown";
  }

  // Running from a source checkout → git install
  // Walk up from packages/cli/dist/lib/ (or src/lib/) to repo root
  const repoRoot = resolve(dirname(resolvedPath), "../../../../");
  if (isAgentOrchestratorRepoRoot(repoRoot)) {
    return "git";
  }

  return "unknown";
}

/** Detect how the running `ao` binary was installed based on its file location. */
export function detectInstallMethod(): InstallMethod {
  return classifyInstallPath(fileURLToPath(import.meta.url));
}

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

/**
 * Get the installed version of the `@aoagents/ao` wrapper package.
 * Falls back to the CLI package version if the wrapper is not resolvable
 * (e.g. running from source where both are the same version anyway).
 */
export function getCurrentVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const aoPkg = require("@aoagents/ao/package.json") as { version: string };
    return aoPkg.version;
  } catch {
    return getCliVersion();
  }
}

// ---------------------------------------------------------------------------
// Update command mapping
// ---------------------------------------------------------------------------

export function getUpdateCommand(method: InstallMethod): string {
  switch (method) {
    case "git":
      return "ao update";
    case "npm-global":
      return "npm install -g @aoagents/ao@latest";
    case "pnpm-global":
      return "pnpm add -g @aoagents/ao@latest";
    case "unknown":
      return "npm install -g @aoagents/ao@latest";
  }
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

export function getCacheDir(): string {
  const xdg = process.env["XDG_CACHE_HOME"];
  const base = xdg || join(homedir(), ".cache");
  return join(base, "ao");
}

function getCachePath(): string {
  return join(getCacheDir(), "update-check.json");
}

/** Read cached update info. Returns null if missing, expired, corrupt, or version-mismatched. */
export function readCachedUpdateInfo(): CacheData | null {
  try {
    const raw = readFileSync(getCachePath(), "utf-8");
    const data = JSON.parse(raw) as CacheData;

    if (!data.latestVersion || !data.checkedAt) return null;

    // Cache is stale if user upgraded since the check
    const currentVersion = getCurrentVersion();
    if (data.currentVersionAtCheck && data.currentVersionAtCheck !== currentVersion) {
      return null;
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
// Registry fetch
// ---------------------------------------------------------------------------

/** Fetch the latest version of @aoagents/ao from the npm registry. */
export async function fetchLatestVersion(): Promise<string | null> {
  try {
    const response = await fetch(REGISTRY_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { version?: string };
    return typeof data.version === "string" ? data.version : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/** Check for updates, using cache when fresh and fetching when stale. */
export async function checkForUpdate(opts?: { force?: boolean }): Promise<UpdateInfo> {
  const currentVersion = getCurrentVersion();
  const installMethod = detectInstallMethod();
  const recommendedCommand = getUpdateCommand(installMethod);

  // Try cache first (unless forced)
  if (!opts?.force) {
    const cached = readCachedUpdateInfo();
    if (cached) {
      return {
        currentVersion,
        latestVersion: cached.latestVersion,
        isOutdated: isVersionOutdated(currentVersion, cached.latestVersion),
        installMethod,
        recommendedCommand,
        checkedAt: cached.checkedAt,
      };
    }
  }

  // Fetch from registry
  const latestVersion = await fetchLatestVersion();
  const now = new Date().toISOString();

  if (latestVersion) {
    writeCache({
      latestVersion,
      checkedAt: now,
      currentVersionAtCheck: currentVersion,
    });
  }

  return {
    currentVersion,
    latestVersion,
    isOutdated: latestVersion ? isVersionOutdated(currentVersion, latestVersion) : false,
    installMethod,
    recommendedCommand,
    checkedAt: latestVersion ? now : null,
  };
}

// ---------------------------------------------------------------------------
// Startup notifier (synchronous, cache-only)
// ---------------------------------------------------------------------------

/** Print an update notice to stderr if a newer version is cached. No network call. */
export function maybeShowUpdateNotice(): void {
  if (!process.stderr.isTTY) return;
  if (process.env["AO_NO_UPDATE_NOTIFIER"] === "1") return;
  if (process.env["CI"] || process.env["AGENT_ORCHESTRATOR_CI"]) return;

  // Skip for meta commands
  const skipArgs = ["update", "doctor", "--version", "-V", "--help", "-h"];
  if (process.argv.some((arg) => skipArgs.includes(arg))) return;

  const cached = readCachedUpdateInfo();
  if (!cached) return;

  const currentVersion = getCurrentVersion();
  if (!isVersionOutdated(currentVersion, cached.latestVersion)) return;

  process.stderr.write(
    `\nUpdate available: ${currentVersion} → ${cached.latestVersion} — Run: ao update\n\n`,
  );
}

/**
 * Kick off a background cache refresh. Call after parse() completes.
 * Uses setTimeout with .unref() so the process can exit without waiting.
 * Note: for short-lived commands, the timer may not fire before exit.
 * The cache gets seeded reliably by `ao update --check` or any `ao update`
 * invocation. This is a best-effort bonus for long-running commands like
 * `ao start`.
 */
export function scheduleBackgroundRefresh(): void {
  const timer = setTimeout(() => {
    checkForUpdate().catch(() => {});
  }, 0);
  timer.unref();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Simple semver comparison: returns true if current < latest.
 *
 * The npm registry `latest` tag normally points to a stable release, so we
 * only need one prerelease rule beyond numeric comparison: when the numeric
 * parts match, a prerelease current version is older than a stable latest
 * version (for example `0.2.2-beta.1` < `0.2.2`).
 */
export function isVersionOutdated(current: string, latest: string): boolean {
  const parseVersion = (version: string) => {
    const [base, prerelease] = version.split("-", 2);
    return {
      parts: (base ?? "").split(".").map(Number),
      hasPrerelease: Boolean(prerelease),
    };
  };

  const currentVersion = parseVersion(current);
  const latestVersion = parseVersion(latest);
  for (let i = 0; i < 3; i++) {
    const c = currentVersion.parts[i] ?? 0;
    const l = latestVersion.parts[i] ?? 0;
    if (Number.isNaN(c) || Number.isNaN(l)) return false;
    if (c < l) return true;
    if (c > l) return false;
  }

  return currentVersion.hasPrerelease && !latestVersion.hasPrerelease;
}
