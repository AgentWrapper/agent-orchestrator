import type { Command } from "commander";
import chalk from "chalk";
import { migrateStorage, rollbackStorage } from "@aoagents/ao-core";

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
        try {
          if (opts.rollback) {
            await rollbackStorage({
              dryRun: opts.dryRun,
              log: (msg) => console.log(msg),
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
          }
        } catch (err) {
          console.error(
            chalk.red(err instanceof Error ? err.message : String(err)),
          );
          process.exit(1);
        }
      },
    );
}
