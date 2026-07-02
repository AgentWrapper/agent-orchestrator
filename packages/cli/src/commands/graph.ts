/**
 * `ao graph` — Ф2-UI: build/inspect the project's graphify knowledge graph
 * (mae-374/375/379 graph-store) so the Maestro app's Structure view has a
 * CLI surface to trigger builds and locate artifacts, without duplicating
 * the mirror/graphify-update machinery.
 *
 * FAIL-OPEN on build: prints a clear error and a non-zero exit code rather
 * than throwing a stack trace — this is invoked from a GUI action.
 */

import chalk from "chalk";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import { ensureGraphBuilt, getGraphOutDir, loadConfig, type OrchestratorConfig } from "@aoagents/ao-core";
import { findProjectForDirectory } from "../lib/project-resolution.js";

/** Same auto-detect precedence as `ao retrieve`/`ao spawn`. */
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

function resolveProjectId(config: OrchestratorConfig, projectOpt: string | undefined): string {
  try {
    return projectOpt ?? autoDetectProject(config);
  } catch (err) {
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
}

type GraphArtifact = "html" | "json" | "report";

function artifactPath(projectId: string, which: GraphArtifact): string {
  const outDir = getGraphOutDir(projectId);
  switch (which) {
    case "html":
      return join(outDir, "graph.html");
    case "json":
      return join(outDir, "graph.json");
    case "report":
      return join(outDir, "GRAPH_REPORT.md");
  }
}

export function registerGraph(program: Command): void {
  const graph = program.command("graph").description("Build and locate the project's graphify knowledge graph.");

  graph
    .command("build")
    .description("Build (or refresh, if stale) the project graph via graphify.")
    .option("--project <id>", "Project ID (defaults to AO_PROJECT_ID or auto-detect from cwd)")
    .action(async (opts: { project?: string }) => {
      const config = loadConfig();
      const projectId = resolveProjectId(config, opts.project);

      const project = config.projects[projectId];
      if (!project) {
        console.error(chalk.red(`Project not found: ${projectId}`));
        process.exit(1);
      }

      const ok = await ensureGraphBuilt({ projectId, projectRoot: project.path });
      if (!ok) {
        console.error(chalk.red("Graph build failed (see graphify/git output above, if any)."));
        process.exit(1);
      }
      console.log(chalk.green(`Graph built for ${projectId}.`));
      console.log(artifactPath(projectId, "json"));
    });

  graph
    .command("path")
    .description("Print the absolute path of a graph artifact (does not build it).")
    .option("--project <id>", "Project ID (defaults to AO_PROJECT_ID or auto-detect from cwd)")
    .option("--which <artifact>", "Which artifact: html | json | report", "html")
    .action((opts: { project?: string; which: string }) => {
      const which = opts.which as GraphArtifact;
      if (which !== "html" && which !== "json" && which !== "report") {
        console.error(chalk.red(`Invalid --which: ${opts.which} (expected html, json, or report)`));
        process.exit(1);
      }

      const config = loadConfig();
      const projectId = resolveProjectId(config, opts.project);

      const path = artifactPath(projectId, which);
      if (!existsSync(path)) {
        console.error(chalk.dim(`No graph artifact yet at ${path} (run 'ao graph build' first).`));
        process.exit(1);
      }
      console.log(path);
    });
}
