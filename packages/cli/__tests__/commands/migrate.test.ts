import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoadedConfig, ProjectConfig } from "@aoagents/ao-core";
import {
  runMigrate,
  resolveDataDir,
  resolveDbPath,
  type ProjectRowDeps,
} from "../../src/commands/migrate.js";
import { loadBetterSqlite3 } from "../../src/lib/migrate-db.js";

let sqlite3Available = true;
try {
  loadBetterSqlite3();
} catch {
  sqlite3Available = false;
}

function project(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return { name: "Project", path: "/repos/p", defaultBranch: "main", ...overrides } as ProjectConfig;
}

function loaded(
  projects: Record<string, ProjectConfig>,
  degraded: LoadedConfig["degradedProjects"] = {},
): LoadedConfig {
  return { projects, degradedProjects: degraded } as unknown as LoadedConfig;
}

// Inject all environment lookups so the test needs neither git nor a registry.
const deps: Partial<ProjectRowDeps> = {
  repoOriginUrl: () => "https://example.com/repo.git",
  registeredAt: () => "2026-01-02T03:04:05.000Z",
  configFileMtime: () => null,
};

const NOW = "2026-06-18T00:00:00.000Z";

describe("resolveDataDir", () => {
  const saved = process.env.AO_DATA_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.AO_DATA_DIR;
    else process.env.AO_DATA_DIR = saved;
  });

  it("honors a non-empty AO_DATA_DIR", () => {
    process.env.AO_DATA_DIR = "/custom/dir";
    expect(resolveDataDir()).toBe("/custom/dir");
    expect(resolveDbPath(resolveDataDir())).toBe("/custom/dir/ao.db");
  });
  it("falls back to ~/.ao/data when unset", () => {
    delete process.env.AO_DATA_DIR;
    expect(resolveDataDir().endsWith(join(".ao", "data"))).toBe(true);
  });
});

describe.skipIf(!sqlite3Available)("runMigrate", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "ao-migrate-cmd-"));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  // Unique ids so the orchestrator reader (real ~/.agent-orchestrator) finds none.
  const ids = () => ({
    [`ao-migrate-test-${process.pid}-a`]: project({ path: "/repos/a", name: "A" }),
    [`ao-migrate-test-${process.pid}-b`]: project({ path: "/repos/b", name: "B" }),
  });

  it("dry run computes the plan and writes nothing", async () => {
    const result = await runMigrate({
      dryRun: true,
      config: loaded(ids(), {
        broken: { projectId: "broken", path: "/x", resolveError: "gone" },
      }),
      dataDir,
      deps,
      now: NOW,
    });

    expect(result.dryRun).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.summary.dbCreated).toBe(true);
    expect(result.summary.schemaVersion).toBe(12);
    expect(result.summary.projects).toEqual({ created: 2, skipped: 1, failed: 0 });
    expect(result.summary.orchestrators).toMatchObject({ created: 0, skipped: 0, failed: 0 });
    // No DB written.
    expect(existsSync(resolveDbPath(dataDir))).toBe(false);
  });

  it("creates the DB and inserts projects on a real run", async () => {
    const result = await runMigrate({ config: loaded(ids()), dataDir, deps, now: NOW });

    expect(result.exitCode).toBe(0);
    expect(result.summary.dbCreated).toBe(true);
    expect(result.summary.schemaVersion).toBe(12);
    expect(result.summary.projects).toEqual({ created: 2, skipped: 0, failed: 0 });
    expect(existsSync(resolveDbPath(dataDir))).toBe(true);
  });

  it("counts degraded and invalid-id projects as skipped, never inserted", async () => {
    const result = await runMigrate({
      config: loaded(
        { ...ids(), "bad/id": project({ path: "/repos/bad" }) },
        { broken: { projectId: "broken", path: "/x", resolveError: "gone" } },
      ),
      dataDir,
      deps,
      now: NOW,
    });
    // 2 valid created; degraded + invalid-id => 2 skipped.
    expect(result.summary.projects).toEqual({ created: 2, skipped: 2, failed: 0 });
    expect(result.notes.some((n) => n.id === "broken")).toBe(true);
    expect(result.notes.some((n) => n.id === "bad/id")).toBe(true);
  });

  it("is idempotent: a re-run inserts nothing and counts ON CONFLICT no-ops as skipped", async () => {
    const config = loaded(ids());
    await runMigrate({ config, dataDir, deps, now: NOW });
    const second = await runMigrate({ config, dataDir, deps, now: NOW });

    expect(second.summary.dbCreated).toBe(false);
    expect(second.summary.projects).toEqual({ created: 0, skipped: 2, failed: 0 });
    expect(second.exitCode).toBe(0);
  });

  it("refuses (exit 1) when the DB schema is older than vendored", async () => {
    // First create the DB, then strip versions to simulate an older schema.
    await runMigrate({ config: loaded(ids()), dataDir, deps, now: NOW });
    const Database = loadBetterSqlite3();
    const db = new Database(resolveDbPath(dataDir));
    db.prepare("DELETE FROM goose_db_version WHERE version_id >= 12").run();
    db.close();

    const result = await runMigrate({ config: loaded(ids()), dataDir, deps, now: NOW });
    expect(result.exitCode).toBe(1);
    expect(result.refusal?.code).toBe("SCHEMA_TOO_OLD");
  });
});
