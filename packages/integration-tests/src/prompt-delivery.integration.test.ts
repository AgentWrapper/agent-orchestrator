/**
 * Integration test: Claude Code prompt delivery — `-p` (one-shot) vs interactive mode.
 *
 * Demonstrates the bug and the fix:
 *
 * 1. "claude -p exits after work" — launches Claude with -p, proves the process
 *    exits after responding. This is the bug: the agent can't receive follow-ups.
 *
 * 2. "interactive claude stays alive" — launches Claude without -p, delivers
 *    the prompt post-launch via runtime.sendMessage(), proves the process stays
 *    alive and can receive follow-up messages.
 *
 * Requires: tmux, claude binary, ANTHROPIC_API_KEY.
 */

import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import claudeCodePlugin from "@aoagents/ao-plugin-agent-claude-code";
import runtimeTmuxPlugin from "@aoagents/ao-plugin-runtime-tmux";
import {
  isTmuxAvailable,
  killSessionsByPrefix,
  createSession,
  killSession,
  capturePane,
} from "./helpers/tmux.js";
import { pollUntilEqual, sleep } from "./helpers/polling.js";
import { makeTmuxHandle } from "./helpers/session-factory.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Prerequisites
// ---------------------------------------------------------------------------

const SESSION_PREFIX = "ao-inttest-prompt-";

/** Lines of scrollback to capture — generous to account for Claude's TUI output. */
const CAPTURE_LINES = 500;

async function findClaudeBinary(): Promise<string | null> {
  try {
    await execFileAsync("which", ["claude"], { timeout: 5_000 });
    return "claude";
  } catch {
    return null;
  }
}

/**
 * Wait for Claude Code's TUI to be ready for input.
 * Polls the tmux pane for Claude's prompt character (❯) on its own line.
 * Returns false if the OAuth/login screen is detected instead.
 */
async function waitForTuiReady(
  sessionName: string,
  timeoutMs = 60_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const output = await capturePane(sessionName, CAPTURE_LINES);

    // Bail early if OAuth/login screen is showing — TUI won't become ready
    if (/sign in|oauth|Paste code here/i.test(output)) return false;

    // Claude Code shows ❯ when idle. Check the last non-empty line specifically
    // (not the end of the full output) to avoid matching "prompted >" etc.
    const lastLine = output
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .pop();
    if (lastLine && /^\s*❯\s*$/.test(lastLine)) return true;

    await sleep(2_000);
  }
  return false;
}

const tmuxOk = await isTmuxAvailable();
const claudeBin = await findClaudeBinary();
const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY);
const canRun = tmuxOk && claudeBin !== null && hasApiKey;
// Interactive mode requires OAuth login. ANTHROPIC_API_KEY alone only works with -p.
// CI environments (GitHub Actions) typically only have API keys, not OAuth sessions.
const canRunInteractive = canRun && !process.env.CI;

// ---------------------------------------------------------------------------
// Test 1: -p flag causes Claude to exit (the bug)
// ---------------------------------------------------------------------------

describe.skipIf(!canRun)("claude -p exits after completing work (the bug)", () => {
  const agent = claudeCodePlugin.create();
  const sessionName = `${SESSION_PREFIX}print-${Date.now()}`;
  let tmpDir: string;

  beforeAll(async () => {
    await killSessionsByPrefix(`${SESSION_PREFIX}print-`);
    const raw = await mkdtemp(join(tmpdir(), "ao-inttest-prompt-print-"));
    tmpDir = await realpath(raw);

    // Create a bash session (keeps tmux pane alive after Claude exits)
    await createSession(sessionName, "bash", tmpDir);
    await sleep(500);

    // Launch Claude with -p (print-and-exit mode)
    await execFileAsync(
      "tmux",
      [
        "send-keys",
        "-t",
        sessionName,
        "-l",
        "CLAUDECODE= claude --dangerously-skip-permissions -p 'Respond with exactly: SENTINEL_P_DELIVERED'",
      ],
      { timeout: 10_000 },
    );
    await execFileAsync("tmux", ["send-keys", "-t", sessionName, "Enter"], {
      timeout: 5_000,
    });
  }, 30_000);

  afterAll(async () => {
    await killSession(sessionName);
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }, 30_000);

  it("claude exits after responding to -p prompt", async () => {
    const handle = makeTmuxHandle(sessionName);

    // Wait for Claude to start
    await pollUntilEqual(() => agent.isProcessRunning(handle), true, {
      timeoutMs: 30_000,
      intervalMs: 1_000,
    });

    // Wait for it to exit — -p mode always exits after responding
    const exited = await pollUntilEqual(() => agent.isProcessRunning(handle), false, {
      timeoutMs: 90_000,
      intervalMs: 2_000,
    });
    expect(exited).toBe(false);

    // Verify the work was done (Claude did respond before exiting)
    const output = await capturePane(sessionName, CAPTURE_LINES);
    expect(output).toContain("SENTINEL_P_DELIVERED");

    // This is the problem: process is gone, ao send has nothing to talk to
    const running = await agent.isProcessRunning(handle);
    expect(running).toBe(false);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Test 2: interactive mode + post-launch prompt keeps Claude alive (the fix)
// ---------------------------------------------------------------------------

describe.skipIf(!canRunInteractive)(
  "interactive claude stays alive after post-launch prompt (the fix)",
  () => {
    const agent = claudeCodePlugin.create();
    const runtime = runtimeTmuxPlugin.create();
    const sessionName = `${SESSION_PREFIX}interactive-${Date.now()}`;
    let tmpDir: string;
    const handle = makeTmuxHandle(sessionName);

    beforeAll(async () => {
      await killSessionsByPrefix(`${SESSION_PREFIX}interactive-`);
      const raw = await mkdtemp(join(tmpdir(), "ao-inttest-prompt-interactive-"));
      tmpDir = await realpath(raw);

      // Create a bash session
      await createSession(sessionName, "bash", tmpDir);
      await sleep(500);

      // Launch Claude WITHOUT -p (interactive mode) — this is the fix
      await execFileAsync(
        "tmux",
        [
          "send-keys",
          "-t",
          sessionName,
          "-l",
          "CLAUDECODE= claude --dangerously-skip-permissions",
        ],
        { timeout: 10_000 },
      );
      await execFileAsync("tmux", ["send-keys", "-t", sessionName, "Enter"], {
        timeout: 5_000,
      });

      // Wait for Claude to start
      await pollUntilEqual(() => agent.isProcessRunning(handle), true, {
        timeoutMs: 30_000,
        intervalMs: 1_000,
      });

      // Wait for Claude's TUI to be fully ready (shows prompt character ❯)
      await waitForTuiReady(sessionName, 60_000);

      // Deliver the initial prompt post-launch (what the fix does)
      await runtime.sendMessage(handle, "Respond with exactly: SENTINEL_I_DELIVERED");

      // Wait for Claude to process the prompt and return to idle (❯)
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        const output = await capturePane(sessionName, CAPTURE_LINES);
        // Check that Claude responded (sentinel in output) AND is back at idle prompt (❯)
        const lastLine = output
          .split("\n")
          .filter((l) => l.trim().length > 0)
          .pop();
        if (output.includes("SENTINEL_I_DELIVERED") && lastLine && /^\s*❯\s*$/.test(lastLine)) {
          break;
        }
        await sleep(2_000);
      }
    }, 180_000);

    afterAll(async () => {
      await killSession(sessionName);
      if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }, 30_000);

    it("prompt was delivered and processed", async () => {
      const output = await capturePane(sessionName, CAPTURE_LINES);
      expect(output).toContain("SENTINEL_I_DELIVERED");
    });

    it("claude is still running after completing the task", async () => {
      const running = await agent.isProcessRunning(handle);
      expect(running).toBe(true);
    });

    it("can receive and process a follow-up message", async () => {
      await runtime.sendMessage(handle, "Respond with exactly: SENTINEL_FOLLOWUP_OK");

      const deadline = Date.now() + 90_000;
      let output = "";
      while (Date.now() < deadline) {
        output = await capturePane(sessionName, CAPTURE_LINES);
        if (output.includes("SENTINEL_FOLLOWUP_OK")) break;
        await sleep(2_000);
      }

      expect(output).toContain("SENTINEL_FOLLOWUP_OK");

      // Still alive after follow-up
      const stillRunning = await agent.isProcessRunning(handle);
      expect(stillRunning).toBe(true);
    }, 120_000);
  },
);
