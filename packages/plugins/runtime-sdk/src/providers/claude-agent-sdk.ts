/**
 * providers/claude-agent-sdk.ts — the default driver: Claude via
 * @anthropic-ai/claude-agent-sdk. The MiMo full-agent path shares this exact
 * query() call (it just points ANTHROPIC_* at MiMo's Anthropic-compatible
 * endpoint first — see providers/mimo-anthropic.ts).
 */

import { query, type EffortLevel, type PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { SessionHost } from "../host/session-host.js";

export interface ClaudeAgentModeOptions {
  cwd: string;
  permissionMode: PermissionMode;
  /** Persistent persona/rules appended to the Claude Code preset; null = omit. */
  appendSystemPrompt: string | null;
  /** Provider session id to resume, or null for a fresh session. */
  resumeFrom: string | null;
  /** Model id, or null to use the SDK default. */
  model: string | null;
  /** Reasoning-effort override, or null to use the SDK default. */
  effort: EffortLevel | null;
  /** Turn-1 prompt submitted once after the stream starts, or null. */
  initialPrompt: string | null;
}

/**
 * Start the streaming Claude Agent SDK session and pump it into the host. Builds
 * the query() with the same options the standalone host has always used; this is
 * a behavior-preserving extraction of the default path out of sdk-host.
 */
export async function runClaudeAgentMode(
  host: SessionHost,
  opts: ClaudeAgentModeOptions,
): Promise<void> {
  const useCanUseTool = opts.permissionMode !== "bypassPermissions";
  const q = query({
    prompt: host.input,
    options: {
      cwd: opts.cwd,
      // Pin the filesystem settings sources explicitly. In claude-agent-sdk
      // 0.3.186 the omitted default is ALREADY ["user","project","local"]
      // (runtime constant `Wre`, mirrored by resolveSettings) — so this is a
      // behavior-preserving no-op today. We keep it as a defensive pin: it
      // documents that the spawned session DEPENDS on file settings being
      // loaded, and guards against a future SDK bump flipping the default to
      // isolation mode (`[]`). What we rely on: 'user' → ~/.claude discipline
      // hooks (orchestrator-no-inline-code, pre-spawn-rlm, rtk); 'project'/'local'
      // → ao's per-worktree .claude activity/metadata inject. settingSources
      // governs ONLY settings/hook loading — permission approval still flows
      // through permissionMode/allowDangerouslySkipPermissions below, so
      // bypassPermissions keeps priority and no MCP/permission surprises leak in.
      settingSources: ["user", "project", "local"],
      // PERSISTENT persona/rules. Append to the Claude Code preset (do NOT
      // replace it) so the agent keeps its base tooling/system prompt and only
      // GAINS our orchestrator/worker rules. Sent on every request by the
      // Anthropic API, so it survives resume — the whole point of this seam.
      // Omitted entirely when no persona is configured → unchanged behavior.
      // The MiMo full-agent path (Anthropic-compatible endpoint) shares this
      // query() call, so MiMo gets the persona for free too.
      ...(opts.appendSystemPrompt
        ? {
            systemPrompt: {
              type: "preset" as const,
              preset: "claude_code" as const,
              append: opts.appendSystemPrompt,
            },
          }
        : {}),
      permissionMode: opts.permissionMode,
      allowDangerouslySkipPermissions: opts.permissionMode === "bypassPermissions",
      includePartialMessages: true,
      ...(opts.resumeFrom ? { resume: opts.resumeFrom } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.effort ? { effort: opts.effort } : {}),
      ...(useCanUseTool ? { canUseTool: host.canUseTool } : {}),
      stderr: () => {},
    },
  });

  if (opts.initialPrompt) host.submitTurn(opts.initialPrompt);

  await host.consume(q);
}
