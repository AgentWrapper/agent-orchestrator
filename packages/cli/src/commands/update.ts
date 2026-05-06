import { spawn } from "node:child_process";
import type { Command } from "commander";
import chalk from "chalk";
import { runRepoScript } from "../lib/script-runner.js";
import {
  checkForUpdate,
  detectInstallMethod,
  getCurrentVersion,
  getUpdateCommand,
  invalidateCache,
} from "../lib/update-check.js";
import { promptConfirm } from "../lib/prompts.js";

/** Inline check instead of module-level constant so tests can control TTY state. */
function isTTY(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function registerUpdate(program: Command): void {
  program
    .command("update")
    .description("Check for updates and upgrade AO to the latest version")
    .option("--skip-smoke", "Skip smoke tests after rebuilding (git installs only)")
    .option("--smoke-only", "Run smoke tests without fetching or rebuilding (git installs only)")
    .option("--check", "Print version info as JSON without upgrading")
    .action(
      async (opts: { skipSmoke?: boolean; smokeOnly?: boolean; check?: boolean }) => {
        if (opts.skipSmoke && opts.smokeOnly) {
          console.error(
            "`ao update` does not allow `--skip-smoke` together with `--smoke-only`.",
          );
          process.exit(1);
        }

        // --check: print JSON and exit
        if (opts.check) {
          await handleCheck();
          return;
        }

        const method = detectInstallMethod();

        switch (method) {
          case "git":
            await handleGitUpdate(opts);
            break;
          case "npm-global":
          case "pnpm-global":
            await handleNpmUpdate(opts);
            break;
          case "unknown":
            await handleUnknownUpdate();
            break;
        }
      },
    );
}

// ---------------------------------------------------------------------------
// --check
// ---------------------------------------------------------------------------

async function handleCheck(): Promise<void> {
  const info = await checkForUpdate({ force: true });
  console.log(JSON.stringify(info, null, 2));
}

// ---------------------------------------------------------------------------
// git install
// ---------------------------------------------------------------------------

async function handleGitUpdate(opts: {
  skipSmoke?: boolean;
  smokeOnly?: boolean;
}): Promise<void> {
  const args: string[] = [];
  if (opts.skipSmoke) args.push("--skip-smoke");
  if (opts.smokeOnly) args.push("--smoke-only");

  try {
    const exitCode = await runRepoScript("ao-update.sh", args);
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
    invalidateCache();
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("Script not found: ao-update.sh")
    ) {
      console.error(
        chalk.red(
          "ao-update.sh is missing from the bundled assets. " +
            "If you're running from a source checkout, rebuild with `pnpm --filter @aoagents/ao-cli build`. " +
            "If you're on a package install, reinstall the package.",
        ),
      );
      process.exit(1);
    }

    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// npm-global install
// ---------------------------------------------------------------------------

async function handleNpmUpdate(opts: {
  skipSmoke?: boolean;
  smokeOnly?: boolean;
}): Promise<void> {
  if (opts.skipSmoke || opts.smokeOnly) {
    console.log(
      chalk.yellow("--skip-smoke and --smoke-only only apply to git source installs. Ignoring."),
    );
  }

  const info = await checkForUpdate({ force: true });

  if (!info.latestVersion) {
    console.error(chalk.red("Could not reach npm registry. Check your network and try again."));
    process.exit(1);
  }

  if (!info.isOutdated) {
    console.log(chalk.green(`Already on latest version (${info.currentVersion}).`));
    return;
  }

  console.log(`Current version: ${chalk.dim(info.currentVersion)}`);
  console.log(`Latest version:  ${chalk.green(info.latestVersion)}`);
  console.log();

  const command = info.recommendedCommand;

  if (!isTTY()) {
    // Non-interactive: print the command. Exit 0 because this isn't an error,
    // the user just needs to run the command manually.
    console.log(`Run: ${chalk.cyan(command)}`);
    return;
  }

  const confirmed = await promptConfirm(`Run ${chalk.cyan(command)}?`);
  if (!confirmed) return;

  const exitCode = await runNpmInstall(command);
  if (exitCode === 0) {
    invalidateCache();
    console.log(chalk.green("\nUpdate complete."));
  } else {
    process.exit(exitCode);
  }
}

function runNpmInstall(command: string): Promise<number> {
  const [cmd, ...args] = command.split(" ");
  return new Promise<number>((resolveExit, reject) => {
    const child = spawn(cmd!, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        resolveExit(1);
        return;
      }

      if (code !== 0) {
        console.error(chalk.yellow(`\n${cmd} exited with code ${code}.`));
      }
      resolveExit(code ?? 1);
    });
  });
}

// ---------------------------------------------------------------------------
// unknown install
// ---------------------------------------------------------------------------

async function handleUnknownUpdate(): Promise<void> {
  const version = getCurrentVersion();
  const info = await checkForUpdate({ force: true });

  console.log(`Installed version: ${chalk.dim(version)}`);
  if (info.latestVersion) {
    console.log(`Latest version:    ${chalk.green(info.latestVersion)}`);
  }
  console.log(`Install method:    ${chalk.yellow("unknown")}`);
  console.log();
  console.log(
    `Could not detect install method. If you installed via npm, run:\n  ${chalk.cyan(getUpdateCommand("npm-global"))}`,
  );
}
