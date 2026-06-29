/**
 * `ao skills list [project] [--json]` — enumerate a project's skill-pool
 * library (`<projectRoot>/.maestro/skills/<name>/SKILL.md`).
 *
 * Purely DESCRIPTIVE: it reads the library that `ao spawn --skills` provisions
 * from (Phase 2) and reports it. The orchestrator consults this to pick a
 * relevant, task-scoped subset to pass via `--skills` (Phase 3). Catalog
 * enumeration + frontmatter parsing live in core (`listProjectSkills`,
 * `parseSkillFrontmatter`) and are shared with provisioning — this command only
 * resolves the project and renders.
 *
 * `--json` emits the array `[{ name, description, enabled }]` verbatim (no
 * envelope) — the simple machine-readable contract the orchestrator scans.
 */

import type { Command } from "commander";
import chalk from "chalk";
import {
  loadConfig,
  listProjectSkills,
  type OrchestratorConfig,
  type SkillCatalogEntry,
} from "@aoagents/ao-core";
import { findProjectForDirectory } from "../lib/project-resolution.js";

/**
 * Resolve the project to inspect, mirroring `ao spawn`'s auto-detection:
 *   - explicit `[project]` arg → exact projectId match
 *   - single configured project → that one
 *   - AO_PROJECT_ID env (set for agent sessions) → that one
 *   - cwd inside a project path → that one
 * Throws an actionable error otherwise.
 */
function resolveProject(
  config: OrchestratorConfig,
  projectArg: string | undefined,
): { projectId: string; projectPath: string } {
  const projectIds = Object.keys(config.projects);
  if (projectIds.length === 0) {
    throw new Error("No projects configured. Run 'ao start' first.");
  }

  if (projectArg) {
    const project = config.projects[projectArg];
    if (!project) {
      throw new Error(
        `Unknown project "${projectArg}". Available: ${projectIds.join(", ")}`,
      );
    }
    return { projectId: projectArg, projectPath: project.path };
  }

  if (projectIds.length === 1) {
    return { projectId: projectIds[0], projectPath: config.projects[projectIds[0]].path };
  }

  const envProject = process.env.AO_PROJECT_ID;
  if (envProject && config.projects[envProject]) {
    return { projectId: envProject, projectPath: config.projects[envProject].path };
  }

  const matched = findProjectForDirectory(config.projects, process.cwd());
  if (matched) {
    return { projectId: matched, projectPath: config.projects[matched].path };
  }

  throw new Error(
    `Multiple projects configured. Specify one: ${projectIds.join(", ")}\n` +
      `Or run from within a project directory.`,
  );
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

/** Render the human-readable table: name · enabled · description. */
export function renderSkillsTable(skills: SkillCatalogEntry[]): string {
  if (skills.length === 0) {
    return chalk.dim("(no skills in .maestro/skills/)");
  }

  const nameW = Math.max(...skills.map((s) => s.name.length), "NAME".length);
  const lines: string[] = [
    chalk.dim(`  ${pad("NAME", nameW)}  ${pad("ENABLED", 8)}  DESCRIPTION`),
  ];
  for (const s of skills) {
    const dot = s.enabled ? chalk.green("●") : chalk.dim("○");
    const enabled = s.enabled ? chalk.green(pad("yes", 8)) : chalk.yellow(pad("no", 8));
    lines.push(
      `${dot} ${pad(s.name, nameW)}  ${enabled}  ${chalk.dim(s.description || "—")}`,
    );
  }
  return lines.join("\n");
}

export function registerSkills(program: Command): void {
  const skills = program
    .command("skills")
    .description("Inspect the project's skill-pool library (.maestro/skills/)");

  skills
    .command("list")
    .description(
      "List skills in the project library. Use --json for the machine-readable array.",
    )
    .argument("[project]", "Project id (defaults to the single/auto-detected project)")
    .option("--json", "Output the JSON array [{ name, description, enabled }]")
    .action((projectArg: string | undefined, opts: { json?: boolean }) => {
      const config = loadConfig();
      let projectPath: string;
      try {
        ({ projectPath } = resolveProject(config, projectArg));
      } catch (err) {
        console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }

      const catalog = listProjectSkills(projectPath);
      if (opts.json) {
        console.log(JSON.stringify(catalog, null, 2));
        return;
      }
      console.log(renderSkillsTable(catalog));
    });
}
