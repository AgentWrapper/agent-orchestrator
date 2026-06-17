import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import chalk from "chalk";
import {
  getGlobalConfigPath,
  loadConfig,
  loadRegistered,
  recordActivityEvent,
  type LoadedConfig,
  type ProjectConfig,
} from "@aoagents/ao-core";
import {
  buildProjectRow,
  isValidRewriteProjectId,
  type ProjectRowDeps,
} from "../lib/migrate.js";
import {
  insertMigration,
  openMigrationDb,
  MigrateRefusal,
  VENDORED_SCHEMA_VERSION,
  type ProjectRow,
  type SessionRow,
} from "../lib/migrate-db.js";
import { readOrchestratorMapping } from "../lib/migrate-orchestrator.js";
import {
  planTranscriptCopy,
  relocateTranscript,
  type TranscriptCopyPlan,
} from "../lib/migrate-claude.js";

// ---------------------------------------------------------------------------
// Data dir resolution (§4 — must match the rewrite's resolveDataDir exactly)
// ---------------------------------------------------------------------------

export function resolveDataDir(): string {
  const fromEnv = process.env.AO_DATA_DIR;
  if (fromEnv && fromEnv.trim() !== "") return fromEnv;
  return join(homedir(), ".ao", "data");
}

export function resolveDbPath(dataDir: string): string {
  return join(dataDir, "ao.db");
}

// ---------------------------------------------------------------------------
// The output contract (§3, LOCKED)
// ---------------------------------------------------------------------------

export interface MigrateSummary {
  dbCreated: boolean;
  schemaVersion: number;
  projects: { created: number; skipped: number; failed: number };
  orchestrators: { created: number; skipped: number; failed: number; relocatedTranscripts: number };
}

/** A note surfaced in the human summary (never in --json). */
interface PlanNote {
  scope: "project" | "orchestrator";
  id: string;
  note: string;
}

interface MigrationPlan {
  projectRows: ProjectRow[];
  orchestratorRows: SessionRow[];
  transcripts: TranscriptCopyPlan[];
  /** Items deliberately not inserted (degraded / invalid id / terminal / non-migratable). */
  projectSkips: number;
  orchestratorSkips: number;
  notes: PlanNote[];
}

// ---------------------------------------------------------------------------
// Environment deps (injectable for tests)
// ---------------------------------------------------------------------------

function defaultRepoOriginUrl(path: string): string {
  try {
    return execFileSync("git", ["-C", path, "remote", "get-url", "origin"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function defaultConfigFileMtime(path: string): string | null {
  for (const name of ["agent-orchestrator.yaml", "agent-orchestrator.yml"]) {
    try {
      return statSync(join(path, name)).mtime.toISOString();
    } catch {
      /* try next */
    }
  }
  return null;
}

function makeRegisteredAtLookup(): (id: string, path: string) => string | null {
  let entries: ReturnType<typeof loadRegistered>["projects"] = [];
  try {
    entries = loadRegistered().projects;
  } catch {
    entries = [];
  }
  return (id, path) => {
    const match = entries.find(
      (e) => e.configProjectKey === id || join(e.path) === join(path),
    );
    return match?.addedAt ?? null;
  };
}

function makeProjectRowDeps(now: string, overrides?: Partial<ProjectRowDeps>): ProjectRowDeps {
  return {
    repoOriginUrl: overrides?.repoOriginUrl ?? defaultRepoOriginUrl,
    registeredAt: overrides?.registeredAt ?? makeRegisteredAtLookup(),
    configFileMtime: overrides?.configFileMtime ?? defaultConfigFileMtime,
    now,
  };
}

// ---------------------------------------------------------------------------
// Plan building
// ---------------------------------------------------------------------------

async function buildMigrationPlan(
  config: LoadedConfig,
  dataDir: string,
  deps: ProjectRowDeps,
): Promise<MigrationPlan> {
  const projectRows: ProjectRow[] = [];
  const orchestratorRows: SessionRow[] = [];
  const transcripts: TranscriptCopyPlan[] = [];
  const notes: PlanNote[] = [];
  let projectSkips = 0;
  let orchestratorSkips = 0;

  // Degraded projects: local config could not be resolved — never inserted (§6).
  for (const [id, entry] of Object.entries(config.degradedProjects)) {
    projectSkips++;
    notes.push({
      scope: "project",
      id,
      note: `local config could not be resolved: ${entry.resolveError}`,
    });
  }

  for (const [id, pc] of Object.entries(config.projects as Record<string, ProjectConfig>)) {
    if (!isValidRewriteProjectId(id)) {
      projectSkips++;
      notes.push({
        scope: "project",
        id,
        note: "project id fails rewrite validation — rename before migrating (orchestrator skipped too)",
      });
      continue;
    }

    const { row, notes: projectNotes } = buildProjectRow(id, pc, deps);
    projectRows.push(row);
    for (const note of projectNotes) notes.push({ scope: "project", id, note });

    const mapping = readOrchestratorMapping(id, pc);
    if (mapping.status === "mapped" && mapping.row) {
      orchestratorRows.push(mapping.row);
      if (mapping.transcript) {
        transcripts.push(
          await planTranscriptCopy({
            dataDir,
            projectId: id,
            prefix: mapping.prefix,
            worktree: mapping.transcript.worktree,
            uuid: mapping.transcript.uuid,
          }),
        );
      }
    } else if (mapping.status === "skipped") {
      orchestratorSkips++;
      notes.push({ scope: "orchestrator", id, note: mapping.note ?? "skipped" });
    }
    // "absent" -> the project has no orchestrator to migrate; nothing to count.
  }

  return { projectRows, orchestratorRows, transcripts, projectSkips, orchestratorSkips, notes };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface RunMigrateOptions {
  dryRun?: boolean;
  /** Test override for the source config. */
  config?: LoadedConfig;
  /** Test override for the data dir (else resolveDataDir). */
  dataDir?: string;
  /** Test override for environment deps. */
  deps?: Partial<ProjectRowDeps>;
  /** Test override for the "now" timestamp. */
  now?: string;
}

export interface RunMigrateResult {
  summary: MigrateSummary;
  exitCode: number;
  dryRun: boolean;
  refusal?: MigrateRefusal;
  notes: PlanNote[];
}

/**
 * Run the migration. Pure-ish: all I/O goes through injectable deps so the flow
 * is testable. Never calls process.exit — returns the exit code for the caller.
 */
export async function runMigrate(opts: RunMigrateOptions = {}): Promise<RunMigrateResult> {
  const dryRun = opts.dryRun === true;
  const dataDir = opts.dataDir ?? resolveDataDir();
  const dbPath = resolveDbPath(dataDir);
  const now = opts.now ?? new Date().toISOString();

  const config = opts.config ?? loadConfig(getGlobalConfigPath());
  const deps = makeProjectRowDeps(now, opts.deps);
  const plan = await buildMigrationPlan(config, dataDir, deps);

  if (dryRun) {
    // Preview only: no DB open-for-write, no file copies.
    const wouldCopy = plan.transcripts.filter(
      (t) => !existsSync(t.destPath) && existsSync(t.sourcePath),
    ).length;
    const summary: MigrateSummary = {
      dbCreated: !existsSync(dbPath),
      schemaVersion: readSchemaVersionForPreview(dbPath),
      projects: { created: plan.projectRows.length, skipped: plan.projectSkips, failed: 0 },
      orchestrators: {
        created: plan.orchestratorRows.length,
        skipped: plan.orchestratorSkips,
        failed: 0,
        relocatedTranscripts: wouldCopy,
      },
    };
    return { summary, exitCode: 0, dryRun: true, notes: plan.notes };
  }

  // Preconditions + create-if-missing open (§10). A refusal aborts non-zero.
  let opened: ReturnType<typeof openMigrationDb>;
  try {
    opened = openMigrationDb(dbPath);
  } catch (err) {
    if (err instanceof MigrateRefusal) {
      const summary: MigrateSummary = {
        dbCreated: false,
        schemaVersion: 0,
        projects: { created: 0, skipped: plan.projectSkips, failed: 0 },
        orchestrators: {
          created: 0,
          skipped: plan.orchestratorSkips,
          failed: 0,
          relocatedTranscripts: 0,
        },
      };
      return { summary, exitCode: 1, dryRun: false, refusal: err, notes: plan.notes };
    }
    throw err;
  }

  let relocated = 0;
  try {
    // Transcript relocation is independent of the DB write (§6 step 6).
    for (const transcript of plan.transcripts) {
      if (relocateTranscript(transcript) === "copied") relocated++;
    }

    const inserted = insertMigration(opened.db, plan.projectRows, plan.orchestratorRows);

    const summary: MigrateSummary = {
      dbCreated: opened.dbCreated,
      schemaVersion: opened.schemaVersion,
      projects: {
        created: inserted.projects.created,
        skipped: inserted.projects.skipped + plan.projectSkips,
        failed: inserted.projects.failed,
      },
      orchestrators: {
        created: inserted.orchestrators.created,
        skipped: inserted.orchestrators.skipped + plan.orchestratorSkips,
        failed: inserted.orchestrators.failed,
        relocatedTranscripts: relocated,
      },
    };
    const exitCode = summary.projects.failed + summary.orchestrators.failed > 0 ? 1 : 0;
    return { summary, exitCode, dryRun: false, notes: plan.notes };
  } finally {
    opened.db.close();
  }
}

/** Best-effort read-only schema version for the dry-run preview (no write). */
function readSchemaVersionForPreview(dbPath: string): number {
  if (!existsSync(dbPath)) return VENDORED_SCHEMA_VERSION;
  try {
    const opened = openMigrationDb(dbPath);
    try {
      return opened.schemaVersion;
    } finally {
      opened.db.close();
    }
  } catch {
    // Locked / too old / unavailable — report what we'd require; the real run refuses.
    return VENDORED_SCHEMA_VERSION;
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printHumanSummary(result: RunMigrateResult): void {
  const { summary, dryRun, refusal, notes } = result;
  if (refusal) {
    console.error(chalk.red(`Migration refused (${refusal.code}): ${refusal.message}`));
    return;
  }

  const header = dryRun ? "Migration plan (dry run — nothing written):" : "Migration complete.";
  console.log(chalk.bold(header));
  console.log(
    `  DB ${summary.dbCreated ? "created at" : "already at"} schema v${summary.schemaVersion}`,
  );
  console.log(
    `  Projects:      ${summary.projects.created} ${dryRun ? "to create" : "created"}, ${summary.projects.skipped} skipped, ${summary.projects.failed} failed`,
  );
  console.log(
    `  Orchestrators: ${summary.orchestrators.created} ${dryRun ? "to create" : "created"}, ${summary.orchestrators.skipped} skipped, ${summary.orchestrators.failed} failed`,
  );
  console.log(
    `  Transcripts:   ${summary.orchestrators.relocatedTranscripts} ${dryRun ? "to relocate" : "relocated"}`,
  );
  if (notes.length > 0) {
    console.log(chalk.dim("\nNotes:"));
    for (const note of notes) {
      console.log(chalk.dim(`  - [${note.scope}] ${note.id}: ${note.note}`));
    }
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerMigrate(program: Command): void {
  program
    .command("migrate")
    .description(
      "Migrate the legacy project registry + orchestrator sessions into the rewrite's SQLite DB (run with the rewrite daemon stopped)",
    )
    .option("--dry-run", "Compute and print the plan without writing anything")
    .option("--json", "Emit the machine-readable summary instead of the human summary")
    .action(async (opts: { dryRun?: boolean; json?: boolean }) => {
      recordActivityEvent({
        source: "cli",
        kind: "cli.migration_invoked",
        level: "info",
        summary: "ao migrate invoked",
        data: { dryRun: opts.dryRun === true, json: opts.json === true },
      });

      try {
        const result = await runMigrate({ dryRun: opts.dryRun });

        if (opts.json) {
          console.log(JSON.stringify(result.summary));
          if (result.refusal) console.error(chalk.red(result.refusal.message));
        } else {
          printHumanSummary(result);
        }

        recordActivityEvent({
          source: "cli",
          kind: result.refusal ? "cli.migration_failed" : "cli.migration_completed",
          level: result.refusal ? "error" : "info",
          summary: result.refusal
            ? `ao migrate refused (${result.refusal.code})`
            : "ao migrate completed",
          data: {
            dryRun: result.dryRun,
            dbCreated: result.summary.dbCreated,
            schemaVersion: result.summary.schemaVersion,
            projects: result.summary.projects,
            orchestrators: result.summary.orchestrators,
          },
        });

        if (result.exitCode !== 0) process.exit(result.exitCode);
      } catch (err) {
        recordActivityEvent({
          source: "cli",
          kind: "cli.migration_failed",
          level: "error",
          summary: "ao migrate failed",
          data: { errorMessage: err instanceof Error ? err.message : String(err) },
        });
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });
}
