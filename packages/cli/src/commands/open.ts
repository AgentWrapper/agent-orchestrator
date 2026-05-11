import { spawn } from "node:child_process";
import chalk from "chalk";
import type { Command } from "commander";
import {
  isMac,
  isTerminalSession,
  isWindows,
  loadConfig,
  type Session,
} from "@aoagents/ao-core";
import { exec } from "../lib/shell.js";
import { getSessionManager } from "../lib/create-session-manager.js";
import { findProjectForSession, matchesPrefix } from "../lib/session-utils.js";
import { DEFAULT_PORT } from "../lib/constants.js";
import { projectSessionUrl } from "../lib/routes.js";
import { openUrl } from "../lib/web-dir.js";
import { getRunning } from "../lib/running-state.js";

async function openInIterm(sessionName: string, newWindow?: boolean): Promise<boolean> {
  try {
    const args = newWindow ? ["--new-window", sessionName] : [sessionName];
    await exec("open-iterm-tab", args);
    return true;
  } catch {
    return false;
  }
}

/**
 * Spawn a detached child and treat any synchronous spawn error as failure.
 * Returns true if the child was launched (its own exit code is not awaited —
 * a new console window has its own lifecycle).
 */
function spawnDetached(cmd: string, args: string[]): boolean {
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: false });
    child.on("error", () => { /* swallow — caller already returned */ });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Open a new attached console window running `ao session attach <id>`.
 * Tries Windows Terminal first (matches the iTerm-tab feel on Mac), falls
 * back to a plain `cmd /k` window which works on every Windows install.
 *
 * Both paths route through `cmd /k` rather than invoking `ao` directly:
 * `wt new-tab` and `start` both call CreateProcess on the first token, and
 * CreateProcess does not honor PATHEXT — so `ao` (really `ao.cmd`, an npm
 * shim) is reported as ERROR_FILE_NOT_FOUND (0x80070002). Letting cmd.exe
 * be the first token lets it do the .cmd resolution.
 *
 * `cwd` should be the project directory (where agent-orchestrator.yaml lives)
 * so the spawned `ao session attach` can resolve config via loadConfig's
 * upward search. Without it the new console inherits the user's homedir and
 * attach fails with "No agent-orchestrator.yaml found".
 */
function openWindowsConsole(sessionId: string, cwd: string | undefined): boolean {
  const title = `ao:${sessionId}`;
  const inner = ["ao", "session", "attach", sessionId];

  const wtArgs = ["-w", "0", "new-tab", "--title", title];
  if (cwd) wtArgs.push("-d", cwd);
  wtArgs.push("cmd.exe", "/k", ...inner);
  if (spawnDetached("wt.exe", wtArgs)) return true;

  // `start` syntax: start "title" [/d <dir>] <command> [args...]
  const startArgs = ["/c", "start", title];
  if (cwd) startArgs.push("/d", cwd);
  startArgs.push("cmd.exe", "/k", ...inner);
  return spawnDetached("cmd.exe", startArgs);
}

export function registerOpen(program: Command): void {
  program
    .command("open")
    .description("Open session(s) in an attached terminal (or the dashboard URL with --browser)")
    .argument("[target]", 'Session name, project ID, or "all" to open everything')
    .option("-w, --new-window", "Open in a new terminal window (macOS)")
    .option("-b, --browser", "Open the dashboard URL in a browser instead of a terminal")
    .action(async (target: string | undefined, opts: { newWindow?: boolean; browser?: boolean }) => {
      const config = loadConfig();
      const sm = await getSessionManager(config);
      const all = await sm.list();

      // For aggregate targets ("all" / project) we hide terminated sessions —
      // mirrors Mac's old tmux-list-sessions behavior, which only ever showed
      // live sessions. For a named lookup the user is asking about a specific
      // session, so we keep terminated ones in scope and open the dashboard
      // so they can read the transcript even if the agent has died.
      let sessionsToOpen: Session[];

      if (!target || target === "all") {
        sessionsToOpen = all.filter((s) => !isTerminalSession(s));
      } else if (config.projects[target]) {
        const project = config.projects[target];
        const prefix = project.sessionPrefix || target;
        sessionsToOpen = all
          .filter((s) => !isTerminalSession(s))
          .filter((s) => s.projectId === target || matchesPrefix(s.id, prefix));
      } else {
        const match = all.find((s) => s.id === target);
        if (!match) {
          console.error(
            chalk.red(`Unknown target: ${target}\nSpecify a session name, project ID, or "all".`),
          );
          process.exit(1);
        }
        sessionsToOpen = [match];
      }

      if (sessionsToOpen.length === 0) {
        console.log(chalk.dim("No sessions to open."));
        return;
      }

      // Prefer the live daemon's port over the config default — they can
      // diverge if the dashboard auto-picked a free port at startup.
      const running = await getRunning();
      const port = running?.port ?? config.port ?? DEFAULT_PORT;
      if (!running && !opts.browser) {
        console.log(
          chalk.dim(
            "Note: AO daemon does not appear to be running — dashboard URL fallback may not load.",
          ),
        );
      }

      console.log(
        chalk.bold(
          `Opening ${sessionsToOpen.length} session${sessionsToOpen.length > 1 ? "s" : ""}...\n`,
        ),
      );

      const sorted = [...sessionsToOpen].sort((a, b) => a.id.localeCompare(b.id));

      for (const session of sorted) {
        const projectId = session.projectId ?? findProjectForSession(config, session.id) ?? target;
        const url = projectSessionUrl(port, projectId ?? session.id, session.id);
        const dead = isTerminalSession(session);

        // --browser, or terminated sessions (no live PTY to attach to), or
        // named-lookup of a dead session: open the dashboard URL.
        if (opts.browser || dead) {
          openUrl(url);
          if (dead) {
            const sr = session.lifecycle.session.reason;
            const rr = session.lifecycle.runtime.reason;
            const at = session.lifecycle.session.terminatedAt;
            const when = at ? new Date(at).toLocaleString() : "unknown time";
            console.log(
              `  ${chalk.yellow(session.id)} ${chalk.dim("(terminated)")} — opened ${chalk.dim(url)}`,
            );
            console.log(
              chalk.dim(`    died at ${when}: session=${sr}, runtime=${rr}`),
            );
            console.log(
              chalk.dim(`    restart with: ao session restore ${session.id}`),
            );
          } else {
            console.log(`  ${chalk.green(session.id)} — opened ${chalk.dim(url)}`);
          }
          continue;
        }

        if (isMac()) {
          const opened = await openInIterm(session.id, opts.newWindow);
          if (opened) {
            console.log(chalk.green(`  Opened: ${session.id}`));
            continue;
          }
        } else if (isWindows()) {
          // The spawned `ao session attach` does loadConfig() which searches
          // upward from cwd for agent-orchestrator.yaml. Anchor the new
          // console at the project's path (where the yaml lives); if that
          // isn't in config, fall back to the worktree (yaml may live in a
          // parent directory of it).
          const projectPath = projectId ? config.projects[projectId]?.path : undefined;
          const cwd = projectPath ?? session.workspacePath ?? undefined;
          if (openWindowsConsole(session.id, cwd)) {
            console.log(chalk.green(`  Opened: ${session.id} (new console)`));
            continue;
          }
        }

        // Final fallback (Linux always lands here, plus any platform whose
        // terminal-spawn helper failed): open the dashboard URL.
        openUrl(url);
        console.log(`  ${chalk.yellow(session.id)} — opened ${chalk.dim(url)}`);
      }
      console.log();
    });
}
