import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { migrateStorage } from "../migration/storage-v2.js";
import { recordActivityEvent } from "../activity-events.js";

vi.mock("../activity-events.js", () => ({
  recordActivityEvent: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    execSync: vi.fn(),
  };
});

function createTempDir(): string {
  const dir = join(
    tmpdir(),
    `ao-migration-events-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("activity events: storage migration", () => {
  let testDir: string;
  let aoBaseDir: string;
  let configPath: string;

  beforeEach(() => {
    testDir = createTempDir();
    aoBaseDir = join(testDir, ".agent-orchestrator");
    configPath = join(aoBaseDir, "config.yaml");
    mkdirSync(aoBaseDir, { recursive: true });
    vi.mocked(recordActivityEvent).mockClear();
    vi.mocked(execSync).mockReturnValue("");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("emits migration.completed when there is nothing to migrate", async () => {
    const result = await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: () => {},
    });

    expect(result.projects).toBe(0);
    const calls = vi.mocked(recordActivityEvent).mock.calls.map((c) => c[0]);
    const completed = calls.find((c) => c.kind === "migration.completed");
    expect(completed).toBeDefined();
    expect(completed?.source).toBe("migration");
    expect(completed?.level).toBe("info");
    expect(completed?.data).toMatchObject({
      projectsMigrated: 0,
      sessions: 0,
      worktrees: 0,
      projectErrors: 0,
    });
  });

  it("emits migration.completed with totals when migration succeeds", async () => {
    const hashDir = join(aoBaseDir, "aaaaaa000000-myproject");
    mkdirSync(join(hashDir, "sessions"), { recursive: true });
    mkdirSync(join(hashDir, "worktrees", "ao-1"), { recursive: true });
    writeFileSync(
      join(hashDir, "sessions", "ao-1"),
      [
        "project=myproject",
        "agent=claude-code",
        "status=working",
        "createdAt=2026-04-21T12:00:00.000Z",
        "branch=session/ao-1",
        `worktree=${join(hashDir, "worktrees", "ao-1")}`,
      ].join("\n"),
    );
    writeFileSync(
      configPath,
      [
        "projects:",
        "  myproject:",
        "    path: /home/user/myproject",
        "    storageKey: aaaaaa000000",
        "    defaultBranch: main",
        "",
      ].join("\n"),
    );

    await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: () => {},
    });

    const calls = vi.mocked(recordActivityEvent).mock.calls.map((c) => c[0]);
    const completed = calls.find((c) => c.kind === "migration.completed");
    expect(completed).toBeDefined();
    const data = (completed?.data ?? {}) as Record<string, unknown>;
    expect(data["projectsMigrated"]).toBe(1);
    expect(data["projectErrors"]).toBe(0);
  });

  it("emits migration.project_failed plus migration.completed when a project fails", async () => {
    // Force migrateProject to throw by pre-creating projects/badproj as a FILE
    // — mkdirSync with recursive:true tolerates existing directories but NOT existing
    // files at the same path, so it throws EEXIST when migrateProject tries to create
    // projects/badproj/sessions.
    const badDir = join(aoBaseDir, "bbbbbb000000-badproj");
    mkdirSync(join(badDir, "sessions"), { recursive: true });
    writeFileSync(
      join(badDir, "sessions", "ao-99"),
      [
        "project=badproj",
        "agent=claude-code",
        "createdAt=2026-04-21T12:00:00.000Z",
        "branch=session/ao-99",
        `worktree=${join(badDir, "worktrees", "ao-99")}`,
      ].join("\n"),
    );

    // Pre-create projects/badproj as a regular file so mkdirSync inside migrateProject
    // raises ENOTDIR / EEXIST when it tries to create a subdirectory under it.
    mkdirSync(join(aoBaseDir, "projects"), { recursive: true });
    writeFileSync(join(aoBaseDir, "projects", "badproj"), "blocker");

    writeFileSync(
      configPath,
      [
        "projects:",
        "  badproj:",
        "    path: /home/user/badproj",
        "    storageKey: bbbbbb000000",
        "    defaultBranch: main",
        "",
      ].join("\n"),
    );

    await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: () => {},
    });

    const calls = vi.mocked(recordActivityEvent).mock.calls.map((c) => c[0]);
    const projectFailed = calls.filter((c) => c.kind === "migration.project_failed");
    const completed = calls.find((c) => c.kind === "migration.completed");

    expect(projectFailed.length).toBeGreaterThanOrEqual(1);
    expect(projectFailed[0]?.projectId).toBe("badproj");
    expect(completed).toBeDefined();
    const completedData = (completed?.data ?? {}) as Record<string, unknown>;
    expect(completedData["projectErrors"]).toBeGreaterThanOrEqual(1);
  });

  it("emits migration.blocked when active sessions are detected", async () => {
    vi.mocked(execSync).mockReturnValue("ao-1\nabcdef012345-worker-7\nunrelated\n");

    writeFileSync(
      configPath,
      "projects:\n  myproject:\n    path: /tmp/x\n    storageKey: aaaaaa000000\n    defaultBranch: main\n",
    );

    await expect(migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      log: () => {},
    })).rejects.toThrow(/Found 2 active AO tmux session/);

    const calls = vi.mocked(recordActivityEvent).mock.calls.map((c) => c[0]);
    const blocked = calls.find((c) => c.kind === "migration.blocked");
    expect(blocked).toBeDefined();
    expect(blocked?.source).toBe("migration");
    expect(blocked?.level).toBe("warn");
    expect(blocked?.summary).toBe("migration blocked by 2 active session(s)");
    expect(blocked?.data).toMatchObject({
      activeSessionCount: 2,
      sample: ["ao-1", "abcdef012345-worker-7"],
    });
  });

  it("does not emit migration.blocked when force skips active-session detection", async () => {
    vi.mocked(execSync).mockReturnValue("ao-1\n");

    const hashDir = join(aoBaseDir, "aaaaaa000000-myproject");
    mkdirSync(join(hashDir, "sessions"), { recursive: true });
    writeFileSync(
      join(hashDir, "sessions", "ao-1"),
      [
        "project=myproject",
        "agent=claude-code",
        "createdAt=2026-04-21T12:00:00.000Z",
        "branch=session/ao-1",
        `worktree=${join(hashDir, "worktrees", "ao-1")}`,
      ].join("\n"),
    );
    mkdirSync(join(hashDir, "worktrees", "ao-1"), { recursive: true });
    writeFileSync(
      configPath,
      "projects:\n  myproject:\n    path: /tmp/x\n    storageKey: aaaaaa000000\n    defaultBranch: main\n",
    );

    // force: true skips the active-session check, so no migration.blocked event.
    await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: () => {},
    });

    const calls = vi.mocked(recordActivityEvent).mock.calls.map((c) => c[0]);
    expect(calls.find((c) => c.kind === "migration.blocked")).toBeUndefined();
  });
});
