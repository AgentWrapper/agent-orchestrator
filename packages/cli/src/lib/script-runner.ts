import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isWindows } from "@aoagents/ao-core";
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

// Common Git Bash install locations on Windows. WSL's bash.exe is intentionally
// excluded: when invoked from Windows-native Node, the spawned WSL bash sees
// Linux paths (/mnt/c/...) while cwd is a Windows path (D:\...), which silently
// breaks repo scripts. Users on WSL run `ao` as a Linux process anyway, where
// process.platform === "linux" and this branch never executes.
const WINDOWS_BASH_CANDIDATES = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
];

// Walk PATH searching for bash.exe. Lets us discover Git Bash installs on
// non-default drives (e.g. D:\Program Files\Git) that the hardcoded list above
// would miss. Returns the first match or null. PATH-walking is sync but
// microseconds — no subprocess.
function findBashOnPath(): string | null {
  const dirs = (process.env["PATH"] ?? "").split(";").filter(Boolean);
  for (const dir of dirs) {
    const candidate = resolve(dir, "bash.exe");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function detectWindowsBash(): string | null {
  for (const candidate of WINDOWS_BASH_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return findBashOnPath();
}

// Windows: prefer PowerShell 7 (pwsh.exe), fall back to bundled Windows
// PowerShell 5.1 (powershell.exe). Both can run our .ps1 scripts.
function detectWindowsPowerShell(): string | null {
  const candidates = ["pwsh.exe", "powershell.exe"];
  const dirs = (process.env["PATH"] ?? "").split(";").filter(Boolean);
  for (const exe of candidates) {
    for (const dir of dirs) {
      const candidate = resolve(dir, exe);
      if (existsSync(candidate)) return candidate;
    }
  }
  // Fallback: powershell.exe ships in System32 on every supported Windows.
  const sysRoot = process.env["SystemRoot"] ?? "C:\\Windows";
  const fallback = resolve(sysRoot, "System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  return existsSync(fallback) ? fallback : null;
}

export function hasRepoScript(scriptName: string): boolean {
  return existsSync(getScriptPath(scriptName));
}

export async function runRepoScript(scriptName: string, args: string[]): Promise<number> {
  const repoRoot = resolveRepoRoot();
  const scriptLayout = resolveScriptLayout();

  // Windows: prefer the .ps1 sibling of the requested .sh script and run via
  // PowerShell. .sh scripts can still be run if the user has installed Git Bash
  // and we ship no .ps1 equivalent. Booth/WSL bash isn't supported (see comment
  // on WINDOWS_BASH_CANDIDATES).
  if (isWindows()) {
    const ps1Name = scriptName.replace(/\.sh$/i, ".ps1");
    if (ps1Name !== scriptName && hasRepoScript(ps1Name)) {
      const ps = detectWindowsPowerShell();
      if (!ps) {
        throw new Error(
          "Cannot run PowerShell scripts on Windows. " +
            "Install PowerShell 7 (https://aka.ms/powershell) or ensure powershell.exe is in PATH.",
        );
      }
      const scriptPath = resolveScriptPath(ps1Name);
      // -File runs the script with positional args; -ExecutionPolicy Bypass
      // avoids machine policy blocking unsigned bundled scripts.
      return await spawnAndWait(
        ps,
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args],
        repoRoot,
        scriptLayout,
      );
    }
  }

  let shellOverride = process.env["AO_BASH_PATH"];
  // Unix: always use bash — repo scripts have #!/bin/bash shebangs and bash-specific syntax.
  // Shebangs are only honoured by the kernel when a file is executed directly; when passed as
  // an argument to another interpreter (e.g. zsh script.sh) the shebang is ignored, so we must
  // name bash explicitly rather than using the user's $SHELL.
  // Windows: no native shell (pwsh, powershell.exe, cmd.exe) can run bash scripts —
  // shebangs are ignored and bash-specific syntax fails. Auto-detect Git Bash / WSL,
  // fall back to AO_BASH_PATH, throw with guidance if neither is found.
  if (!shellOverride && isWindows()) {
    const detected = detectWindowsBash();
    if (!detected) {
      throw new Error(
        "Cannot run repo scripts on Windows without bash. " +
          "Install Git for Windows (https://git-scm.com/download/win) or " +
          "set AO_BASH_PATH to a bash executable " +
          "(e.g. C:\\Program Files\\Git\\bin\\bash.exe).",
      );
    }
    shellOverride = detected;
  }

  const shell = shellOverride ?? "bash";
  const scriptPath = resolveScriptPath(scriptName);

  return await spawnAndWait(shell, [scriptPath, ...args], repoRoot, scriptLayout);
}

function spawnAndWait(
  shell: string,
  shellArgs: string[],
  repoRoot: string,
  scriptLayout: ScriptLayout,
): Promise<number> {
  return new Promise<number>((resolveExit, reject) => {
    const child = spawn(shell, shellArgs, {
      cwd: repoRoot,
      env: { ...process.env, AO_REPO_ROOT: repoRoot, AO_SCRIPT_LAYOUT: scriptLayout },
      stdio: "inherit",
      windowsHide: true,
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
