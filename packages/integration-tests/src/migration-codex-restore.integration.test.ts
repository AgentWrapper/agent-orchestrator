/**
 * Integration round-trip for the boundary-bug-hunter Phase 1 finding on
 * PR #1466: after `ao migrate-storage` rewrites a session's worktree path
 * from V1 (`{hash}-{project}/worktrees/{sid}`) to V2
 * (`projects/{projectId}/worktrees/{sid}`), the agent-codex plugin must
 * still be able to find the prior Codex thread and produce a real
 * `codex resume <threadId>` command.
 *
 * The migrator owns rewriting `~/.codex/sessions/**\/rollout-*.jsonl`
 * `session_meta.payload.cwd`; the consumer (agent-codex) matches the
 * rewritten cwd against the migrated `Session.workspacePath`. This test
 * exercises both halves end-to-end against real fs.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { migrateStorage } from "@aoagents/ao-core";
import { makeSession } from "./helpers/session-factory.js";

describe("migrate-storage → agent-codex.getRestoreCommand round-trip", () => {
  let testDir: string;
  let aoBaseDir: string;
  let configPath: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), `ao-mig-codex-rt-${randomUUID()}-`));
    aoBaseDir = join(testDir, ".agent-orchestrator");
    mkdirSync(aoBaseDir, { recursive: true });
    configPath = join(aoBaseDir, "config.yaml");
    writeFileSync(
      configPath,
      [
        "projects:",
        "  myproject:",
        "    name: My Project",
        `    path: ${join(testDir, "repo")}`,
        "    storageKey: aaaaaa000000",
        "",
      ].join("\n"),
    );
    mkdirSync(join(testDir, "repo"), { recursive: true });
    prevHome = process.env["HOME"];
    process.env["HOME"] = testDir;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
    rmSync(testDir, { recursive: true, force: true });
  });

  it("produces a `codex resume <threadId>` command for a migrated Codex session", async () => {
    // 1) Seed a V1 layout with a Codex session whose worktree is at the
    //    old path. The session-meta payload inside the rollout JSONL
    //    points at that old path — exactly what the user would have on
    //    disk before running migrate-storage.
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

    const codexShard = join(testDir, ".codex", "sessions", "2026", "04", "28");
    mkdirSync(codexShard, { recursive: true });
    const rolloutPath = join(codexShard, "rollout-2026-04-28T12-00-00-thread.jsonl");
    const sessionMeta = {
      type: "session_meta",
      payload: {
        id: "thread-abc-xyz",
        cwd: oldWorktreePath,
        model: "gpt-5",
      },
    };
    writeFileSync(rolloutPath, JSON.stringify(sessionMeta) + "\n");

    // 2) Run the real migrator. It rewrites the rollout's session_meta
    //    cwd to point at the new V2 worktree path.
    const result = await migrateStorage({
      aoBaseDir,
      globalConfigPath: configPath,
      force: true,
      log: () => {},
    });
    expect(result.codexSessionsRewritten).toBe(1);

    const newWorktreePath = join(
      aoBaseDir,
      "projects",
      "myproject",
      "worktrees",
      "ao-1",
    );
    const rewritten = JSON.parse(
      readFileSync(rolloutPath, "utf-8").split("\n")[0],
    ) as { payload: { cwd: string; id: string } };
    expect(rewritten.payload.cwd).toBe(newWorktreePath);

    // 3) Real consumer call. Build a Session pointing at the V2 worktree
    //    (what `SessionManager.list()` would yield post-migration) and
    //    ask the codex plugin for its restore command. Without the fix
    //    this returns `null` because the rollout's old cwd no longer
    //    matches the migrated workspacePath.
    // Dynamic import: agent-codex captures `~/.codex/sessions` from
    // `homedir()` at module-evaluation time, so we must import it after
    // setting `process.env["HOME"]`.
    const codexPlugin = (await import("@aoagents/ao-plugin-agent-codex"))
      .default;
    const agent = codexPlugin.create();
    const session = makeSession("ao-1", null, newWorktreePath);
    const projectConfig = {
      name: "My Project",
      repo: "owner/repo",
      path: join(testDir, "repo"),
      defaultBranch: "main",
      sessionPrefix: "ao",
    };
    const cmd = await agent.getRestoreCommand!(session, projectConfig);

    expect(cmd).not.toBeNull();
    expect(cmd).toContain("'codex' resume");
    expect(cmd).toContain("'thread-abc-xyz'");
  });
});
