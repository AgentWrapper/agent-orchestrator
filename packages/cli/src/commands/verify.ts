import chalk from "chalk";
import type { Command } from "commander";
import {
  type Tracker,
  type ProjectConfig,
  type OrchestratorConfig,
  type PluginRegistry,
  loadConfig,
} from "@aoagents/ao-core";
import { importPluginModuleFromSource } from "../lib/plugin-store.js";

/**
 * Resolve the target project from config.
 * If --project is given, use that. If there is exactly one project, use it.
 * Otherwise, error out asking the user to specify --project.
 */
function resolveProject(
  config: OrchestratorConfig,
  projectOpt?: string,
): { projectId: string; project: ProjectConfig } {
  if (projectOpt) {
    const project = config.projects[projectOpt];
    if (!project) {
      console.error(chalk.red(`Unknown project: ${projectOpt}`));
      process.exit(1);
    }
    return { projectId: projectOpt, project };
  }

  const ids = Object.keys(config.projects);
  if (ids.length === 0) {
    console.error(chalk.red("No projects configured. Run `ao start` to create one."));
    process.exit(1);
  }
  if (ids.length > 1) {
    console.error(
      chalk.red(`Multiple projects found. Specify one with --project: ${ids.join(", ")}`),
    );
    process.exit(1);
  }

  return { projectId: ids[0], project: config.projects[ids[0]] };
}

/**
 * Get a Tracker instance from the plugin registry for the given project.
 */
async function getTracker(
  config: OrchestratorConfig,
  project: ProjectConfig,
): Promise<{ tracker: Tracker; registry: PluginRegistry }> {
  if (!project.tracker) {
    console.error(chalk.red("No tracker configured for this project."));
    process.exit(1);
  }

  // getSessionManager internally creates the registry; we need the registry
  // directly, so we replicate the same pattern from create-session-manager.
  const { createPluginRegistry } = await import("@aoagents/ao-core");
  const registry = createPluginRegistry();
  await registry.loadFromConfig(config, importPluginModuleFromSource);

  if (!project.tracker.plugin) {
    console.error(chalk.red("Project tracker plugin not configured."));
    process.exit(1);
  }
  const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
  if (!tracker) {
    console.error(chalk.red(`Tracker plugin "${project.tracker.plugin}" not found.`));
    process.exit(1);
  }

  return { tracker, registry };
}

export function registerVerify(program: Command): void {
  program
    .command("verify")
    .description("Mark an issue as verified (or failed) after checking the fix on staging")
    .argument("[issue]", "Issue number or identifier to verify")
    .option("-p, --project <id>", "Project ID (required if multiple projects)")
    .option("--fail", "Mark verification as failed instead of passing")
    .option("-c, --comment <msg>", "Custom comment to add")
    .option("-l, --list", "List all issues with merged-unverified label")
    .action(
      async (
        issue: string | undefined,
        opts: { project?: string; fail?: boolean; comment?: string; list?: boolean },
      ) => {
        let config: OrchestratorConfig;
        try {
          config = loadConfig();
        } catch {
          console.error(chalk.red("No config found. Run `ao start` to create one."));
          process.exit(1);
          return;
        }

        const { projectId, project } = resolveProject(config, opts.project);
        const { tracker } = await getTracker(config, project);

        // --list mode: show all merged-unverified issues
        if (opts.list) {
          if (!tracker.listIssues) {
            console.error(chalk.red("Tracker does not support listing issues."));
            process.exit(1);
          }

          const issues = await tracker.listIssues(
            { state: "open", labels: ["merged-unverified"] },
            project,
          );

          if (issues.length === 0) {
            console.log(chalk.dim("No merged-unverified issues found."));
            return;
          }

          console.log(chalk.bold(`Merged-unverified issues in ${project.name || projectId}:\n`));
          for (const i of issues) {
            const labels = i.labels.length > 0 ? chalk.dim(` [${i.labels.join(", ")}]`) : "";
            console.log(`  ${chalk.cyan(i.id)}  ${i.title}${labels}`);
            if (i.url) {
              console.log(`       ${chalk.dim(i.url)}`);
            }
          }
          console.log(
            chalk.dim(
              `\n  ${issues.length} issue${issues.length !== 1 ? "s" : ""} awaiting verification`,
            ),
          );
          return;
        }

        // Verify/fail mode: requires an issue argument
        if (!issue) {
          console.error(chalk.red("Issue number is required. Usage: ao verify <issue>"));
          process.exit(1);
        }

        if (!tracker.updateIssue) {
          console.error(chalk.red("Tracker does not support updating issues."));
          process.exit(1);
        }

        if (opts.fail) {
          // Verification failed
          const comment = opts.comment ?? "Verification failed — problem persists on staging.";

          await tracker.updateIssue(
            issue,
            {
              state: "open",
              labels: ["verification-failed"],
              removeLabels: ["merged-unverified"],
              comment,
            },
            project,
          );

          console.log(chalk.red(`Issue ${issue} marked as verification-failed (kept open).`));
          console.log(chalk.dim(`  Comment: ${comment}`));
        } else {
          // Verification passed
          const comment = opts.comment ?? "Verified — fix confirmed on staging.";

          await tracker.updateIssue(
            issue,
            {
              state: "closed",
              labels: ["verified"],
              removeLabels: ["merged-unverified"],
              comment,
            },
            project,
          );

          console.log(chalk.green(`Issue ${issue} verified and closed.`));
          console.log(chalk.dim(`  Comment: ${comment}`));
        }
      },
    );
}
