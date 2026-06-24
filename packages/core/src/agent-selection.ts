import {
  normalizeAgentPermissionMode,
  isOrchestratorSession,
  type AgentPermissionMode,
  type AgentSpecificConfig,
  type DefaultPlugins,
  type ProjectConfig,
} from "./types.js";

export type SessionRole = "orchestrator" | "worker";

export interface ResolvedAgentSelection {
  role: SessionRole;
  agentName: string;
  agentConfig: AgentSpecificConfig;
  model?: string;
  permissions?: AgentPermissionMode;
  subagent?: string;
}

export function resolveSessionRole(
  sessionId: string,
  metadata: Record<string, string> | undefined,
  sessionPrefix: string,
  allSessionPrefixes?: string[],
): SessionRole {
  return isOrchestratorSession({ id: sessionId, metadata }, sessionPrefix, allSessionPrefixes)
    ? "orchestrator"
    : "worker";
}

/**
 * Resolve the agent identity for a session metadata record. Normalized Session
 * objects are expected to carry metadata.agent; fallback resolution exists only
 * for legacy raw metadata read/repair boundaries.
 */
export function resolveAgentSelectionForSession(params: {
  sessionId: string;
  metadata?: Record<string, string>;
  project: ProjectConfig;
  defaults: DefaultPlugins;
  allSessionPrefixes?: string[];
  /**
   * Top-level worker-model default. Threaded through so a restored/resumed
   * worker keeps the cheaper model instead of silently reverting to the account
   * default on engine restart.
   */
  defaultWorkerModel?: string;
}): ResolvedAgentSelection {
  // A persisted per-session model override (`sessionModel` written by
  // `ao session set-model`) takes effect on every restore/restart of this
  // session, beating project-level config but losing to an explicit spawn-time
  // override (which is only present during initial spawn, not restore).
  const sessionModelOverride = params.metadata?.["sessionModel"] || undefined;
  return resolveAgentSelection({
    role: resolveSessionRole(
      params.sessionId,
      params.metadata,
      params.project.sessionPrefix,
      params.allSessionPrefixes,
    ),
    project: params.project,
    defaults: params.defaults,
    persistedAgent: params.metadata?.["agent"],
    spawnModelOverride: sessionModelOverride,
    defaultWorkerModel: params.defaultWorkerModel,
  });
}

export function resolveAgentSelection(params: {
  role: SessionRole;
  project: ProjectConfig;
  defaults: DefaultPlugins;
  persistedAgent?: string;
  spawnAgentOverride?: string;
  /**
   * Explicit per-spawn model override (e.g. `ao spawn --model sonnet`). Highest
   * priority — wins over any configured model for either role.
   */
  spawnModelOverride?: string;
  /**
   * Top-level config fallback applied to WORKER sessions only. Used as the
   * lowest-priority source so every worker defaults to a cheaper model unless a
   * more specific selection (spawn override or per-project model) exists. Never
   * applied to orchestrators. Empty/undefined = the account default (current
   * behavior).
   */
  defaultWorkerModel?: string;
}): ResolvedAgentSelection {
  const { role, project, defaults, persistedAgent, spawnAgentOverride } = params;
  const { spawnModelOverride, defaultWorkerModel } = params;
  const roleProjectConfig = role === "orchestrator" ? project.orchestrator : project.worker;
  const roleDefaults = role === "orchestrator" ? defaults.orchestrator : defaults.worker;
  const sharedConfig = project.agentConfig ?? {};
  const roleAgentConfig = roleProjectConfig?.agentConfig ?? {};

  const agentName = persistedAgent
    ? persistedAgent
    : role === "worker"
      ? (spawnAgentOverride ??
        roleProjectConfig?.agent ??
        project.agent ??
        roleDefaults?.agent ??
        defaults.agent)
      : (roleProjectConfig?.agent ?? project.agent ?? roleDefaults?.agent ?? defaults.agent);

  const agentConfig: AgentSpecificConfig = {
    ...sharedConfig,
  };
  for (const [key, value] of Object.entries(roleAgentConfig)) {
    if (value !== undefined) {
      agentConfig[key] = value;
    }
  }

  const configuredModel =
    role === "orchestrator"
      ? (roleAgentConfig.orchestratorModel ??
        roleAgentConfig.model ??
        sharedConfig.orchestratorModel ??
        sharedConfig.model)
      : (roleAgentConfig.model ?? sharedConfig.model);

  // Priority: explicit spawn override > per-project configured model >
  // top-level defaultWorkerModel (workers only). Orchestrators never inherit
  // defaultWorkerModel — only an explicit override or their own configured
  // (orchestrator)model applies. Undefined means "no model set" = account
  // default = current behavior.
  const model =
    spawnModelOverride ??
    configuredModel ??
    (role === "worker" ? defaultWorkerModel : undefined);

  if (model !== undefined) {
    agentConfig.model = model;
  }

  const permissions = normalizeAgentPermissionMode(
    typeof agentConfig.permissions === "string" ? agentConfig.permissions : undefined,
  );
  if (permissions !== undefined) {
    agentConfig.permissions = permissions;
  }
  const subagent =
    typeof agentConfig["subagent"] === "string" ? agentConfig["subagent"] : undefined;

  return {
    role,
    agentName,
    agentConfig,
    model,
    permissions,
    subagent,
  };
}
