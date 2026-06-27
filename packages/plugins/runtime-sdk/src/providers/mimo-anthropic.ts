/**
 * providers/mimo-anthropic.ts — MiMo (Xiaomi) FULL-AGENT path.
 *
 * MiMo exposes an Anthropic-compatible Messages API endpoint that supports
 * tool_use, so we point the Claude Agent SDK at it to give MiMo the full agent
 * path (tools + system prompt with our rules + discipline hooks) — exactly like
 * a native Claude agent. This module only sets the per-session ANTHROPIC_* env
 * the bundled SDK reads; the actual streaming runs through the shared Claude
 * Agent SDK driver (see providers/claude-agent-sdk.ts).
 */

/**
 * MiMo's Anthropic-compatible Messages API endpoint. Unlike MIMO_BASE_URL
 * (the OpenAI /v1 chat-loop fallback), this endpoint supports tool_use, so we
 * point the Claude Agent SDK at it to give MiMo the full agent path (tools +
 * system prompt with our rules + discipline hooks). Overridable per-session
 * via AO_MIMO_ANTHROPIC_BASE_URL (injected from config mimo.anthropicBaseUrl).
 */
export const MIMO_ANTHROPIC_BASE_URL =
  process.env.AO_MIMO_ANTHROPIC_BASE_URL ?? "https://api.xiaomimimo.com/anthropic";

/**
 * Point the bundled Claude Agent SDK at MiMo's Anthropic-compatible endpoint for
 * THIS host process: set the ANTHROPIC_* env the SDK reads and DELETE
 * ANTHROPIC_API_KEY so the real Anthropic key (from defaults.environment) can't
 * override the MiMo token (auth conflict). Set per-session here (the parent
 * strips inherited ANTHROPIC_* before spawn), so a claude worker spawned from a
 * mimo session does NOT inherit MiMo's base/token — it goes to real Anthropic.
 */
export function applyMimoAnthropicEnv(
  model: string,
  apiKey: string,
  baseUrl: string = MIMO_ANTHROPIC_BASE_URL,
): void {
  process.env.ANTHROPIC_BASE_URL = baseUrl;
  process.env.ANTHROPIC_AUTH_TOKEN = apiKey;
  process.env.ANTHROPIC_MODEL = model;
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
  process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
  process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
  delete process.env.ANTHROPIC_API_KEY;
}
