/**
 * Integration tests for the Claude Code agent plugin.
 *
 * Two test suites:
 *
 * 1. "path encoding & JSONL reading" — validates that toClaudeProjectPath()
 *    resolves to real ~/.claude/projects/ directories and readLastJsonlEntry()
 *    can parse real session files. Only requires Claude to have been run at
 *    least once on this machine (no API key, no tmux needed).
 *
 * 2. "agent-claude-code (integration)" — full lifecycle test spawning a real
 *    Claude process. Requires claude binary, tmux, and ANTHROPIC_API_KEY.
 *
 * Skipped automatically when prerequisites are missing.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  readLastJsonlEntry,
  type ActivityDetection,
  type AgentSessionInfo,
} from "@aoagents/ao-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import claudeCodePlugin, { toClaudeProjectPath } from "@aoagents/ao-plugin-agent-claude-code";
import {
  isTmuxAvailable,
  killSessionsByPrefix,
  createSession,
  killSession,
} from "./helpers/tmux.js";
import { pollUntilEqual, sleep } from "./helpers/polling.js";
import { makeTmuxHandle, makeSession } from "./helpers/session-factory.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Prerequisites
// ---------------------------------------------------------------------------

const SESSION_PREFIX = "ao-inttest-claude-";

async function findClaudeBinary(): Promise<string | null> {
  for (const bin of ["claude"]) {
    try {
      await execFileAsync("which", [bin], { timeout: 5_000 });
      return bin;
    } catch {
      // not found
    }
  }
  return null;
}

const tmuxOk = await isTmuxAvailable();
const claudeBin = await findClaudeBinary();
const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY);
const canRun = tmuxOk && claudeBin !== null && hasApiKey;

// ---------------------------------------------------------------------------
// Path encoding & JSONL reading — real ~/.claude/projects/ validation
// ---------------------------------------------------------------------------

/**
 * Find a workspace path on this machine that has a matching Claude project
 * directory with at least one JSONL session file. Returns null if Claude
 * has never been used (test will skip).
 */
async function findRealClaudeProject(): Promise<{
  workspacePath: string;
  projectDir: string;
  jsonlFile: string;
} | null> {
  const claudeProjectsDir = join(homedir(), ".claude", "projects");
  let dirs: string[];
  try {
    dirs = await readdir(claudeProjectsDir);
  } catch {
    return null;
  }

  for (const dir of dirs) {
    // Reverse the encoding: leading dash → leading slash, internal dashes → slashes
    // This is a heuristic — we just need one workspace that exists on disk
    const projectDir = join(claudeProjectsDir, dir);
    let files: string[];
    try {
      files = await readdir(projectDir);
    } catch {
      continue;
    }

    const jsonlFiles = files.filter((f) => f.endsWith(".jsonl") && !f.startsWith("agent-"));
    if (jsonlFiles.length === 0) continue;

    // Try to reconstruct the workspace path from the encoded dir name
    // Encoded format: /Users/dev/project → -Users-dev-project
    // We can't perfectly reverse this (dashes are ambiguous), but we can
    // verify the forward direction: encode known paths and check if they match
    const candidatePath = "/" + dir.slice(1).replace(/-/g, "/");
    const reEncoded = toClaudeProjectPath(candidatePath);
    if (reEncoded === dir) {
      return {
        workspacePath: candidatePath,
        projectDir,
        jsonlFile: join(projectDir, jsonlFiles[0]),
      };
    }
  }

  return null;
}

const realProject = await findRealClaudeProject();

describe.skipIf(!realProject)("path encoding & JSONL reading (real Claude data)", () => {
  it("toClaudeProjectPath resolves to a real ~/.claude/projects/ directory", () => {
    const encoded = toClaudeProjectPath(realProject!.workspacePath);
    const expectedDir = join(homedir(), ".claude", "projects", encoded);
    expect(expectedDir).toBe(realProject!.projectDir);
  });

  it("readLastJsonlEntry parses a real session JSONL file", async () => {
    const entry = await readLastJsonlEntry(realProject!.jsonlFile);

    expect(entry).not.toBeNull();
    expect(entry!.modifiedAt).toBeInstanceOf(Date);
    // lastType should be a known Claude message type or null (not undefined)
    expect(entry!.lastType === null || typeof entry!.lastType === "string").toBe(true);
  });

  it("readLastJsonlEntry returns a recognized message type", async () => {
    const entry = await readLastJsonlEntry(realProject!.jsonlFile);
    if (entry?.lastType) {
      const knownTypes = [
        "user",
        "assistant",
        "system",
        "last-prompt",
        "tool_use",
        "progress",
        "permission_request",
        "permission-mode",
        "error",
        "summary",
        "result",
        "file-history-snapshot",
        "queue-operation",
        "pr-link",
      ];
      expect(knownTypes).toContain(entry.lastType);
    }
  });

  it("getActivityState returns a valid state for a real workspace path", async () => {
    const agent = claudeCodePlugin.create();
    // Mock isProcessRunning to return false — we're not testing process detection,
    // we're testing path resolution and JSONL parsing
    vi.spyOn(agent, "isProcessRunning").mockResolvedValue(false);

    const handle = makeTmuxHandle("fake-session");
    const session = makeSession("real-path-test", handle, realProject!.workspacePath);
    const state = await agent.getActivityState(session);

    // Process is "not running" so should get "exited" — but the important thing
    // is it didn't return null (which would mean the path didn't resolve)
    expect(state).not.toBeNull();
    expect(state?.state ?? state).toBe("exited");
  });
});

// ---------------------------------------------------------------------------
// Full lifecycle test (requires claude binary + API key + tmux)
// ---------------------------------------------------------------------------

describe.skipIf(!canRun)("agent-claude-code (integration)", () => {
  const agent = claudeCodePlugin.create();
  const sessionName = `${SESSION_PREFIX}${Date.now()}`;
  let tmpDir: string;

  // Observations captured while the agent is alive
  let aliveRunning = false;
  let aliveActivityState: ActivityDetection | null | undefined;
  let aliveSessionInfo: AgentSessionInfo | null = null;

  // Observations captured after the agent exits
  let exitedRunning: boolean;
  let exitedActivityState: ActivityDetection | null;
  let exitedSessionInfo: AgentSessionInfo | null;

  beforeAll(async () => {
    await killSessionsByPrefix(SESSION_PREFIX);

    // Create temp workspace — resolve symlinks (macOS /tmp → /private/tmp)
    const raw = await mkdtemp(join(tmpdir(), "ao-inttest-claude-"));
    tmpDir = await realpath(raw);

    // Spawn Claude with a task that generates observable activity (file creation)
    const cmd = `CLAUDECODE= ${claudeBin} -p 'Create a file called test.txt with the content "integration test"'`;
    await createSession(sessionName, cmd, tmpDir);

    const handle = makeTmuxHandle(sessionName);
    const session = makeSession("inttest-claude", handle, tmpDir);

    // Poll until we capture "alive" observations
    // Claude needs time to start, create JSONL, and begin processing
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const running = await agent.isProcessRunning(handle);
      if (running) {
        aliveRunning = true;
        try {
          const activityState = await agent.getActivityState(session);
          if (activityState?.state !== "exited") {
            aliveActivityState = activityState;
            // Also capture session info while alive
            aliveSessionInfo = await agent.getSessionInfo(session);
            break;
          }
        } catch {
          // JSONL might not exist yet, keep polling
        }
      }
      await sleep(1_000);
    }

    // Wait for agent to exit (simple task should complete within 90s)
    exitedRunning = await pollUntilEqual(() => agent.isProcessRunning(handle), false, {
      timeoutMs: 90_000,
      intervalMs: 2_000,
    });

    // Capture post-exit observations
    exitedActivityState = await agent.getActivityState(session);
    exitedSessionInfo = await agent.getSessionInfo(session);
  }, 150_000);

  afterAll(async () => {
    await killSession(sessionName);
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 30_000);

  it("isProcessRunning → true while agent is alive", () => {
    expect(aliveRunning).toBe(true);
  });

  it("getActivityState → returns valid non-exited state while agent is alive", () => {
    expect(aliveActivityState).toBeDefined();
    expect(aliveActivityState?.state).not.toBe("exited");
    // May be null (no JSONL yet) or a concrete state
    expect([null, "active", "ready", "idle", "waiting_input", "blocked"]).toContain(
      aliveActivityState?.state ?? null,
    );
  });

  it("getSessionInfo → returns session data while agent is alive (or null if path mismatch)", () => {
    // The JSONL path depends on Claude's internal encoding of workspacePath.
    // If the temp dir resolves differently (symlinks, etc.), may return null.
    // Both outcomes are acceptable — the key is it doesn't throw.
    if (aliveSessionInfo !== null) {
      expect(aliveSessionInfo).toHaveProperty("summary");
      expect(aliveSessionInfo).toHaveProperty("agentSessionId");
      expect(typeof aliveSessionInfo.agentSessionId).toBe("string");
    }
  });

  it("isProcessRunning → false after agent exits", () => {
    expect(exitedRunning).toBe(false);
  });

  it("getActivityState → returns exited after agent process terminates", () => {
    expect(exitedActivityState?.state).toBe("exited");
  });

  it("getSessionInfo → returns session data after agent exits (or null if path mismatch)", () => {
    // JSONL should still be readable after exit, but path encoding may cause null.
    // Both outcomes are acceptable — the key is it doesn't throw.
    if (exitedSessionInfo !== null) {
      expect(exitedSessionInfo).toHaveProperty("summary");
      expect(exitedSessionInfo).toHaveProperty("agentSessionId");
      expect(typeof exitedSessionInfo.agentSessionId).toBe("string");
    }
  });
});
