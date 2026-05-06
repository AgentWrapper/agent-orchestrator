import { spawn } from "node:child_process";
import chalk from "chalk";
import type { Command } from "commander";
import {
  isOrchestratorSession,
  isTerminalSession,
  loadConfig,
  SessionNotRestorableError,
  WorkspaceMissingError,
} from "@aoagents/ao-core";
import { DEFAULT_PORT } from "../lib/constants.js";
import { git, getTmuxActivity, tmux } from "../lib/shell.js";
import { formatAge } from "../lib/format.js";
import { getSessionManager } from "../lib/create-session-manager.js";
import { isOrchestratorSessionName } from "../lib/session-utils.js";
import { projectSessionUrl } from "../lib/routes.js";

interface SessionListEntry {
  id: string;
  projectId: string;
  projectName: string;
  role: "worker" | "orchestrator";
  branch: string | null;
  status: string | null;
  issueId: string | null;
  pr: string | null;
  workspacePath: string | null;
  lastActivityAt: string | null;
}

export function registerSession(program: Command): void {
  const session = program
    .command("session")
    .description("Session management (ls, kill, cleanup, restore, claim-pr)");

  session
    .command("ls")
    .description("List all sessions")
    .option("-p, --project <id>", "Filter by project ID")
    .option("-a, --all", "Include orchestrator sessions")
    .option(
      "--include-terminated",
      "Include terminated sessions (killed/done/merged/terminated/errored/cleanup)",
    )
    .option("--json", "Output as JSON")
    .action(async (opts: {
      project?: string;
      all?: boolean;
      includeTerminated?: boolean;
      json?: boolean;
    }) => {
      const config = loadConfig();
      if (opts.project && !config.projects[opts.project]) {
        console.error(chalk.red(`Unknown project: ${opts.project}`));
        process.exit(1);
      }

      const sm = await getSessionManager(config);
      const allSessions = await sm.list(opts.project);

      // Filter out orchestrator sessions unless --all is passed
      const withoutOrchestrators = opts.all
        ? allSessions
        : allSessions.filter(
            (s) => !isOrchestratorSessionName(config, s.id, s.projectId),
          );

      // Count terminal sessions that would be hidden by default, then
      // drop them unless --include-terminated is passed.
      const hiddenTerminatedCount = opts.includeTerminated
        ? 0
        : withoutOrchestrators.filter(isTerminalSession).length;
      const sessions = opts.includeTerminated
        ? withoutOrchestrators
        : withoutOrchestrators.filter((s) => !isTerminalSession(s));

      // Group sessions by project
      const byProject = new Map<string, typeof sessions>();
      for (const s of sessions) {
        const list = byProject.get(s.projectId) ?? [];
        list.push(s);
        byProject.set(s.projectId, list);
      }

      // Iterate over all configured projects (not just ones with sessions)
      const projectIds = opts.project ? [opts.project] : Object.keys(config.projects);
      const allSessionPrefixes = Object.entries(config.projects).map(
        ([id, project]) => project.sessionPrefix ?? id,
      );
      const jsonOutput: SessionListEntry[] = [];

      for (const projectId of projectIds) {
        const project = config.projects[projectId];
        if (!project) continue;
        if (!opts.json) {
          console.log(chalk.bold(`\n${project.name || projectId}:`));
        }

        const projectSessions = (byProject.get(projectId) ?? []).sort((a, b) =>
          a.id.localeCompare(b.id),
        );

        if (projectSessions.length === 0) {
          if (!opts.json) {
            console.log(chalk.dim("  (no active sessions)"));
          }
          continue;
        }

        // Pre-fetch all branches and activities in parallel
        const branches = await Promise.all(
          projectSessions.map(async (s) => {
            if (s.workspacePath) {
              return git(["branch", "--show-current"], s.workspacePath).catch(() => null);
            }
            return null;
          }),
        );

        const activities = await Promise.all(
          projectSessions.map((s) => {
            const tmuxTarget = s.runtimeHandle?.id ?? s.id;
            return getTmuxActivity(tmuxTarget).catch(() => null);
          }),
        );

        for (let i = 0; i < projectSessions.length; i++) {
          const s = projectSessions[i];
          const liveBranch = branches[i];
          const activityTs = activities[i];

          // Priority: live branch from workspace > metadata branch > empty string
          const branchStr = (s.workspacePath && liveBranch) ? liveBranch : (s.branch || "");
          const prUrl = s.metadata["pr"] ?? null;

          if (opts.json) {
            const role = isOrchestratorSession(
              s,
              project.sessionPrefix ?? projectId,
              allSessionPrefixes,
            )
              ? "orchestrator"
              : "worker";

            jsonOutput.push({
              id: s.id,
              projectId,
              projectName: project.name || projectId,
              role,
              branch: branchStr || null,
              status: s.status,
              issueId: s.issueId,
              pr: prUrl,
              workspacePath: s.workspacePath,
              lastActivityAt: activityTs ? new Date(activityTs).toISOString() : null,
            });

            continue;
          }

          const age = activityTs ? formatAge(activityTs) : "-";
          const parts = [chalk.green(s.id), chalk.dim(`(${age})`)];
          if (branchStr) parts.push(chalk.cyan(branchStr));
          if (s.status) parts.push(chalk.dim(`[${s.status}]`));
          if (prUrl) parts.push(chalk.blue(prUrl));

          console.log(`  ${parts.join("  ")}`);
        }
      }

      if (opts.json) {
        console.log(
          JSON.stringify(
            { data: jsonOutput, meta: { hiddenTerminatedCount } },
            null,
            2,
          ),
        );
        return;
      }

      if (hiddenTerminatedCount > 0) {
        console.log(
          chalk.dim(
            `  ${hiddenTerminatedCount} terminated session${hiddenTerminatedCount !== 1 ? "s" : ""} hidden. Use --include-terminated to show.`,
          ),
        );
      }

      console.log();
    });

  session
    .command("attach")
    .description("Attach to a session's tmux window")
    .argument("<session>", "Session name to attach")
    .action(async (sessionName: string) => {
      const config = loadConfig();
      const sm = await getSessionManager(config);
      const sessionInfo = await sm.get(sessionName);
      const tmuxTarget = sessionInfo?.runtimeHandle?.id ?? sessionName;

      const exists = await tmux("has-session", "-t", tmuxTarget);
      if (exists === null) {
        console.error(chalk.red(`Session '${sessionName}' does not exist`));
        process.exit(1);
      }

      await new Promise<void>((resolve, reject) => {
        const child = spawn("tmux", ["attach", "-t", tmuxTarget], { stdio: "inherit" });
        child.once("error", (err) => reject(err));
        child.once("exit", (code) => {
          if (code === 0 || code === null) {
            resolve();
            return;
          }
          reject(new Error(`tmux attach exited with code ${code}`));
        });
      }).catch((err) => {
        console.error(chalk.red(`Failed to attach to session ${sessionName}: ${err}`));
        process.exit(1);
      });
    });

  session
    .command("kill")
    .description("Kill a session and remove its worktree")
    .argument("<session>", "Session name to kill")
    .option("--purge-session", "Delete mapped OpenCode session during kill")
    .action(async (sessionName: string, opts: { purgeSession?: boolean }) => {
      const config = loadConfig();
      const sm = await getSessionManager(config);

      try {
        await sm.kill(sessionName, { purgeOpenCode: opts.purgeSession === true });
        console.log(chalk.green(`\nSession ${sessionName} killed.`));
      } catch (err) {
        console.error(chalk.red(`Failed to kill session ${sessionName}: ${err}`));
        process.exit(1);
      }
    });

  session
    .command("cleanup")
    .description("Kill cleanup-eligible sessions with closed work or dead runtimes")
    .option("-p, --project <id>", "Filter by project ID")
    .option("--dry-run", "Show what would be cleaned up without doing it")
    .action(async (opts: { project?: string; dryRun?: boolean }) => {
      const config = loadConfig();
      if (opts.project && !config.projects[opts.project]) {
        console.error(chalk.red(`Unknown project: ${opts.project}`));
        process.exit(1);
      }

      console.log(chalk.bold("Checking for completed sessions...\n"));

      const sm = await getSessionManager(config);

      const filterCleanupIds = (ids: string[]): string[] =>
        ids.filter((entry) => {
          const separator = entry.indexOf(":");
          const entryProjectId = separator === -1 ? opts.project : entry.slice(0, separator);
          const sessionId = separator === -1 ? entry : entry.slice(separator + 1);
          return !isOrchestratorSessionName(config, sessionId, entryProjectId);
        });

      const filterCleanupErrors = (errors: Array<{ sessionId: string; error: string }>) =>
        errors.filter(({ sessionId }) => {
          const separator = sessionId.indexOf(":");
          const entryProjectId = separator === -1 ? opts.project : sessionId.slice(0, separator);
          const normalizedSessionId = separator === -1 ? sessionId : sessionId.slice(separator + 1);
          return !isOrchestratorSessionName(config, normalizedSessionId, entryProjectId);
        });

      if (opts.dryRun) {
        // Dry-run delegates to sm.cleanup() with dryRun flag so it uses the
        // same live checks (PR state, runtime alive, tracker) as actual cleanup.
        const rawResult = await sm.cleanup(opts.project, { dryRun: true });
        const result = {
          ...rawResult,
          killed: filterCleanupIds(rawResult.killed),
          errors: filterCleanupErrors(rawResult.errors),
        };

        if (result.errors.length > 0) {
          for (const { sessionId, error } of result.errors) {
            console.error(chalk.red(`  Error checking ${sessionId}: ${error}`));
          }
        }

        if (result.killed.length === 0 && result.errors.length === 0) {
          console.log(chalk.dim("  No sessions to clean up."));
        } else {
          for (const id of result.killed) {
            console.log(chalk.yellow(`  Would kill ${id}`));
          }
          if (result.killed.length > 0) {
            console.log(
              chalk.dim(
                `\nDry run complete. ${result.killed.length} session${result.killed.length !== 1 ? "s" : ""} would be cleaned.`,
              ),
            );
          }
        }
      } else {
        const rawResult = await sm.cleanup(opts.project);
        const result = {
          ...rawResult,
          killed: filterCleanupIds(rawResult.killed),
          errors: filterCleanupErrors(rawResult.errors),
        };

        if (result.killed.length === 0 && result.errors.length === 0) {
          console.log(chalk.dim("  No sessions to clean up."));
        } else {
          if (result.killed.length > 0) {
            for (const id of result.killed) {
              console.log(chalk.green(`  Cleaned: ${id}`));
            }
          }
          if (result.errors.length > 0) {
            for (const { sessionId, error } of result.errors) {
              console.error(chalk.red(`  Error cleaning ${sessionId}: ${error}`));
            }
          }
          console.log(chalk.green(`\nCleanup complete. ${result.killed.length} sessions cleaned.`));
        }
      }
    });

  session
    .command("claim-pr")
    .description("Attach an existing PR to a session")
    .argument("<pr>", "Pull request number or URL")
    .argument("[session]", "Session name (defaults to AO_SESSION_NAME/AO_SESSION)")
    .option("--assign-on-github", "Assign the PR to the authenticated GitHub user")
    .action(
      async (
        prRef: string,
        sessionName: string | undefined,
        opts: { assignOnGithub?: boolean },
      ) => {
        const config = loadConfig();
        const resolvedSession =
          sessionName ?? process.env["AO_SESSION_NAME"] ?? process.env["AO_SESSION"];

        if (!resolvedSession) {
          console.error(
            chalk.red(
              "No session provided. Pass a session name or run this inside a managed AO session.",
            ),
          );
          process.exit(1);
        }

        const sm = await getSessionManager(config);

        try {
          const result = await sm.claimPR(resolvedSession, prRef, {
            assignOnGithub: opts.assignOnGithub,
          });

          console.log(chalk.green(`\nSession ${resolvedSession} claimed PR #${result.pr.number}.`));
          console.log(chalk.dim(`  PR:       ${result.pr.url}`));
          console.log(chalk.dim(`  Branch:   ${result.pr.branch}`));
          console.log(
            chalk.dim(
              `  Checkout: ${result.branchChanged ? "switched to PR branch" : "already on PR branch"}`,
            ),
          );
          if (result.takenOverFrom.length > 0) {
            console.log(chalk.dim(`  Took over from: ${result.takenOverFrom.join(", ")}`));
          }
          if (opts.assignOnGithub) {
            if (result.githubAssigned) {
              console.log(chalk.dim("  GitHub assignee: updated"));
            } else if (result.githubAssignmentError) {
              console.log(chalk.yellow(`  GitHub assignee: ${result.githubAssignmentError}`));
            }
          }
        } catch (err) {
          console.error(chalk.red(`Failed to claim PR for session ${resolvedSession}: ${err}`));
          process.exit(1);
        }
      },
    );

  session
    .command("restore")
    .description("Restore a terminated/crashed session in-place")
    .argument("<session>", "Session name to restore")
    .action(async (sessionName: string) => {
      const config = loadConfig();
      const sm = await getSessionManager(config);

      try {
        const restored = await sm.restore(sessionName);
        console.log(chalk.green(`\nSession ${sessionName} restored.`));
        if (restored.workspacePath) {
          console.log(chalk.dim(`  Worktree: ${restored.workspacePath}`));
        }
        if (restored.branch) {
          console.log(chalk.dim(`  Branch:   ${restored.branch}`));
        }
        const port = config.port ?? DEFAULT_PORT;
        console.log(chalk.dim(`  View:     ${projectSessionUrl(port, restored.projectId, sessionName)}`));
      } catch (err) {
        if (err instanceof SessionNotRestorableError) {
          console.error(chalk.red(`Cannot restore: ${err.reason}`));
        } else if (err instanceof WorkspaceMissingError) {
          console.error(chalk.red(`Workspace missing: ${err.message}`));
        } else {
          console.error(chalk.red(`Failed to restore session ${sessionName}: ${err}`));
        }
        process.exit(1);
      }
    });

  session
    .command("remap")
    .description("Re-discover and persist OpenCode session mapping for an AO session")
    .argument("<session>", "Session name to remap")
    .option("-f, --force", "Force fresh remap by re-discovering the OpenCode session")
    .action(async (sessionName: string, opts: { force?: boolean }) => {
      const config = loadConfig();
      const sm = await getSessionManager(config);

      try {
        const mapped = await sm.remap(sessionName, opts.force === true);
        console.log(chalk.green(`\nSession ${sessionName} remapped.`));
        console.log(chalk.dim(`  OpenCode session: ${mapped}`));
      } catch (err) {
        console.error(chalk.red(`Failed to remap session ${sessionName}: ${err}`));
        process.exit(1);
      }
    });
}
