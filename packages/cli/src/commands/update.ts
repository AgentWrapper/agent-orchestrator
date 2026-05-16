import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Command } from "commander";
import chalk from "chalk";
import {
  getGlobalConfigPath,
  isCanonicalGlobalConfigPath,
  isWindows,
  loadConfig,
  loadGlobalConfig,
  type Session,
} from "@aoagents/ao-core";
import { runRepoScript } from "../lib/script-runner.js";
import {
  checkForUpdate,
  detectInstallMethod,
  getCurrentVersion,
  getUpdateCommand,
  invalidateCache,
  readCachedUpdateInfo,
  resolveUpdateChannel,
  type InstallMethod,
} from "../lib/update-check.js";
import { promptConfirm } from "../lib/prompts.js";
import { getSessionManager } from "../lib/create-session-manager.js";
import { getRunning } from "../lib/running-state.js";

/** Inline check instead of module-level constant so tests can control TTY state. */
function isTTY(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * The dashboard's POST /api/update spawns `ao update` with `stdio: "ignore"`,
 * which makes `isTTY()` return false. That used to be fatal: handleNpmUpdate
 * fell into the "non-interactive — print and return" branch and never invoked
 * the install. The route would respond 202 "started" and absolutely nothing
 * would happen.
 *
 * /api/update sets `AO_NON_INTERACTIVE_INSTALL=1` on the spawn env so we can
 * distinguish "API kicked this off, please install without prompting" from
 * "user piped output and we shouldn't surprise-install."
 */
export const NON_INTERACTIVE_INSTALL_ENV = "AO_NON_INTERACTIVE_INSTALL";

function isApiInvoked(): boolean {
  return process.env[NON_INTERACTIVE_INSTALL_ENV] === "1";
}

/**
 * Statuses that mean "the agent is doing real work right now and updating
 * `ao` would yank the rug out from under it."
 *
 * Mirrors the design doc (release-process.html §07): refuse, never auto-stop.
 */
const ACTIVE_SESSION_STATUSES = new Set<Session["status"]>([
  "working",
  "idle",
  "needs_input",
  "stuck",
]);

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

        if (opts.check) {
          await handleCheck();
          return;
        }

        const method = detectInstallMethod();

        // Reject git-only flags up front when the install isn't a git source.
        // Without this, users copy/pasting `ao update --skip-smoke` from older
        // docs would silently no-op on npm/pnpm/bun installs (the flag would be
        // accepted, ignored, and the user would never know why smoke tests
        // didn't run — because they never ran on these install methods anyway).
        if ((opts.skipSmoke || opts.smokeOnly) && method !== "git") {
          const flag = opts.skipSmoke ? "--skip-smoke" : "--smoke-only";
          console.error(`${flag} only applies to git installs (current install: ${method}).`);
          process.exit(1);
        }

        switch (method) {
          case "git":
            await handleGitUpdate(opts);
            break;
          case "homebrew":
            await handleHomebrewUpdate();
            break;
          case "npm-global":
          case "pnpm-global":
          case "bun-global":
            await handleNpmUpdate(method);
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
// Active-session guard
// ---------------------------------------------------------------------------

/**
 * Refuse to update when the user has live sessions.
 *
 * Auto-stopping would lose the agent's in-flight context (and potentially
 * uncommitted work). The release doc is explicit: refuse, surface the
 * `ao stop` command, let the user decide.
 *
 * Best-effort — when no config is reachable (fresh install, broken yaml)
 * we skip the guard rather than blocking the update on a missing dependency.
 */
async function ensureNoActiveSessions(): Promise<boolean> {
  let sessions: Session[];
  try {
    // Live signal first: running.json lists whichever projects the active
    // `ao start` daemon is currently polling. That can include local-only
    // projects whose `agent-orchestrator.yaml` is NOT in the global registry
    // (Dhruv edge case: user runs `ao start` from a repo with a local config
    // and no global registration — sessions live on disk, would be clobbered
    // if `ao update` proceeded).
    //
    // If a daemon is running, trust its configPath — it's the source of
    // truth for "which sessions does the running ao instance own?"
    const running = await getRunning();
    if (running && running.projects.length > 0) {
      // running.configPath could be local-wrapped (a project's
      // agent-orchestrator.yaml) OR the canonical global path. loadConfig
      // dispatches based on the path shape — both cases produce a full
      // OrchestratorConfig the SessionManager can enumerate.
      const config = loadConfig(running.configPath);
      const sm = await getSessionManager(config);
      sessions = await sm.list();
    } else {
      // No live daemon. Fall back to the global registry — covers the case
      // where the user ran `ao stop` (running.json gone) but stale sessions
      // sit on disk under ~/.agent-orchestrator/{hash}-{projectId}/. The
      // SessionManager's enrichment will reconcile any stale-runtime
      // sessions to `killed`, so terminal statuses don't block the update.
      const globalPath = getGlobalConfigPath();
      if (!existsSync(globalPath)) return true;
      const globalConfig = loadGlobalConfig(globalPath);
      if (!globalConfig || Object.keys(globalConfig.projects).length === 0) {
        return true;
      }
      if (!isCanonicalGlobalConfigPath(globalPath)) {
        return true;
      }
      const config = loadConfig(globalPath);
      const sm = await getSessionManager(config);
      sessions = await sm.list();
    }
  } catch {
    // If we can't enumerate sessions, don't pretend there are zero — but
    // also don't block the upgrade indefinitely. Surface a soft warning.
    console.error(
      chalk.yellow(
        "⚠ Could not check for active sessions before updating. Proceeding anyway.",
      ),
    );
    return true;
  }

  const active = sessions.filter((s) => ACTIVE_SESSION_STATUSES.has(s.status));
  if (active.length === 0) return true;

  const noun = active.length === 1 ? "session" : "sessions";
  console.error(
    chalk.red(
      `\n✗ ${active.length} ${noun} active. Run \`ao stop\` first, then \`ao update\`.\n`,
    ),
  );
  for (const s of active.slice(0, 5)) {
    console.error(chalk.dim(`    • ${s.id}  (${s.status})`));
  }
  if (active.length > 5) {
    console.error(chalk.dim(`    … and ${active.length - 5} more`));
  }
  return false;
}

// ---------------------------------------------------------------------------
// git install
// ---------------------------------------------------------------------------

async function handleGitUpdate(opts: {
  skipSmoke?: boolean;
  smokeOnly?: boolean;
}): Promise<void> {
  if (!(await ensureNoActiveSessions())) {
    process.exit(1);
  }

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
// npm / pnpm / bun global install
// ---------------------------------------------------------------------------

async function handleNpmUpdate(method: InstallMethod): Promise<void> {
  const channel = resolveUpdateChannel();

  // Snapshot the previously cached channel BEFORE we force a refresh, so we
  // can detect a channel switch (stable→nightly or vice versa). force:true
  // would overwrite cache.channel before we can read it.
  const previousChannel = readCachedUpdateInfo(method)?.channel;

  const info = await checkForUpdate({ force: true, channel });

  if (!info.latestVersion) {
    console.error(chalk.red("Could not reach npm registry. Check your network and try again."));
    process.exit(1);
  }

  // Detect a channel switch. When stable=0.5.0 and nightly=0.5.0-nightly-abc,
  // isVersionOutdated returns false (per semver, prerelease < stable on equal
  // base), so a stable→nightly user would see "Already on latest nightly"
  // until the next numeric bump. Force the prompt instead — explicit consent
  // is the right UX for a channel transition, and the install command we'd
  // run is genuinely different even if the version-compare says "no".
  const isChannelSwitch =
    !info.isOutdated &&
    previousChannel !== undefined &&
    previousChannel !== channel;

  // First-channel opt-in. previousChannel === undefined means we've never
  // installed via the auto-updater. A user who just ran `ao config set
  // updateChannel nightly` (after a manual install) would otherwise see
  // "Already on latest nightly" because semver says prerelease < stable.
  // Treat any version mismatch as install-worthy in that case.
  const isFirstChannelOptIn =
    !info.isOutdated &&
    !isChannelSwitch &&
    previousChannel === undefined &&
    info.currentVersion !== info.latestVersion;

  const needsInstall = info.isOutdated || isChannelSwitch || isFirstChannelOptIn;

  if (!needsInstall) {
    console.log(
      chalk.green(
        `Already on latest ${channel === "nightly" ? "nightly" : "version"} (${info.currentVersion}).`,
      ),
    );
    return;
  }

  console.log(`Current version: ${chalk.dim(info.currentVersion)}`);
  console.log(`Latest version:  ${chalk.green(info.latestVersion)}`);
  console.log(`Channel:         ${chalk.cyan(channel)}`);
  if (isChannelSwitch) {
    console.log(
      chalk.yellow(
        `\nChannel switch detected: was on ${previousChannel}, now ${channel}.`,
      ),
    );
    console.log(
      chalk.dim(
        "  The version compare says you're current, but the install command picks a different dist-tag.",
      ),
    );
  } else if (isFirstChannelOptIn) {
    console.log(
      chalk.yellow(
        `\nFirst install via the ${channel} channel — installing the channel's current build.`,
      ),
    );
  }
  console.log();

  const command = getUpdateCommand(method, channel);
  const apiInvoked = isApiInvoked();
  const interactive = isTTY() && !apiInvoked;

  // Non-interactive path: API-invoked OR piped output. We still gate on the
  // active-session guard (refusing returns true/false), but we never bail
  // out just because there's no terminal — the dashboard's "Update" click
  // must actually install. The only thing we skip is the confirm prompt.
  if (!(await ensureNoActiveSessions())) {
    process.exit(1);
  }

  if (interactive) {
    // Soft auto-install: when the user has opted into stable or nightly we
    // skip the confirm prompt — they've already said "keep me on this channel."
    // Manual users (and explicit channel switches / first opt-ins) still see
    // the confirm so an unintended `ao update` doesn't wipe the version they
    // pinned to.
    if (channel === "manual" || isChannelSwitch || isFirstChannelOptIn) {
      const promptText =
        isChannelSwitch || isFirstChannelOptIn
          ? `Switch to ${channel} via ${chalk.cyan(command)}?`
          : `Run ${chalk.cyan(command)}?`;
      const confirmed = await promptConfirm(
        promptText,
        !(isChannelSwitch || isFirstChannelOptIn),
      );
      if (!confirmed) return;
    } else {
      console.log(chalk.dim(`Updating: ${command}`));
    }
  } else if (apiInvoked) {
    console.log(chalk.dim(`Updating (api-invoked): ${command}`));
  } else {
    // Non-TTY but also not API-invoked (piped output). Keep the old
    // "print the command and let the user run it" behavior so a script
    // running `ao update | tee` doesn't get a surprise install.
    console.log(`Run: ${chalk.cyan(command)}`);
    return;
  }

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
    // `shell: isWindows()` is required so PATHEXT gets consulted on Windows —
    // npm/pnpm/bun install as `*.cmd` shims, and Node.js does not look at
    // PATHEXT for non-shell spawns, so a bare `npm` / `pnpm` / `bun` lookup
    // would silently ENOENT on every Windows install. `windowsHide: true`
    // keeps the shell window from flashing. Same fix that landed for the
    // dashboard's /api/update spawn in commit 9f29131d.
    const child = spawn(cmd!, args, {
      stdio: "inherit",
      shell: isWindows(),
      windowsHide: true,
    });
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
// homebrew install (notice only)
// ---------------------------------------------------------------------------

async function handleHomebrewUpdate(): Promise<void> {
  const channel = resolveUpdateChannel();
  const info = await checkForUpdate({ force: true, channel });
  console.log(`Installed via:   ${chalk.yellow("Homebrew")}`);
  console.log(`Current version: ${chalk.dim(info.currentVersion)}`);
  if (info.latestVersion) {
    console.log(`Latest version:  ${chalk.green(info.latestVersion)}`);
  }
  console.log();
  console.log(
    `Homebrew installs are managed by brew. Run:\n  ${chalk.cyan("brew upgrade ao")}`,
  );
  console.log(
    chalk.dim(
      "  (AO does not auto-install for brew installs because it would clobber brew's symlinks.)",
    ),
  );
}

// ---------------------------------------------------------------------------
// unknown install
// ---------------------------------------------------------------------------

async function handleUnknownUpdate(): Promise<void> {
  const version = getCurrentVersion();
  const channel = resolveUpdateChannel();
  const info = await checkForUpdate({ force: true, channel });

  console.log(`Installed version: ${chalk.dim(version)}`);
  if (info.latestVersion) {
    console.log(`Latest version:    ${chalk.green(info.latestVersion)}`);
  }
  console.log(`Install method:    ${chalk.yellow("unknown")}`);
  console.log(`Channel:           ${chalk.cyan(channel)}`);
  console.log();
  console.log(
    `Could not detect install method. If you installed via npm, run:\n  ${chalk.cyan(getUpdateCommand("npm-global", channel))}`,
  );
  console.log(
    chalk.dim(
      `  Override detection in ~/.agent-orchestrator/config.yaml:\n    installMethod: pnpm-global  # or bun-global, npm-global, homebrew, git`,
    ),
  );
}
