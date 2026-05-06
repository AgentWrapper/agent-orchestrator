import type { Agent, OrchestratorConfig, PluginRegistry, SCM } from "@aoagents/ao-core";
import claudeCodePlugin from "@aoagents/ao-plugin-agent-claude-code";
import codexPlugin from "@aoagents/ao-plugin-agent-codex";
import aiderPlugin from "@aoagents/ao-plugin-agent-aider";
import cursorPlugin from "@aoagents/ao-plugin-agent-cursor";
import kimicodePlugin from "@aoagents/ao-plugin-agent-kimicode";
import opencodePlugin from "@aoagents/ao-plugin-agent-opencode";
import githubSCMPlugin from "@aoagents/ao-plugin-scm-github";
import forgejoSCMPlugin from "@aoagents/ao-plugin-scm-forgejo";

const agentPlugins: Record<string, { create(): Agent }> = {
  "claude-code": claudeCodePlugin,
  codex: codexPlugin,
  aider: aiderPlugin,
  cursor: cursorPlugin,
  kimicode: kimicodePlugin,
  opencode: opencodePlugin,
};

const scmPlugins: Record<string, { create(config?: Record<string, unknown>): SCM }> = {
  github: githubSCMPlugin,
  forgejo: forgejoSCMPlugin,
};

/**
 * Resolve the Agent plugin for a project (or fall back to the config default).
 * Direct import — no dynamic loading needed since the CLI depends on all agent plugins.
 */
export function getAgent(config: OrchestratorConfig, projectId?: string): Agent {
  const agentName =
    (projectId ? config.projects[projectId]?.agent : undefined) || config.defaults.agent;
  return getAgentByName(agentName);
}

/** Get an agent by name directly (for fallback/no-config scenarios). */
export function getAgentByName(name: string): Agent {
  const plugin = agentPlugins[name];
  if (!plugin) {
    throw new Error(`Unknown agent plugin: ${name}`);
  }
  return plugin.create();
}

/** Get an agent by name from the shared registry. */
export function getAgentByNameFromRegistry(registry: PluginRegistry, name: string): Agent {
  const plugin = registry.get<Agent>("agent", name);
  if (!plugin) {
    throw new Error(`Unknown agent plugin: ${name}`);
  }
  return plugin;
}

/**
 * Resolve the SCM plugin for a project (or fall back to "github").
 */
export function getSCM(config: OrchestratorConfig, projectId: string): SCM {
  const projectScm = config.projects[projectId]?.scm;
  const scmName = projectScm?.plugin || "github";
  const plugin = scmPlugins[scmName];
  if (!plugin) {
    throw new Error(`Unknown SCM plugin: ${scmName}`);
  }
  return plugin.create(projectScm);
}

/** Resolve the SCM plugin for a project from the shared registry. */
export function getSCMFromRegistry(
  registry: PluginRegistry,
  config: OrchestratorConfig,
  projectId: string,
): SCM {
  const scmName = config.projects[projectId]?.scm?.plugin || "github";
  const plugin = registry.get<SCM>("scm", scmName);
  if (!plugin) {
    throw new Error(`Unknown SCM plugin: ${scmName}`);
  }
  return plugin;
}
