import { existsSync } from "node:fs";
import {
  ConfigNotFoundError,
  getGlobalConfigPath,
  loadConfig,
  type InstalledPluginConfig,
  type OrchestratorConfig,
  type ProjectConfig,
} from "@aoagents/ao-core";

function isMissingConfigError(error: unknown): boolean {
  if (error instanceof ConfigNotFoundError) return true;
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function tryLoadOptionalConfig(path: string): OrchestratorConfig | null {
  try {
    return loadConfig(path);
  } catch (error) {
    if (isMissingConfigError(error)) return null;
    throw error;
  }
}

function loadExistingOptionalConfig(path: string): OrchestratorConfig | null {
  if (!existsSync(path)) {
    return null;
  }
  return tryLoadOptionalConfig(path);
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

function mergeProjectsPreferSecondary(
  primary: OrchestratorConfig,
  secondary: OrchestratorConfig | null,
): OrchestratorConfig {
  if (!secondary || secondary.configPath === primary.configPath) return primary;

  const projects: Record<string, ProjectConfig> = { ...primary.projects };
  for (const [projectId, project] of Object.entries(secondary.projects)) {
    projects[projectId] = withExplicitDefaults(project, secondary.defaults);
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
 * launched from a local config, merge projects from the running config so no
 * active session is missed. The running config wins same-ID collisions because
 * it is the config that owns the live daemon process being stopped.
 */
export function loadAllProjectsConfig(runningConfigPath?: string): OrchestratorConfig {
  const globalPath = getGlobalConfigPath();
  const globalConfig = loadExistingOptionalConfig(globalPath);
  const runningConfig =
    runningConfigPath && runningConfigPath !== globalPath
      ? loadExistingOptionalConfig(runningConfigPath)
      : null;

  if (globalConfig) return mergeProjectsPreferSecondary(globalConfig, runningConfig);
  if (runningConfig) return runningConfig;
  return loadConfig();
}

export interface AllProjectsConfigFallbackResult {
  config: OrchestratorConfig;
  warning?: string;
}

export interface AllProjectsConfigFallbackOptions {
  /**
   * Allow the final fallback to `loadConfig()` with normal config discovery.
   *
   * This is safe for interactive restore flows where the user already selected
   * the foreground project. Shutdown/stop paths must leave this disabled so a
   * broken daemon-owned config cannot accidentally fall through to the caller's
   * unrelated current working directory config.
   */
  includeDefaultFallback?: boolean;
}

function formatLoadError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatFallbackSource(candidate: string | undefined): string {
  return candidate ?? "default config discovery";
}

function loadFallbackCandidate(candidate: string | undefined): OrchestratorConfig {
  return candidate ? loadConfig(candidate) : loadConfig();
}

/**
 * Load all-project config for shutdown-like paths that must remain stoppable.
 *
 * `loadAllProjectsConfig()` stays strict so malformed existing configs are not
 * hidden from ordinary callers. Stop/shutdown flows, however, must still be able
 * to signal the registered daemon if one side of the merged config is broken.
 */
export function loadAllProjectsConfigWithFallback(
  runningConfigPath?: string,
  options: AllProjectsConfigFallbackOptions = {},
): AllProjectsConfigFallbackResult {
  try {
    return { config: loadAllProjectsConfig(runningConfigPath) };
  } catch (error) {
    const globalPath = getGlobalConfigPath();
    const candidates = [
      runningConfigPath,
      globalPath,
      ...(options.includeDefaultFallback ? [undefined] : []),
    ];
    const attempted = new Set<string>();

    for (const candidate of candidates) {
      if (candidate === undefined && !options.includeDefaultFallback) continue;
      const key = candidate ?? "<default>";
      if (attempted.has(key)) continue;
      attempted.add(key);

      try {
        return {
          config: loadFallbackCandidate(candidate),
          warning: `Could not load merged all-project config (${formatLoadError(error)}); falling back to ${formatFallbackSource(candidate)}.`,
        };
      } catch {
        // Try the next narrower source.
      }
    }

    throw error;
  }
}
