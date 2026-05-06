import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  inventoryHashDirs,
  convertKeyValueToJson,
  detectActiveSessions,
  migrateStorage,
  rollbackStorage,
} from "../migration/storage-v2.js";
import { readMetadata } from "../metadata.js";

function createTempDir(): string {
  const dir = join(
    tmpdir(),
    `ao-migration-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("inventoryHashDirs", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTempDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("detects hash-based directories", () => {
    mkdirSync(join(testDir, "aaaaaa000000-myproject", "sessions"), { recursive: true });
    writeFileSync(join(testDir, "aaaaaa000000-myproject", "sessions", "ao-1"), "status=working\n");

    const dirs = inventoryHashDirs(testDir);
    expect(dirs).toHaveLength(1);
    expect(dirs[0].hash).toBe("aaaaaa000000");
    expect(dirs[0].projectId).toBe("myproject");
    expect(dirs[0].empty).toBe(false);
  });

  it("marks empty directories correctly", () => {
    mkdirSync(join(testDir, "aaaaaa000000-empty-project"), { recursive: true });

    const dirs = inventoryHashDirs(testDir);
    expect(dirs).toHaveLength(1);
    expect(dirs[0].empty).toBe(true);
  });

  it("ignores non-hash directories", () => {
    mkdirSync(join(testDir, "projects"), { recursive: true });
    mkdirSync(join(testDir, "config.yaml"), { recursive: true });
    mkdirSync(join(testDir, "not-a-hash-dir"), { recursive: true });

    const dirs = inventoryHashDirs(testDir);
    expect(dirs).toHaveLength(0);
  });

  it("detects multiple hash dirs for the same project", () => {
    mkdirSync(join(testDir, "aaaaaaaaaaaa-myproject", "sessions"), { recursive: true });
    mkdirSync(join(testDir, "bbbbbbbbbbbb-myproject", "sessions"), { recursive: true });
    writeFileSync(join(testDir, "aaaaaaaaaaaa-myproject", "sessions", "ao-1"), "status=working\n");
    writeFileSync(join(testDir, "bbbbbbbbbbbb-myproject", "sessions", "ao-2"), "status=working\n");

    const dirs = inventoryHashDirs(testDir);
    expect(dirs).toHaveLength(2);
    expect(dirs.every((d) => d.projectId === "myproject")).toBe(true);
  });

  it("returns empty array for non-existent directory", () => {
    const dirs = inventoryHashDirs(join(testDir, "nonexistent"));
    expect(dirs).toHaveLength(0);
  });

  it("detects bare 12-hex hash directories", () => {
    mkdirSync(join(testDir, "aaaaaa000000", "sessions"), { recursive: true });
    writeFileSync(
      join(testDir, "aaaaaa000000", "sessions", "ao-1"),
      "project=myproject\nstatus=working\n",
    );

    const dirs = inventoryHashDirs(testDir);
    expect(dirs).toHaveLength(1);
    expect(dirs[0].hash).toBe("aaaaaa000000");
    // projectId derived from session metadata
    expect(dirs[0].projectId).toBe("myproject");
    expect(dirs[0].empty).toBe(false);
  });

  it("derives bare hash projectId from global config storageKey", () => {
    mkdirSync(join(testDir, "aaaaaa000000", "sessions"), { recursive: true });
    writeFileSync(join(testDir, "aaaaaa000000", "sessions", "ao-1"), "status=working\n");

    // Write a config that maps storageKey → projectId
    const configPath = join(testDir, "config.yaml");
    writeFileSync(
      configPath,
      [
        "projects:",
        "  my-app:",
        "    path: /home/user/my-app",
        "    storageKey: aaaaaa000000",
        "",
      ].join("\n"),
    );

    const dirs = inventoryHashDirs(testDir, configPath);
    expect(dirs).toHaveLength(1);
    expect(dirs[0].projectId).toBe("my-app");
  });

  it("falls back to hash as projectId when no config or project field", () => {
    mkdirSync(join(testDir, "aaaaaa000000", "sessions"), { recursive: true });
    // Session file with no "project" field
    writeFileSync(join(testDir, "aaaaaa000000", "sessions", "ao-1"), "status=working\n");

    const dirs = inventoryHashDirs(testDir);
    expect(dirs).toHaveLength(1);
    expect(dirs[0].projectId).toBe("aaaaaa000000");
  });

  it("skips observability directories", () => {
    mkdirSync(join(testDir, "aaaaaa000000-observability"), { recursive: true });
    mkdirSync(join(testDir, "aaaaaa000000-myproject", "sessions"), { recursive: true });
    writeFileSync(join(testDir, "aaaaaa000000-myproject", "sessions", "ao-1"), "status=working\n");

    const dirs = inventoryHashDirs(testDir);
    expect(dirs).toHaveLength(1);
    expect(dirs[0].projectId).toBe("myproject");
  });

  it("skips .migrated directories (prevents .migrated.migrated on re-run)", () => {
    // Simulate post-migration state: original renamed to .migrated
    mkdirSync(join(testDir, "aaaaaa000000-myproject.migrated", "sessions"), { recursive: true });
    writeFileSync(
      join(testDir, "aaaaaa000000-myproject.migrated", "sessions", "ao-1"),
      "status=working\n",
    );

    const dirs = inventoryHashDirs(testDir);
    expect(dirs).toHaveLength(0);
  });
});

describe("detectActiveSessions", () => {
  it("returns empty array when tmux is not available", async () => {
    // On CI or machines without tmux, this should return empty
    const sessions = await detectActiveSessions();
    expect(Array.isArray(sessions)).toBe(true);
  });
});

describe("convertKeyValueToJson", () => {
  it("converts basic key-value pairs", () => {
    const kv = [
      "project=myproject",
      "agent=claude-code",
      "status=working",
      "createdAt=2026-04-21T12:00:00.000Z",
      "branch=session/ao-1",
      "worktree=/home/user/.agent-orchestrator/abc-myproject/worktrees/ao-1",
    ].join("\n");

    const result = convertKeyValueToJson(kv);
    expect(result["project"]).toBe("myproject");
    expect(result["agent"]).toBe("claude-code");
    expect(result["createdAt"]).toBe("2026-04-21T12:00:00.000Z");
    expect(result["branch"]).toBe("session/ao-1");
    // status preserved for pre-lifecycle sessions (no statePayload)
    expect(result["status"]).toBe("working");
  });

  it("converts statePayload to lifecycle object", () => {
    const lifecycle = {
      version: 2,
      session: { kind: "worker", state: "working" },
    };
    const kv = [
      "project=myproject",
      `statePayload=${JSON.stringify(lifecycle)}`,
      "stateVersion=2",
    ].join("\n");

    const result = convertKeyValueToJson(kv);
    expect(result["lifecycle"]).toEqual(lifecycle);
    // stateVersion is dropped (lives inside lifecycle)
    expect(result).not.toHaveProperty("stateVersion");
    expect(result).not.toHaveProperty("statePayload");
  });

  it("converts prAutoDetect on/off to boolean", () => {
    expect(convertKeyValueToJson("prAutoDetect=on")["prAutoDetect"]).toBe(true);
    expect(convertKeyValueToJson("prAutoDetect=off")["prAutoDetect"]).toBe(false);
  });

  it("converts port fields to numbers in dashboard group", () => {
    const kv = "dashboardPort=3000\nterminalWsPort=3001\ndirectTerminalWsPort=3002";
    const result = convertKeyValueToJson(kv);
    expect(result["dashboard"]).toEqual({
      port: 3000,
      terminalWsPort: 3001,
      directTerminalWsPort: 3002,
    });
  });

  // Agent-report and report-watcher fields stay flat in V2 because the
  // live runtime readers (parseExistingAgentReport, lifecycle-manager,
  // etc.) look them up directly on session.metadata and the metadata
  // flatten layer (readMetadataRaw → flattenToStringRecord) does NOT
  // unfold nested objects back into flat keys. Nesting them during
  // migration silently dropped this state for migrated sessions.
  it("keeps agentReport fields flat at top level for migrated sessions", () => {
    const kv = [
      "agentReportedState=addressing_reviews",
      "agentReportedAt=2026-04-21T12:35:05.200Z",
      "agentReportedNote=Fixed 2 test regressions",
      "agentReportedPrUrl=https://github.com/o/r/pull/1",
      "agentReportedPrNumber=1",
      "agentReportedPrIsDraft=false",
    ].join("\n");

    const result = convertKeyValueToJson(kv);
    expect(result["agentReport"]).toBeUndefined();
    expect(result["agentReportedState"]).toBe("addressing_reviews");
    expect(result["agentReportedAt"]).toBe("2026-04-21T12:35:05.200Z");
    expect(result["agentReportedNote"]).toBe("Fixed 2 test regressions");
    expect(result["agentReportedPrUrl"]).toBe("https://github.com/o/r/pull/1");
    expect(result["agentReportedPrNumber"]).toBe("1");
    expect(result["agentReportedPrIsDraft"]).toBe("false");
  });

  it("keeps reportWatcher fields flat at top level for migrated sessions", () => {
    const kv = [
      "reportWatcherLastAuditedAt=2026-04-21T16:50:09.934Z",
      "reportWatcherActiveTrigger=stale_report",
      "reportWatcherTriggerActivatedAt=2026-04-21T13:12:39.670Z",
      "reportWatcherTriggerCount=133",
    ].join("\n");

    const result = convertKeyValueToJson(kv);
    expect(result["reportWatcher"]).toBeUndefined();
    expect(result["reportWatcherLastAuditedAt"]).toBe("2026-04-21T16:50:09.934Z");
    expect(result["reportWatcherActiveTrigger"]).toBe("stale_report");
    expect(result["reportWatcherTriggerActivatedAt"]).toBe("2026-04-21T13:12:39.670Z");
    // triggerCount stays as a string — readers consume it via String() and Number() in lifecycle-manager.
    expect(result["reportWatcherTriggerCount"]).toBe("133");
  });

  it("keeps detecting fields at top level (matching runtime behavior)", () => {
    const lifecycle = {
      version: 2,
      session: { kind: "worker", state: "working" },
    };
    const kv = [
      `statePayload=${JSON.stringify(lifecycle)}`,
      "lifecycleEvidence=review_pending",
      "detectingAttempts=3",
      "detectingStartedAt=2026-04-21T12:00:00.000Z",
      "detectingEvidenceHash=abc123",
    ].join("\n");

    const result = convertKeyValueToJson(kv);
    // Detecting fields stay at top level — the lifecycle manager reads them from
    // session.metadata["detectingAttempts"] etc., not from lifecycle.detecting
    expect(result["lifecycleEvidence"]).toBe("review_pending");
    expect(result["detectingAttempts"]).toBe("3");
    expect(result["detectingStartedAt"]).toBe("2026-04-21T12:00:00.000Z");
    expect(result["detectingEvidenceHash"]).toBe("abc123");
    // lifecycle object should NOT contain a detecting sub-object
    const resultLifecycle = result["lifecycle"] as Record<string, unknown>;
    expect(resultLifecycle).not.toHaveProperty("detecting");
  });

  it("parses runtimeHandle JSON string", () => {
    const handle = { id: "ao-1", runtimeName: "tmux", data: {} };
    const kv = `runtimeHandle=${JSON.stringify(handle)}`;
    const result = convertKeyValueToJson(kv);
    expect(result["runtimeHandle"]).toEqual(handle);
  });

  // Regression test for the agent-report / report-watcher migration bug:
  // the runtime readers (parseExistingAgentReport, lifecycle-manager) look
  // up flat keys on session.metadata. readMetadataRaw → flattenToStringRecord
  // stringifies nested objects as a single JSON blob and does NOT unfold
  // them back to flat keys. So nesting these during migration silently
  // dropped the state for migrated sessions.
  it(
    "round-trips agent-report and report-watcher flat keys through readMetadataRaw",
    () => {
      const kv = [
        "agentReportedState=needs_input",
        "agentReportedAt=2026-04-21T12:00:00.000Z",
        "agentReportedNote=please clarify",
        "reportWatcherTriggerCount=5",
        "reportWatcherActiveTrigger=stale_report",
      ].join("\n");

      const migrated = convertKeyValueToJson(kv);
      // After migration, the flat keys must be present at the top level
      // of the V2 JSON record.
      expect(migrated["agentReportedState"]).toBe("needs_input");
      expect(migrated["agentReportedAt"]).toBe("2026-04-21T12:00:00.000Z");
      expect(migrated["agentReportedNote"]).toBe("please clarify");
      expect(migrated["reportWatcherTriggerCount"]).toBe("5");
      expect(migrated["reportWatcherActiveTrigger"]).toBe("stale_report");
      // No nested wrapper objects — those would be lost by flattenToStringRecord.
      expect(migrated["agentReport"]).toBeUndefined();
      expect(migrated["reportWatcher"]).toBeUndefined();
    },
  );
});

describe("migrateStorage", () => {
  let testDir: string;
  let aoBaseDir: string;
  let configPath: string;

  beforeEach(() => {
    testDir = createTempDir();
    aoBaseDir = join(testDir, ".agent-orchestrator");
    configPath = join(aoBaseDir, "config.yaml");
    mkdirSync(aoBaseDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("migrates a single project with one session", async () => {
    // Setup: hash dir with one worker session and worktree
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
        "worktree=/home/user/.agent-orchestrator/aaaaaa000000-myproject/worktrees/ao-1",
      ].join("\n"),
    );

    // Setup: config with storageKey
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

    const logs: string[] = [];
    const result = await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: (msg) => logs.push(msg),
    });

    expect(result.projects).toBe(1);
    expect(result.sessions).toBe(1);

    // Session file should exist in new location
    const sessionPath = join(aoBaseDir, "projects", "myproject", "sessions", "ao-1.json");
    expect(existsSync(sessionPath)).toBe(true);

    const session = JSON.parse(readFileSync(sessionPath, "utf-8"));
    expect(session.project).toBe("myproject");
    expect(session.agent).toBe("claude-code");
    expect(session.worktree).toBe(join(aoBaseDir, "projects", "myproject", "worktrees", "ao-1"));
    // status preserved for pre-lifecycle sessions (no statePayload)
    expect(session.status).toBe("working");

    // Old dir should be renamed to .migrated
    expect(existsSync(`${hashDir}.migrated`)).toBe(true);
    expect(existsSync(hashDir)).toBe(false);

    // Config should have storageKey stripped
    const configContent = readFileSync(configPath, "utf-8");
    expect(configContent).not.toContain("storageKey");
  });

  it("writes orchestrator sessions to sessions/ alongside workers", async () => {
    const hashDir = join(aoBaseDir, "aaaaaa000000-myproject");
    mkdirSync(join(hashDir, "sessions"), { recursive: true });

    // Orchestrator session
    writeFileSync(
      join(hashDir, "sessions", "ao-orchestrator-1"),
      [
        "project=myproject",
        "role=orchestrator",
        "agent=claude-code",
        "createdAt=2026-04-21T12:00:00.000Z",
      ].join("\n"),
    );

    // Worker session
    writeFileSync(
      join(hashDir, "sessions", "ao-1"),
      [
        "project=myproject",
        "agent=claude-code",
        "createdAt=2026-04-21T12:00:00.000Z",
        "branch=session/ao-1",
        "worktree=/tmp/worktrees/ao-1",
      ].join("\n"),
    );

    const result = await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: () => {},
    });

    expect(result.projects).toBe(1);
    // Both orchestrator and worker are counted as sessions
    expect(result.sessions).toBe(2);

    // Orchestrator should be in sessions/ (not orchestrator.json)
    const orchSessionPath = join(
      aoBaseDir,
      "projects",
      "myproject",
      "sessions",
      "ao-orchestrator-1.json",
    );
    expect(existsSync(orchSessionPath)).toBe(true);
    const orch = JSON.parse(readFileSync(orchSessionPath, "utf-8"));
    expect(orch.role).toBe("orchestrator");
  });

  it("merges multiple hash dirs for the same project", async () => {
    // Two hash dirs with different sessions for the same project
    const hash1 = join(aoBaseDir, "aaaaaaaaaaaa-myproject");
    const hash2 = join(aoBaseDir, "bbbbbbbbbbbb-myproject");
    mkdirSync(join(hash1, "sessions"), { recursive: true });
    mkdirSync(join(hash2, "sessions"), { recursive: true });

    writeFileSync(
      join(hash1, "sessions", "ao-1"),
      "project=myproject\nagent=claude-code\ncreatedAt=2026-04-21T12:00:00.000Z\nbranch=b1\nworktree=/tmp/w1",
    );
    writeFileSync(
      join(hash2, "sessions", "ao-2"),
      "project=myproject\nagent=claude-code\ncreatedAt=2026-04-21T13:00:00.000Z\nbranch=b2\nworktree=/tmp/w2",
    );

    const result = await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: () => {},
    });

    expect(result.projects).toBe(1);
    expect(result.sessions).toBe(2);

    // Both sessions should be in the new location
    expect(existsSync(join(aoBaseDir, "projects", "myproject", "sessions", "ao-1.json"))).toBe(
      true,
    );
    expect(existsSync(join(aoBaseDir, "projects", "myproject", "sessions", "ao-2.json"))).toBe(
      true,
    );
  });

  it("handles duplicate session IDs across hash dirs — newer keeps the canonical id, older is renamed", async () => {
    const hash1 = join(aoBaseDir, "aaaaaaaaaaaa-myproject");
    const hash2 = join(aoBaseDir, "bbbbbbbbbbbb-myproject");
    mkdirSync(join(hash1, "sessions"), { recursive: true });
    mkdirSync(join(hash2, "sessions"), { recursive: true });

    // Same session ID, different timestamps. Both records must
    // survive in V2 — the newer one keeps `ao-1`, the older is
    // renamed to `ao-1__from-{hash}` so no work is silently lost.
    writeFileSync(
      join(hash1, "sessions", "ao-1"),
      "project=myproject\ncreatedAt=2026-04-21T12:00:00.000Z\nbranch=b1\nworktree=/tmp/w1",
    );
    writeFileSync(
      join(hash2, "sessions", "ao-1"),
      "project=myproject\ncreatedAt=2026-04-21T14:00:00.000Z\nbranch=b2\nworktree=/tmp/w2",
    );

    const logs: string[] = [];
    const result = await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: (msg) => logs.push(msg),
    });

    expect(result.sessions).toBe(2);

    // The newer session keeps the canonical id.
    const sessionsDir = join(aoBaseDir, "projects", "myproject", "sessions");
    const canonical = JSON.parse(readFileSync(join(sessionsDir, "ao-1.json"), "utf-8"));
    expect(canonical.createdAt).toBe("2026-04-21T14:00:00.000Z");

    // The older duplicate is preserved under a hash-suffixed alias
    // (the loser was hash1 = aaaaaaaaaaaa).
    const aliasPath = join(sessionsDir, "ao-1__from-aaaaaaaaaaaa.json");
    expect(existsSync(aliasPath)).toBe(true);
    const aliased = JSON.parse(readFileSync(aliasPath, "utf-8"));
    expect(aliased.createdAt).toBe("2026-04-21T12:00:00.000Z");

    // The rename should be logged so the user can audit it.
    expect(logs.some((l) => l.includes("[rename] duplicate session ao-1"))).toBe(true);
  });

  it("deletes empty hash directories", async () => {
    mkdirSync(join(aoBaseDir, "aaaaaa000000-empty-project"), { recursive: true });

    const result = await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: () => {},
    });

    expect(result.emptyDirsDeleted).toBe(1);
    expect(existsSync(join(aoBaseDir, "aaaaaa000000-empty-project"))).toBe(false);
  });

  it("dry run makes no changes", async () => {
    const hashDir = join(aoBaseDir, "aaaaaa000000-myproject");
    mkdirSync(join(hashDir, "sessions"), { recursive: true });
    writeFileSync(
      join(hashDir, "sessions", "ao-1"),
      "project=myproject\ncreatedAt=2026-04-21T12:00:00.000Z\nbranch=b\nworktree=/tmp/w",
    );

    await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      dryRun: true,
      log: () => {},
    });

    // Nothing should have changed
    expect(existsSync(hashDir)).toBe(true);
    expect(existsSync(join(aoBaseDir, "projects"))).toBe(false);
  });

  it("reports nothing to migrate when no hash dirs exist", async () => {
    const result = await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: () => {},
    });

    expect(result.projects).toBe(0);
    expect(result.sessions).toBe(0);
  });

  it("flattens archives into sessions/ as terminated records", async () => {
    const hashDir = join(aoBaseDir, "aaaaaa000000-myproject");
    mkdirSync(join(hashDir, "sessions", "archive"), { recursive: true });

    // Regular session so the hash dir is not considered empty
    writeFileSync(
      join(hashDir, "sessions", "ao-1"),
      "project=myproject\ncreatedAt=2026-04-21T12:00:00.000Z\nbranch=b1\nworktree=/tmp/w1",
    );

    // Old archive with colon-containing timestamp
    writeFileSync(
      join(hashDir, "sessions", "archive", "ao-83_2026-04-20T14:30:52.000Z"),
      "project=myproject\ncreatedAt=2026-04-20T14:30:52.000Z\nbranch=b\nworktree=/tmp/w",
    );

    const result = await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: () => {},
    });

    // 2 sessions: ao-1 (regular) + ao-83 (flattened from archive)
    expect(result.sessions).toBe(2);

    // Archive should be flattened into sessions/ as a JSON file (not into sessions/archive/)
    const sessionPath = join(aoBaseDir, "projects", "myproject", "sessions", "ao-83.json");
    expect(existsSync(sessionPath)).toBe(true);
    const session = JSON.parse(readFileSync(sessionPath, "utf-8"));
    expect(session.project).toBe("myproject");
    // Flat metadata — should have terminated status
    expect(session.status).toBe("terminated");

    // No archive directory should exist in new location
    expect(existsSync(join(aoBaseDir, "projects", "myproject", "sessions", "archive"))).toBe(false);
  });

  it("converts key=value format to JSON during migration", async () => {
    const hashDir = join(aoBaseDir, "aaaaaa000000-myproject");
    mkdirSync(join(hashDir, "sessions"), { recursive: true });

    const lifecycle = JSON.stringify({
      version: 2,
      session: { kind: "worker", state: "working" },
    });

    writeFileSync(
      join(hashDir, "sessions", "ao-1"),
      [
        "project=myproject",
        "agent=claude-code",
        "status=working",
        "createdAt=2026-04-21T12:00:00.000Z",
        `statePayload=${lifecycle}`,
        "stateVersion=2",
        "prAutoDetect=on",
        "dashboardPort=3000",
        "agentReportedState=task_complete",
        "branch=session/ao-1",
        "worktree=/tmp/worktrees/ao-1",
      ].join("\n"),
    );

    await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: () => {},
    });

    const session = JSON.parse(
      readFileSync(join(aoBaseDir, "projects", "myproject", "sessions", "ao-1.json"), "utf-8"),
    );

    expect(session.lifecycle).toEqual({
      version: 2,
      session: { kind: "worker", state: "working" },
    });
    expect(session.prAutoDetect).toBe(true);
    expect(session.dashboard).toEqual({ port: 3000 });
    // agentReport stays flat — see "round-trips agent-report ..." regression test above.
    expect(session.agentReportedState).toBe("task_complete");
    expect(session).not.toHaveProperty("agentReport");
    expect(session).not.toHaveProperty("status");
    expect(session).not.toHaveProperty("statePayload");
    expect(session).not.toHaveProperty("stateVersion");
  });

  it("migrated JSON without stored status derives status from lifecycle on read", async () => {
    const hashDir = join(aoBaseDir, "aaaaaa000000-myproject");
    mkdirSync(join(hashDir, "sessions"), { recursive: true });

    const lifecycle = JSON.stringify({
      version: 2,
      session: {
        kind: "worker",
        state: "working",
        reason: "task_in_progress",
        startedAt: "2026-04-21T12:00:00.000Z",
        completedAt: null,
        terminatedAt: null,
        lastTransitionAt: "2026-04-21T12:00:00.000Z",
      },
      pr: {
        state: "open",
        reason: "review_pending",
        url: "https://github.com/test/repo/pull/1",
        lastObservedAt: "2026-04-21T12:30:00.000Z",
      },
      runtime: { handle: null, tmuxName: null },
    });

    writeFileSync(
      join(hashDir, "sessions", "ao-1"),
      [
        "project=myproject",
        "agent=claude-code",
        "status=review_pending",
        "createdAt=2026-04-21T12:00:00.000Z",
        `statePayload=${lifecycle}`,
        "stateVersion=2",
        "branch=session/ao-1",
        "worktree=/tmp/worktrees/ao-1",
      ].join("\n"),
    );

    await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: () => {},
    });

    // Verify status is NOT stored in the JSON file
    const rawJson = JSON.parse(
      readFileSync(join(aoBaseDir, "projects", "myproject", "sessions", "ao-1.json"), "utf-8"),
    );
    expect(rawJson).not.toHaveProperty("status");
    expect(rawJson.lifecycle).toBeDefined();

    // Verify readMetadata derives the correct status from lifecycle
    const sessionsDir = join(aoBaseDir, "projects", "myproject", "sessions");
    const meta = readMetadata(sessionsDir, "ao-1");
    expect(meta).not.toBeNull();
    expect(meta!.status).toBe("review_pending");
  });

  it("migrates bare 12-hex hash directories", async () => {
    const hashDir = join(aoBaseDir, "aaaaaa000000");
    mkdirSync(join(hashDir, "sessions"), { recursive: true });
    writeFileSync(
      join(hashDir, "sessions", "ao-1"),
      "project=myproject\nagent=claude-code\ncreatedAt=2026-04-21T12:00:00.000Z\nbranch=b1\nworktree=/tmp/w1",
    );

    // Config with storageKey for lookup
    writeFileSync(
      configPath,
      [
        "projects:",
        "  myproject:",
        "    path: /home/user/myproject",
        "    storageKey: aaaaaa000000",
        "",
      ].join("\n"),
    );

    const result = await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: () => {},
    });

    expect(result.projects).toBe(1);
    expect(result.sessions).toBe(1);

    // Session should be under the correct project
    const sessionPath = join(aoBaseDir, "projects", "myproject", "sessions", "ao-1.json");
    expect(existsSync(sessionPath)).toBe(true);

    // Old bare hash dir should be renamed to .migrated
    expect(existsSync(`${hashDir}.migrated`)).toBe(true);
    expect(existsSync(hashDir)).toBe(false);
  });

  it("preserves observability directories during migration", async () => {
    // Create an observability dir that matches the hash-name pattern
    const obsDir = join(aoBaseDir, "aaaaaa000000-observability");
    mkdirSync(obsDir, { recursive: true });
    writeFileSync(join(obsDir, "metrics.log"), "some observability data");

    // Also create a real project dir
    const hashDir = join(aoBaseDir, "aaaaaa000000-myproject");
    mkdirSync(join(hashDir, "sessions"), { recursive: true });
    writeFileSync(
      join(hashDir, "sessions", "ao-1"),
      "project=myproject\ncreatedAt=2026-04-21T12:00:00.000Z\nbranch=b1\nworktree=/tmp/w1",
    );

    const result = await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: () => {},
    });

    expect(result.projects).toBe(1);

    // Observability dir must NOT be touched
    expect(existsSync(obsDir)).toBe(true);
    expect(readFileSync(join(obsDir, "metrics.log"), "utf-8")).toBe("some observability data");
  });

  it("is idempotent — re-running migration skips .migrated dirs", async () => {
    // First migration
    const hashDir = join(aoBaseDir, "aaaaaa000000-myproject");
    mkdirSync(join(hashDir, "sessions"), { recursive: true });
    writeFileSync(
      join(hashDir, "sessions", "ao-1"),
      "project=myproject\nstatus=working\ncreatedAt=2026-04-21T12:00:00.000Z",
    );

    await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: () => {},
    });

    // After first migration: .migrated exists, projects/ exists
    expect(existsSync(`${hashDir}.migrated`)).toBe(true);

    // Second migration — should be a no-op
    const logs: string[] = [];
    const result = await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: (msg) => logs.push(msg),
    });

    expect(result.projects).toBe(0);
    expect(result.sessions).toBe(0);
    // Must NOT create .migrated.migrated
    expect(existsSync(`${hashDir}.migrated.migrated`)).toBe(false);
    expect(existsSync(`${hashDir}.migrated`)).toBe(true);
  });

  it("handles ENOTEMPTY when .migrated target already exists from interrupted run", async () => {
    const hashDir = join(aoBaseDir, "aaaaaa000000-myproject");
    mkdirSync(join(hashDir, "sessions"), { recursive: true });
    writeFileSync(
      join(hashDir, "sessions", "ao-1"),
      "project=myproject\nstatus=working\ncreatedAt=2026-04-21T12:00:00.000Z",
    );

    // Simulate interrupted previous run: .migrated already exists with leftover content
    const migratedDir = `${hashDir}.migrated`;
    mkdirSync(join(migratedDir, "sessions"), { recursive: true });
    writeFileSync(join(migratedDir, "sessions", "ao-1"), "leftover");

    const logs: string[] = [];
    const result = await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: (msg) => logs.push(msg),
    });

    expect(result.projects).toBe(1);
    // Source dir should be removed, .migrated should remain
    expect(existsSync(hashDir)).toBe(false);
    expect(existsSync(migratedDir)).toBe(true);
    expect(logs.some((l) => l.includes("already exists"))).toBe(true);
  });

  it("preserves config and migration marker when retiring a legacy dir fails", async () => {
    const hashDir = join(aoBaseDir, "aaaaaa000000-myproject");
    mkdirSync(join(hashDir, "sessions"), { recursive: true });
    writeFileSync(
      join(hashDir, "sessions", "ao-1"),
      "project=myproject\nstatus=working\ncreatedAt=2026-04-21T12:00:00.000Z",
    );
    writeFileSync(`${hashDir}.migrated`, "not a directory");
    writeFileSync(
      configPath,
      [
        "projects:",
        "  myproject:",
        "    path: /home/user/myproject",
        "    storageKey: aaaaaa000000",
        "",
      ].join("\n"),
    );

    const logs: string[] = [];
    await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: (msg) => logs.push(msg),
    });

    expect(existsSync(hashDir)).toBe(true);
    expect(existsSync(join(aoBaseDir, ".migration-in-progress"))).toBe(true);
    expect(readFileSync(configPath, "utf-8")).toContain("storageKey");
    expect(logs.some((l) => l.includes("Failed to rename"))).toBe(true);
    expect(logs.some((l) => l.includes("Skipping config update"))).toBe(true);
  });

  it("continues migrating other projects when one project fails", async () => {
    // Project A — will succeed
    const hashDirA = join(aoBaseDir, "aaaaaa000000-project-a");
    mkdirSync(join(hashDirA, "sessions"), { recursive: true });
    writeFileSync(
      join(hashDirA, "sessions", "ao-1"),
      "project=project-a\nstatus=working\ncreatedAt=2026-04-21T12:00:00.000Z",
    );

    // Project B — will fail (create a file where migrateProject expects a directory)
    const hashDirB = join(aoBaseDir, "bbbbbb000000-project-b");
    mkdirSync(join(hashDirB, "sessions"), { recursive: true });
    writeFileSync(
      join(hashDirB, "sessions", "ao-2"),
      "project=project-b\nstatus=working\ncreatedAt=2026-04-21T12:00:00.000Z",
    );
    // Pre-create a FILE at the projects/project-b path to cause an error
    mkdirSync(join(aoBaseDir, "projects"), { recursive: true });
    writeFileSync(join(aoBaseDir, "projects", "project-b"), "conflict");

    const logs: string[] = [];
    const result = await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: (msg) => logs.push(msg),
    });

    // Project A should succeed
    expect(result.projects).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(aoBaseDir, "projects", "project-a", "sessions", "ao-1.json"))).toBe(
      true,
    );
    // Should report the failure
    expect(logs.some((l) => l.includes("ERROR") && l.includes("project-b"))).toBe(true);
    // Summary should mention failed projects
    expect(logs.some((l) => l.includes("Failed to migrate"))).toBe(true);
  });
});

describe("rollbackStorage", () => {
  let testDir: string;
  let aoBaseDir: string;
  let configPath: string;

  beforeEach(() => {
    testDir = createTempDir();
    aoBaseDir = join(testDir, ".agent-orchestrator");
    configPath = join(aoBaseDir, "config.yaml");
    mkdirSync(aoBaseDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("restores .migrated directories and removes migrated projects", async () => {
    // Simulate post-migration state
    mkdirSync(join(aoBaseDir, "aaaaaa000000-myproject.migrated", "sessions"), { recursive: true });
    writeFileSync(
      join(aoBaseDir, "aaaaaa000000-myproject.migrated", "sessions", "ao-1"),
      "project=myproject",
    );
    mkdirSync(join(aoBaseDir, "projects", "myproject", "sessions"), { recursive: true });
    writeFileSync(
      join(aoBaseDir, "projects", "myproject", "sessions", "ao-1.json"),
      '{"project":"myproject"}',
    );

    // Config without storageKey
    writeFileSync(
      configPath,
      [
        "projects:",
        "  myproject:",
        "    path: /home/user/myproject",
        "    defaultBranch: main",
        "",
      ].join("\n"),
    );

    await rollbackStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      log: () => {},
    });

    // .migrated should be restored
    expect(existsSync(join(aoBaseDir, "aaaaaa000000-myproject"))).toBe(true);
    expect(existsSync(join(aoBaseDir, "aaaaaa000000-myproject.migrated"))).toBe(false);

    // migrated project dir should be gone (no post-migration sessions)
    expect(existsSync(join(aoBaseDir, "projects", "myproject"))).toBe(false);

    // storageKey should be re-added to config in {hash}-{projectId} format
    const configContent = readFileSync(configPath, "utf-8");
    expect(configContent).toContain("storageKey");
    expect(configContent).toContain("aaaaaa000000-myproject");
  });

  it("does not treat flattened archive records as post-migration sessions", async () => {
    mkdirSync(join(aoBaseDir, "aaaaaa000000-myproject.migrated", "sessions", "archive"), {
      recursive: true,
    });
    writeFileSync(
      join(
        aoBaseDir,
        "aaaaaa000000-myproject.migrated",
        "sessions",
        "archive",
        "ao-83_2026-04-20T14:30:52.000Z",
      ),
      "project=myproject",
    );
    mkdirSync(join(aoBaseDir, "projects", "myproject", "sessions"), { recursive: true });
    writeFileSync(
      join(aoBaseDir, "projects", "myproject", "sessions", "ao-83.json"),
      '{"project":"myproject","status":"terminated","reason":"migrated_from_archive"}',
    );

    writeFileSync(
      configPath,
      ["projects:", "  myproject:", "    path: /home/user/myproject", ""].join("\n"),
    );

    const logs: string[] = [];
    await rollbackStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      log: (msg) => logs.push(msg),
    });

    expect(existsSync(join(aoBaseDir, "aaaaaa000000-myproject"))).toBe(true);
    expect(existsSync(join(aoBaseDir, "projects", "myproject"))).toBe(false);
    expect(logs.some((l) => l.includes("created after migration"))).toBe(false);
  });

  it("writes storageKey in original directory name format", async () => {
    mkdirSync(join(aoBaseDir, "a3b4c5d6e7f8-myapp.migrated"), { recursive: true });
    mkdirSync(join(aoBaseDir, "projects", "myapp"), { recursive: true });

    writeFileSync(
      configPath,
      ["projects:", "  myapp:", "    path: /home/user/myapp", ""].join("\n"),
    );

    await rollbackStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      log: () => {},
    });

    const configContent = readFileSync(configPath, "utf-8");
    // storageKey should be the full directory name, not just the hash
    expect(configContent).toContain("a3b4c5d6e7f8-myapp");
  });

  it("restores config storageKey for bare hash directories", async () => {
    mkdirSync(join(aoBaseDir, "aaaaaa000000.migrated", "sessions"), { recursive: true });
    writeFileSync(
      join(aoBaseDir, "aaaaaa000000.migrated", "sessions", "ao-1"),
      "project=myproject",
    );
    mkdirSync(join(aoBaseDir, "projects", "myproject", "sessions"), { recursive: true });
    writeFileSync(
      join(aoBaseDir, "projects", "myproject", "sessions", "ao-1.json"),
      '{"project":"myproject"}',
    );

    writeFileSync(
      configPath,
      ["projects:", "  myproject:", "    path: /home/user/myproject", ""].join("\n"),
    );

    await rollbackStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      log: () => {},
    });

    expect(existsSync(join(aoBaseDir, "aaaaaa000000"))).toBe(true);
    expect(existsSync(join(aoBaseDir, "projects", "myproject"))).toBe(false);

    const configContent = readFileSync(configPath, "utf-8");
    expect(configContent).toContain("storageKey");
    expect(configContent).toContain("aaaaaa000000");
  });

  it("preserves post-migration sessions during rollback", async () => {
    // Simulate migrated dir with original session
    mkdirSync(join(aoBaseDir, "aaaaaa000000-myproject.migrated", "sessions"), { recursive: true });
    writeFileSync(
      join(aoBaseDir, "aaaaaa000000-myproject.migrated", "sessions", "ao-1"),
      "project=myproject",
    );

    // Migrated sessions (from migration) — ao-1 came from .migrated, ao-50 was created after
    mkdirSync(join(aoBaseDir, "projects", "myproject", "sessions"), { recursive: true });
    writeFileSync(
      join(aoBaseDir, "projects", "myproject", "sessions", "ao-1.json"),
      '{"project":"myproject"}',
    );
    writeFileSync(
      join(aoBaseDir, "projects", "myproject", "sessions", "ao-50.json"),
      '{"project":"myproject","status":"working"}',
    );

    // A DIFFERENT project that was NOT migrated (created post-migration)
    mkdirSync(join(aoBaseDir, "projects", "new-project", "sessions"), { recursive: true });
    writeFileSync(
      join(aoBaseDir, "projects", "new-project", "sessions", "ao-99.json"),
      '{"project":"new-project","status":"working"}',
    );

    writeFileSync(
      configPath,
      [
        "projects:",
        "  myproject:",
        "    path: /home/user/myproject",
        "  new-project:",
        "    path: /home/user/new-project",
        "",
      ].join("\n"),
    );

    const logs: string[] = [];
    await rollbackStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      log: (msg) => logs.push(msg),
    });

    // myproject has ao-50 which was created post-migration — dir should be PRESERVED
    expect(existsSync(join(aoBaseDir, "projects", "myproject"))).toBe(true);
    expect(existsSync(join(aoBaseDir, "projects", "myproject", "sessions", "ao-50.json"))).toBe(
      true,
    );
    expect(logs.some((l) => l.includes("1 session(s) created after migration"))).toBe(true);

    // Non-migrated project dir must be preserved
    expect(existsSync(join(aoBaseDir, "projects", "new-project", "sessions", "ao-99.json"))).toBe(
      true,
    );

    // projects/ dir should still exist (has remaining content)
    expect(existsSync(join(aoBaseDir, "projects"))).toBe(true);
  });

  it("deletes migrated project dir when no post-migration sessions exist", async () => {
    // Simulate migrated dir with original session
    mkdirSync(join(aoBaseDir, "aaaaaa000000-myproject.migrated", "sessions"), { recursive: true });
    writeFileSync(
      join(aoBaseDir, "aaaaaa000000-myproject.migrated", "sessions", "ao-1"),
      "project=myproject",
    );

    // Only the migrated session in the project dir — no new sessions
    mkdirSync(join(aoBaseDir, "projects", "myproject", "sessions"), { recursive: true });
    writeFileSync(
      join(aoBaseDir, "projects", "myproject", "sessions", "ao-1.json"),
      '{"project":"myproject"}',
    );

    writeFileSync(
      configPath,
      ["projects:", "  myproject:", "    path: /home/user/myproject", ""].join("\n"),
    );

    await rollbackStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      log: () => {},
    });

    // No post-migration sessions — safe to delete
    expect(existsSync(join(aoBaseDir, "projects", "myproject"))).toBe(false);
  });

  it("moves worktrees back to restored hash dir before deleting project dir", async () => {
    // Simulate post-migration state: worktree was moved to projects/
    mkdirSync(join(aoBaseDir, "aaaaaa000000-myproject.migrated", "sessions"), { recursive: true });
    mkdirSync(join(aoBaseDir, "aaaaaa000000-myproject.migrated", "worktrees"), { recursive: true });
    writeFileSync(
      join(aoBaseDir, "aaaaaa000000-myproject.migrated", "sessions", "ao-1"),
      "project=myproject",
    );

    mkdirSync(join(aoBaseDir, "projects", "myproject", "sessions"), { recursive: true });
    mkdirSync(join(aoBaseDir, "projects", "myproject", "worktrees", "ao-1"), { recursive: true });
    writeFileSync(
      join(aoBaseDir, "projects", "myproject", "sessions", "ao-1.json"),
      '{"project":"myproject"}',
    );
    // Simulate a file inside the worktree
    writeFileSync(
      join(aoBaseDir, "projects", "myproject", "worktrees", "ao-1", "README.md"),
      "# test",
    );

    writeFileSync(
      configPath,
      ["projects:", "  myproject:", "    path: /home/user/myproject", ""].join("\n"),
    );

    await rollbackStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      log: () => {},
    });

    // Worktree should be moved back to restored hash dir
    expect(existsSync(join(aoBaseDir, "aaaaaa000000-myproject", "worktrees", "ao-1"))).toBe(true);
    expect(
      readFileSync(
        join(aoBaseDir, "aaaaaa000000-myproject", "worktrees", "ao-1", "README.md"),
        "utf-8",
      ),
    ).toBe("# test");

    // Project dir should be deleted
    expect(existsSync(join(aoBaseDir, "projects", "myproject"))).toBe(false);
  });

  it("does not delete migrated project dir when restore is skipped", async () => {
    mkdirSync(join(aoBaseDir, "aaaaaa000000-myproject.migrated", "sessions"), { recursive: true });
    writeFileSync(
      join(aoBaseDir, "aaaaaa000000-myproject.migrated", "sessions", "ao-1"),
      "project=myproject",
    );
    mkdirSync(join(aoBaseDir, "aaaaaa000000-myproject"), { recursive: true });
    mkdirSync(join(aoBaseDir, "projects", "myproject", "sessions"), { recursive: true });
    writeFileSync(
      join(aoBaseDir, "projects", "myproject", "sessions", "ao-1.json"),
      '{"project":"myproject"}',
    );

    writeFileSync(
      configPath,
      ["projects:", "  myproject:", "    path: /home/user/myproject", ""].join("\n"),
    );

    const logs: string[] = [];
    await rollbackStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      log: (msg) => logs.push(msg),
    });

    expect(existsSync(join(aoBaseDir, "projects", "myproject"))).toBe(true);
    expect(existsSync(join(aoBaseDir, "aaaaaa000000-myproject"))).toBe(true);
    expect(existsSync(join(aoBaseDir, "aaaaaa000000-myproject.migrated"))).toBe(true);
    expect(logs.some((line) => line.includes("skipping restore"))).toBe(true);
  });

  it("does nothing when no .migrated directories exist", async () => {
    const logs: string[] = [];
    await rollbackStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      log: (msg) => logs.push(msg),
    });

    expect(logs.some((l) => l.includes("Nothing to rollback"))).toBe(true);
  });

  it("dry run reports actions without modifying files", async () => {
    mkdirSync(join(aoBaseDir, "aaaaaa000000-myproject.migrated", "sessions"), { recursive: true });
    writeFileSync(
      join(aoBaseDir, "aaaaaa000000-myproject.migrated", "sessions", "ao-1"),
      "project=myproject",
    );
    mkdirSync(join(aoBaseDir, "projects", "myproject", "sessions"), { recursive: true });
    writeFileSync(
      join(aoBaseDir, "projects", "myproject", "sessions", "ao-1.json"),
      '{"project":"myproject"}',
    );

    const logs: string[] = [];
    await rollbackStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      dryRun: true,
      log: (msg) => logs.push(msg),
    });

    expect(logs.some((l) => l.includes("DRY RUN"))).toBe(true);
    // .migrated dir should still exist (not renamed)
    expect(existsSync(join(aoBaseDir, "aaaaaa000000-myproject.migrated"))).toBe(true);
    // migrated project dir should still exist (not deleted)
    expect(existsSync(join(aoBaseDir, "projects", "myproject"))).toBe(true);
  });
});

describe("migration edge cases", () => {
  let testDir: string;
  let aoBaseDir: string;
  let configPath: string;

  beforeEach(() => {
    testDir = createTempDir();
    aoBaseDir = join(testDir, ".agent-orchestrator");
    mkdirSync(aoBaseDir, { recursive: true });
    configPath = join(testDir, "config.yaml");
    writeFileSync(configPath, "projects: {}\n");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("blocks migration when active sessions detected (or proceeds when none)", async () => {
    const hashDir = join(aoBaseDir, "aaaaaa000000-myproject");
    mkdirSync(join(hashDir, "sessions"), { recursive: true });
    writeFileSync(
      join(hashDir, "sessions", "ao-1"),
      "project=myproject\ncreatedAt=2026-04-21T12:00:00.000Z\nbranch=b1\nworktree=/tmp/w1",
    );

    try {
      const result = await migrateStorage({
        aoBaseDir,
        globalConfigPath: configPath,
        // force: false is default
        log: () => {},
      });
      // No active sessions (CI) → migration proceeds
      expect(result.sessions).toBe(1);
    } catch (err) {
      // Active sessions detected → throws with actionable message
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("active AO tmux session");
      expect((err as Error).message).toContain("--force");
    }
  });

  it("blocks migration when an active session uses a custom sessionPrefix", async () => {
    const hashDir = join(aoBaseDir, "aaaaaa000000-backend-service");
    mkdirSync(join(hashDir, "sessions"), { recursive: true });
    writeFileSync(
      join(hashDir, "sessions", "be-1"),
      "project=backend-service\ncreatedAt=2026-04-21T12:00:00.000Z\nbranch=b1\nworktree=/tmp/w1",
    );

    writeFileSync(
      configPath,
      [
        "projects:",
        "  backend-service:",
        "    path: /home/user/backend-service",
        "    sessionPrefix: be",
        "",
      ].join("\n"),
    );

    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execSync: vi.fn(() => "be-1\n"),
    }));

    const { migrateStorage: migrateStorageWithMock } = await import("../migration/storage-v2.js");

    try {
      await expect(
        migrateStorageWithMock({
          aoBaseDir,
          globalConfigPath: configPath,
          log: () => {},
        }),
      ).rejects.toThrow(/active AO tmux session/);
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });

  it("migrates worktree directories to new layout", async () => {
    const hashDir = join(aoBaseDir, "aaaaaa000000-myproject");
    mkdirSync(join(hashDir, "sessions"), { recursive: true });
    mkdirSync(join(hashDir, "worktrees", "ao-1"), { recursive: true });
    writeFileSync(join(hashDir, "worktrees", "ao-1", "file.txt"), "test");
    writeFileSync(
      join(hashDir, "sessions", "ao-1"),
      "project=myproject\ncreatedAt=2026-04-21T12:00:00.000Z\nbranch=b1\nworktree=/tmp/w1",
    );

    const result = await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: () => {},
    });

    expect(result.worktrees).toBe(1);
    // Worktree should be moved to new location
    const newWorktree = join(aoBaseDir, "projects", "myproject", "worktrees", "ao-1");
    expect(existsSync(newWorktree)).toBe(true);
    expect(readFileSync(join(newWorktree, "file.txt"), "utf-8")).toBe("test");
  });

  it("preserves status for pre-lifecycle sessions during migration", async () => {
    const hashDir = join(aoBaseDir, "aaaaaa000000-myproject");
    mkdirSync(join(hashDir, "sessions"), { recursive: true });
    writeFileSync(
      join(hashDir, "sessions", "ao-1"),
      "project=myproject\nstatus=working\ncreatedAt=2026-04-21T12:00:00.000Z\nbranch=b1\nworktree=/tmp/w1",
    );

    await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: () => {},
    });

    // Pre-lifecycle session should retain status in migrated JSON
    const session = JSON.parse(
      readFileSync(join(aoBaseDir, "projects", "myproject", "sessions", "ao-1.json"), "utf-8"),
    );
    expect(session.status).toBe("working");
    expect(session).not.toHaveProperty("lifecycle");

    // readMetadata should use the stored status
    const sessionsDir = join(aoBaseDir, "projects", "myproject", "sessions");
    const meta = readMetadata(sessionsDir, "ao-1");
    expect(meta!.status).toBe("working");
  });

  it("duplicate sessions across hash dirs are renamed to a hash-suffixed alias, not archived", async () => {
    const hash1 = join(aoBaseDir, "aaaaaaaaaaaa-myproject");
    const hash2 = join(aoBaseDir, "bbbbbbbbbbbb-myproject");
    mkdirSync(join(hash1, "sessions"), { recursive: true });
    mkdirSync(join(hash2, "sessions"), { recursive: true });

    // Same session ID in both hash dirs.
    writeFileSync(
      join(hash1, "sessions", "ao-1"),
      "project=myproject\ncreatedAt=2026-04-21T10:00:00.000Z\nbranch=b1\nworktree=/tmp/w1",
    );
    writeFileSync(
      join(hash2, "sessions", "ao-1"),
      "project=myproject\ncreatedAt=2026-04-21T12:00:00.000Z\nbranch=b1\nworktree=/tmp/w1",
    );

    const logs: string[] = [];
    const result = await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: (msg) => logs.push(msg),
    });

    // BOTH sessions are preserved — the newer keeps the canonical id,
    // the older lands under `ao-1__from-{loserHash}`.
    expect(result.sessions).toBe(2);

    const sessionsDir = join(aoBaseDir, "projects", "myproject", "sessions");

    // Archive directory must NOT be re-created.
    expect(existsSync(join(sessionsDir, "archive"))).toBe(false);

    // Rename should be logged so the user can audit it.
    expect(logs.some((l) => l.includes("[rename] duplicate session ao-1"))).toBe(true);

    // Newer session keeps `ao-1`.
    const canonical = JSON.parse(readFileSync(join(sessionsDir, "ao-1.json"), "utf-8"));
    expect(canonical.createdAt).toBe("2026-04-21T12:00:00.000Z");

    // Older session is preserved under the alias suffix.
    const alias = JSON.parse(
      readFileSync(join(sessionsDir, "ao-1__from-aaaaaaaaaaaa.json"), "utf-8"),
    );
    expect(alias.createdAt).toBe("2026-04-21T10:00:00.000Z");
  });

  it("moves stray worktrees from nested ~/.worktrees/{projectId}/{sessionId}/ layout", async () => {
    // Setup: hash dir with session (no worktree in hash dir — it's in ~/.worktrees/)
    const hashDir = join(aoBaseDir, "aaaaaa000000-myproject");
    mkdirSync(join(hashDir, "sessions"), { recursive: true });
    writeFileSync(
      join(hashDir, "sessions", "ao-1"),
      "project=myproject\ncreatedAt=2026-04-21T12:00:00.000Z\nbranch=b1\nworktree=/tmp/w1",
    );

    // Setup: stray worktree at ~/.worktrees/myproject/ao-1/ (default workspace plugin layout)
    const strayDir = join(homedir(), ".worktrees", "myproject", "ao-1");
    mkdirSync(strayDir, { recursive: true });
    writeFileSync(join(strayDir, "marker.txt"), "stray-test");

    try {
      const result = await migrateStorage({
        aoBaseDir,
        globalConfigPath: configPath,
        force: true,
        log: () => {},
      });

      expect(result.strayWorktreesMoved).toBe(1);

      // Worktree should be in new location
      const newWorktree = join(aoBaseDir, "projects", "myproject", "worktrees", "ao-1");
      expect(existsSync(newWorktree)).toBe(true);
      expect(readFileSync(join(newWorktree, "marker.txt"), "utf-8")).toBe("stray-test");

      // Original should be cleaned up
      expect(existsSync(strayDir)).toBe(false);
    } finally {
      // Cleanup stray dir if test failed before migration moved it
      const parentDir = join(homedir(), ".worktrees", "myproject");
      if (existsSync(parentDir)) {
        rmSync(parentDir, { recursive: true, force: true });
      }
    }
  });

  it("keeps original worktree path when worktree directory was not moved", async () => {
    // Session references a worktree at an external path (e.g. ~/.worktrees/myproject/ao-1)
    // but no worktree directory exists in the hash dir to be moved
    const hashDir = join(aoBaseDir, "aaaaaa000000-myproject");
    mkdirSync(join(hashDir, "sessions"), { recursive: true });
    writeFileSync(
      join(hashDir, "sessions", "ao-1"),
      "project=myproject\ncreatedAt=2026-04-21T12:00:00.000Z\nbranch=b1\nworktree=/tmp/external-worktree/ao-1",
    );

    await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: () => {},
    });

    const sessionPath = join(aoBaseDir, "projects", "myproject", "sessions", "ao-1.json");
    const session = JSON.parse(readFileSync(sessionPath, "utf-8"));
    // Path should NOT be rewritten since no worktree was moved to the new location
    expect(session.worktree).toBe("/tmp/external-worktree/ao-1");
  });

  it("writes and removes .migration-in-progress marker file", async () => {
    const hashDir = join(aoBaseDir, "aaaaaa000000-myproject");
    mkdirSync(join(hashDir, "sessions"), { recursive: true });
    writeFileSync(
      join(hashDir, "sessions", "ao-1"),
      "project=myproject\ncreatedAt=2026-04-21T12:00:00.000Z\nbranch=b1\nworktree=/tmp/w1",
    );

    const markerPath = join(aoBaseDir, ".migration-in-progress");

    await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: () => {},
    });

    // Marker should be removed after successful migration
    expect(existsSync(markerPath)).toBe(false);
    // Migration should have completed
    expect(existsSync(join(aoBaseDir, "projects", "myproject", "sessions", "ao-1.json"))).toBe(
      true,
    );
  });

  it("detects interrupted migration on re-run", async () => {
    const markerPath = join(aoBaseDir, ".migration-in-progress");
    // Simulate interrupted migration: marker exists, partial state
    writeFileSync(markerPath, "2026-04-21T12:00:00.000Z");
    const hashDir = join(aoBaseDir, "aaaaaa000000-myproject");
    mkdirSync(join(hashDir, "sessions"), { recursive: true });
    writeFileSync(
      join(hashDir, "sessions", "ao-1"),
      "project=myproject\ncreatedAt=2026-04-21T12:00:00.000Z\nbranch=b1\nworktree=/tmp/w1",
    );

    const logs: string[] = [];
    await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: (msg) => logs.push(msg),
    });

    // Should warn about interrupted migration
    expect(logs.some((m) => m.includes("interrupted"))).toBe(true);
    // Should still complete successfully
    expect(existsSync(markerPath)).toBe(false);
    expect(existsSync(join(aoBaseDir, "projects", "myproject", "sessions", "ao-1.json"))).toBe(
      true,
    );
  });

  it("does not write marker file in dry-run mode", async () => {
    const hashDir = join(aoBaseDir, "aaaaaa000000-myproject");
    mkdirSync(join(hashDir, "sessions"), { recursive: true });
    writeFileSync(
      join(hashDir, "sessions", "ao-1"),
      "project=myproject\ncreatedAt=2026-04-21T12:00:00.000Z\nbranch=b1\nworktree=/tmp/w1",
    );

    await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      dryRun: true,
      log: () => {},
    });

    expect(existsSync(join(aoBaseDir, ".migration-in-progress"))).toBe(false);
  });

  // Regression for the Mode A bug surfaced in PR #1466 QA: after migration
  // the worktree path changes (V1 hash dir → V2 projects/ dir), but Claude
  // Code keys session JSONLs by the encoded form of the workspace path.
  // The migrator must move ~/.claude/projects/<old-encoded>/ → <new-encoded>/
  // so chat history survives migration; otherwise the next ao start →
  // restore launches a fresh `claude` and the conversation is lost.
  it(
    "relinks ~/.claude/projects/<old-encoded>/ to <new-encoded>/ for migrated worktrees",
    async () => {
      const origHome = process.env["HOME"];
      const fakeHome = join(testDir, "fake-home");
      mkdirSync(fakeHome, { recursive: true });
      process.env["HOME"] = fakeHome;

      try {
        // Seed a V1 layout with one session whose worktree has a Claude
        // session-storage dir at the OLD encoded path.
        const hashDir = join(aoBaseDir, "aaaaaa000000-myproject");
        mkdirSync(join(hashDir, "sessions"), { recursive: true });
        const oldWorktreePath = join(hashDir, "worktrees", "ao-1");
        mkdirSync(oldWorktreePath, { recursive: true });

        writeFileSync(
          join(hashDir, "sessions", "ao-1"),
          [
            "project=myproject",
            "agent=claude-code",
            "branch=session/ao-1",
            `worktree=${oldWorktreePath}`,
          ].join("\n"),
        );

        // Encode the old workspace path the way Claude Code does
        // (replace `/` and `.` with `-`, strip `:`).
        const encode = (p: string) =>
          p.replace(/\\/g, "/").replace(/:/g, "").replace(/[/.]/g, "-");
        const oldEncoded = encode(oldWorktreePath);
        const claudeProjectsDir = join(fakeHome, ".claude", "projects");
        const oldClaudeDir = join(claudeProjectsDir, oldEncoded);
        mkdirSync(oldClaudeDir, { recursive: true });
        // A session JSONL — content doesn't matter for the relink, only
        // that the directory has files we can verify ended up at the new path.
        writeFileSync(
          join(oldClaudeDir, "session-uuid.jsonl"),
          '{"type":"user","message":{"content":"hello"}}\n',
        );

        const result = await migrateStorage({
          aoBaseDir,
          globalConfigPath: configPath,
          force: true,
          log: () => {},
        });

        // Worktree was migrated, so the encoded path changed.
        const newWorktreePath = join(aoBaseDir, "projects", "myproject", "worktrees", "ao-1");
        const newEncoded = encode(newWorktreePath);
        expect(oldEncoded).not.toBe(newEncoded);

        // Old Claude dir should be gone, new one should have the JSONL.
        expect(existsSync(oldClaudeDir)).toBe(false);
        expect(
          existsSync(join(claudeProjectsDir, newEncoded, "session-uuid.jsonl")),
        ).toBe(true);
        expect(result.claudeSessionsRelinked).toBe(1);
      } finally {
        if (origHome === undefined) delete process.env["HOME"];
        else process.env["HOME"] = origHome;
      }
    },
  );

  // Safety: never overwrite an existing Claude session dir at the new
  // encoded path. Skip and warn instead so the user reconciles manually.
  it("does NOT overwrite an existing Claude session dir at the new encoded path", async () => {
    const origHome = process.env["HOME"];
    const fakeHome = join(testDir, "fake-home-2");
    mkdirSync(fakeHome, { recursive: true });
    process.env["HOME"] = fakeHome;

    try {
      const hashDir = join(aoBaseDir, "aaaaaa000000-myproject");
      mkdirSync(join(hashDir, "sessions"), { recursive: true });
      const oldWorktreePath = join(hashDir, "worktrees", "ao-1");
      mkdirSync(oldWorktreePath, { recursive: true });

      writeFileSync(
        join(hashDir, "sessions", "ao-1"),
        [
          "project=myproject",
          "agent=claude-code",
          "branch=session/ao-1",
          `worktree=${oldWorktreePath}`,
        ].join("\n"),
      );

      const encode = (p: string) =>
        p.replace(/\\/g, "/").replace(/:/g, "").replace(/[/.]/g, "-");
      const oldEncoded = encode(oldWorktreePath);
      const newWorktreePath = join(aoBaseDir, "projects", "myproject", "worktrees", "ao-1");
      const newEncoded = encode(newWorktreePath);
      const claudeProjectsDir = join(fakeHome, ".claude", "projects");
      // Pre-create BOTH the old and new dirs — the new one already has
      // content (e.g. user manually re-attached). Migration must not clobber it.
      mkdirSync(join(claudeProjectsDir, oldEncoded), { recursive: true });
      writeFileSync(join(claudeProjectsDir, oldEncoded, "old.jsonl"), "old");
      mkdirSync(join(claudeProjectsDir, newEncoded), { recursive: true });
      writeFileSync(join(claudeProjectsDir, newEncoded, "new.jsonl"), "new");

      const result = await migrateStorage({
        aoBaseDir,
        globalConfigPath: configPath,
        force: true,
        log: () => {},
      });

      // Both dirs still exist; the new dir's content is untouched.
      expect(existsSync(join(claudeProjectsDir, oldEncoded, "old.jsonl"))).toBe(true);
      expect(existsSync(join(claudeProjectsDir, newEncoded, "new.jsonl"))).toBe(true);
      expect(result.claudeSessionsRelinked).toBe(0);
    } finally {
      if (origHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = origHome;
    }
  });

  // Regression for the boundary-bug-hunter finding on PR #1466: Codex stores
  // its rollouts at ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl with the
  // session cwd embedded in the first JSONL line's `session_meta` payload.
  // The agent-codex plugin's restore lookup matches `session_meta.cwd ===
  // session.workspacePath` exactly, so post-migration the new V2 worktree
  // path no longer matches and `getRestoreCommand` returns null. The
  // migrator must rewrite that cwd in place so Codex restore continues to
  // find the prior thread.
  it(
    "rewrites ~/.codex/sessions/**/rollout-*.jsonl session_meta.cwd for migrated worktrees",
    async () => {
      const origHome = process.env["HOME"];
      const fakeHome = join(testDir, "fake-home-codex");
      mkdirSync(fakeHome, { recursive: true });
      process.env["HOME"] = fakeHome;

      try {
        const hashDir = join(aoBaseDir, "aaaaaa000000-myproject");
        mkdirSync(join(hashDir, "sessions"), { recursive: true });
        const oldWorktreePath = join(hashDir, "worktrees", "ao-1");
        mkdirSync(oldWorktreePath, { recursive: true });

        writeFileSync(
          join(hashDir, "sessions", "ao-1"),
          [
            "project=myproject",
            "agent=codex",
            "branch=session/ao-1",
            `worktree=${oldWorktreePath}`,
          ].join("\n"),
        );

        const codexShard = join(fakeHome, ".codex", "sessions", "2026", "04", "28");
        mkdirSync(codexShard, { recursive: true });
        const rolloutPath = join(codexShard, "rollout-2026-04-28T12-00-00-thread.jsonl");
        const sessionMeta = {
          type: "session_meta",
          payload: {
            id: "thread-1",
            cwd: oldWorktreePath,
            model: "gpt-5",
          },
        };
        const otherEntry = { type: "user", payload: { content: "hi" } };
        writeFileSync(
          rolloutPath,
          JSON.stringify(sessionMeta) + "\n" + JSON.stringify(otherEntry) + "\n",
        );

        const result = await migrateStorage({
          aoBaseDir,
          globalConfigPath: configPath,
          force: true,
          log: () => {},
        });

        const newWorktreePath = join(
          aoBaseDir,
          "projects",
          "myproject",
          "worktrees",
          "ao-1",
        );

        const rewritten = readFileSync(rolloutPath, "utf-8");
        const lines = rewritten.split("\n").filter(Boolean);
        const firstParsed = JSON.parse(lines[0]) as {
          type: string;
          payload: { cwd: string; id: string; model: string };
        };
        expect(firstParsed.type).toBe("session_meta");
        expect(firstParsed.payload.cwd).toBe(newWorktreePath);
        // Other payload fields must survive the rewrite.
        expect(firstParsed.payload.id).toBe("thread-1");
        expect(firstParsed.payload.model).toBe("gpt-5");
        // Subsequent lines are copied byte-for-byte.
        expect(lines[1]).toBe(JSON.stringify(otherEntry));
        expect(result.codexSessionsRewritten).toBe(1);
      } finally {
        if (origHome === undefined) delete process.env["HOME"];
        else process.env["HOME"] = origHome;
      }
    },
  );

  // Safety: rollouts that don't match any moved cwd must be left alone
  // byte-for-byte. The migrator must never touch unrelated Codex history.
  it("leaves Codex rollouts with non-matching cwd untouched", async () => {
    const origHome = process.env["HOME"];
    const fakeHome = join(testDir, "fake-home-codex-2");
    mkdirSync(fakeHome, { recursive: true });
    process.env["HOME"] = fakeHome;

    try {
      const hashDir = join(aoBaseDir, "aaaaaa000000-myproject");
      mkdirSync(join(hashDir, "sessions"), { recursive: true });
      const oldWorktreePath = join(hashDir, "worktrees", "ao-1");
      mkdirSync(oldWorktreePath, { recursive: true });

      writeFileSync(
        join(hashDir, "sessions", "ao-1"),
        [
          "project=myproject",
          "agent=codex",
          "branch=session/ao-1",
          `worktree=${oldWorktreePath}`,
        ].join("\n"),
      );

      const codexShard = join(fakeHome, ".codex", "sessions", "2026", "04", "28");
      mkdirSync(codexShard, { recursive: true });
      const unrelatedPath = join(codexShard, "rollout-2026-04-28T09-00-00-other.jsonl");
      const unrelatedContent =
        JSON.stringify({
          type: "session_meta",
          payload: { id: "other", cwd: "/some/unrelated/path", model: "gpt-5" },
        }) + "\n";
      writeFileSync(unrelatedPath, unrelatedContent);

      const result = await migrateStorage({
        aoBaseDir,
        globalConfigPath: configPath,
        force: true,
        log: () => {},
      });

      expect(readFileSync(unrelatedPath, "utf-8")).toBe(unrelatedContent);
      expect(result.codexSessionsRewritten).toBe(0);
    } finally {
      if (origHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = origHome;
    }
  });

  it("handles corrupt session metadata during migration without crashing", async () => {
    const hashDir = join(aoBaseDir, "aaaaaa000000-myproject");
    mkdirSync(join(hashDir, "sessions"), { recursive: true });

    // Good session
    writeFileSync(
      join(hashDir, "sessions", "ao-1"),
      "project=myproject\ncreatedAt=2026-04-21T12:00:00.000Z\nbranch=b1\nworktree=/tmp/w1",
    );
    // Corrupt session (binary garbage)
    writeFileSync(join(hashDir, "sessions", "ao-2"), Buffer.from([0x00, 0xff, 0xfe]));
    // Empty session
    writeFileSync(join(hashDir, "sessions", "ao-3"), "");

    const result = await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: () => {},
    });

    // Good session should be migrated
    expect(existsSync(join(aoBaseDir, "projects", "myproject", "sessions", "ao-1.json"))).toBe(
      true,
    );
    // Migration should not crash
    expect(result.projects).toBe(1);
  });
});
