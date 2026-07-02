/**
 * `ao retrieve` — Ф3: mid-task retrieval CLI over the maestro-retrieval
 * fusion layer (mae-374/375). Lets a running worker/orchestrator pull a
 * graph+vector context bundle for an ad-hoc query, independent of the
 * spawn-time seeding path (which stays behind `retrieval.fusion`).
 *
 * FAIL-OPEN: prints an empty/degraded bundle rather than throwing — a
 * missing graph or search binary must never break a worker calling this
 * mid-task.
 */

import chalk from "chalk";
import { resolve } from "node:path";
import type { Command } from "commander";
import { assembleContextBundle, loadConfig, type OrchestratorConfig } from "@aoagents/ao-core";
import { findProjectForDirectory } from "../lib/project-resolution.js";

/** Same auto-detect precedence as `ao spawn`: single project → AO_PROJECT_ID → cwd match. */
function autoDetectProject(config: OrchestratorConfig): string {
  const projectIds = Object.keys(config.projects);
  if (projectIds.length === 0) {
    throw new Error("No projects configured. Run 'ao start' first.");
  }
  if (projectIds.length === 1) {
    return projectIds[0];
  }

  const envProject = process.env["AO_PROJECT_ID"];
  if (envProject && config.projects[envProject]) {
    return envProject;
  }

  const cwd = resolve(process.cwd());
  const matched = findProjectForDirectory(config.projects, cwd);
  if (matched) {
    return matched;
  }

  throw new Error(
    `Multiple projects configured. Specify one with --project: ${projectIds.join(", ")}\n` +
      `Or run from within a project directory.`,
  );
}

interface RetrieveOptions {
  budget?: string;
  json?: boolean;
  project?: string;
}

export function registerRetrieve(program: Command): void {
  program
    .command("retrieve")
    .description(
      "Query the graph+vector retrieval fusion bundle for a task (mid-task tool for workers/orchestrator).",
    )
    .argument("<query>", "Task text / question to retrieve context for")
    .option("--budget <tokens>", "Max tokens for the assembled bundle (default: planner default)")
    .option("--json", "Print the bundle accounting as JSON instead of markdown")
    .option("--project <id>", "Project ID (defaults to AO_PROJECT_ID or auto-detect from cwd)")
    .action(async (query: string, opts: RetrieveOptions) => {
      const config = loadConfig();

      let projectId: string;
      try {
        projectId = opts.project ?? autoDetectProject(config);
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      const project = config.projects[projectId];
      if (!project) {
        console.error(chalk.red(`Project not found: ${projectId}`));
        process.exit(1);
      }

      let budget: number | undefined;
      if (opts.budget !== undefined) {
        budget = Number.parseInt(opts.budget, 10);
        if (!Number.isFinite(budget) || budget <= 0) {
          console.error(chalk.red(`Invalid --budget: ${opts.budget}`));
          process.exit(1);
        }
      }

      const bundle = await assembleContextBundle({
        projectId,
        projectRoot: project.path,
        taskText: query,
      });

      if (!bundle) {
        if (opts.json) {
          console.log(JSON.stringify({ markdown: null, json: null }));
        } else {
          console.error(chalk.dim("No retrieval context available for this query."));
        }
        return;
      }

      // --budget is advisory here: assembleContextBundle's internal planner
      // already caps at BUNDLE_MAX. A tighter caller budget just truncates
      // the printed markdown so downstream tools can enforce their own cap
      // without re-implementing the packer.
      let markdown = bundle.markdown;
      if (budget !== undefined && bundle.json.tokensPacked > budget) {
        const approxChars = budget * 4;
        markdown = `${markdown.slice(0, approxChars)}\n...[truncated to ~${budget} tokens]`;
      }

      if (opts.json) {
        console.log(JSON.stringify({ markdown, json: bundle.json }, null, 2));
      } else {
        console.log(markdown);
      }
    });
}
