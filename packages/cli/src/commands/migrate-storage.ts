import type { Command } from "commander";
import chalk from "chalk";
import { migrateStorage, recordActivityEvent, rollbackStorage } from "@aoagents/ao-core";

export function registerMigrateStorage(program: Command): void {
  program
    .command("migrate-storage")
    .description(
      "Migrate storage from legacy hash-based layout to projects/{projectId}/ layout",
    )
    .option("--dry-run", "Report what would be done without making changes")
    .option("--force", "Migrate even if active tmux sessions are detected")
    .option("--rollback", "Reverse a previous migration (restores .migrated directories)")
    .action(
      async (opts: { dryRun?: boolean; force?: boolean; rollback?: boolean }) => {
        recordActivityEvent({
          source: "cli",
          kind: "cli.migration_invoked",
          level: "info",
          summary: `storage ${opts.rollback ? "rollback" : "migration"} invoked`,
          data: {
            rollback: opts.rollback === true,
            dryRun: opts.dryRun === true,
            force: opts.force === true,
          },
        });

        try {
          if (opts.rollback) {
            await rollbackStorage({
              dryRun: opts.dryRun,
              log: (msg) => console.log(msg),
            });
            recordActivityEvent({
              source: "cli",
              kind: "cli.migration_completed",
              level: "info",
              summary: `storage rollback completed`,
              data: { rollback: true, dryRun: opts.dryRun === true },
            });
          } else {
            const result = await migrateStorage({
              dryRun: opts.dryRun,
              force: opts.force,
              log: (msg) => console.log(msg),
            });

            if (result.projects === 0 && !opts.dryRun) {
              console.log(chalk.green("\nNothing to migrate — already on V2 layout."));
            } else {
              console.log(chalk.green("\nMigration complete."));
            }
            recordActivityEvent({
              source: "cli",
              kind: "cli.migration_completed",
              level: "info",
              summary: `storage migration completed (${result.projects} project(s))`,
              data: {
                rollback: false,
                dryRun: opts.dryRun === true,
                force: opts.force === true,
                projects: result.projects,
              },
            });
          }
        } catch (err) {
          recordActivityEvent({
            source: "cli",
            kind: "cli.migration_failed",
            level: "error",
            summary: `storage migration failed`,
            data: {
              rollback: opts.rollback === true,
              errorMessage: err instanceof Error ? err.message : String(err),
            },
          });
          console.error(
            chalk.red(err instanceof Error ? err.message : String(err)),
          );
          process.exit(1);
        }
      },
    );
}
