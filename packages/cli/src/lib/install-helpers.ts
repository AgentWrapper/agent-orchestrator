/**
 * Shared primitives for interactively installing missing CLI tools.
 *
 * Used by `startup-preflight.ts` (ensureGit, ensureTmux), the agent runtime
 * installer, and the optional gh install path in autoCreateConfig. Lives in
 * its own module so the preflight code can be moved out of `start.ts`
 * without re-extracting these helpers later.
 */

import { spawn } from "node:child_process";
import chalk from "chalk";
import { formatCommandError } from "./cli-errors.js";
import { isHumanCaller } from "./caller-context.js";
import { promptConfirm } from "./prompts.js";

export interface InstallAttempt {
  cmd: string;
  args: string[];
  label: string;
}

export function canPromptForInstall(): boolean {
  return isHumanCaller() && Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function genericInstallHints(command: string): string[] {
  switch (command) {
    case "node":
    case "npm":
      return ["Install Node.js/npm from https://nodejs.org/"];
    case "pnpm":
      return ["corepack enable && corepack prepare pnpm@latest --activate", "npm install -g pnpm"];
    case "pipx":
      return ["python3 -m pip install --user pipx", "python3 -m pipx ensurepath"];
    default:
      return [];
  }
}

export async function askYesNo(
  question: string,
  defaultYes = true,
  nonInteractiveDefault = defaultYes,
): Promise<boolean> {
  if (!canPromptForInstall()) return nonInteractiveDefault;
  return await promptConfirm(question, defaultYes);
}

export async function runInteractiveCommand(
  cmd: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: Record<string, string>;
    action?: string;
    installHints?: string[];
  },
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options?.cwd,
      env: options?.env ? { ...process.env, ...options.env } : process.env,
      stdio: "inherit",
    });
    child.once("error", (err) => {
      reject(
        formatCommandError(err, {
          cmd,
          args,
          action: options?.action ?? "run an interactive command",
          installHints: options?.installHints ?? genericInstallHints(cmd),
        }),
      );
    });
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Command failed (${code ?? "unknown"}): ${cmd} ${args.join(" ")}`));
    });
  });
}

export async function tryInstallWithAttempts(
  attempts: InstallAttempt[],
  verify: () => Promise<boolean>,
): Promise<boolean> {
  for (const attempt of attempts) {
    try {
      console.log(chalk.dim(`  Running: ${attempt.label}`));
      await runInteractiveCommand(attempt.cmd, attempt.args, {
        action: "run an interactive installer",
        installHints: genericInstallHints(attempt.cmd),
      });
      if (await verify()) return true;
    } catch {
      // Try next installer
    }
  }
  return verify();
}
