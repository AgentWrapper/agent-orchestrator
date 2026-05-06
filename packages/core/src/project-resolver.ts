import {
  ProjectResolveError,
  type DegradedProjectEntry,
  type LoadedConfig,
  type ProjectConfig,
} from "./types.js";
import { resolveProjectIdentity, type GlobalConfig } from "./global-config.js";

export function loadEffectiveProjectConfig(
  projectId: string,
  globalConfig: GlobalConfig,
  globalConfigPath?: string,
): ProjectConfig {
  const resolved = resolveProjectIdentity(projectId, globalConfig, globalConfigPath);
  if (!resolved) {
    throw new ProjectResolveError(projectId, `Unknown project: ${projectId}`);
  }
  if (typeof resolved.resolveError === "string" && resolved.resolveError.length > 0) {
    throw new ProjectResolveError(projectId, resolved.resolveError);
  }
  return resolved;
}

export function* iterateAllProjects(
  config: LoadedConfig,
): Iterable<ProjectConfig | DegradedProjectEntry> {
  yield* Object.values(config.projects);
  yield* Object.values(config.degradedProjects);
}
