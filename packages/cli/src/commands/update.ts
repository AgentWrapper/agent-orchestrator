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
  recordActivityEvent,
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
    .option("--no-restore", "Restart AO after updating but do not restore stopped sessions")
    .action(
      async (opts: {
        skipSmoke?: boolean;
        smokeOnly?: boolean;
        check?: boolean;
        restore?: boolean;
      }) => {
        if (opts.skipSmoke && opts.smokeOnly) {
          console.error("`ao update` does not allow `--skip-smoke` together with `--smoke-only`.");
          process.exit(1);
        }

        if (opts.check) {
          await handleCheck();
          return;
        }

        const method = detectInstallMethod();

        recordActivityEvent({
          source: "cli",
          kind: "cli.update_invoked",
          level: "info",
          summary: `ao update invoked (method: ${method})`,
          data: { method, options: opts },
        });

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
            await handleNpmUpdate(method, { restore: opts.restore !== false });
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
// Update lifecycle planning
// ---------------------------------------------------------------------------

/**
 * Best-effort snapshot used by `ao update` to pause and resume AO around the
 * package-manager install. Missing/broken config should not block an update;
 * in that case we proceed without attempting a stop/start round trip.
 */
interface UpdateLifecyclePlan {
  runningBeforeUpdate: boolean;
  configPath?: string;
  primaryProjectId?: string;
  activeSessions: Session[];
}

async function getUpdateLifecyclePlan(): Promise<UpdateLifecyclePlan> {
  let sessions: Session[];
  let configPath: string | undefined;
  let primaryProjectId: string | undefined;
  let runningBeforeUpdate = false;
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
      runningBeforeUpdate = true;
      configPath = running.configPath;
      primaryProjectId = running.projects[0];
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
      if (!existsSync(globalPath)) {
        return { runningBeforeUpdate, configPath, primaryProjectId, activeSessions: [] };
      }
      const globalConfig = loadGlobalConfig(globalPath);
      if (!globalConfig || Object.keys(globalConfig.projects).length === 0) {
        return { runningBeforeUpdate, configPath, primaryProjectId, activeSessions: [] };
      }
      if (!isCanonicalGlobalConfigPath(globalPath)) {
        return { runningBeforeUpdate, configPath, primaryProjectId, activeSessions: [] };
      }
      configPath = globalPath;
      const config = loadConfig(globalPath);
      primaryProjectId = Object.keys(config.projects)[0];
      const sm = await getSessionManager(config);
      sessions = await sm.list();
    }
  } catch {
    // If we can't enumerate sessions, don't pretend there are zero — but
    // also don't block the upgrade indefinitely. Surface a soft warning.
    console.error(
      chalk.yellow("⚠ Could not check for active sessions before updating. Proceeding anyway."),
    );
    return { runningBeforeUpdate, configPath, primaryProjectId, activeSessions: [] };
  }

  const active = sessions.filter((s) => ACTIVE_SESSION_STATUSES.has(s.status));
  return { runningBeforeUpdate, configPath, primaryProjectId, activeSessions: active };
}

async function pauseAoForUpdate(plan: UpdateLifecyclePlan): Promise<boolean> {
  const shouldStop = plan.runningBeforeUpdate || plan.activeSessions.length > 0;
  if (!shouldStop) return false;

  if (plan.activeSessions.length > 0) {
    const noun = plan.activeSessions.length === 1 ? "session" : "sessions";
    console.log(
      chalk.yellow(
        `\n${plan.activeSessions.length} active ${noun} will be paused and restored after the update.`,
      ),
    );
    for (const s of plan.activeSessions.slice(0, 5)) {
      console.log(chalk.dim(`    • ${s.id}  (${s.status})`));
    }
    if (plan.activeSessions.length > 5) {
      console.log(chalk.dim(`    … and ${plan.activeSessions.length - 5} more`));
    }
  } else {
    console.log(chalk.dim("\nAO is running; it will be restarted after the update."));
  }

  const stopExit = await runAoLifecycleCommand(["stop", "--yes"], {
    configPath: plan.configPath,
  });
  if (stopExit !== 0) {
    recordActivityEvent({
      source: "cli",
      kind: "cli.update_failed",
      level: "error",
      summary: `ao update failed: internal ao stop exited non-zero`,
      data: { exitCode: stopExit },
    });
    console.error(chalk.red(`\nAO update could not stop the running daemon (exit ${stopExit}).`));
    process.exit(stopExit);
  }

  const afterStop = await getUpdateLifecyclePlan();
  if (afterStop.runningBeforeUpdate || afterStop.activeSessions.length > 0) {
    recordActivityEvent({
      source: "cli",
      kind: "cli.update_failed",
      level: "error",
      summary: `ao update failed: AO still appears active after internal ao stop`,
      data: {
        runningAfterStop: afterStop.runningBeforeUpdate,
        activeSessionCount: afterStop.activeSessions.length,
        activeSessionIds: afterStop.activeSessions.map((s) => s.id).slice(0, 20),
      },
    });
    console.error(
      chalk.red(
        "\nAO update stopped before installing because AO still appears to be running after `ao stop --yes`.",
      ),
    );
    if (afterStop.activeSessions.length > 0) {
      console.error(chalk.dim("Still-active sessions:"));
      for (const s of afterStop.activeSessions.slice(0, 5)) {
        console.error(chalk.dim(`    • ${s.id}  (${s.status})`));
      }
      if (afterStop.activeSessions.length > 5) {
        console.error(chalk.dim(`    … and ${afterStop.activeSessions.length - 5} more`));
      }
    }
    console.error(chalk.dim("Run `ao stop` and retry `ao update` after AO is fully stopped."));
    process.exit(1);
  }

  return plan.runningBeforeUpdate;
}

async function restartAoAfterUpdate(
  plan: UpdateLifecyclePlan,
  opts: { restore: boolean },
): Promise<void> {
  const args = ["start"];
  if (plan.primaryProjectId) args.push(plan.primaryProjectId);
  args.push(opts.restore ? "--restore" : "--no-restore");

  console.log(chalk.dim(`\nRestarting AO: ao ${args.join(" ")}`));
  const exitCode = await runAoLifecycleCommand(args, { configPath: plan.configPath });
  if (exitCode !== 0) {
    recordActivityEvent({
      source: "cli",
      kind: "cli.update_restart_failed",
      level: "error",
      summary: `ao update could not restart AO after install`,
      data: { exitCode, args },
    });
    console.error(
      chalk.yellow(
        `\nAO was updated, but \`ao ${args.join(" ")}\` failed with exit ${exitCode}. ` +
          `Run it manually to restore your sessions.`,
      ),
    );
    process.exit(exitCode);
  }
}

function runAoLifecycleCommand(
  args: string[],
  opts: { configPath?: string } = {},
): Promise<number> {
  return new Promise<number>((resolveExit) => {
    const child = spawn("ao", args, {
      stdio: "inherit",
      shell: isWindows(),
      windowsHide: true,
      env: opts.configPath ? { ...process.env, AO_CONFIG_PATH: opts.configPath } : process.env,
    });
    child.on("error", (error) => {
      console.error(chalk.yellow(`Could not run ao ${args.join(" ")}: ${error.message}`));
      resolveExit(1);
    });
    child.on("exit", (code, signal) => {
      resolveExit(signal ? 1 : (code ?? 1));
    });
  });
}

// ---------------------------------------------------------------------------
// git install
// ---------------------------------------------------------------------------

async function handleGitUpdate(opts: {
  skipSmoke?: boolean;
  smokeOnly?: boolean;
  restore?: boolean;
}): Promise<void> {
  const lifecyclePlan = await getUpdateLifecyclePlan();
  const shouldRestart = await pauseAoForUpdate(lifecyclePlan);

  const args: string[] = [];
  if (opts.skipSmoke) args.push("--skip-smoke");
  if (opts.smokeOnly) args.push("--smoke-only");

  try {
    const exitCode = await runRepoScript("ao-update.sh", args);
    if (exitCode !== 0) {
      recordActivityEvent({
        source: "cli",
        kind: "cli.update_failed",
        level: "error",
        summary: `ao update (git) failed: ao-update.sh exited non-zero`,
        data: { method: "git", exitCode },
      });
      if (shouldRestart) {
        await restartAoAfterUpdate(lifecyclePlan, { restore: opts.restore !== false });
      }
      process.exit(exitCode);
    }
    invalidateCache();
    if (shouldRestart) {
      await restartAoAfterUpdate(lifecyclePlan, { restore: opts.restore !== false });
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("Script not found: ao-update.sh")) {
      recordActivityEvent({
        source: "cli",
        kind: "cli.update_failed",
        level: "error",
        summary: `ao update (git) failed: ao-update.sh missing from bundled assets`,
        data: { method: "git", reason: "script_missing" },
      });
      console.error(
        chalk.red(
          "ao-update.sh is missing from the bundled assets. " +
            "If you're running from a source checkout, rebuild with `pnpm --filter @aoagents/ao-cli build`. " +
            "If you're on a package install, reinstall the package.",
        ),
      );
      if (shouldRestart) {
        await restartAoAfterUpdate(lifecyclePlan, { restore: opts.restore !== false });
      }
      process.exit(1);
    }

    recordActivityEvent({
      source: "cli",
      kind: "cli.update_failed",
      level: "error",
      summary: `ao update (git) failed`,
      data: {
        method: "git",
        errorMessage: error instanceof Error ? error.message : String(error),
      },
    });
    console.error(error instanceof Error ? error.message : String(error));
    if (shouldRestart) {
      await restartAoAfterUpdate(lifecyclePlan, { restore: opts.restore !== false });
    }
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// npm / pnpm / bun global install
// ---------------------------------------------------------------------------

async function handleNpmUpdate(method: InstallMethod, opts: { restore: boolean }): Promise<void> {
  const channel = resolveUpdateChannel();

  // Snapshot the previously cached channel BEFORE we force a refresh, so we
  // can detect a channel switch (stable→nightly or vice versa). force:true
  // would overwrite cache.channel before we can read it.
  const previousChannel = readCachedUpdateInfo(method)?.channel;

  let info: Awaited<ReturnType<typeof checkForUpdate>>;
  try {
    info = await checkForUpdate({ force: true, channel });
  } catch (error) {
    recordActivityEvent({
      source: "cli",
      kind: "cli.update_failed",
      level: "error",
      summary: `ao update (${method}) failed: npm registry lookup threw`,
      data: {
        method,
        channel,
        reason: "registry_lookup_threw",
        errorMessage: error instanceof Error ? error.message : String(error),
      },
    });
    console.error(chalk.red("Could not reach npm registry. Check your network and try again."));
    process.exit(1);
  }

  if (!info.latestVersion) {
    recordActivityEvent({
      source: "cli",
      kind: "cli.update_failed",
      level: "error",
      summary: `ao update (${method}) failed: npm registry lookup returned no version`,
      data: { method, channel, reason: "registry_unreachable" },
    });
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
    !info.isOutdated && previousChannel !== undefined && previousChannel !== channel;

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
      chalk.yellow(`\nChannel switch detected: was on ${previousChannel}, now ${channel}.`),
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
  const lifecyclePlan = await getUpdateLifecyclePlan();

  // Non-interactive path: API-invoked OR piped output. We still plan the
  // stop/start lifecycle, but we never bail out just because there's no
  // terminal — the dashboard's "Update" click must actually install. The
  // only thing we skip is the confirm prompt.
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
      const confirmed = await promptConfirm(promptText, !(isChannelSwitch || isFirstChannelOptIn));
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

  const shouldRestart = await pauseAoForUpdate(lifecyclePlan);
  const installResult = await runNpmInstall(command);
  if (installResult.exitCode !== 0) {
    recordActivityEvent({
      source: "cli",
      kind: "cli.update_failed",
      level: "error",
      summary: `ao update (${method}) failed: install command exited non-zero`,
      data: {
        method,
        command,
        exitCode: installResult.exitCode,
        classification: classifyInstallFailure(installResult.output).kind,
      },
    });
    printInstallFailure({
      method,
      command,
      channel,
      currentVersion: info.currentVersion,
      exitCode: installResult.exitCode,
      output: installResult.output,
    });
    if (shouldRestart) {
      console.log(chalk.dim("\nRestarting AO with the existing installation..."));
      await restartAoAfterUpdate(lifecyclePlan, opts);
    }
    process.exit(1);
  }

  const verification = await verifyInstalledVersion(info.latestVersion, info.currentVersion);
  if (!verification.ok) {
    recordActivityEvent({
      source: "cli",
      kind: "cli.update_failed",
      level: "error",
      summary: `ao update (${method}) failed: installed version verification failed`,
      data: {
        method,
        command,
        expectedVersion: info.latestVersion,
        actualVersion: verification.actualVersion,
        output: verification.output,
      },
    });
    console.error(chalk.red(`\nAO was not verified after install.`));
    console.error(chalk.yellow(verification.message));
    console.error(chalk.dim(`Expected: ${info.latestVersion}`));
    console.error(chalk.dim(`Current before update: ${info.currentVersion}`));
    if (shouldRestart) {
      console.log(chalk.dim("\nRestarting AO before exiting..."));
      await restartAoAfterUpdate(lifecyclePlan, opts);
    }
    process.exit(1);
  }

  invalidateCache();
  if (shouldRestart) {
    await restartAoAfterUpdate(lifecyclePlan, opts);
  }
  console.log(
    chalk.green(
      `\nUpdate complete: ${info.currentVersion} → ${verification.actualVersion}.` +
        (shouldRestart ? " AO restarted." : ""),
    ),
  );
}

interface CommandResult {
  exitCode: number;
  output: string;
}

function runNpmInstall(command: string): Promise<CommandResult> {
  const [cmd, ...args] = command.split(" ");
  return runCommandCapture(cmd!, args, { echo: true }).then((result) => {
    if (result.exitCode !== 0) {
      console.error(chalk.yellow(`\n${cmd} exited with code ${result.exitCode}.`));
    }
    return result;
  });
}

function runCommandCapture(
  cmd: string,
  args: string[],
  opts: { echo?: boolean } = {},
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolveExit) => {
    // `shell: isWindows()` is required so PATHEXT gets consulted on Windows —
    // npm/pnpm/bun install as `*.cmd` shims, and Node.js does not look at
    // PATHEXT for non-shell spawns, so a bare `npm` / `pnpm` / `bun` lookup
    // would silently ENOENT on every Windows install. `windowsHide: true`
    // keeps the shell window from flashing. Same fix that landed for the
    // dashboard's /api/update spawn in commit 9f29131d.
    const child = spawn(cmd!, args, {
      stdio: ["inherit", "pipe", "pipe"],
      shell: isWindows(),
      windowsHide: true,
    });
    let output = "";
    const collect = (chunk: Buffer | string, stream: NodeJS.WriteStream): void => {
      const text = chunk.toString();
      output += text;
      if (opts.echo) stream.write(chunk);
    };
    child.stdout?.on("data", (chunk: Buffer | string) => collect(chunk, process.stdout));
    child.stderr?.on("data", (chunk: Buffer | string) => collect(chunk, process.stderr));
    child.on("error", (error) => {
      output += `${error.name}: ${error.message}`;
      resolveExit({ exitCode: 1, output });
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        resolveExit({ exitCode: 1, output: `${output}\nTerminated by signal ${signal}` });
        return;
      }

      resolveExit({ exitCode: code ?? 1, output });
    });
  });
}

interface VerificationResult {
  ok: boolean;
  actualVersion?: string;
  output: string;
  message: string;
}

async function verifyInstalledVersion(
  expectedVersion: string,
  previousVersion: string,
): Promise<VerificationResult> {
  const result = await runCommandCapture("ao", ["--version"]);
  const output = result.output.trim();
  const actualVersion = parseAoVersion(output);

  if (result.exitCode !== 0) {
    return {
      ok: false,
      output,
      message: `\`ao --version\` failed with exit ${result.exitCode}.`,
    };
  }
  if (!actualVersion) {
    return {
      ok: false,
      output,
      message: `Could not parse \`ao --version\` output: ${output || "<empty>"}`,
    };
  }
  if (actualVersion !== expectedVersion) {
    return {
      ok: false,
      actualVersion,
      output,
      message:
        actualVersion === previousVersion
          ? `The install command exited successfully, but AO is still on ${previousVersion}.`
          : `The install command exited successfully, but AO reports ${actualVersion}.`,
    };
  }

  return { ok: true, actualVersion, output, message: "verified" };
}

function parseAoVersion(output: string): string | undefined {
  const match = output.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/);
  return match?.[1];
}

function classifyInstallFailure(output: string): { kind: string; guidance: string } {
  if (/ERR_PNPM_UNEXPECTED_VIRTUAL_STORE/i.test(output)) {
    return {
      kind: "pnpm_virtual_store",
      guidance:
        "pnpm's global store metadata is inconsistent. Try `pnpm store prune`, then retry `ao update`. " +
        "If pnpm remains stuck, use the npm fallback below.",
    };
  }
  if (/(?:EACCES|EPERM|permission denied|access denied)/i.test(output)) {
    return {
      kind: "permission",
      guidance:
        "The package manager could not write to the global install location. Fix your npm/pnpm global prefix permissions, or retry from a shell with access to that directory.",
    };
  }
  if (/(?:ENETUNREACH|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network|socket hang up)/i.test(output)) {
    return {
      kind: "network",
      guidance:
        "The registry request failed due to a network error. Check connectivity/VPN/proxy settings and retry `ao update`.",
    };
  }
  if (
    /(?:lockfile|ERR_PNPM_LOCKFILE|ERR_PNPM_OUTDATED_LOCKFILE|ERR_PNPM_BROKEN_LOCKFILE)/i.test(
      output,
    )
  ) {
    return {
      kind: "lockfile",
      guidance:
        "pnpm reported lockfile state problems. Clear the affected global install metadata or retry with the npm fallback below.",
    };
  }
  if (
    /(?:registry|ERR_PNPM_FETCH|ERR_PNPM_META_FETCH_FAIL|E401|E403|E404|404 Not Found|401 Unauthorized|403 Forbidden)/i.test(
      output,
    )
  ) {
    return {
      kind: "registry",
      guidance:
        "The npm registry rejected or failed the package request. Check registry configuration, auth tokens, and the selected AO update channel.",
    };
  }
  return {
    kind: "unknown",
    guidance:
      "The package manager failed before AO could verify the new version. Retry `ao update` after addressing the package-manager error below.",
  };
}

function printInstallFailure(opts: {
  method: InstallMethod;
  command: string;
  channel: ReturnType<typeof resolveUpdateChannel>;
  currentVersion: string;
  exitCode: number;
  output: string;
}): void {
  const classification = classifyInstallFailure(opts.output);
  const fallbackCommand = getUpdateCommand("npm-global", opts.channel);

  console.error(
    chalk.red(`\nAO was not updated. You are still on version ${opts.currentVersion}.`),
  );
  console.error(
    chalk.yellow(
      `The package manager (${opts.method.replace("-global", "")}) failed with exit ${opts.exitCode}.`,
    ),
  );
  console.error(chalk.yellow(classification.guidance));
  console.error(chalk.dim(`\nTo retry: ao update`));
  if (opts.command !== fallbackCommand) {
    console.error(chalk.dim(`You can also try: ${fallbackCommand}`));
  }
  console.error(chalk.dim("\nPackage manager output:"));
  console.error(opts.output.trim() || "<no output>");
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
  console.log(`Homebrew installs are managed by brew. Run:\n  ${chalk.cyan("brew upgrade ao")}`);
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
