import chalk from "chalk";
import type { Command } from "commander";
import {
  createShellCodeReviewRunner,
  createCodeReviewStore,
  executeCodeReviewRun,
  loadConfig,
  sendCodeReviewFindingsToAgent,
  SessionNotFoundError,
  triggerCodeReviewForSession,
  type CodeReviewRunStatus,
  type CodeReviewRunSummary,
} from "@aoagents/ao-core";
import { getSessionManager } from "../lib/create-session-manager.js";

const RUN_STATUSES: ReadonlySet<CodeReviewRunStatus> = new Set([
  "queued",
  "preparing",
  "running",
  "needs_triage",
  "sent_to_agent",
  "waiting_update",
  "clean",
  "outdated",
  "failed",
  "cancelled",
]);

function parseRunStatus(value: string | undefined): CodeReviewRunStatus | undefined {
  if (!value) return undefined;
  if (RUN_STATUSES.has(value as CodeReviewRunStatus)) {
    return value as CodeReviewRunStatus;
  }
  throw new Error(`Unknown review status: ${value}`);
}

function printRun(run: CodeReviewRunSummary): void {
  const findings =
    run.openFindingCount === 1 ? "1 open finding" : `${run.openFindingCount} open findings`;
  const parts = [
    chalk.green(run.reviewerSessionId),
    chalk.dim(run.id),
    run.status,
    chalk.cyan(run.linkedSessionId),
    findings,
  ];

  if (run.prNumber) {
    parts.push(chalk.blue(`PR #${run.prNumber}`));
  }

  console.log(parts.join("  "));
}

function printSendResult(run: CodeReviewRunSummary, sentFindingCount: number): void {
  const findings = sentFindingCount === 1 ? "1 finding" : `${sentFindingCount} findings`;
  console.log(chalk.green(`Sent ${findings} to ${chalk.cyan(run.linkedSessionId)}:`));
  printRun(run);
}

function getRunProjectId(
  projectIds: string[],
  runId: string,
): { projectId: string; run: CodeReviewRunSummary } | null {
  for (const projectId of projectIds) {
    const run = createCodeReviewStore(projectId)
      .listRunSummaries()
      .find((entry) => entry.id === runId || entry.reviewerSessionId === runId);
    if (run) return { projectId, run };
  }
  return null;
}

function getNextQueuedRun(
  projectIds: string[],
): { projectId: string; run: CodeReviewRunSummary } | null {
  return (
    projectIds
      .flatMap((projectId) =>
        createCodeReviewStore(projectId)
          .listRunSummaries({ status: "queued" })
          .map((run) => ({ projectId, run })),
      )
      .sort(
        (a, b) =>
          a.run.createdAt.localeCompare(b.run.createdAt) ||
          a.projectId.localeCompare(b.projectId) ||
          a.run.id.localeCompare(b.run.id),
      )[0] ?? null
  );
}

export function registerReview(program: Command): void {
  const review = program.command("review").description("Manage AO-local reviewer runs");

  review
    .command("run")
    .description("Request a reviewer run for a worker session")
    .argument("<session>", "Worker session ID")
    .option("--summary <text>", "Summary to store on the review run")
    .option("--status <status>", "Initial run status (defaults to queued)")
    .option("--execute", "Execute the review run immediately")
    .option("--command <command>", "Shell command to execute as the reviewer")
    .option("--json", "Output as JSON")
    .action(
      async (
        sessionId: string,
        opts: {
          summary?: string;
          status?: string;
          execute?: boolean;
          command?: string;
          json?: boolean;
        },
      ) => {
        try {
          const config = loadConfig();
          const sessionManager = await getSessionManager(config);
          let run = await triggerCodeReviewForSession(
            { config, sessionManager },
            {
              sessionId,
              requestedBy: "cli",
              status: parseRunStatus(opts.status),
              summary: opts.summary,
            },
          );

          if (opts.execute || opts.command) {
            run = await executeCodeReviewRun(
              {
                config,
                sessionManager,
                ...(opts.command ? { runReviewer: createShellCodeReviewRunner(opts.command) } : {}),
              },
              { projectId: run.projectId, runId: run.id },
            );
          }

          if (opts.json) {
            console.log(JSON.stringify({ run }, null, 2));
            return;
          }

          console.log(
            chalk.green(
              opts.execute || opts.command ? "Review run executed:" : "Review run requested:",
            ),
          );
          printRun(run);
        } catch (error) {
          if (error instanceof SessionNotFoundError) {
            console.error(chalk.red(error.message));
            process.exit(1);
          }
          console.error(chalk.red(error instanceof Error ? error.message : String(error)));
          process.exit(1);
        }
      },
    );

  review
    .command("execute")
    .description("Execute a queued AO-local reviewer run")
    .argument("[project]", "Project ID (searches all projects if omitted)")
    .option("--run <run>", "Review run ID or reviewer session ID")
    .option("--command <command>", "Shell command to execute as the reviewer")
    .option("--force", "Execute even if the run is not queued")
    .option("--json", "Output as JSON")
    .action(
      async (
        projectId: string | undefined,
        opts: { run?: string; command?: string; force?: boolean; json?: boolean },
      ) => {
        try {
          const config = loadConfig();
          if (projectId && !config.projects[projectId]) {
            throw new Error(`Unknown project: ${projectId}`);
          }

          const projectIds = projectId ? [projectId] : Object.keys(config.projects);
          const target = opts.run
            ? getRunProjectId(projectIds, opts.run)
            : getNextQueuedRun(projectIds);
          if (!target) {
            throw new Error(
              opts.run ? `Review run not found: ${opts.run}` : "No queued review runs found.",
            );
          }

          const sessionManager = await getSessionManager(config);
          const run = await executeCodeReviewRun(
            {
              config,
              sessionManager,
              force: opts.force,
              ...(opts.command ? { runReviewer: createShellCodeReviewRunner(opts.command) } : {}),
            },
            { projectId: target.projectId, runId: target.run.id },
          );

          if (opts.json) {
            console.log(JSON.stringify({ run }, null, 2));
            return;
          }

          console.log(chalk.green("Review run executed:"));
          printRun(run);
        } catch (error) {
          if (error instanceof SessionNotFoundError) {
            console.error(chalk.red(error.message));
            process.exit(1);
          }
          console.error(chalk.red(error instanceof Error ? error.message : String(error)));
          process.exit(1);
        }
      },
    );

  review
    .command("send")
    .description("Send open AO-local review findings to the linked coding worker")
    .argument("<run>", "Review run ID or reviewer session ID")
    .option("-p, --project <project>", "Project ID (searches all projects if omitted)")
    .option("--json", "Output as JSON")
    .action(async (runRef: string, opts: { project?: string; json?: boolean }) => {
      try {
        const config = loadConfig();
        if (opts.project && !config.projects[opts.project]) {
          throw new Error(`Unknown project: ${opts.project}`);
        }

        const projectIds = opts.project ? [opts.project] : Object.keys(config.projects);
        const target = getRunProjectId(projectIds, runRef);
        if (!target) {
          throw new Error(`Review run not found: ${runRef}`);
        }

        const sessionManager = await getSessionManager(config);
        const result = await sendCodeReviewFindingsToAgent(
          { config, sessionManager },
          { projectId: target.projectId, runId: target.run.id },
        );

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        printSendResult(result.run, result.sentFindingCount);
      } catch (error) {
        if (error instanceof SessionNotFoundError) {
          console.error(chalk.red(error.message));
          process.exit(1);
        }
        console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });

  review
    .command("list")
    .description("List AO-local reviewer runs")
    .argument("[project]", "Project ID (lists all projects if omitted)")
    .option("--json", "Output as JSON")
    .action(async (projectId: string | undefined, opts: { json?: boolean }) => {
      try {
        const config = loadConfig();
        if (projectId && !config.projects[projectId]) {
          throw new Error(`Unknown project: ${projectId}`);
        }

        const projectIds = projectId ? [projectId] : Object.keys(config.projects);
        const runs = projectIds.flatMap((id) => createCodeReviewStore(id).listRunSummaries());

        if (opts.json) {
          console.log(JSON.stringify({ runs }, null, 2));
          return;
        }

        if (runs.length === 0) {
          console.log(chalk.dim("No review runs found."));
          return;
        }

        for (const run of runs) {
          printRun(run);
        }
      } catch (error) {
        console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });
}
