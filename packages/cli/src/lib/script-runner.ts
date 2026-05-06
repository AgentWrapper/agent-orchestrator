import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyInstallPath,
  hasNodeModulesAncestor,
  isAgentOrchestratorRepoRoot,
  isAoCliPackageRoot,
} from "./update-check.js";

const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);
const CURRENT_MODULE_DIR = dirname(CURRENT_MODULE_PATH);
const CLI_DIST_ROOT = resolve(CURRENT_MODULE_DIR, "..");

export type ScriptLayout = "source-checkout" | "package-install";

export function resolveScriptLayoutFromPath(modulePath: string): ScriptLayout {
  const installMethod = classifyInstallPath(modulePath);
  if (installMethod === "git") {
    return "source-checkout";
  }
  if (installMethod === "npm-global" || installMethod === "pnpm-global") {
    return "package-install";
  }

  return hasNodeModulesAncestor(modulePath) ? "package-install" : "source-checkout";
}

export function resolveDefaultRepoRootFromPath(modulePath: string): string {
  const moduleDir = dirname(modulePath);
  const layout = resolveScriptLayoutFromPath(modulePath);
  return layout === "package-install"
    ? resolve(moduleDir, "../..")
    : resolve(moduleDir, "../../../../");
}

const DEFAULT_REPO_ROOT = resolveDefaultRepoRootFromPath(CURRENT_MODULE_PATH);
const DEFAULT_SCRIPT_LAYOUT = resolveScriptLayoutFromPath(CURRENT_MODULE_PATH);

function isValidRepoRootForLayout(root: string, layout: ScriptLayout): boolean {
  return layout === "source-checkout"
    ? isAgentOrchestratorRepoRoot(root)
    : isAoCliPackageRoot(root);
}

export function resolveRepoRoot(): string {
  const override = process.env["AO_REPO_ROOT"];
  if (!override) {
    return DEFAULT_REPO_ROOT;
  }

  const resolved = resolve(override);
  if (!isValidRepoRootForLayout(resolved, DEFAULT_SCRIPT_LAYOUT)) {
    const expected =
      DEFAULT_SCRIPT_LAYOUT === "source-checkout"
        ? "an agent-orchestrator checkout"
        : "an installed @aoagents/ao-cli package";
    throw new Error(`AO_REPO_ROOT=${override} does not look like ${expected}`);
  }

  return resolved;
}

export function resolveScriptLayout(): ScriptLayout {
  const override = process.env["AO_SCRIPT_LAYOUT"];
  if (
    process.env["AO_DEV"] === "1" &&
    (override === "package-install" || override === "source-checkout")
  ) {
    return override;
  }
  return DEFAULT_SCRIPT_LAYOUT;
}

function getScriptPath(scriptName: string): string {
  return resolve(CLI_DIST_ROOT, "assets", "scripts", scriptName);
}

export function resolveScriptPath(scriptName: string): string {
  const scriptPath = getScriptPath(scriptName);
  if (!existsSync(scriptPath)) {
    throw new Error(
      `Script not found: ${scriptName}. Expected at: ${scriptPath} (scripts directory: ${resolve(CLI_DIST_ROOT, "assets", "scripts")})`,
    );
  }
  return scriptPath;
}

export function hasRepoScript(scriptName: string): boolean {
  return existsSync(getScriptPath(scriptName));
}

export async function runRepoScript(scriptName: string, args: string[]): Promise<number> {
  const shell = process.env["AO_BASH_PATH"] || "bash";
  const scriptPath = resolveScriptPath(scriptName);
  const repoRoot = resolveRepoRoot();
  const scriptLayout = resolveScriptLayout();

  return await new Promise<number>((resolveExit, reject) => {
    const child = spawn(shell, [scriptPath, ...args], {
      cwd: repoRoot,
      env: { ...process.env, AO_REPO_ROOT: repoRoot, AO_SCRIPT_LAYOUT: scriptLayout },
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        resolveExit(1);
        return;
      }

      resolveExit(code ?? 1);
    });
  });
}

export async function executeScriptCommand(scriptName: string, args: string[]): Promise<void> {
  try {
    const exitCode = await runRepoScript(scriptName, args);
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
