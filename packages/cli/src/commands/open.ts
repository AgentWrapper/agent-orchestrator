import chalk from "chalk";
import type { Command } from "commander";
import { loadConfig } from "@aoagents/ao-core";
import { exec, getTmuxSessions } from "../lib/shell.js";
import { findProjectForSession, matchesPrefix, stripHashPrefix } from "../lib/session-utils.js";
import { DEFAULT_PORT } from "../lib/constants.js";
import { projectSessionUrl } from "../lib/routes.js";

async function openInTerminal(sessionName: string, newWindow?: boolean): Promise<boolean> {
  try {
    const args = newWindow ? ["--new-window", sessionName] : [sessionName];
    await exec("open-iterm-tab", args);
    return true;
  } catch {
    // Fall back to tmux attach hint
    return false;
  }
}

export function registerOpen(program: Command): void {
  program
    .command("open")
    .description("Open session(s) in terminal tabs")
    .argument("[target]", 'Session name, project ID, or "all" to open everything')
    .option("-w, --new-window", "Open in a new terminal window")
    .action(async (target: string | undefined, opts: { newWindow?: boolean }) => {
      const config = loadConfig();
      const allTmux = await getTmuxSessions();

      let sessionsToOpen: string[] = [];

      if (!target || target === "all") {
        // Open all sessions across all projects
        for (const [projectId, project] of Object.entries(config.projects)) {
          const prefix = project.sessionPrefix || projectId;
          const matching = allTmux.filter((s) => matchesPrefix(s, prefix));
          sessionsToOpen.push(...matching);
        }
      } else if (config.projects[target]) {
        // Open all sessions for a specific project
        const project = config.projects[target];
        const prefix = project.sessionPrefix || target;
        sessionsToOpen = allTmux.filter((s) => matchesPrefix(s, prefix));
      } else if (allTmux.includes(target)) {
        // Open a specific session
        sessionsToOpen = [target];
      } else {
        console.error(
          chalk.red(`Unknown target: ${target}\nSpecify a session name, project ID, or "all".`),
        );
        process.exit(1);
      }

      if (sessionsToOpen.length === 0) {
        console.log(chalk.dim("No sessions to open."));
        return;
      }

      console.log(
        chalk.bold(
          `Opening ${sessionsToOpen.length} session${sessionsToOpen.length > 1 ? "s" : ""}...\n`,
        ),
      );

      const port = config.port ?? DEFAULT_PORT;
      for (const session of sessionsToOpen.sort()) {
        const opened = await openInTerminal(session, opts.newWindow);
        if (opened) {
          console.log(chalk.green(`  Opened: ${session}`));
        } else {
          const sessionId = stripHashPrefix(session);
          const matchedProjectId = findProjectForSession(config, session) ?? target ?? sessionId;
          console.log(
            `  ${chalk.yellow(session)} — view at: ${chalk.dim(projectSessionUrl(port, matchedProjectId, sessionId))}`,
          );
        }
      }
      console.log();
    });
}
