/**
 * Integration tests for the OpenCode agent plugin.
 *
 * Requires:
 *   - `opencode` binary on PATH
 *   - tmux installed and running
 *   - Any supported API key (ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY,
 *     GEMINI_API_KEY, ZAI_API_KEY, ZAI_CODING_PLAN_API_KEY, KIMI_API_KEY,
 *     OPENROUTER_API_KEY, GROK_API_KEY, GITHUB_TOKEN, COPILOT_API_KEY)
 *
 * Skipped automatically when prerequisites are missing.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ActivityDetection, AgentSessionInfo } from "@aoagents/ao-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import opencodePlugin from "@aoagents/ao-plugin-agent-opencode";
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

const SESSION_PREFIX = "ao-inttest-opencode-";

async function findOpencodeBinary(): Promise<string | null> {
  try {
    await execFileAsync("which", ["opencode"], { timeout: 5_000 });
    return "opencode";
  } catch {
    return null;
  }
}

/** Verify opencode can start (has API key, binary works). */
async function canOpencodeRun(bin: string): Promise<boolean> {
  const probe = "ao-inttest-opencode-probe";
  try {
    await killSessionsByPrefix(probe);
    await createSession(probe, `${bin} run 'Say hello'`, tmpdir());
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1_000));
      try {
        await execFileAsync("tmux", ["has-session", "-t", probe], { timeout: 5_000 });
      } catch {
        return true;
      }
    }
    await killSession(probe);
    return false;
  } catch {
    return false;
  }
}

const tmuxOk = await isTmuxAvailable();
const opencodeBin = await findOpencodeBinary();

async function hasOpencodeCredentials(): Promise<boolean> {
  const hasEnvKey = Boolean(
    process.env.ANTHROPIC_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.ZAI_API_KEY ||
    process.env.ZAI_CODING_PLAN_API_KEY ||
    process.env.KIMI_API_KEY ||
    process.env.OPENROUTER_API_KEY ||
    process.env.GROK_API_KEY ||
    process.env.GITHUB_TOKEN ||
    process.env.COPILOT_API_KEY,
  );

  if (hasEnvKey) return true;

  try {
    const authPath = join(homedir(), ".local", "share", "opencode", "auth.json");
    await readFile(authPath, "utf-8");
    return true;
  } catch {
    return false;
  }
}

const hasCredentials = await hasOpencodeCredentials();
const opencodeReady = opencodeBin !== null && hasCredentials && (await canOpencodeRun(opencodeBin));
const canRun = tmuxOk && opencodeReady;

// ---------------------------------------------------------------------------
// Lifecycle Tests (requires opencode + tmux + API key)
// ---------------------------------------------------------------------------

describe.skipIf(!canRun)("agent-opencode (integration)", () => {
  const agent = opencodePlugin.create();
  const sessionName = `${SESSION_PREFIX}${Date.now()}`;
  let tmpDir: string;

  let aliveRunning = false;
  let aliveActivityState: ActivityDetection | null | undefined;
  let exitedRunning: boolean;
  let exitedActivityState: ActivityDetection | null;
  let sessionInfo: AgentSessionInfo | null;

  beforeAll(async () => {
    await killSessionsByPrefix(SESSION_PREFIX);
    tmpDir = await mkdtemp(join(tmpdir(), "ao-inttest-opencode-"));

    const cmd = `${opencodeBin} run 'Say hello and nothing else'`;
    await createSession(sessionName, cmd, tmpDir);

    const handle = makeTmuxHandle(sessionName);
    const session = makeSession("inttest-opencode", handle, tmpDir);

    const deadline = Date.now() + 15_000;
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
      await sleep(500);
    }

    exitedRunning = await pollUntilEqual(() => agent.isProcessRunning(handle), false, {
      timeoutMs: 90_000,
      intervalMs: 2_000,
    });

    exitedActivityState = await agent.getActivityState(session);
    sessionInfo = await agent.getSessionInfo(session);
  }, 120_000);

  afterAll(async () => {
    await killSession(sessionName);
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 30_000);

  it("isProcessRunning -> true while agent is alive", () => {
    expect(aliveRunning).toBe(true);
  });

  it("getActivityState -> returns null while agent is running (no per-session tracking)", () => {
    if (aliveActivityState !== undefined) {
      expect(aliveActivityState).toBeNull();
    }
  });

  it("isProcessRunning -> false after agent exits", () => {
    expect(exitedRunning).toBe(false);
  });

  it("getActivityState -> returns exited after agent process terminates", () => {
    expect(exitedActivityState?.state).toBe("exited");
  });

  it("getSessionInfo -> null (not implemented for opencode)", () => {
    expect(sessionInfo).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Launch command tests (no external dependencies)
// ---------------------------------------------------------------------------

describe("getLaunchCommand (integration)", () => {
  const agent = opencodePlugin.create();

  const baseConfig = {
    sessionId: "test-1",
    projectConfig: {
      name: "test",
      repo: "owner/repo",
      path: "/workspace",
      defaultBranch: "main",
      sessionPrefix: "test",
    },
  };

  it("generates correct command with subagent", () => {
    const cmd = agent.getLaunchCommand({
      ...baseConfig,
      subagent: "sisyphus",
      prompt: "fix the bug",
    });
    expect(cmd).toContain("--agent 'sisyphus'");
    expect(cmd).toContain(
      "opencode run --format json --title 'AO:test-1' --agent 'sisyphus' --command true",
    );
    expect(cmd).toContain("'fix the bug'");
    expect(cmd).toContain("exec opencode --session \"$SES_ID\" --prompt 'fix the bug'");
    expect(cmd).toContain("--agent 'sisyphus'");
  });

  it("generates correct command with systemPrompt", () => {
    const cmd = agent.getLaunchCommand({
      ...baseConfig,
      systemPrompt: "You are an orchestrator",
      prompt: "do the task",
    });
    expect(cmd).toContain("opencode run --format json --title 'AO:test-1' --command true");
    expect(cmd).toContain(`exec opencode --session "$SES_ID" --prompt 'do the task'`);
  });

  it("generates correct command with systemPromptFile", () => {
    const cmd = agent.getLaunchCommand({
      ...baseConfig,
      systemPromptFile: "/tmp/orchestrator-prompt.md",
      prompt: "do the task",
    });
    expect(cmd).toContain("opencode run --format json --title 'AO:test-1' --command true");
    expect(cmd).toContain(`exec opencode --session "$SES_ID" --prompt 'do the task'`);
  });

  it("generates correct command with model override", () => {
    const cmd = agent.getLaunchCommand({
      ...baseConfig,
      model: "claude-sonnet-4-5-20250929",
      prompt: "do the task",
    });
    expect(cmd).toContain("--model 'claude-sonnet-4-5-20250929'");
  });

  it("combines subagent + systemPrompt + model + prompt", () => {
    const cmd = agent.getLaunchCommand({
      ...baseConfig,
      subagent: "oracle",
      systemPrompt: "You are an expert",
      model: "gpt-5.2",
      prompt: "review this code",
    });
    expect(cmd).toContain("--agent 'oracle'");
    expect(cmd).toContain(
      "opencode run --format json --title 'AO:test-1' --agent 'oracle' --model 'gpt-5.2' --command true",
    );
    expect(cmd).toContain(
      `exec opencode --session "$SES_ID" --prompt 'review this code' --agent 'oracle' --model 'gpt-5.2'`,
    );
    expect(cmd).toContain("--model 'gpt-5.2'");
  });

  it("systemPromptFile takes precedence over systemPrompt", () => {
    const cmd = agent.getLaunchCommand({
      ...baseConfig,
      systemPrompt: "direct prompt",
      systemPromptFile: "/tmp/file-prompt.md",
    });
    expect(cmd).not.toContain("direct prompt");
  });

  it("uses prompt with systemPromptFile for orchestrator-style launch", () => {
    const cmd = agent.getLaunchCommand({
      ...baseConfig,
      sessionId: "test-orchestrator",
      permissions: "permissionless",
      systemPromptFile: "/tmp/orchestrator-prompt.md",
    });
    expect(cmd).toContain(
      "opencode run --format json --title 'AO:test-orchestrator' --command true",
    );
    expect(cmd).toContain('exec opencode --session "$SES_ID"');
  });

  it("escapes single quotes in systemPrompt", () => {
    const cmd = agent.getLaunchCommand({
      ...baseConfig,
      systemPrompt: "it's important",
    });
    expect(cmd).not.toContain("'it'\\''s important'");
  });

  it("escapes path with single quotes in systemPromptFile", () => {
    const cmd = agent.getLaunchCommand({
      ...baseConfig,
      systemPromptFile: "/tmp/it's-prompt.md",
    });
    expect(cmd).not.toContain("/tmp/it'\\''s-prompt.md");
  });

  it("handles prompt with special shell characters", () => {
    const cmd = agent.getLaunchCommand({
      ...baseConfig,
      prompt: "fix  and `backtick` and 'quote'",
    });
    expect(cmd).toContain("opencode run --format json --title 'AO:test-1' --command true");
    expect(cmd).toContain("fix  and `backtick`");
    expect(cmd).toContain('exec opencode --session "$SES_ID" --prompt');
  });

  it("handles empty prompt", () => {
    const cmd = agent.getLaunchCommand({
      ...baseConfig,
      prompt: "",
    });
    expect(cmd).toContain("opencode run --format json --title 'AO:test-1' --command true");
    expect(cmd).toContain('exec opencode --session "$SES_ID"');
    expect(cmd).toContain("opencode session list --format json");
    expect(cmd).toContain("AO:test-1");
  });

  it("handles prompt with newlines", () => {
    const cmd = agent.getLaunchCommand({
      ...baseConfig,
      prompt: "line1\nline2",
    });
    expect(cmd).toContain("opencode run --format json --title 'AO:test-1' --command true");
    expect(cmd).toContain('exec opencode --session "$SES_ID" --prompt \'line1');
  });

  it("uses run bootstrap launch for fresh sessions", () => {
    const cmd = agent.getLaunchCommand({
      ...baseConfig,
      prompt: "start work",
    });
    expect(cmd).toContain("--title 'AO:test-1'");
    expect(cmd).toContain("opencode run --format json --title 'AO:test-1' --command true");
    expect(cmd).toContain("exec opencode --session \"$SES_ID\" --prompt 'start work'");
    expect(cmd).toContain('exec opencode --session "$SES_ID"');
  });

  it("uses --session when existing OpenCode session id is provided", () => {
    const cmd = agent.getLaunchCommand({
      ...baseConfig,
      projectConfig: {
        ...baseConfig.projectConfig,
        agentConfig: {
          opencodeSessionId: "ses_abc123",
        },
      },
      prompt: "continue",
    });
    expect(cmd).toBe("opencode --session 'ses_abc123' --prompt 'continue'");
  });
});

// ---------------------------------------------------------------------------
// getEnvironment tests
// ---------------------------------------------------------------------------

describe("getEnvironment (integration)", () => {
  const agent = opencodePlugin.create();

  const baseConfig = {
    sessionId: "sess-123",
    projectConfig: {
      name: "test",
      repo: "owner/repo",
      path: "/workspace",
      defaultBranch: "main",
      sessionPrefix: "test",
    },
  };

  it("sets AO_SESSION_ID", () => {
    const env = agent.getEnvironment(baseConfig);
    expect(env["AO_SESSION_ID"]).toBe("sess-123");
  });

  it("sets AO_ISSUE_ID when provided", () => {
    const env = agent.getEnvironment({ ...baseConfig, issueId: "GH-42" });
    expect(env["AO_ISSUE_ID"]).toBe("GH-42");
  });

  it("omits AO_ISSUE_ID when not provided", () => {
    const env = agent.getEnvironment(baseConfig);
    expect(env["AO_ISSUE_ID"]).toBeUndefined();
  });

  it("does not set AO_PROJECT_ID (caller's responsibility)", () => {
    const env = agent.getEnvironment(baseConfig);
    expect(env["AO_PROJECT_ID"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// detectActivity tests
// ---------------------------------------------------------------------------

describe("detectActivity (integration)", () => {
  const agent = opencodePlugin.create();

  it("returns idle for empty terminal output", () => {
    expect(agent.detectActivity("")).toBe("idle");
  });

  it("returns idle for whitespace-only terminal output", () => {
    expect(agent.detectActivity("   \n  ")).toBe("idle");
  });

  it("returns active for non-empty terminal output", () => {
    expect(agent.detectActivity("opencode is working\n")).toBe("active");
  });

  it("returns active for output with ANSI codes", () => {
    expect(agent.detectActivity("\u001b[32mSuccess\u001b[0m\n")).toBe("active");
  });

  it("returns active for multiline output", () => {
    expect(agent.detectActivity("line1\nline2\nline3\n")).toBe("active");
  });
});
