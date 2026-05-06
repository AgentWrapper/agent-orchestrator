/**
 * Integration tests for the Aider agent plugin.
 *
 * Requires:
 *   - `aider` binary on PATH
 *   - tmux installed and running
 *   - ANTHROPIC_API_KEY or OPENAI_API_KEY set (aider may open a browser if missing)
 *
 * Skipped automatically when prerequisites are missing.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ActivityDetection, AgentSessionInfo } from "@aoagents/ao-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import aiderPlugin from "@aoagents/ao-plugin-agent-aider";
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

const SESSION_PREFIX = "ao-inttest-aider-";

async function findAiderBinary(): Promise<string | null> {
  for (const bin of ["aider"]) {
    try {
      await execFileAsync("which", [bin], { timeout: 5_000 });
      return bin;
    } catch {
      // not found
    }
  }
  return null;
}

/**
 * Verify aider has a usable API key by running a quick smoke test inside
 * tmux (same context as the real test). A direct `execFileAsync` check
 * would inherit the vitest process's env, which may differ from tmux's.
 */
async function canAiderConnect(bin: string): Promise<boolean> {
  const probe = "ao-inttest-aider-probe";
  try {
    await killSessionsByPrefix(probe);
    await createSession(probe, `${bin} --exit --no-git --no-browser`, tmpdir());
    // Wait for the probe to finish (should take <10s if key is present)
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1_000));
      try {
        await execFileAsync("tmux", ["has-session", "-t", probe], { timeout: 5_000 });
        // session still exists — keep waiting
      } catch {
        // session is gone → aider exited cleanly
        return true;
      }
    }
    // Still running after 20s → stuck on auth prompt
    await killSession(probe);
    return false;
  } catch {
    return false;
  }
}

const tmuxOk = await isTmuxAvailable();
const aiderBin = await findAiderBinary();
const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);
// Skip the expensive canAiderConnect probe if no API key is available
const aiderReady = hasApiKey && aiderBin !== null && (await canAiderConnect(aiderBin));
const canRun = tmuxOk && aiderReady;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!canRun)("agent-aider (integration)", () => {
  const agent = aiderPlugin.create();
  const sessionName = `${SESSION_PREFIX}${Date.now()}`;
  let tmpDir: string;

  // Observations captured while the agent is alive
  let aliveRunning = false;
  let aliveActivityState: ActivityDetection | null | undefined;

  // Observations captured after the agent exits
  let exitedRunning: boolean;
  let exitedActivityState: ActivityDetection | null;
  let sessionInfo: AgentSessionInfo | null;

  beforeAll(async () => {
    await killSessionsByPrefix(SESSION_PREFIX);
    tmpDir = await mkdtemp(join(tmpdir(), "ao-inttest-aider-"));

    // --no-git avoids needing a git repo, --yes auto-accepts, --no-browser
    // prevents aider from opening the browser for auth (which would block).
    const cmd = `${aiderBin} --message 'Say hello and nothing else' --yes --no-auto-commits --no-git --no-browser`;
    await createSession(sessionName, cmd, tmpDir);

    const handle = makeTmuxHandle(sessionName);
    const session = makeSession("inttest-aider", handle, tmpDir);

    // Poll until we observe the agent is running. Aider has ~5s Python startup.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const running = await agent.isProcessRunning(handle);
      if (running) {
        aliveRunning = true;
        const activityState = await agent.getActivityState(session);
        if (activityState?.state !== "exited") {
          aliveActivityState = activityState;
          break;
        }
      }
      await sleep(1_000);
    }

    // Wait for agent to exit — aider with --message should exit after responding
    exitedRunning = await pollUntilEqual(() => agent.isProcessRunning(handle), false, {
      timeoutMs: 90_000,
      intervalMs: 2_000,
    });

    exitedActivityState = await agent.getActivityState(session);
    sessionInfo = await agent.getSessionInfo(session);
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

  it("getActivityState → returns valid state while agent is running", () => {
    // Aider checks git commits and chat history mtime for activity detection.
    // May return null if no chat history exists yet.
    if (aliveActivityState !== undefined) {
      expect(aliveActivityState?.state).not.toBe("exited");
      expect([null, "active", "ready", "idle", "waiting_input", "blocked"]).toContain(
        aliveActivityState?.state ?? null,
      );
    }
  });

  it("isProcessRunning → false after agent exits", () => {
    expect(exitedRunning).toBe(false);
  });

  it("getActivityState → returns exited after agent process terminates", () => {
    expect(exitedActivityState?.state).toBe("exited");
  });

  it("getSessionInfo → null (not implemented for aider)", () => {
    expect(sessionInfo).toBeNull();
  });
});
