import { existsSync } from "node:fs";
import {
  getGlobalConfigPath,
  loadConfig,
  type InstalledPluginConfig,
  type OrchestratorConfig,
  type ProjectConfig,
} from "@aoagents/ao-core";

function tryLoadConfig(path?: string): OrchestratorConfig | null {
  try {
    return path ? loadConfig(path) : loadConfig();
  } catch {
    return null;
  }
}

function withExplicitDefaults(
  project: ProjectConfig,
  defaults: OrchestratorConfig["defaults"],
): ProjectConfig {
  return {
    ...project,
    runtime: project.runtime ?? defaults.runtime,
    agent: project.agent ?? defaults.agent,
    workspace: project.workspace ?? defaults.workspace,
  };
}

function mergePlugins(
  primary?: InstalledPluginConfig[],
  secondary?: InstalledPluginConfig[],
): InstalledPluginConfig[] | undefined {
  if (!primary && !secondary) return undefined;

  const merged = new Map<string, InstalledPluginConfig>();
  for (const plugin of secondary ?? []) {
    merged.set(plugin.name, plugin);
  }
  for (const plugin of primary ?? []) {
    merged.set(plugin.name, plugin);
  }
  return [...merged.values()];
}

function mergeMissingProjects(
  primary: OrchestratorConfig,
  secondary: OrchestratorConfig | null,
): OrchestratorConfig {
  if (!secondary || secondary.configPath === primary.configPath) return primary;

  const projects: Record<string, ProjectConfig> = { ...primary.projects };
  for (const [projectId, project] of Object.entries(secondary.projects)) {
    projects[projectId] ??= withExplicitDefaults(project, secondary.defaults);
  }

  return {
    ...primary,
    plugins: mergePlugins(primary.plugins, secondary.plugins),
    notifiers: { ...secondary.notifiers, ...primary.notifiers },
    notificationRouting: {
      ...secondary.notificationRouting,
      ...primary.notificationRouting,
    },
    reactions: { ...secondary.reactions, ...primary.reactions },
    projects,
  };
}

/**
 * Load a config suitable for full-process shutdown/stop paths.
 *
 * The global registry is the broadest source of all AO projects. When AO was
 * launched from a local config, merge any local-only project from the running
 * config so no active session is missed.
 */
export function loadAllProjectsConfig(runningConfigPath?: string): OrchestratorConfig {
  const globalPath = getGlobalConfigPath();
  const globalConfig = existsSync(globalPath) ? tryLoadConfig(globalPath) : null;
  const runningConfig =
    runningConfigPath && runningConfigPath !== globalPath ? tryLoadConfig(runningConfigPath) : null;

  if (globalConfig) return mergeMissingProjects(globalConfig, runningConfig);
  if (runningConfig) return runningConfig;
  return loadConfig();
}
