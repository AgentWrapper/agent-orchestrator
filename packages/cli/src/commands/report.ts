/**
 * `ao acknowledge` and `ao report` — explicit agent reporting commands (Stage 3).
 *
 * These commands are invoked by the worker agent from inside its managed
 * session to declare workflow transitions (started / waiting / needs-input /
 * fixing-ci / addressing-reviews / completed).
 *
 * Both commands resolve the session from:
 *   1. Explicit `--session` / positional argument, OR
 *   2. the `AO_SESSION_ID` environment variable set by every agent plugin.
 *
 * The lifecycle manager prefers fresh reports over weak inference but runtime
 * evidence (process death, merged PR) still overrides — see
 * `packages/core/src/agent-report.ts` for the fallback matrix.
 */

import chalk from "chalk";
import type { Command } from "commander";
import {
  AGENT_REPORTED_STATES,
  applyAgentReport,
  getProjectSessionsDir,
  loadConfig,
  normalizeAgentReportedState,
  type AgentReportedState,
} from "@aoagents/ao-core";
import { getSessionManager } from "../lib/create-session-manager.js";

function resolveSessionId(explicit: string | undefined): string {
  const fromArg = explicit?.trim();
  if (fromArg) return fromArg;
  const fromEnv = process.env["AO_SESSION_ID"]?.trim();
  if (fromEnv) return fromEnv;
  console.error(
    chalk.red(
      "No session provided. Pass a session name or set AO_SESSION_ID (set automatically inside managed sessions).",
    ),
  );
  process.exit(1);
}

async function writeReport(
  sessionName: string,
  state: AgentReportedState,
  note: string | undefined,
  prUrl: string | undefined,
  prNumber: number | undefined,
  source: "acknowledge" | "report",
): Promise<void> {
  const config = loadConfig();
  const sm = await getSessionManager(config);
  const session = await sm.get(sessionName);
  if (!session) {
    console.error(chalk.red(`Session not found: ${sessionName}`));
    process.exit(1);
  }
  const project = config.projects[session.projectId];
  if (!project) {
    console.error(chalk.red(`Project not found for session: ${sessionName}`));
    process.exit(1);
  }
  const sessionsDir = getProjectSessionsDir(session.projectId);
  try {
    const result = applyAgentReport(sessionsDir, sessionName, {
      state,
      note,
      prUrl,
      prNumber,
      source,
      actor: process.env["USER"] ?? process.env["LOGNAME"] ?? process.env["USERNAME"],
    });
    const label =
      result.previousState === result.nextState
        ? chalk.dim(`(${result.nextState})`)
        : chalk.dim(`(${result.previousState} → ${result.nextState})`);
    console.log(
      `${chalk.green("✓")} ${chalk.bold(sessionName)} reported ${chalk.cyan(state)} ${label}`,
    );
    if (prUrl || prNumber !== undefined) {
      const details = [prNumber !== undefined ? `#${prNumber}` : null, prUrl ?? null].filter(
        (value): value is string => Boolean(value),
      );
      console.log(chalk.dim(`  PR: ${details.join(" ")}`));
    }
    if (note) {
      console.log(chalk.dim(`  note: ${note}`));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`Report rejected: ${message}`));
    process.exit(1);
  }
}

export function registerAcknowledge(program: Command): void {
  program
    .command("acknowledge")
    .description(
      "Acknowledge session pickup — agents run this once after reading the initial prompt (Stage 3).",
    )
    .argument("[session]", "Session ID (defaults to AO_SESSION_ID)")
    .option("--note <text>", "Optional brief note to include with the acknowledgment")
    .action(async (session: string | undefined, opts: { note?: string }) => {
      const sessionId = resolveSessionId(session);
      await writeReport(sessionId, "started", opts.note, undefined, undefined, "acknowledge");
    });
}

export function registerReport(program: Command): void {
  const allowed = AGENT_REPORTED_STATES.join(", ");
  program
    .command("report")
    .description(
      `Declare a workflow transition (Stage 3). Allowed states: ${allowed} (hyphenated aliases accepted).`,
    )
    .argument(
      "<state>",
      `One of: ${allowed} (aliases: fixing-ci, addressing-reviews, needs-input, pr-created, ready-for-review, ...)`,
    )
    .option("-s, --session <id>", "Session ID (defaults to AO_SESSION_ID)")
    .option("--note <text>", "Optional brief note to include with the report")
    .option(
      "--pr-url <url>",
      "Attach a PR URL to pr-created / draft-pr-created / ready-for-review reports",
    )
    .option(
      "--pr-number <number>",
      "Attach a PR number to pr-created / draft-pr-created / ready-for-review reports",
    )
    .action(
      async (
        state: string,
        opts: { session?: string; note?: string; prUrl?: string; prNumber?: string },
      ) => {
        const canonical = normalizeAgentReportedState(state);
        if (!canonical) {
          console.error(
            chalk.red(
              `Unknown state: ${state}. Allowed: ${allowed} (or aliases: fixing-ci, addressing-reviews, needs-input, pr-created, ready-for-review).`,
            ),
          );
          process.exit(1);
        }
        const prWorkflowState =
          canonical === "pr_created" ||
          canonical === "draft_pr_created" ||
          canonical === "ready_for_review";
        if (!prWorkflowState && (opts.prUrl || opts.prNumber)) {
          console.error(
            chalk.red(
              "PR metadata flags are only valid with pr-created, draft-pr-created, or ready-for-review.",
            ),
          );
          process.exit(1);
        }
        const prNumber =
          opts.prNumber !== undefined ? Number.parseInt(opts.prNumber, 10) : undefined;
        if (
          opts.prNumber !== undefined &&
          (!Number.isInteger(prNumber) || prNumber === undefined || prNumber <= 0)
        ) {
          console.error(chalk.red(`Invalid PR number: ${opts.prNumber}`));
          process.exit(1);
        }
        const sessionId = resolveSessionId(opts.session);
        await writeReport(sessionId, canonical, opts.note, opts.prUrl, prNumber, "report");
      },
    );
}
