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
 *   1. explicit project-level `runtime`            — always wins
 *   2. explicit defaults-level `runtime`           — a value the user chose, i.e.
 *      one that differs from the platform default
 *   3. the agent's preferred runtime               — claude-code -> sdk
 *   4. getDefaultRuntime()                         — tmux (non-Windows) / process (Windows)
 *
 * A `defaults.runtime` equal to the platform default is treated as unconfigured
 * (config generators write `getDefaultRuntime()` there), so the agent preference
 * still applies. To pin a runtime for an agent that has a preference, set it at
 * the PROJECT level — `project.runtime` always wins.
 */
export function resolveRuntimeName(
  project: RuntimeResolutionProject | null | undefined,
  config: RuntimeResolutionConfig,
  agentName?: string | null,
): string {
  if (project?.runtime) return project.runtime;

  const configured = config.defaults?.runtime;
  const effectiveAgent = agentName ?? project?.agent ?? config.defaults?.agent;
  const preferred = agentPreferredRuntime(effectiveAgent);

  // The agent preference applies only when the user has NOT chosen a runtime —
  // i.e. defaults.runtime is absent or merely the platform default.
  if (preferred && (!configured || configured === getDefaultRuntime())) {
    return preferred;
  }
  return configured ?? getDefaultRuntime();
}
