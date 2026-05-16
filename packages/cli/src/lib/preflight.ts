/**
 * Pre-flight checks for `ao start` (port + dashboard build artifacts).
 *
 * Tool/auth checks for `ao spawn` live on each plugin's `preflight()` method.
 * Adding a new runtime/tracker/scm therefore doesn't require editing this
 * file — the plugin declares its own prereqs.
 *
 * All checks throw on failure so callers can catch and handle uniformly.
 */

import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { isPortAvailable } from "./web-dir.js";
import { isInstalledUnderNodeModules } from "./dashboard-rebuild.js";

/**
 * Check that the dashboard port is free.
 * Throws if the port is already in use.
 */
async function checkPort(port: number): Promise<void> {
  const free = await isPortAvailable(port);
  if (!free) {
    throw new Error(
      `Port ${port} is already in use. Free it or change 'port' in agent-orchestrator.yaml.`,
    );
  }
}

/**
 * Check that workspace packages have been compiled (TypeScript → JavaScript).
 * Locates @aoagents/ao-core by walking up from webDir, handling both pnpm
 * workspaces (symlinked deps in webDir/node_modules) and npm/yarn global
 * installs (hoisted to a parent node_modules).
 */
async function checkBuilt(webDir: string): Promise<void> {
  const isNpmInstall = isInstalledUnderNodeModules(webDir);
  const corePkgDir = findPackageUp(webDir, "@aoagents", "ao-core");
  if (!corePkgDir) {
    const hint = isNpmInstall
      ? "Run: npm install -g @aoagents/ao@latest"
      : "Run: pnpm install && pnpm build";
    throw new Error(`Dependencies not installed. ${hint}`);
  }
  const coreEntry = resolve(corePkgDir, "dist", "index.js");
  if (!existsSync(coreEntry)) {
    const hint = isNpmInstall
      ? "Run: npm install -g @aoagents/ao@latest"
      : "Run: pnpm build";
    throw new Error(`Packages not built. ${hint}`);
  }

  const webBuildId = resolve(webDir, ".next", "BUILD_ID");
  const startAllEntry = resolve(webDir, "dist-server", "start-all.js");
  if (!existsSync(webBuildId) || !existsSync(startAllEntry)) {
    const hint = isNpmInstall
      ? "Run: npm install -g @aoagents/ao@latest"
      : "Run: pnpm build";
    throw new Error(`Packages not built. ${hint}`);
  }
}

/**
 * Walk up from startDir looking for node_modules/<segments>.
 * Mirrors Node's module resolution: checks each ancestor directory until
 * the package is found or the filesystem root is reached.
 */
function findPackageUp(startDir: string, ...segments: string[]): string | null {
  let dir = resolve(startDir);
  while (true) {
    const candidate = resolve(dir, "node_modules", ...segments);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export const preflight = {
  checkPort,
  checkBuilt,
};
