/**
 * runtime-resolution.ts — choose which runtime plugin a session uses.
 *
 * The default runtime is per-AGENT, not global: the `claude-code` agent prefers
 * `runtime-sdk` (drive Claude via the Agent SDK — real-time chat, no terminal),
 * while every other agent keeps the platform default (`tmux` / `process`) and
 * runs its own CLI. An explicit `runtime` in project/session config always wins.
 *
 * This is name-keyed (not plugin-instance-keyed) so the same resolution works
 * everywhere it is needed — session spawn, lifecycle probes, and startup
 * preflight — without loading the plugin registry.
 */

import { getDefaultRuntime } from "./platform.js";

/**
 * Agents that prefer a specific runtime when the user has not chosen one.
 * Single source of truth for the per-agent runtime default; add entries here as
 * other agents want a non-default runtime (multi-model friendly).
 */
export const AGENT_PREFERRED_RUNTIME: Readonly<Record<string, string>> = {
  "claude-code": "sdk",
};

/** The preferred runtime for an agent name, or undefined if it has none. */
export function agentPreferredRuntime(agentName: string | undefined | null): string | undefined {
  return agentName ? AGENT_PREFERRED_RUNTIME[agentName] : undefined;
}

interface RuntimeResolutionProject {
  runtime?: string;
  agent?: string;
}
interface RuntimeResolutionConfig {
  defaults?: { runtime?: string; agent?: string };
}

/**
 * Resolve the runtime plugin name for a session.
 *
 * Order (highest precedence first):
 *   1. project-level `runtime` DIFFERENT from the platform default
 *   2. defaults-level `runtime` DIFFERENT from the platform default
 *   3. the agent's preferred runtime               — claude-code -> sdk
 *   4. getDefaultRuntime()                         — tmux (non-Windows) / process (Windows)
 *
 * A `runtime` (project- OR defaults-level) equal to the platform default is
 * treated as UNCONFIGURED, so the per-agent preference still applies. This is
 * deliberate: config loaders back-fill BOTH `defaults.runtime` (config-generator)
 * AND `project.runtime` (global-config `applyBehaviorDefaults`) with
 * `getDefaultRuntime()`, so a platform-default value is a generated default, not
 * a real user choice — honoring it as an explicit pin silently defeated the agent
 * preference (claude-code spawned on tmux instead of sdk). To pin a runtime for an
 * agent that has a preference, choose a NON-default value; the platform default
 * itself cannot be force-pinned (and need not be — it's what you get by default).
 */
export function resolveRuntimeName(
  project: RuntimeResolutionProject | null | undefined,
  config: RuntimeResolutionConfig,
  agentName?: string | null,
): string {
  const platformDefault = getDefaultRuntime();

  // An explicit project-level runtime wins — unless it merely equals the platform
  // default (a back-filled value, not a user choice; see the note above).
  if (project?.runtime && project.runtime !== platformDefault) return project.runtime;

  const configured = config.defaults?.runtime;
  const effectiveAgent = agentName ?? project?.agent ?? config.defaults?.agent;
  const preferred = agentPreferredRuntime(effectiveAgent);

  // The agent preference applies when the user has NOT chosen a runtime — i.e.
  // neither project nor defaults runtime carries a non-platform-default value.
  if (preferred && (!configured || configured === platformDefault)) {
    return preferred;
  }
  return configured ?? platformDefault;
}
