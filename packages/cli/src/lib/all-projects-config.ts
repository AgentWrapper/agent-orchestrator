import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  ConfigNotFoundError,
  getGlobalConfigPath,
  loadConfig,
  type ExternalPluginEntryRef,
  type InstalledPluginConfig,
  type NotifierConfig,
  type OrchestratorConfig,
  type ProjectConfig,
  type SCMConfig,
  type TrackerConfig,
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
  for (const plugin of primary ?? []) {
    merged.set(plugin.name, plugin);
  }
  for (const plugin of secondary ?? []) {
    merged.set(plugin.name, plugin);
  }
  return [...merged.values()];
}

function absolutePathFromConfig(value: string | undefined, configPath: string): string | undefined {
  if (!value || isAbsolute(value)) return value;
  return resolve(dirname(configPath), value);
}

function withAbsolutePluginPath<T extends { path?: string }>(
  config: T | undefined,
  configPath: string,
): T | undefined {
  if (!config?.path) return config;
  const path = absolutePathFromConfig(config.path, configPath);
  return path === config.path ? config : { ...config, path };
}

function withAbsoluteInstalledPluginPaths(
  plugins: InstalledPluginConfig[] | undefined,
  configPath: string,
): InstalledPluginConfig[] | undefined {
  return plugins?.map((plugin) => withAbsolutePluginPath(plugin, configPath) ?? plugin);
}

function withAbsoluteNotifierPaths(
  notifiers: Record<string, NotifierConfig>,
  configPath: string,
): Record<string, NotifierConfig> {
  return Object.fromEntries(
    Object.entries(notifiers).map(([id, notifier]) => [
      id,
      withAbsolutePluginPath(notifier, configPath) ?? notifier,
    ]),
  );
}

function withAbsoluteProjectPluginPaths(project: ProjectConfig, configPath: string): ProjectConfig {
  const tracker = withAbsolutePluginPath<TrackerConfig>(project.tracker, configPath);
  const scm = withAbsolutePluginPath<SCMConfig>(project.scm, configPath);
  return {
    ...project,
    ...(tracker ? { tracker } : {}),
    ...(scm ? { scm } : {}),
  };
}

function withAbsoluteExternalEntryPaths(
  entries: ExternalPluginEntryRef[] | undefined,
  configPath: string,
): ExternalPluginEntryRef[] | undefined {
  return entries?.map((entry) => withAbsolutePluginPath(entry, configPath) ?? entry);
}

function normalizeConfigRelativePluginPaths(config: OrchestratorConfig): OrchestratorConfig {
  return {
    ...config,
    plugins: withAbsoluteInstalledPluginPaths(config.plugins, config.configPath),
    notifiers: withAbsoluteNotifierPaths(config.notifiers, config.configPath),
    projects: Object.fromEntries(
      Object.entries(config.projects).map(([projectId, project]) => [
        projectId,
        withAbsoluteProjectPluginPaths(project, config.configPath),
      ]),
    ),
    _externalPluginEntries: withAbsoluteExternalEntryPaths(
      config._externalPluginEntries,
      config.configPath,
    ),
  };
}

function mergeExternalPluginEntries(
  primary: OrchestratorConfig,
  secondary: OrchestratorConfig,
  projects: Record<string, ProjectConfig>,
): ExternalPluginEntryRef[] | undefined {
  const secondaryProjectIds = new Set(Object.keys(secondary.projects));
  const entries = (primary._externalPluginEntries ?? []).filter(
    (entry) =>
      entry.location.kind !== "project" || !secondaryProjectIds.has(entry.location.projectId),
  );
  const primaryNotifierIds = new Set(Object.keys(primary.notifiers));

  for (const entry of secondary._externalPluginEntries ?? []) {
    if (entry.location.kind === "project") {
      if (projects[entry.location.projectId]) entries.push(entry);
      continue;
    }

    if (!primaryNotifierIds.has(entry.location.notifierId)) {
      entries.push(entry);
    }
  }

  return entries.length > 0 ? entries : undefined;
}

function mergeProjectsPreferSecondary(
  primary: OrchestratorConfig,
  secondary: OrchestratorConfig | null,
): OrchestratorConfig {
  if (!secondary || secondary.configPath === primary.configPath) return primary;
  const normalizedSecondary = normalizeConfigRelativePluginPaths(secondary);

  const projects: Record<string, ProjectConfig> = { ...primary.projects };
  for (const [projectId, project] of Object.entries(normalizedSecondary.projects)) {
    projects[projectId] = withExplicitDefaults(project, normalizedSecondary.defaults);
  }

  return {
    ...primary,
    plugins: mergePlugins(primary.plugins, normalizedSecondary.plugins),
    notifiers: { ...normalizedSecondary.notifiers, ...primary.notifiers },
    notificationRouting: {
      ...normalizedSecondary.notificationRouting,
      ...primary.notificationRouting,
    },
    reactions: { ...normalizedSecondary.reactions, ...primary.reactions },
    projects,
    _externalPluginEntries: mergeExternalPluginEntries(primary, normalizedSecondary, projects),
  };
}

/**
 * Load a config suitable for full-process shutdown/stop paths.
 *
 * The global registry is the broadest source of all AO projects. When AO was
 * launched from a local config, merge projects from the running config so no
 * active session is missed. For projects and plugin definitions, the running
 * config wins same-ID collisions because it owns the live daemon process being
 * stopped. Running-config relative plugin paths are converted to absolute paths
 * before merging, while non-plugin global fields keep global-config precedence.
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
