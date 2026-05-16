import { basename, resolve } from "node:path";
import { existsSync } from "node:fs";
import chalk from "chalk";
import type { Command } from "commander";
import {
  getPortfolio,
  getPortfolioSessionCounts,
  isPortfolioEnabled,
  registerProject,
  unregisterProject,
  loadPreferences,
  savePreferences,
  loadLocalProjectConfig,
  loadConfig,
} from "@aoagents/ao-core";
import {
  formatPortfolioDegradedReason,
  formatPortfolioProjectName,
  formatPortfolioProjectStatus,
} from "../lib/portfolio-display.js";

function assertPortfolioEnabled(): void {
  if (isPortfolioEnabled()) return;
  console.error(
    chalk.red(
      "Portfolio mode is disabled. Unset AO_ENABLE_PORTFOLIO or set it to 1 to use `ao project`.",
    ),
  );
  process.exit(1);
}

export function registerProjectCommand(program: Command): void {
  const project = program.command("project").description("Manage portfolio projects");

  // ao project ls
  project
    .command("ls")
    .description("List all portfolio projects")
    .action(async () => {
      assertPortfolioEnabled();
      const portfolio = getPortfolio();

      if (portfolio.length === 0) {
        console.log(chalk.dim("No projects in portfolio."));
        console.log(
          chalk.dim("Run `ao start` in a project or `ao project add <path>` to register one."),
        );
        return;
      }

      const counts = await getPortfolioSessionCounts(portfolio);
      const prefs = loadPreferences();

      console.log(chalk.bold("\nPortfolio Projects\n"));

      for (const p of portfolio) {
        const count = counts[p.id] || { total: 0, active: 0 };
        const isDefault = prefs.defaultProjectId === p.id;
        const status = formatPortfolioProjectStatus(p, count);

        const pin = p.pinned ? chalk.yellow("*") : " ";
        const def = isDefault ? chalk.cyan(" (default)") : "";
        const name = formatPortfolioProjectName(p);
        const degradedReason = formatPortfolioDegradedReason(p);

        console.log(`  ${pin} ${chalk.bold(p.id)}${name}${def}`);
        console.log(`    ${status} | ${count.total} sessions | ${chalk.dim(p.source)}`);
        if (degradedReason) {
          console.log(`    ${degradedReason}`);
        }
      }

      console.log();
    });

  // ao project add <path>
  project
    .command("add <path>")
    .description("Register a project path in the portfolio")
    .option(
      "-k, --key <key>",
      "Legacy only: the project key under `projects:` in a wrapped agent-orchestrator.yaml. Omit for flat configs.",
    )
    .option("--default", "Use the default project ID, adding a numeric suffix if needed")
    .action(async (path: string, opts: { key?: string; default?: boolean }) => {
      assertPortfolioEnabled();
      const resolvedPath = resolve(path);
      const candidatePaths = [
        resolve(resolvedPath, "agent-orchestrator.yaml"),
        resolve(resolvedPath, "agent-orchestrator.yml"),
      ];

      if (!loadLocalProjectConfig(resolvedPath)) {
        const existingConfigPath = candidatePaths.find((candidate) => existsSync(candidate));

        if (!existingConfigPath) {
          console.error(chalk.red(`No agent-orchestrator.yaml found at ${resolvedPath}`));
          process.exit(1);
        }

        try {
          loadConfig(existingConfigPath);
          console.error(
            chalk.red(
              `Found old-format config at ${existingConfigPath}. Run \`ao start\` in that project to migrate it before using \`ao project add\`.`,
            ),
          );
        } catch (error) {
          console.error(
            chalk.red(
              `Found agent-orchestrator config at ${existingConfigPath}, but it could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        }
        process.exit(1);
      }

      let projectId = opts.key;
      if (!projectId) {
        projectId = basename(resolvedPath) || "project";
      }

      const effectiveId = registerProject(resolvedPath, projectId, basename(resolvedPath) || projectId);
      console.log(chalk.green(`Registered project "${effectiveId}" at ${resolvedPath}`));
    });

  // ao project rm <id>
  project
    .command("rm <id>")
    .description("Remove a project from the portfolio")
    .action((id: string) => {
      assertPortfolioEnabled();
      const portfolio = getPortfolio();
      const found = portfolio.find((p) => p.id === id);
      if (!found) {
        console.error(chalk.red(`Project "${id}" not found in portfolio`));
        process.exit(1);
      }

      unregisterProject(id);
      console.log(chalk.green(`Removed project "${id}" from portfolio`));
    });

  // ao project set-default <id>
  project
    .command("set-default <id>")
    .description("Set the default project for the portfolio")
    .action((id: string) => {
      assertPortfolioEnabled();
      const portfolio = getPortfolio();
      const found = portfolio.find((p) => p.id === id);
      if (!found) {
        console.error(chalk.red(`Project "${id}" not found in portfolio`));
        process.exit(1);
      }

      const prefs = loadPreferences();
      prefs.defaultProjectId = id;
      savePreferences(prefs);
      console.log(chalk.green(`Set default project to "${id}"`));
    });
}
