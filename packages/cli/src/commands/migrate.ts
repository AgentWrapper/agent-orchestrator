import type { Command } from "commander";
import chalk from "chalk";
import { recordActivityEvent } from "@aoagents/ao-core";
import {
  DaemonUnreachableError,
  resolveDaemonUrl,
  runMigrate,
  type MigrateProjectResult,
  type MigrateSummary,
} from "../lib/migrate.js";

/**
 * `ao migrate` — port the legacy project registry + per-project settings into
 * the rewrite (Go/Electron) daemon. Projects + settings only; sessions are not
 * migrated (yet). See lib/migrate.ts for the cross-repo contract and mapping.
 */
export function registerMigrate(program: Command): void {
  program
    .command("migrate")
    .description("Port legacy projects and their settings into the new AO (rewrite) daemon")
    .option("--dry-run", "Parse and map the legacy registry, print the plan, write nothing")
    .option(
      "--daemon-url <url>",
      "New AO daemon base URL (default http://127.0.0.1:3001; env AO_DAEMON_URL / AO_PORT)",
    )
    .action(async (opts: { dryRun?: boolean; daemonUrl?: string }) => {
      const dryRun = opts.dryRun === true;
      const daemonUrl = resolveDaemonUrl(opts.daemonUrl);

      recordActivityEvent({
        source: "cli",
        kind: "cli.migrate_invoked",
        level: "info",
        summary: `ao migrate invoked${dryRun ? " (dry-run)" : ""}`,
        data: { dryRun, daemonUrl },
      });

      let summary: MigrateSummary;
      try {
        summary = await runMigrate({ dryRun, daemonUrl });
      } catch (error) {
        if (error instanceof DaemonUnreachableError) {
          recordActivityEvent({
            source: "cli",
            kind: "cli.migrate_failed",
            level: "error",
            summary: "ao migrate failed: daemon unreachable",
            data: { daemonUrl, reason: "daemon_unreachable" },
          });
          console.error(chalk.red(`\nCould not reach the new AO daemon at ${daemonUrl}.`));
          console.error(
            chalk.dim(
              "Start the new AO (the rewrite) first so its daemon is listening, then run `ao migrate`.\n" +
                "Override the address with --daemon-url or the AO_DAEMON_URL / AO_PORT env vars.",
            ),
          );
          process.exit(1);
        }
        recordActivityEvent({
          source: "cli",
          kind: "cli.migrate_failed",
          level: "error",
          summary: "ao migrate failed",
          data: { daemonUrl, errorMessage: error instanceof Error ? error.message : String(error) },
        });
        console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }

      printSummary(summary);

      const hadError = summary.results.some((r) => r.outcome === "error");
      recordActivityEvent({
        source: "cli",
        kind: hadError ? "cli.migrate_failed" : "cli.migrate_completed",
        level: hadError ? "error" : "info",
        summary: `ao migrate ${dryRun ? "dry-run " : ""}finished`,
        data: { daemonUrl, dryRun, counts: countByOutcome(summary.results) },
      });

      if (hadError) process.exit(1);
    });
}

function countByOutcome(results: MigrateProjectResult[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of results) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
  return counts;
}

function printSummary(summary: MigrateSummary): void {
  const { results, dryRun, daemonUrl } = summary;

  if (results.length === 0) {
    console.log(chalk.dim("No registered projects found in the legacy config. Nothing to migrate."));
    return;
  }

  console.log(
    dryRun
      ? chalk.cyan(`\nPlan (dry-run) — target: ${daemonUrl}\n`)
      : chalk.cyan(`\nMigration — target: ${daemonUrl}\n`),
  );

  for (const r of results) {
    console.log(`${outcomeBadge(r)} ${chalk.bold(r.id)} ${chalk.dim(r.path)}`);
    if (r.configApplied) console.log(chalk.dim(`    settings: ${dryRun ? "to apply" : "applied"}`));
    if (r.error) console.log(chalk.red(`    error: ${r.error}`));
    for (const note of r.notes) console.log(chalk.yellow(`    note: ${note}`));
  }

  const counts = countByOutcome(results);
  const parts: string[] = [];
  if (counts["created"]) parts.push(`${counts["created"]} created`);
  if (counts["planned"]) parts.push(`${counts["planned"]} planned`);
  if (counts["skipped-conflict"]) parts.push(`${counts["skipped-conflict"]} already present`);
  if (counts["skipped-degraded"]) parts.push(`${counts["skipped-degraded"]} unresolved`);
  if (counts["skipped-invalid-id"]) parts.push(`${counts["skipped-invalid-id"]} invalid id`);
  if (counts["error"]) parts.push(chalk.red(`${counts["error"]} failed`));

  console.log(`\n${parts.join(", ") || "nothing to do"}.`);
  if (dryRun) {
    console.log(chalk.dim("Re-run without --dry-run to apply."));
  }
}

function outcomeBadge(r: MigrateProjectResult): string {
  switch (r.outcome) {
    case "created":
      return chalk.green("✓");
    case "planned":
      return chalk.cyan("•");
    case "skipped-conflict":
      return chalk.dim("=");
    case "skipped-degraded":
    case "skipped-invalid-id":
      return chalk.yellow("⊘");
    case "error":
      return chalk.red("✗");
  }
}
