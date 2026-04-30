/**
 * Dashboard cache utilities — cleans stale .next artifacts, detects
 * running dashboard processes, and rebuilds production artifacts.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { normalize, resolve } from "node:path";
import ora from "ora";
import { exec, execSilent } from "./shell.js";

/**
 * Check if the web directory is inside a node_modules tree (npm/yarn global install).
 * Matches node_modules as a path segment, not just a substring.
 */
export function isInstalledUnderNodeModules(path: string): boolean {
  return path.includes("/node_modules/") || path.includes("\\node_modules\\");
}

/**
 * Guard: rebuilds are only possible from a source checkout.
 * Global npm installs ship prebuilt artifacts and cannot rebuild in place.
 */
export function assertDashboardRebuildSupported(webDir: string): void {
  if (isInstalledUnderNodeModules(webDir)) {
    throw new Error(
      "Dashboard rebuild is only available from a source checkout. " +
        "Run `ao update`, or reinstall with `npm install -g @aoagents/ao@latest`.",
    );
  }
}

/**
 * Find the PID of a process listening on the given port.
 * Returns null if no process is found.
 */
export async function findRunningDashboardPid(port: number): Promise<string | null> {
  const lsofOutput = await execSilent("lsof", ["-ti", `:${port}`, "-sTCP:LISTEN"]);
  if (!lsofOutput) return null;

  const pid = lsofOutput.split("\n")[0]?.trim();
  if (!pid || !/^\d+$/.test(pid)) return null;
  return pid;
}

async function getProcessCwd(pid: string): Promise<string | null> {
  const output = await execSilent("lsof", ["-a", "-p", pid, "-d", "cwd", "-Fn"]);
  if (!output) return null;

  const cwdLine = output.split("\n").find((line) => line.startsWith("n"));
  const cwd = cwdLine?.slice(1).trim();
  return cwd ? normalize(cwd) : null;
}

/**
 * Find live dashboard server PIDs whose current working directory is webDir.
 */
export async function findRunningDashboardPidsForWebDir(
  webDir: string,
  ports: readonly number[],
): Promise<string[]> {
  const expectedCwd = normalize(resolve(webDir));
  const pids = new Set<string>();

  for (const port of ports) {
    const output = await execSilent("lsof", ["-ti", `:${port}`, "-sTCP:LISTEN"]);
    if (!output) continue;
    for (const rawPid of output.split("\n")) {
      const pid = rawPid.trim();
      if (!/^\d+$/.test(pid)) continue;
      const cwd = await getProcessCwd(pid);
      if (cwd === expectedCwd) pids.add(pid);
    }
  }

  return [...pids];
}

/**
 * Stop any live production dashboard serving from webDir before mutating .next.
 */
export async function stopRunningDashboardsForWebDir(
  webDir: string,
  ports: readonly number[],
): Promise<void> {
  const pids = await findRunningDashboardPidsForWebDir(webDir, ports);
  if (pids.length === 0) return;

  console.log(
    `Stopping running dashboard${pids.length === 1 ? "" : "s"} before rebuilding .next (PID${pids.length === 1 ? "" : "s"} ${pids.join(", ")})...`,
  );
  for (const pid of pids) {
    try {
      process.kill(Number(pid), "SIGTERM");
    } catch {
      // Process already exited (ESRCH) — that's fine.
    }
  }

  for (const port of ports) {
    await waitForPortFree(port, 5000);
  }
}

/**
 * Wait for a port to be free (no process listening).
 * Throws if the port is still busy after the timeout.
 */
export async function waitForPortFree(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const pid = await findRunningDashboardPid(port);
    if (!pid) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `Port ${port} still in use after ${timeoutMs}ms — old process did not exit in time`,
  );
}

/**
 * Remove the .next directory before a rebuild.
 */
export async function cleanNextCache(webDir: string): Promise<void> {
  const nextDir = resolve(webDir, ".next");
  if (existsSync(nextDir)) {
    const spinner = ora();
    spinner.start("Cleaning .next build cache");
    rmSync(nextDir, { recursive: true, force: true });
    spinner.succeed(`Cleaned .next build cache (${webDir})`);
  }
}

/**
 * Compare the .next/AO_VERSION stamp against the current web package version.
 * If they differ (or the stamp is missing), clear the .next/cache directory
 * so Next.js doesn't serve stale pages after a version upgrade.
 */
export async function clearStaleCacheIfNeeded(webDir: string): Promise<void> {
  try {
    const stampPath = resolve(webDir, ".next", "AO_VERSION");
    const pkgPath = resolve(webDir, "package.json");

    if (!existsSync(pkgPath)) return;

    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
    const currentVersion = pkg.version;

    if (!currentVersion) return;

    let needsClear = false;

    if (!existsSync(stampPath)) {
      needsClear = true;
    } else {
      const stamp = readFileSync(stampPath, "utf8").trim();
      needsClear = stamp !== currentVersion;
    }

    if (needsClear) {
      const cacheDir = resolve(webDir, ".next", "cache");
      if (existsSync(cacheDir)) {
        const spinner = ora();
        spinner.start("Clearing stale Next.js cache (version upgrade detected)");
        rmSync(cacheDir, { recursive: true, force: true });
        spinner.succeed(`Cleared stale .next cache → v${currentVersion}`);
      }
      // Update stamp so subsequent starts skip the check
      const nextDir = resolve(webDir, ".next");
      if (existsSync(nextDir)) {
        writeFileSync(stampPath, currentVersion, "utf8");
      }
    }
  } catch (err) {
    // Best-effort cache cleanup — never prevent dashboard from starting
    console.debug("Cache version check skipped:", err);
  }
}

/**
 * Rebuild dashboard production artifacts (Next.js build + server compilation)
 * from a source checkout. Throws if called from an npm global install.
 */
export async function rebuildDashboardProductionArtifacts(
  webDir: string,
  ports: readonly number[] = [],
): Promise<void> {
  assertDashboardRebuildSupported(webDir);

  await stopRunningDashboardsForWebDir(webDir, ports);
  await cleanNextCache(webDir);

  const workspaceRoot = resolve(webDir, "../..");
  const spinner = ora("Rebuilding dashboard production artifacts").start();

  try {
    await exec("pnpm", ["build"], { cwd: workspaceRoot });
    spinner.succeed("Rebuilt dashboard production artifacts");
  } catch (error) {
    spinner.fail("Dashboard rebuild failed");
    throw new Error(
      "Failed to rebuild dashboard production artifacts. Run `pnpm build` and try again.",
      { cause: error },
    );
  }
}
