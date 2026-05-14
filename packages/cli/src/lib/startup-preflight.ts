/**
 * Runtime preflight checks for `ao start`.
 *
 * Distinct from `lib/preflight.ts` (which validates dashboard build
 * artifacts). This module verifies system tools (git, tmux), warns about
 * legacy storage and OpenClaw status, and applies side effects like idle
 * sleep prevention and credential injection.
 *
 * Each check is exported individually for callers that need it at a
 * specific point in the flow (e.g. `ensureGit` before clone). The
 * top-level `runtimePreflight(config)` orchestrates the checks that
 * `runStartup` runs once at process start.
 */

import { readFileSync, writeFileSync } from "node:fs";
import chalk from "chalk";
import {
  getAoBaseDir,
  getDefaultRuntime,
  getGlobalConfigPath,
  inventoryHashDirs,
  isWindows,
  type OrchestratorConfig,
} from "@aoagents/ao-core";
import { execSilent } from "./shell.js";
import { detectOpenClawInstallation } from "./openclaw-probe.js";
import { applyOpenClawCredentials } from "./credential-resolver.js";
import { preventIdleSleep } from "./prevent-sleep.js";
import { askYesNo, tryInstallWithAttempts, type InstallAttempt } from "./install-helpers.js";

function gitInstallAttempts(): InstallAttempt[] {
  if (process.platform === "darwin") {
    return [{ cmd: "brew", args: ["install", "git"], label: "brew install git" }];
  }
  if (process.platform === "linux") {
    return [
      {
        cmd: "sudo",
        args: ["apt-get", "install", "-y", "git"],
        label: "sudo apt-get install -y git",
      },
      { cmd: "sudo", args: ["dnf", "install", "-y", "git"], label: "sudo dnf install -y git" },
    ];
  }
  if (process.platform === "win32") {
    return [
      {
        cmd: "winget",
        args: ["install", "--id", "Git.Git", "-e", "--source", "winget"],
        label: "winget install --id Git.Git -e --source winget",
      },
    ];
  }
  return [];
}

function gitInstallHints(): string[] {
  if (process.platform === "darwin") return ["brew install git"];
  if (process.platform === "win32") return ["winget install --id Git.Git -e --source winget"];
  return ["sudo apt install git      # Debian/Ubuntu", "sudo dnf install git      # Fedora/RHEL"];
}

function tmuxInstallAttempts(): InstallAttempt[] {
  if (process.platform === "darwin") {
    return [{ cmd: "brew", args: ["install", "tmux"], label: "brew install tmux" }];
  }
  if (process.platform === "linux") {
    return [
      {
        cmd: "sudo",
        args: ["apt-get", "install", "-y", "tmux"],
        label: "sudo apt-get install -y tmux",
      },
      { cmd: "sudo", args: ["dnf", "install", "-y", "tmux"], label: "sudo dnf install -y tmux" },
    ];
  }
  return [];
}

function tmuxInstallHints(): string[] {
  if (process.platform === "darwin") return ["brew install tmux"];
  if (process.platform === "win32")
    return ["# Install WSL first, then inside WSL:", "sudo apt install tmux"];
  return ["sudo apt install tmux      # Debian/Ubuntu", "sudo dnf install tmux      # Fedora/RHEL"];
}

export async function ensureGit(context: string): Promise<void> {
  const hasGit = (await execSilent("git", ["--version"])) !== null;
  if (hasGit) return;

  console.log(chalk.yellow(`⚠ Git is required for ${context}.`));
  const shouldInstall = await askYesNo("Install Git now?", true, false);
  if (shouldInstall) {
    const installed = await tryInstallWithAttempts(
      gitInstallAttempts(),
      async () => (await execSilent("git", ["--version"])) !== null,
    );
    if (installed) {
      console.log(chalk.green("  ✓ Git installed successfully"));
      return;
    }
  }

  console.error(chalk.red("\n✗ Git is required but is not installed.\n"));
  console.log(chalk.bold("  Install Git manually, then re-run ao start:\n"));
  for (const hint of gitInstallHints()) {
    console.log(chalk.cyan(`    ${hint}`));
  }
  console.log();
  process.exit(1);
}

/**
 * On Windows, attempt to rewrite `runtime: tmux` -> `runtime: process` in the
 * project's agent-orchestrator.yaml after asking the user. Uses a targeted
 * line replace (not a yaml round-trip) so comments and quoting are preserved.
 *
 * Returns `true` on a successful rewrite. The caller is responsible for
 * mutating the in-memory config (or reloading) so the rest of preflight
 * sees the new runtime.
 */
async function offerWindowsRuntimeSwitch(configPath: string): Promise<boolean> {
  console.log(chalk.yellow("\n⚠ tmux runtime is not supported on Windows."));
  console.log(chalk.dim(`  Config: ${configPath}`));
  console.log(
    chalk.dim(
      "  AO can rewrite `runtime: tmux` -> `runtime: process` in this file.\n" +
        "  If the file is git-tracked, you'll see this as a local change.",
    ),
  );

  const accept = await askYesNo("Switch this project to runtime: process?", true, false);
  if (!accept) return false;

  let original: string;
  try {
    original = readFileSync(configPath, "utf-8");
  } catch (err) {
    console.error(
      chalk.red(`  ✗ Could not read config: ${err instanceof Error ? err.message : String(err)}`),
    );
    return false;
  }

  // Match the runtime line whether quoted or unquoted, and preserve any
  // trailing comment. Anchored multiline so we don't accidentally rewrite
  // e.g. a string value on another line.
  const runtimeLineRe = /^([ \t]*runtime:[ \t]*)(?:'tmux'|"tmux"|tmux)([ \t]*(?:#.*)?)$/m;
  if (!runtimeLineRe.test(original)) {
    console.error(
      chalk.red("  ✗ Could not locate `runtime: tmux` line in config; aborting rewrite."),
    );
    return false;
  }
  const rewritten = original.replace(runtimeLineRe, "$1process$2");

  try {
    writeFileSync(configPath, rewritten, "utf-8");
  } catch (err) {
    console.error(
      chalk.red(`  ✗ Failed to write config: ${err instanceof Error ? err.message : String(err)}`),
    );
    return false;
  }
  console.log(chalk.green("  ✓ Updated runtime to process"));
  return true;
}

/**
 * Ensure tmux is available — interactive install with user consent if missing.
 * Called from runtimePreflight() so all `ao start` paths are covered.
 *
 * On Windows, tmux cannot run; instead, offer to rewrite the project config
 * to `runtime: process`. Returns `{ switchedToProcess: true }` if the rewrite
 * succeeded so the caller can update the in-memory config.
 */
export async function ensureTmux(configPath?: string): Promise<{ switchedToProcess: boolean }> {
  if (isWindows()) {
    if (configPath) {
      const switched = await offerWindowsRuntimeSwitch(configPath);
      if (switched) return { switchedToProcess: true };
    }
    console.error(chalk.red("\n✗ tmux runtime is not supported on Windows.\n"));
    console.log(
      chalk.bold("  Set ") +
        chalk.cyan("runtime: process") +
        chalk.bold(" in agent-orchestrator.yaml, then re-run ao start.\n"),
    );
    process.exit(1);
  }

  const hasTmux = (await execSilent("tmux", ["-V"])) !== null;
  if (hasTmux) return { switchedToProcess: false };

  console.log(chalk.yellow('⚠ tmux is required for runtime "tmux".'));
  const shouldInstall = await askYesNo("Install tmux now?", true, false);
  if (shouldInstall) {
    const installed = await tryInstallWithAttempts(
      tmuxInstallAttempts(),
      async () => (await execSilent("tmux", ["-V"])) !== null,
    );
    if (installed) {
      console.log(chalk.green("  ✓ tmux installed successfully"));
      return { switchedToProcess: false };
    }
  }

  console.error(chalk.red("\n✗ tmux is required but is not installed.\n"));
  console.log(chalk.bold("  Install tmux manually, then re-run ao start:\n"));
  for (const hint of tmuxInstallHints()) {
    console.log(chalk.cyan(`    ${hint}`));
  }
  console.log();
  process.exit(1);
}

export function warnAboutLegacyStorage(): void {
  try {
    const hashDirs = inventoryHashDirs(getAoBaseDir(), getGlobalConfigPath());
    if (hashDirs.length === 0) return;

    const nonEmptyDirCount = hashDirs.reduce((sum, d) => {
      if (d.empty) return sum;
      return sum + 1;
    }, 0);
    if (nonEmptyDirCount === 0) return;

    console.log(
      chalk.yellow(
        `\n  ⚠ Found ${nonEmptyDirCount} legacy storage director${nonEmptyDirCount === 1 ? "y" : "ies"} that need${nonEmptyDirCount === 1 ? "s" : ""} migration.\n` +
          `    Sessions stored in the old format won't appear until migrated.\n` +
          `    Run ${chalk.bold("ao migrate-storage")} to upgrade (use ${chalk.bold("--dry-run")} to preview).\n`,
      ),
    );
  } catch {
    // Non-critical — don't block startup
  }
}

export async function warnAboutOpenClawStatus(config: OrchestratorConfig): Promise<void> {
  const openclawConfig = config.notifiers?.["openclaw"];
  const openclawConfigured =
    openclawConfig !== null &&
    openclawConfig !== undefined &&
    typeof openclawConfig === "object" &&
    openclawConfig.plugin === "openclaw";
  const configuredUrl =
    openclawConfigured && typeof openclawConfig.url === "string" ? openclawConfig.url : undefined;

  try {
    const installation = configuredUrl
      ? await detectOpenClawInstallation(configuredUrl)
      : await detectOpenClawInstallation();

    if (openclawConfigured) {
      if (installation.state !== "running") {
        console.log(
          chalk.yellow(
            `⚠ OpenClaw is configured but the gateway is not reachable at ${installation.gatewayUrl}. Notifications may fail until it is running.`,
          ),
        );
      }
      return;
    }

    if (installation.state === "running") {
      console.log(
        chalk.yellow(
          `⚠ OpenClaw is running at ${installation.gatewayUrl} but AO is not configured to use it. Run \`ao setup openclaw\` if you want OpenClaw notifications.`,
        ),
      );
    }
  } catch {
    // OpenClaw probing is advisory for `ao start`; never block startup on it.
  }
}

/**
 * Top-level orchestrator: tools + state warnings + idle-sleep + credentials.
 * Replaces the inline preflight block in `runStartup`. Idempotent within a
 * single process — the side effects (caffeinate spawn, env injection) latch
 * for the lifetime of the process.
 */
export async function runtimePreflight(config: OrchestratorConfig): Promise<void> {
  const runtime = config.defaults?.runtime ?? getDefaultRuntime();
  if (runtime === "tmux") {
    const result = await ensureTmux(config.configPath);
    if (result.switchedToProcess) {
      // Mutate in-memory config so the rest of startup uses the new runtime.
      // Disk has already been updated; subsequent loadConfig() calls will
      // see the same value.
      const defaults = config.defaults ?? {};
      defaults.runtime = "process";
      config.defaults = defaults;
    }
  }
  warnAboutLegacyStorage();
  await warnAboutOpenClawStatus(config);

  // Prevent macOS idle sleep while AO is running (if enabled in config).
  // Uses caffeinate -i -w <pid> to hold an assertion tied to this process
  // lifetime. No-op on non-macOS platforms.
  if (config.power?.preventIdleSleep !== false) {
    const sleepHandle = preventIdleSleep();
    if (sleepHandle) {
      console.log(chalk.dim("  Preventing macOS idle sleep while AO is running"));
    }
  }

  // Only inject OpenClaw credentials when the project actually uses OpenClaw.
  // Avoids exposing API keys to projects/plugins that don't need them.
  const openclawNotifier = config.notifiers?.["openclaw"];
  const hasOpenClaw =
    openclawNotifier !== null &&
    openclawNotifier !== undefined &&
    typeof openclawNotifier === "object" &&
    openclawNotifier.plugin === "openclaw";
  if (hasOpenClaw) {
    const injectedKeys = applyOpenClawCredentials();
    if (injectedKeys.length > 0) {
      const names = injectedKeys.map((k) => k.key).join(", ");
      console.log(chalk.dim(`  Resolved from OpenClaw config: ${names}`));
    }
  }
}
