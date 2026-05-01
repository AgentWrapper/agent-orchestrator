import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { resolve } from "node:path";
import {
  loadConfig,
  resolveSpawnTarget,
  TERMINAL_STATUSES,
  type OrchestratorConfig,
} from "@aoagents/ao-core";
import { DEFAULT_PORT } from "../lib/constants.js";
import { exec } from "../lib/shell.js";
import { banner } from "../lib/format.js";
import { getSessionManager } from "../lib/create-session-manager.js";
import { preflight } from "../lib/preflight.js";
import { findProjectForDirectory } from "../lib/project-resolution.js";
import { getRunning } from "../lib/running-state.js";
import { projectSessionUrl } from "../lib/routes.js";

/**
 * Auto-detect the project ID from the config.
 * - If only one project exists, use it.
 * - If multiple projects exist, match cwd against project paths.
 * - Falls back to AO_PROJECT_ID env var (set when called from an agent session).
 */
function autoDetectProject(config: OrchestratorConfig): string {
  const projectIds = Object.keys(config.projects);
  if (projectIds.length === 0) {
    throw new Error("No projects configured. Run 'ao start' first.");
  }
  if (projectIds.length === 1) {
    return projectIds[0];
  }

  // Try AO_PROJECT_ID env var (set by AO when spawning agent sessions)
  const envProject = process.env.AO_PROJECT_ID;
  if (envProject && config.projects[envProject]) {
    return envProject;
  }

  // Try matching cwd to a project path
  const cwd = resolve(process.cwd());
  const matchedProjectId = findProjectForDirectory(config.projects, cwd);
  if (matchedProjectId) {
    return matchedProjectId;
  }

  throw new Error(
    `Multiple projects configured. Specify one: ${projectIds.join(", ")}\n` +
      `Or run from within a project directory.`,
  );
}

interface SpawnClaimOptions {
  claimPr?: string;
  assignOnGithub?: boolean;
}

/**
 * Lifecycle polling runs in-process inside the long-lived `ao start` process.
 * `ao spawn` is a one-shot CLI — it can't start polling in its own process
 * (the interval would keep the CLI alive forever and duplicate work). Warn
 * when no `ao start` is running, or when the running instance isn't covering
 * this project (e.g. `ao start A` then `ao spawn` in B).
 */
async function warnIfAONotRunning(projectId: string): Promise<void> {
  const running = await getRunning();
  if (!running) {
    console.log(
      chalk.yellow(
        "⚠ AO is not running — lifecycle polling is inactive. Run `ao start` so the new session is tracked.",
      ),
    );
    return;
  }
  if (!running.projects.includes(projectId)) {
    console.log(
      chalk.yellow(
        `⚠ The running AO instance (pid ${running.pid}) is not polling project "${projectId}". Run \`ao start ${projectId}\` so the new session is tracked.`,
      ),
    );
  }
}

/**
 * Run pre-flight checks for a project once, before any sessions are spawned.
 * Validates runtime and tracker prerequisites so failures surface immediately
 * rather than repeating per-session in a batch.
 */
async function runSpawnPreflight(
  config: OrchestratorConfig,
  projectId: string,
  options?: SpawnClaimOptions,
): Promise<void> {
  const project = config.projects[projectId];
  const runtime = project?.runtime ?? config.defaults.runtime;
  if (runtime === "tmux") {
    await preflight.checkTmux();
  }
  const needsGitHubAuth =
    project?.tracker?.plugin === "github" ||
    (options?.claimPr && project?.scm?.plugin === "github");
  if (needsGitHubAuth) {
    await preflight.checkGhAuth();
  }
}

async function spawnSession(
  config: OrchestratorConfig,
  projectId: string,
  issueId?: string,
  openTab?: boolean,
  agent?: string,
  claimOptions?: SpawnClaimOptions,
  prompt?: string,
): Promise<string> {
  const spinner = ora("Creating session").start();

  try {
    const sm = await getSessionManager(config);
    spinner.text = "Spawning session via core";

    // Validate and sanitize prompt (strip newlines to prevent metadata injection)
    const sanitizedPrompt = prompt?.replace(/[\r\n]/g, " ").trim() || undefined;
    if (sanitizedPrompt && sanitizedPrompt.length > 4096) {
      throw new Error("Prompt must be at most 4096 characters");
    }

    const session = await sm.spawn({
      projectId,
      issueId,
      agent,
      prompt: sanitizedPrompt,
    });

    let claimedPrUrl: string | null = null;

    if (claimOptions?.claimPr) {
      spinner.text = `Claiming PR ${claimOptions.claimPr}`;
      try {
        const claimResult = await sm.claimPR(session.id, claimOptions.claimPr, {
          assignOnGithub: claimOptions.assignOnGithub,
        });
        claimedPrUrl = claimResult.pr.url;
      } catch (err) {
        throw new Error(
          `Session ${session.id} was created, but failed to claim PR ${claimOptions.claimPr}: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    }

    const issueLabel = issueId ? ` for issue #${issueId}` : "";
    const claimLabel = claimedPrUrl ? ` (claimed ${claimedPrUrl})` : "";
    const port = config.port ?? DEFAULT_PORT;
    spinner.succeed(
      `Session ${chalk.green(session.id)} spawned${issueLabel}${claimLabel}`,
    );
    console.log(`  View:     ${chalk.dim(projectSessionUrl(port, projectId, session.id))}`);

    // Warn if prompt delivery failed (for post-launch agents like Claude Code)
    const promptDelivered = session.metadata?.promptDelivered;
    if (promptDelivered === "false") {
      console.warn(
        chalk.yellow(
          `  ⚠ Prompt delivery failed — agent may be idle.\n` +
            `    Use '${chalk.cyan("ao send " + session.id + ' "message..."')}' to send instructions manually.`,
        ),
      );
    }

    // Open terminal tab if requested
    if (openTab) {
      try {
        const tmuxTarget = session.runtimeHandle?.id ?? session.id;
        await exec("open-iterm-tab", [tmuxTarget]);
      } catch {
        // open-iterm-tab helper not available — ignore
      }
    }

    // Output for scripting
    console.log(`SESSION=${session.id}`);
    return session.id;
  } catch (err) {
    spinner.fail("Failed to create or initialize session");
    throw err;
  }
}

export function registerSpawn(program: Command): void {
  program
    .command("spawn")
    .description("Spawn a single agent session")
    .argument(
      "[issue]",
      "Issue identifier. Accepts bare ids (42, INT-100) or prefixed forms (x402-identity/42, xid/42) to target a specific project by id or sessionPrefix.",
    )
    .allowExcessArguments()
    .option("--open", "Open session in terminal tab")
    .option("--agent <name>", "Override the agent plugin (e.g. codex, claude-code)")
    .option("--claim-pr <pr>", "Immediately claim an existing PR for the spawned session")
    .option("--assign-on-github", "Assign the claimed PR to the authenticated GitHub user")
    .option("--prompt <text>", "Initial prompt/instructions for the agent (use instead of an issue)")
    .action(
      async (
        issue: string | undefined,
        opts: {
          open?: boolean;
          agent?: string;
          claimPr?: string;
          assignOnGithub?: boolean;
          prompt?: string;
        },
        command: Command,
      ) => {
        if (command.args.length > 1) {
          console.error(
            chalk.red(
              `✗ \`ao spawn\` accepts at most 1 argument, but ${command.args.length} were provided.\n\n` +
                `Use:\n` +
                `  ao spawn [issue]`,
            ),
          );
          process.exit(1);
        }

        const config = loadConfig();
        let projectId: string;
        let issueId: string | undefined;

        if (issue) {
          const prefixed = resolveSpawnTarget(config.projects, issue);
          if (prefixed) {
            projectId = prefixed.projectId;
            issueId = prefixed.issueId;
          } else {
            issueId = issue;
            try {
              projectId = autoDetectProject(config);
            } catch (err) {
              console.error(chalk.red(err instanceof Error ? err.message : String(err)));
              process.exit(1);
            }
          }
        } else {
          // No args: auto-detect project, no issue
          try {
            projectId = autoDetectProject(config);
          } catch (err) {
            console.error(chalk.red(err instanceof Error ? err.message : String(err)));
            process.exit(1);
          }
        }

        if (!opts.claimPr && opts.assignOnGithub) {
          console.error(chalk.red("--assign-on-github requires --claim-pr on `ao spawn`."));
          process.exit(1);
        }

        const claimOptions: SpawnClaimOptions = {
          claimPr: opts.claimPr,
          assignOnGithub: opts.assignOnGithub,
        };

        try {
          await runSpawnPreflight(config, projectId, claimOptions);
          await warnIfAONotRunning(projectId);

          await spawnSession(config, projectId, issueId, opts.open, opts.agent, claimOptions, opts.prompt);
        } catch (err) {
          console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
          process.exit(1);
        }
      },
    );
}

export function registerBatchSpawn(program: Command): void {
  program
    .command("batch-spawn")
    .description("Spawn sessions for multiple issues with duplicate detection")
    .argument(
      "<issues...>",
      "Issue identifiers. Accepts bare ids or prefixed forms (x402-identity/42, xid/42); mixed projects are grouped automatically.",
    )
    .option("--open", "Open sessions in terminal tabs")
    .action(async (issues: string[], opts: { open?: boolean }) => {
      const config = loadConfig();

      // Resolve each issue to its target project. Issues without a prefix fall
      // back to auto-detection; prefixed issues route to the matched project.
      let fallbackProjectId: string | null = null;
      const needsFallback = issues.some(
        (issue) => resolveSpawnTarget(config.projects, issue) === null,
      );
      if (needsFallback) {
        try {
          fallbackProjectId = autoDetectProject(config);
        } catch (err) {
          console.error(chalk.red(err instanceof Error ? err.message : String(err)));
          process.exit(1);
        }
      }

      // Group issues by resolved project so each group preflights once.
      const groups = new Map<string, Array<{ original: string; resolved: string }>>();
      for (const issue of issues) {
        const target = resolveSpawnTarget(config.projects, issue, fallbackProjectId ?? undefined);
        if (!target) {
          console.error(chalk.red(`Could not resolve project for issue: ${issue}`));
          process.exit(1);
        }
        if (!config.projects[target.projectId]) {
          console.error(
            chalk.red(
              `Unknown project: ${target.projectId}\nAvailable: ${Object.keys(config.projects).join(", ")}`,
            ),
          );
          process.exit(1);
        }
        if (!groups.has(target.projectId)) groups.set(target.projectId, []);
        groups.get(target.projectId)!.push({ original: issue, resolved: target.issueId });
      }

      console.log(banner("BATCH SESSION SPAWNER"));
      console.log();
      for (const [pid, items] of groups) {
        console.log(
          `  ${chalk.bold(pid)}: ${items.map((i) => i.original).join(", ")}`,
        );
      }
      console.log();

      const created: Array<{ session: string; issue: string }> = [];
      const skipped: Array<{ issue: string; existing: string }> = [];
      const failed: Array<{ issue: string; error: string }> = [];

      const sm = await getSessionManager(config);

      for (const [groupProjectId, items] of groups) {
        // Pre-flight once per project group so a missing prerequisite fails fast.
        try {
          await runSpawnPreflight(config, groupProjectId);
          await warnIfAONotRunning(groupProjectId);
        } catch (err) {
          console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
          process.exit(1);
        }

        // Load existing sessions once per group (exclude terminal sessions so
        // merged/completed sessions don't block respawning a reopened issue).
        const existingSessions = await sm.list(groupProjectId);
        const existingIssueMap = new Map(
          existingSessions
            .filter((s) => s.issueId && !TERMINAL_STATUSES.has(s.status))
            .map((s) => [s.issueId!.toLowerCase(), s.id]),
        );
        const spawnedIssues = new Set<string>();

        for (const { original, resolved } of items) {
          if (spawnedIssues.has(resolved.toLowerCase())) {
            console.log(chalk.yellow(`  Skip ${original} — duplicate in this batch`));
            skipped.push({ issue: original, existing: "(this batch)" });
            continue;
          }
          const existingSessionId = existingIssueMap.get(resolved.toLowerCase());
          if (existingSessionId) {
            console.log(
              chalk.yellow(`  Skip ${original} — already has session ${existingSessionId}`),
            );
            skipped.push({ issue: original, existing: existingSessionId });
            continue;
          }

          try {
            const session = await sm.spawn({ projectId: groupProjectId, issueId: resolved });
            created.push({ session: session.id, issue: original });
            spawnedIssues.add(resolved.toLowerCase());
            console.log(chalk.green(`  Created ${session.id} for ${original}`));

            if (opts.open) {
              try {
                const tmuxTarget = session.runtimeHandle?.id ?? session.id;
                await exec("open-iterm-tab", [tmuxTarget]);
              } catch {
                // best effort
              }
            }
          } catch (err) {
            failed.push({
              issue: original,
              error: err instanceof Error ? err.message : String(err),
            });
            console.log(
              chalk.red(
                `  Failed ${original} — ${err instanceof Error ? err.message : String(err)}`,
              ),
            );
          }
        }
      }

      console.log();
      if (created.length > 0) {
        console.log(chalk.green(`Created ${created.length} sessions:`));
        for (const item of created) console.log(`  ${item.session} ← ${item.issue}`);
      }
      if (skipped.length > 0) {
        console.log(chalk.yellow(`Skipped ${skipped.length} issues:`));
        for (const item of skipped) console.log(`  ${item.issue} (existing: ${item.existing})`);
      }
      if (failed.length > 0) {
        console.log(chalk.red(`Failed ${failed.length} issues:`));
        for (const item of failed) console.log(`  ${item.issue}: ${item.error}`);
      }
      console.log();
    });
}
