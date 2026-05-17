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
}): ResolvedAgentSelection {
  // Spawn-time resolved values are persisted to metadata (see _spawnInner /
  // spawnOrchestrator). Reading them back here means a restored session keeps
  // its original permissions/model/subagent even after the project config has
  // drifted. See issue #1475. Legacy sessions lack these keys and fall back to
  // current project defaults.
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
    persistedPermissions: normalizeAgentPermissionMode(params.metadata?.["spawnedPermissions"]),
    persistedModel: params.metadata?.["spawnedModel"] || undefined,
    persistedSubagent: params.metadata?.["spawnedSubagent"] || undefined,
  });
}

export function resolveAgentSelection(params: {
  role: SessionRole;
  project: ProjectConfig;
  defaults: DefaultPlugins;
  persistedAgent?: string;
  spawnAgentOverride?: string;
  /**
   * Values resolved at spawn time and persisted to session metadata. When
   * present, they take precedence over project defaults — this is how a
   * restored session preserves its original spawn-time permissions / model /
   * subagent even after the project config has drifted. See issue #1475.
   */
  persistedPermissions?: AgentPermissionMode;
  persistedModel?: string;
  persistedSubagent?: string;
}): ResolvedAgentSelection {
  const {
    role,
    project,
    defaults,
    persistedAgent,
    spawnAgentOverride,
    persistedPermissions,
    persistedModel,
    persistedSubagent,
  } = params;
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

  const model =
    persistedModel ??
    (role === "orchestrator"
      ? (roleAgentConfig.orchestratorModel ??
        roleAgentConfig.model ??
        sharedConfig.orchestratorModel ??
        sharedConfig.model)
      : (roleAgentConfig.model ?? sharedConfig.model));

  if (model !== undefined) {
    agentConfig.model = model;
  }

  const permissions =
    persistedPermissions ??
    normalizeAgentPermissionMode(
      typeof agentConfig.permissions === "string" ? agentConfig.permissions : undefined,
    );
  if (permissions !== undefined) {
    agentConfig.permissions = permissions;
  }
  const subagent =
    persistedSubagent ??
    (typeof agentConfig["subagent"] === "string" ? agentConfig["subagent"] : undefined);
  if (subagent !== undefined) {
    agentConfig["subagent"] = subagent;
  }

  return {
    role,
    agentName,
    agentConfig,
    model,
    permissions,
    subagent,
  };
}
