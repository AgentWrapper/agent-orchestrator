import type { LoadedConfig, PortfolioProject, ProjectConfig } from "./types.js";
import { loadConfig, validateConfig } from "./config.js";
import {
  buildEffectiveProjectConfig,
  getGlobalConfigPath,
  loadGlobalConfig,
} from "./global-config.js";

const CACHE_TTL_MS = 30_000;
const configCache = new Map<string, { config: LoadedConfig; expiresAt: number }>();

export function resolveProjectConfig(
  entry: PortfolioProject,
): { config: LoadedConfig; project: ProjectConfig } | null {
  try {
    if (entry.configPath === getGlobalConfigPath()) {
      const globalConfig = loadGlobalConfig(entry.configPath);
      if (!globalConfig) return null;

      const effectiveProject = buildEffectiveProjectConfig(entry.configProjectKey, globalConfig);
      if (!effectiveProject) return null;

      const config = validateConfig({
        port: globalConfig.port,
        terminalPort: globalConfig.terminalPort,
        directTerminalPort: globalConfig.directTerminalPort,
        readyThresholdMs: globalConfig.readyThresholdMs,
        defaults: globalConfig.defaults,
        notifiers: globalConfig.notifiers,
        notificationRouting: globalConfig.notificationRouting,
        reactions: globalConfig.reactions,
        projects: {
          [entry.configProjectKey]: {
            ...effectiveProject,
            ...(typeof effectiveProject["repo"] === "string"
              ? { repo: effectiveProject["repo"] }
              : {}),
          },
        },
      });
      const loadedConfig: LoadedConfig = { ...config, degradedProjects: {} };
      loadedConfig.configPath = entry.configPath;

      const project = loadedConfig.projects[entry.configProjectKey];
      if (!project) {
        return null;
      }
      return { config: loadedConfig, project };
    }

    const cached = configCache.get(entry.configPath);
    let config: LoadedConfig;
    if (cached && Date.now() < cached.expiresAt) {
      config = cached.config;
    } else {
      config = loadConfig(entry.configPath);
      configCache.set(entry.configPath, { config, expiresAt: Date.now() + CACHE_TTL_MS });
    }

    const project = config.projects[entry.configProjectKey];
    if (!project) {
      return null;
    }
    return { config, project };
  } catch {
    return null;
  }
}

export function clearConfigCache(): void {
  configCache.clear();
}
