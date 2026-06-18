import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { exec } from "./shell.js";
import { formatCommandError } from "./cli-errors.js";

interface PluginStoreManifest {
  name: string;
  private: boolean;
  type: "module";
}

const STORE_MANIFEST: PluginStoreManifest = {
  name: "ao-plugin-store",
  private: true,
  type: "module",
};

function getPluginStorePackageJsonPath(): string {
  return join(getPluginStoreRoot(), "package.json");
}

function getInstalledPackageJsonPath(packageName: string): string {
  return join(getPluginStoreRoot(), "node_modules", ...packageName.split("/"), "package.json");
}

function getStoreRequire(): NodeRequire {
  const packageJsonPath = getPluginStorePackageJsonPath();
  ensurePluginStore();
  return createRequire(packageJsonPath);
}

function isPackageSpecifier(specifier: string): boolean {
  return !(
    specifier.startsWith("file:") ||
    specifier.startsWith("node:") ||
    specifier.startsWith("/") ||
    specifier.startsWith("./") ||
    specifier.startsWith("../")
  );
}

async function runNpmInStore(args: string[]): Promise<void> {
  const storeRoot = ensurePluginStore();
  try {
    await exec("npm", args, { cwd: storeRoot });
  } catch (err) {
    throw formatCommandError(err, {
      cmd: "npm",
      args,
      action: "manage AO marketplace plugins",
      installHints: ["Install Node.js/npm from https://nodejs.org/ and re-run the command."],
    });
  }
}

export function getPluginStoreRoot(): string {
  return join(homedir(), ".agent-orchestrator", "plugins");
}

export function ensurePluginStore(): string {
  const rootDir = getPluginStoreRoot();
  mkdirSync(rootDir, { recursive: true });

  const packageJsonPath = getPluginStorePackageJsonPath();
  if (!existsSync(packageJsonPath)) {
    writeFileSync(packageJsonPath, `${JSON.stringify(STORE_MANIFEST, null, 2)}\n`, "utf-8");
  }

  return rootDir;
}

export function readInstalledPackageVersion(packageName: string): string | null {
  const packageJsonPath = getInstalledPackageJsonPath(packageName);
  if (!existsSync(packageJsonPath)) return null;

  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.length > 0 ? parsed.version : null;
  } catch {
    return null;
  }
}

export async function installPackageIntoStore(
  packageName: string,
  version?: string,
): Promise<string> {
  const requested = version ? `${packageName}@${version}` : packageName;
  await runNpmInStore(["install", "--save-exact", requested]);

  const installedVersion = readInstalledPackageVersion(packageName);
  if (!installedVersion) {
    throw new Error(
      `Package ${packageName} was installed into the AO plugin store but no version was resolved afterwards.`,
    );
  }

  return installedVersion;
}

export async function uninstallPackageFromStore(packageName: string): Promise<boolean> {
  if (!readInstalledPackageVersion(packageName)) {
    return false;
  }

  await runNpmInStore(["uninstall", packageName]);
  return readInstalledPackageVersion(packageName) === null;
}

export function tryResolveInstalledPluginSpecifier(packageName: string): string | null {
  try {
    const resolvedPath = getStoreRequire().resolve(packageName);
    return pathToFileURL(resolvedPath).href;
  } catch {
    return null;
  }
}

export async function importPluginModuleFromSource(specifier: string): Promise<unknown> {
  if (isPackageSpecifier(specifier)) {
    const storeSpecifier = tryResolveInstalledPluginSpecifier(specifier);
    if (storeSpecifier) {
      return import(storeSpecifier);
    }
  }

  return import(specifier);
}

export async function getLatestPublishedPackageVersion(packageName: string): Promise<string> {
  try {
    const { stdout } = await exec("npm", ["view", packageName, "version", "--json"]);
    const parsed = JSON.parse(stdout) as unknown;
    if (typeof parsed === "string" && parsed.length > 0) {
      return parsed;
    }
  } catch (err) {
    throw formatCommandError(err, {
      cmd: "npm",
      args: ["view", packageName, "version", "--json"],
      action: `resolve the latest published version for ${packageName}`,
      installHints: ["Install Node.js/npm from https://nodejs.org/ and re-run the command."],
    });
  }

  throw new Error(`npm did not return a usable version for ${packageName}.`);
}
