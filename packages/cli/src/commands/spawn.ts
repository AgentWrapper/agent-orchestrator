import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import { resolve } from "node:path";
import {
  loadConfig,
  resolveSpawnTarget,
  TERMINAL_STATUSES,
  type OrchestratorConfig,
  type PreflightContext,
} from "@aoagents/ao-core";
import { DEFAULT_PORT } from "../lib/constants.js";
import { exec } from "../lib/shell.js";
import { banner } from "../lib/format.js";
import { getPluginRegistry, getSessionManager } from "../lib/create-session-manager.js";
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

/**
 * Non-throwing variant — returns null when the project can't be resolved
 * unambiguously. Used to feed `resolveSpawnTarget`'s fallback parameter so
 * the prefix/no-prefix and issue/no-issue paths share one code path.
 */
function tryAutoDetectProject(config: OrchestratorConfig): string | null {
  try {
    return autoDetectProject(config);
  } catch {
    return null;
  }
}

/**
 * Resolve the project + issue from a single optional CLI argument.
 *
 * Single source of truth for the four cases:
 *   - `ao spawn`                   → auto-detect project, no issue
 *   - `ao spawn 42`                → auto-detect project, issue=42
 *   - `ao spawn xid/42`            → prefix match, issue=42
 *   - `ao spawn x402-identity/42`  → exact projectId match, issue=42
 *
 * Throws (via autoDetectProject) when the project can't be resolved — the
 * caller wraps in one try/catch instead of duplicating it across branches.
 */
function resolveProjectAndIssue(
  config: OrchestratorConfig,
  issue: string | undefined,
): { projectId: string; issueId?: string } {
  const fallback = tryAutoDetectProject(config);
  if (issue) {
    const target = resolveSpawnTarget(config.projects, issue, fallback ?? undefined);
    if (target) return { projectId: target.projectId, issueId: target.issueId };
    autoDetectProject(config); // throws with the real error message
    throw new Error("unreachable");
  }
  if (!fallback) {
    autoDetectProject(config); // throws
    throw new Error("unreachable");
  }
  return { projectId: fallback };
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
        `⚠ The running AO instance (pid ${running.pid}) is not polling project "${projectId}" yet. Lifecycle polling will attach within ~60s.`,
      ),
    );
  }
}

/**
 * Run pre-flight checks for a project once, before any sessions are spawned.
 *
 * Iterates the plugins selected for this spawn and calls each one's optional
 * `preflight()`. Plugins own their own prerequisites (binary present, auth
 * configured, etc.) so this CLI helper does not need to know which plugin
 * needs which tool. Adding a new runtime/tracker/scm plugin only requires
 * the plugin to declare its own preflight — no edits here.
 *
 * Collects every plugin's failure rather than aborting at the first one, so a
 * user with multiple broken prerequisites (e.g. tmux missing AND gh logged
 * out) sees both errors in a single run instead of fixing one and re-invoking.
 */
async function runSpawnPreflight(
  config: OrchestratorConfig,
  projectId: string,
  options?: SpawnClaimOptions,
): Promise<void> {
  const project = config.projects[projectId];
  if (!project) return;

  const ctx: PreflightContext = {
    project,
    intent: {
      role: "worker",
      willClaimExistingPR: !!options?.claimPr,
    },
  };

  const registry = await getPluginRegistry(config);
  // DefaultPluginsSchema (config.ts) defaults runtime/agent/workspace via
  // .default(), so these are guaranteed strings — no literal fallback needed.
  const runtimeName = project.runtime ?? config.defaults.runtime;
  const agentName = project.agent ?? config.defaults.agent;
  const workspaceName = project.workspace ?? config.defaults.workspace;
  const trackerName = project.tracker?.plugin;
  const scmName = project.scm?.plugin;

  // Only iterate plugins that the spawn will actually exercise. SCM is
  // skipped unless the user passed --claim-pr; otherwise an unconfigured
  // gh auth would block spawns that don't touch PRs.
  const candidates: Array<unknown> = [
    registry.get("runtime", runtimeName),
    registry.get("agent", agentName),
    registry.get("workspace", workspaceName),
    trackerName ? registry.get("tracker", trackerName) : null,
    options?.claimPr && scmName ? registry.get("scm", scmName) : null,
  ];

  const errors: Error[] = [];
  for (const plugin of candidates) {
    const preflight = (plugin as { preflight?: (ctx: PreflightContext) => Promise<void> } | null)
      ?.preflight;
    if (!preflight) continue;
    try {
      await preflight.call(plugin, ctx);
    } catch (err) {
      errors.push(err instanceof Error ? err : new Error(String(err)));
    }
  }

  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new Error(
      `${errors.length} preflight checks failed:\n` +
        errors.map((e, i) => `  ${i + 1}. ${e.message}`).join("\n"),
    );
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
): Promise<void> {
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
        // Terminal plugin not available
      }
    }

    // Output for scripting
    console.log(`SESSION=${session.id}`);
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
        try {
          ({ projectId, issueId } = resolveProjectAndIssue(config, issue));
        } catch (err) {
          console.error(chalk.red(err instanceof Error ? err.message : String(err)));
          process.exit(1);
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
