import "server-only";

import { cache } from "react";
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ConfigNotFoundError, getGlobalConfigPath, loadConfig } from "@aoagents/ao-core";

export interface ProjectInfo {
  id: string;
  name: string;
  sessionPrefix?: string;
  resolveError?: string;
}

function loadProjectDiscoveryConfig() {
  const globalConfigPath = getGlobalConfigPath();

  try {
    return loadConfig(globalConfigPath);
  } catch (error) {
    if (error instanceof ConfigNotFoundError) {
      return loadConfig();
    }
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return loadConfig();
    }
    throw error;
  }
}

function getCanonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function findProjectIdForPath(projectPath: string, config: ReturnType<typeof loadProjectDiscoveryConfig>): string | undefined {
  const canonicalProjectPath = getCanonicalPath(projectPath);

  for (const [projectId, project] of Object.entries(config.projects)) {
    if (typeof project.path !== "string") continue;
    if (getCanonicalPath(project.path) === canonicalProjectPath) {
      return projectId;
    }
  }

  return undefined;
}

function findLocalConfigPath(startDir: string): string | undefined {
  let currentDir = resolve(startDir);

  while (true) {
    for (const filename of ["agent-orchestrator.yaml", "agent-orchestrator.yml"]) {
      const candidate = resolve(currentDir, filename);
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return undefined;
    }
    currentDir = parentDir;
  }
}

function findDiscoveredRepoProjectId(config: ReturnType<typeof loadProjectDiscoveryConfig>): string | undefined {
  try {
    const localConfigPath = findLocalConfigPath(process.cwd());
    if (!localConfigPath) {
      return undefined;
    }

    const discoveredConfig = loadConfig(localConfigPath);
    const canonicalGlobalConfigPath = getCanonicalPath(getGlobalConfigPath());
    const canonicalDiscoveredConfigPath = getCanonicalPath(discoveredConfig.configPath);

    if (canonicalDiscoveredConfigPath !== canonicalGlobalConfigPath) {
      for (const project of Object.values(discoveredConfig.projects)) {
        if (typeof project.path !== "string") continue;
        const projectId = findProjectIdForPath(project.path, config);
        if (projectId) return projectId;
      }

      return findProjectIdForPath(dirname(discoveredConfig.configPath), config);
    }
  } catch {
    // Fall through to cwd-based discovery for environments without a local config.
  }

  return undefined;
}

function findCurrentRepoProjectId(
  config: ReturnType<typeof loadProjectDiscoveryConfig> = loadProjectDiscoveryConfig(),
): string | undefined {
  try {
    const discoveredProjectId = findDiscoveredRepoProjectId(config);
    if (discoveredProjectId) {
      return discoveredProjectId;
    }

    const cwd = getCanonicalPath(process.cwd());
    return findProjectIdForPath(cwd, config);
  } catch {
    return undefined;
  }
}

export const getProjectName = cache((): string => {
  try {
    const config = loadProjectDiscoveryConfig();
    const currentProjectId = findCurrentRepoProjectId(config);
    if (currentProjectId) {
      const currentProject = config.projects[currentProjectId];
      return currentProject?.name ?? currentProjectId;
    }
    const firstKey = Object.keys(config.projects)[0];
    if (firstKey) {
      const name = config.projects[firstKey].name ?? firstKey;
      return name || firstKey || "ao";
    }
  } catch {
    // Config not available
  }
  return "ao";
});

export const getPrimaryProjectId = cache((): string => {
  try {
    const config = loadProjectDiscoveryConfig();
    const currentProjectId = findCurrentRepoProjectId(config);
    if (currentProjectId) return currentProjectId;
    const firstKey = Object.keys(config.projects)[0];
    if (firstKey) return firstKey;
  } catch {
    // Config not available
  }
  return "ao";
});

export const getAllProjects = cache((): ProjectInfo[] => {
  try {
    const config = loadProjectDiscoveryConfig();
    return [
      ...Object.entries(config.projects).map(([id, project]) => ({
        id,
        name: project.name ?? id,
        sessionPrefix: project.sessionPrefix ?? id,
      })),
      ...Object.entries(config.degradedProjects).map(([id, project]) => ({
        id,
        name: id,
        sessionPrefix: id,
        resolveError: project.resolveError,
      })),
    ];
  } catch {
    return [];
  }
});
