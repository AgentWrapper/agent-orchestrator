import chalk from "chalk";
import type { CIStatus, ReviewDecision, ActivityState } from "@aoagents/ao-core";

export function header(title: string): string {
  const line = "─".repeat(76);
  return [
    chalk.dim(`┌${line}┐`),
    chalk.dim("│") + chalk.bold(` ${title}`.padEnd(76)) + chalk.dim("│"),
    chalk.dim(`└${line}┘`),
  ].join("\n");
}

export function banner(title: string): string {
  const line = "═".repeat(76);
  return [
    chalk.dim(`╔${line}╗`),
    chalk.dim("║") + chalk.bold.cyan(` ${title}`.padEnd(76)) + chalk.dim("║"),
    chalk.dim(`╚${line}╝`),
  ].join("\n");
}

export function formatAge(epochMs: number): string {
  const diff = Math.floor((Date.now() - epochMs) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function statusColor(status: string): string {
  switch (status) {
    case "working":
      return chalk.green(status);
    case "idle":
      return chalk.yellow(status);
    case "pr_open":
    case "review_pending":
      return chalk.blue(status);
    case "approved":
    case "mergeable":
    case "merged":
      return chalk.green(status);
    case "ci_failed":
    case "errored":
    case "stuck":
      return chalk.red(status);
    case "changes_requested":
    case "needs_input":
      return chalk.magenta(status);
    case "spawning":
      return chalk.cyan(status);
    case "killed":
    case "cleanup":
      return chalk.gray(status);
    default:
      return status;
  }
}

export function ciStatusIcon(status: CIStatus | null): string {
  switch (status) {
    case "passing":
      return chalk.green("pass");
    case "failing":
      return chalk.red("fail");
    case "pending":
      return chalk.yellow("pend");
    case "none":
    case null:
      return chalk.dim("-");
  }
}

export function reviewDecisionIcon(decision: ReviewDecision | null): string {
  switch (decision) {
    case "approved":
      return chalk.green("ok");
    case "changes_requested":
      return chalk.red("chg!");
    case "pending":
      return chalk.yellow("rev?");
    case "none":
    case null:
      return chalk.dim("-");
  }
}

export function activityIcon(activity: ActivityState | null): string {
  switch (activity) {
    case "active":
      return chalk.green("working");
    case "ready":
      return chalk.cyan("ready");
    case "idle":
      return chalk.yellow("idle");
    case "waiting_input":
      return chalk.magenta("waiting");
    case "blocked":
      return chalk.red("blocked");
    case "exited":
      return chalk.dim("exited");
    case null:
      return chalk.dim("unknown");
  }
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*m/g;

/** Pad/truncate a string to exactly `width` visible characters */
export function padCol(str: string, width: number): string {
  // Strip ANSI codes to measure visible length
  const visible = str.replace(ANSI_RE, "");
  if (visible.length > width) {
    // Truncate visible content, re-apply truncation
    const plain = visible.slice(0, width - 1) + "\u2026";
    return plain.padEnd(width);
  }
  // Pad with spaces based on visible length
  const padding = width - visible.length;
  return str + " ".repeat(Math.max(0, padding));
}
