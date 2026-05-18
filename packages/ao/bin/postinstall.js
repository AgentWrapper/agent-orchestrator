#!/usr/bin/env node
/**
 * Postinstall script for @aoagents/ao (npm/yarn global installs).
 *
 * 1. Fixes node-pty's spawn-helper binary missing the execute bit.
 *    node-pty@1.1.0 ships spawn-helper without +x; the monorepo works around
 *    this via scripts/rebuild-node-pty.js, but that never runs for global installs.
 *    Upstream fix: microsoft/node-pty#866 (only in 1.2.0-beta, not stable yet).
 *
 * 2. Verifies the prebuilt binary is compatible with the current Node.js version.
 *    If not (common with nvm/fnm/volta), rebuilds from source via npx node-gyp.
 *    See: https://github.com/ComposioHQ/agent-orchestrator/issues/987
 *
 * 3. Verifies better-sqlite3 has a native binding for this Node ABI.
 *    Node majors can ship new NODE_MODULE_VERSION values before better-sqlite3
 *    publishes matching prebuilds; global installs must rebuild from source.
 *    See: https://github.com/ComposioHQ/agent-orchestrator/issues/1822
 *
 * 4. Clears stale Next.js runtime cache (.next/cache) from @composio/ao-web
 *    after a version upgrade, so `ao start` serves fresh dashboard assets.
 *    Writes a version stamp (.next/AO_VERSION) to skip cleanup on subsequent runs.
 */

import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function isWindows() {
  return process.platform === "win32";
}

export function findPackageUp(startDir, ...segments) {
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

export function resolveNodeModulesPackage(fromDir, ...segments) {
  const packageDir = resolve(fromDir, "node_modules", ...segments);
  return existsSync(resolve(packageDir, "package.json")) ? packageDir : null;
}

export function findWebDir() {
  const directWebDir = findPackageUp(__dirname, "@aoagents", "ao-web");
  if (directWebDir) return directWebDir;

  const cliDir = findPackageUp(__dirname, "@aoagents", "ao-cli");
  if (!cliDir) return null;

  return resolveNodeModulesPackage(cliDir, "@aoagents", "ao-web");
}

export function findBetterSqlite3Dir() {
  const directBetterSqlite3Dir = findPackageUp(__dirname, "better-sqlite3");
  if (directBetterSqlite3Dir) return directBetterSqlite3Dir;

  const cliDir = findPackageUp(__dirname, "@aoagents", "ao-cli");
  if (!cliDir) return null;

  const coreDir = resolveNodeModulesPackage(cliDir, "@aoagents", "ao-core");
  if (!coreDir) return null;

  return (
    resolveNodeModulesPackage(coreDir, "better-sqlite3") ?? findPackageUp(coreDir, "better-sqlite3")
  );
}

export function betterSqlite3BindingCandidates(
  packageDir,
  {
    platform = process.platform,
    arch = process.arch,
    modules = process.versions.modules,
    nodeVersion = process.versions.node,
  } = {},
) {
  return [
    resolve(packageDir, "build", "better_sqlite3.node"),
    resolve(packageDir, "build", "Debug", "better_sqlite3.node"),
    resolve(packageDir, "build", "Release", "better_sqlite3.node"),
    resolve(packageDir, "out", "Debug", "better_sqlite3.node"),
    resolve(packageDir, "Debug", "better_sqlite3.node"),
    resolve(packageDir, "out", "Release", "better_sqlite3.node"),
    resolve(packageDir, "Release", "better_sqlite3.node"),
    resolve(packageDir, "build", "default", "better_sqlite3.node"),
    resolve(packageDir, "compiled", nodeVersion, platform, arch, "better_sqlite3.node"),
    resolve(packageDir, "addon-build", "release", "install-root", "better_sqlite3.node"),
    resolve(packageDir, "addon-build", "debug", "install-root", "better_sqlite3.node"),
    resolve(packageDir, "addon-build", "default", "install-root", "better_sqlite3.node"),
    resolve(
      packageDir,
      "lib",
      "binding",
      `node-v${modules}-${platform}-${arch}`,
      "better_sqlite3.node",
    ),
  ];
}

export function hasBetterSqlite3Binding(packageDir, options = {}) {
  const fileExists = options.existsSync ?? existsSync;
  return betterSqlite3BindingCandidates(packageDir, options).some((candidate) =>
    fileExists(candidate),
  );
}

export function betterSqlite3RebuildCommand(packageDir, env = process.env) {
  const packageManager =
    `${env.npm_config_user_agent ?? ""} ${env.npm_execpath ?? ""}`.toLowerCase();
  if (packageManager.includes("npm") && !packageManager.includes("pnpm")) {
    return { command: "npm", args: ["rebuild"], display: `cd ${packageDir} && npm rebuild` };
  }
  return {
    command: "pnpm",
    args: ["--dir", packageDir, "rebuild"],
    display: `pnpm --dir ${packageDir} rebuild`,
  };
}

function checkBetterSqlite3Binding() {
  const betterSqlite3Dir = findBetterSqlite3Dir();
  if (!betterSqlite3Dir) {
    console.warn(
      "⚠️  better-sqlite3 package not found; skipping activity-events native binding check",
    );
    return;
  }

  const abi = process.versions.modules;
  if (hasBetterSqlite3Binding(betterSqlite3Dir)) {
    console.log(
      `✓ better-sqlite3 native binding present for Node ${process.version} (ABI v${abi})`,
    );
    return;
  }

  const { command, args, display } = betterSqlite3RebuildCommand(betterSqlite3Dir);
  try {
    execFileSync(command, args, {
      cwd: betterSqlite3Dir,
      stdio: "ignore",
      timeout: 120000,
      shell: isWindows(),
      windowsHide: true,
    });
    console.log(
      `✓ better-sqlite3 native binding rebuilt for Node ${process.version} (ABI v${abi})`,
    );
  } catch {
    console.warn(
      `⚠️  better-sqlite3 rebuild failed for Node ${process.version} (ABI v${abi}) — activity events may be unavailable. Manual fix: ${display}`,
    );
  }
}

function fixNodePty() {
  if (isWindows()) return;

  const nodePtyDir = findPackageUp(__dirname, "node-pty");
  if (nodePtyDir) {
    const spawnHelper = resolve(
      nodePtyDir,
      "prebuilds",
      `${process.platform}-${process.arch}`,
      "spawn-helper",
    );

    if (existsSync(spawnHelper)) {
      try {
        chmodSync(spawnHelper, 0o755);
        console.log("✓ node-pty spawn-helper permissions set");
      } catch {
        console.warn("⚠️  Could not set spawn-helper permissions (non-critical)");
      }
    }

    // Verify the prebuilt binary actually works with this Node.js version.
    // If it doesn't (ABI mismatch from nvm/fnm/volta version switching), rebuild.
    // We exercise pty.spawn() — not just require() — because the posix_spawnp
    // failure only surfaces when the helper binary is actually executed.
    try {
      execSync(
        "node -e \"var p=require('node-pty');var t=p.spawn('/bin/sh',['-c','exit 0'],{});t.kill();process.exit(0);\"",
        {
          cwd: resolve(nodePtyDir, ".."),
          stdio: "ignore",
          timeout: 10000,
        },
      );
    } catch {
      console.log(
        "⚠️  node-pty prebuilt binary incompatible with Node.js " +
          process.version +
          ", rebuilding...",
      );
      try {
        execSync("npx --yes node-gyp rebuild", {
          cwd: nodePtyDir,
          stdio: "inherit",
          timeout: 120000,
        });
        console.log("✓ node-pty rebuilt successfully");
      } catch {
        console.warn("⚠️  node-pty rebuild failed — web terminal may not work");
        console.warn("  Manual fix: cd " + nodePtyDir + " && npx node-gyp rebuild");
      }
    }
  }
}

function clearDashboardCache() {
  try {
    const webDir = findWebDir();
    if (webDir) {
      const pkgPath = resolve(webDir, "package.json");
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        const version = pkg.version;
        const cacheDir = resolve(webDir, ".next", "cache");
        const stampPath = resolve(webDir, ".next", "AO_VERSION");

        if (existsSync(cacheDir)) {
          rmSync(cacheDir, { recursive: true, force: true });
          console.log("✓ Cleared stale .next/cache");
        }
        if (existsSync(resolve(webDir, ".next"))) {
          writeFileSync(stampPath, version, "utf8");
          console.log(`✓ Dashboard version stamp set to ${version}`);
        }
      }
    }
  } catch (err) {
    console.warn(`⚠️  Could not clear dashboard cache (non-critical): ${err.message}`);
  }
}

export function runPostinstall() {
  // --- 1 & 2. Fix node-pty spawn-helper permissions and verify ABI (non-Windows only) ---
  fixNodePty();

  // --- 3. Ensure better-sqlite3 has a native binding for this Node ABI ---
  checkBetterSqlite3Binding();

  // --- 4. Clear stale Next.js runtime cache after version upgrade ---
  clearDashboardCache();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPostinstall();
}
