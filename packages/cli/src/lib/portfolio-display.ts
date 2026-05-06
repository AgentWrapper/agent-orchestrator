import chalk from "chalk";
import type { PortfolioProject } from "@aoagents/ao-core";

type PortfolioSessionCount = {
  total: number;
  active: number;
};

export function formatPortfolioProjectStatus(
  project: PortfolioProject,
  count: PortfolioSessionCount,
): string {
  if (project.resolveError) {
    return chalk.red("degraded");
  }

  if (!project.enabled) {
    return chalk.dim("disabled");
  }

  return count.active > 0 ? chalk.green(`${count.active} active`) : chalk.dim("idle");
}

export function formatPortfolioProjectName(project: PortfolioProject): string {
  return project.name !== project.id ? ` ${chalk.dim(`(${project.name})`)}` : "";
}

export function formatPortfolioDegradedReason(project: PortfolioProject): string | null {
  return project.resolveError ? chalk.red(project.resolveError) : null;
}
