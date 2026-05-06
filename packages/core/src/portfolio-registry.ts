/**
 * Portfolio registry — global-config-backed project projection plus user preferences.
 *
 * The global config is the canonical source of truth for which projects exist.
 * Preferences provide a lightweight UI overlay for ordering, pinning, visibility,
 * and display names.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import type {
  PortfolioProject,
  PortfolioPreferences,
  PortfolioRegistered,
} from "./types.js";
import {
  getPortfolioDir,
  getPreferencesPath,
  getRegisteredPath,
  generateSessionPrefix,
} from "./paths.js";
import {
  getGlobalConfigPath,
  loadGlobalConfig,
  loadLocalProjectConfig,
  registerProjectInGlobalConfig,
  saveGlobalConfig,
  type RegisterProjectOptions,
} from "./global-config.js";
import { atomicWriteFileSync } from "./atomic-write.js";
import { loadConfig } from "./config.js";

function normalizePath(path: string): string {
  return resolve(path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePortfolioRegistered(value: unknown): PortfolioRegistered | null {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.projects)) {
    return null;
  }

  const projects: PortfolioRegistered["projects"] = [];
  for (const project of value.projects) {
    if (!isRecord(project) || typeof project.path !== "string" || typeof project.addedAt !== "string") {
      return null;
    }
    if (
      "configProjectKey" in project &&
      project.configProjectKey !== undefined &&
      typeof project.configProjectKey !== "string"
    ) {
      return null;
    }

    projects.push({
      path: project.path,
      addedAt: project.addedAt,
      ...(typeof project.configProjectKey === "string"
        ? { configProjectKey: project.configProjectKey }
        : {}),
    });
  }

  return { version: 1, projects };
}

function parsePortfolioPreferences(value: unknown): PortfolioPreferences | null {
  if (!isRecord(value) || value.version !== 1) {
    return null;
  }

  if ("defaultProjectId" in value && value.defaultProjectId !== undefined && typeof value.defaultProjectId !== "string") {
    return null;
  }

  if (
    "projectOrder" in value &&
    value.projectOrder !== undefined &&
    (!Array.isArray(value.projectOrder) || value.projectOrder.some((id) => typeof id !== "string"))
  ) {
    return null;
  }

  if ("projects" in value && value.projects !== undefined) {
    if (!isRecord(value.projects)) {
      return null;
    }

    for (const prefs of Object.values(value.projects)) {
      if (!isRecord(prefs)) {
        return null;
      }
      if ("pinned" in prefs && prefs.pinned !== undefined && typeof prefs.pinned !== "boolean") {
        return null;
      }
      if ("enabled" in prefs && prefs.enabled !== undefined && typeof prefs.enabled !== "boolean") {
        return null;
      }
      if (
        "displayName" in prefs &&
        prefs.displayName !== undefined &&
        typeof prefs.displayName !== "string"
      ) {
        return null;
      }
    }
  }

  return {
    version: 1,
    ...(typeof value.defaultProjectId === "string" ? { defaultProjectId: value.defaultProjectId } : {}),
    ...(Array.isArray(value.projectOrder) ? { projectOrder: value.projectOrder } : {}),
    ...(isRecord(value.projects)
      ? {
          projects: Object.fromEntries(
            Object.entries(value.projects).map(([id, prefs]) => [
              id,
              {
                ...(isRecord(prefs) && typeof prefs.pinned === "boolean"
                  ? { pinned: prefs.pinned }
                  : {}),
                ...(isRecord(prefs) && typeof prefs.enabled === "boolean"
                  ? { enabled: prefs.enabled }
                  : {}),
                ...(isRecord(prefs) && typeof prefs.displayName === "string"
                  ? { displayName: prefs.displayName }
                  : {}),
              },
            ]),
          ),
        }
      : {}),
  };
}

/** Load registered projects from registered.json (legacy compatibility only). */
export function loadRegistered(): PortfolioRegistered {
  const path = getRegisteredPath();
  if (!existsSync(path)) {
    return { version: 1, projects: [] };
  }
  try {
    const content = readFileSync(path, "utf-8");
    return parsePortfolioRegistered(JSON.parse(content)) ?? { version: 1, projects: [] };
  } catch {
    return { version: 1, projects: [] };
  }
}

/** Save registered projects to registered.json (legacy compatibility only). */
export function saveRegistered(reg: PortfolioRegistered): void {
  const dir = getPortfolioDir();
  mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(getRegisteredPath(), JSON.stringify(reg, null, 2));
}

/** Load portfolio preferences from preferences.json */
export function loadPreferences(): PortfolioPreferences {
  const path = getPreferencesPath();
  if (!existsSync(path)) {
    return { version: 1 };
  }
  try {
    const content = readFileSync(path, "utf-8");
    return parsePortfolioPreferences(JSON.parse(content)) ?? { version: 1 };
  } catch {
    return { version: 1 };
  }
}

/** Save portfolio preferences to preferences.json */
export function savePreferences(prefs: PortfolioPreferences): void {
  const dir = getPortfolioDir();
  mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(getPreferencesPath(), JSON.stringify(prefs, null, 2));
}

/**
 * Atomically update preferences: reads the current state, applies the updater,
 * and writes back in a single synchronous block. This prevents lost updates
 * from concurrent async handlers that might interleave between read and write.
 */
export function updatePreferences(updater: (prefs: PortfolioPreferences) => void): void {
  const prefs = loadPreferences();
  updater(prefs);
  savePreferences(prefs);
}

function applyPreferences(
  projects: PortfolioProject[],
  preferences: PortfolioPreferences,
): PortfolioProject[] {
  const projectMap = new Map(projects.map((project) => [project.id, project]));

  if (preferences.projects) {
    for (const [id, prefs] of Object.entries(preferences.projects)) {
      const project = projectMap.get(id);
      if (!project) continue;

      if (prefs.pinned !== undefined) project.pinned = prefs.pinned;
      if (prefs.enabled !== undefined) project.enabled = prefs.enabled;
      if (prefs.displayName) project.name = prefs.displayName;
    }
  }

  const orderMap = new Map<string, number>();
  if (preferences.projectOrder) {
    for (let i = 0; i < preferences.projectOrder.length; i++) {
      orderMap.set(preferences.projectOrder[i], i);
    }
  }

  return [...projectMap.values()].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;

    const orderA = orderMap.get(a.id) ?? Infinity;
    const orderB = orderMap.get(b.id) ?? Infinity;
    if (orderA !== orderB) return orderA - orderB;

    return a.name.localeCompare(b.name);
  });
}

function projectFromGlobalConfig(): PortfolioProject[] {
  try {
    const config = loadConfig(getGlobalConfigPath());
    const allEntries = [
      ...Object.entries(config.projects).map(([id, project]) => ({
        id,
        name: project.name ?? id,
        configPath: config.configPath,
        configProjectKey: id,
        repoPath: project.path,

        repo: project.repo,
        defaultBranch: project.defaultBranch,
        sessionPrefix: project.sessionPrefix ?? generateSessionPrefix(id),
        source: "config" as const,
        enabled: true,
        pinned: false,
        lastSeenAt: new Date().toISOString(),
      })),
      ...Object.entries(config.degradedProjects).map(([id, project]) => ({
        id,
        name: id,
        configPath: config.configPath,
        configProjectKey: id,
        repoPath: project.path,

        sessionPrefix: generateSessionPrefix(id),
        source: "config" as const,
        enabled: true,
        pinned: false,
        lastSeenAt: new Date().toISOString(),
        resolveError: project.resolveError,
      })),
    ];
    return allEntries;
  } catch {
    return [];
  }
}

function fallbackPortfolioFromLoadedConfig(): PortfolioProject[] {
  try {
    const config = loadConfig();
    return [
      ...Object.entries(config.projects).map(([id, project]) => ({
        id,
        name: project.name ?? id,
        configPath: config.configPath,
        configProjectKey: id,
        repoPath: project.path,

        repo: project.repo,
        defaultBranch: project.defaultBranch,
        sessionPrefix: project.sessionPrefix ?? generateSessionPrefix(id),
        source: "config" as const,
        enabled: true,
        pinned: false,
        lastSeenAt: new Date().toISOString(),
      })),
      ...Object.entries(config.degradedProjects).map(([id, project]) => ({
        id,
        name: id,
        configPath: config.configPath,
        configProjectKey: id,
        repoPath: project.path,

        sessionPrefix: generateSessionPrefix(id),
        source: "config" as const,
        enabled: true,
        pinned: false,
        lastSeenAt: new Date().toISOString(),
        resolveError: project.resolveError,
      })),
    ];
  } catch {
    return [];
  }
}

/**
 * Backward-compatible alias for callers that previously treated "discovered"
 * projects as the portfolio base. Projects are now projected from the
 * canonical registry, so discovery simply returns that projection.
 */
export function discoverProjects(): PortfolioProject[] {
  return projectFromGlobalConfig();
}

/**
 * Build the portfolio directly from the canonical global registry, with
 * preferences layered on top. Falls back to the currently loaded config when
 * no global config exists yet.
 */
export function getPortfolio(): PortfolioProject[] {
  const preferences = loadPreferences();
  const projects = projectFromGlobalConfig();

  if (projects.length > 0) {
    return applyPreferences(projects, preferences);
  }

  return applyPreferences(fallbackPortfolioFromLoadedConfig(), preferences);
}

/** Register a project into the canonical global config registry. Returns the effective registered project ID. */
export function registerProject(
  repoPath: string,
  configProjectKey?: string,
  displayName?: string,
  options?: RegisterProjectOptions,
): string {
  const normalizedRepoPath = normalizePath(repoPath);
  const localConfig = loadLocalProjectConfig(normalizedRepoPath);
  if (!localConfig) {
    throw new Error(`No local project config found at ${normalizedRepoPath}`);
  }

  const projectId = configProjectKey ?? basename(normalizedRepoPath);
  return registerProjectInGlobalConfig(projectId, displayName ?? projectId, normalizedRepoPath, localConfig, options);
}

/** Remove a project from the canonical global config registry. */
export function unregisterProject(projectId: string): void {
  const globalConfig = loadGlobalConfig();
  if (!globalConfig?.projects[projectId]) return;

  const { [projectId]: _removedProject, ...remainingProjects } = globalConfig.projects;
  globalConfig.projects = remainingProjects;
  if (globalConfig.projectOrder) {
    const nextProjectOrder = globalConfig.projectOrder.filter((id) => id !== projectId);
    globalConfig.projectOrder = nextProjectOrder.length > 0 ? nextProjectOrder : undefined;
  }

  saveGlobalConfig(globalConfig);
}

/** Refresh is a no-op for the global-registry-backed portfolio. */
export function refreshProject(_projectId: string, _configPath: string): void {
  // Canonical portfolio entries are read directly from global config, so there
  // is no separate last-seen registry to update.
}
