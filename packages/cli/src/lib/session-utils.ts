import type { OrchestratorConfig } from "@aoagents/ao-core";

export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Strip optional 12-char hex hash prefix from a tmux session name.
 * "1686e4aaaeaa-ao-145" → "ao-145"
 * "ao-145" → "ao-145" (no-op if no hash prefix)
 */
export function stripHashPrefix(name: string): string {
  const match = name.match(/^[a-f0-9]{12}-(.+)$/);
  return match ? match[1] : name;
}

/** Check whether a session name matches a project prefix (strict: prefix-\d+ only). */
export function matchesPrefix(sessionName: string, prefix: string): boolean {
  const normalizedName = stripHashPrefix(sessionName);
  return new RegExp(`^${escapeRegex(prefix)}-\\d+$`).test(normalizedName);
}

/** Find which project a session belongs to by matching its name against session prefixes. */
export function findProjectForSession(
  config: OrchestratorConfig,
  sessionName: string,
): string | null {
  for (const [id, project] of Object.entries(config.projects) as Array<
    [string, OrchestratorConfig["projects"][string]]
  >) {
    const prefix = project.sessionPrefix || id;
    if (matchesPrefix(sessionName, prefix) || isOrchestratorSessionName(config, sessionName, id)) {
      return id;
    }
  }
  return null;
}

export function isOrchestratorSessionName(
  config: OrchestratorConfig,
  sessionName: string,
  projectId?: string,
): boolean {
  const normalizedName = stripHashPrefix(sessionName);

  // If sessionName is a numbered worker for any configured project, it is not an orchestrator.
  // This guard runs first to prevent cross-project false positives: e.g. prefix "app" would
  // match "app-orchestrator-1" as an orchestrator pattern, but if another project has prefix
  // "app-orchestrator" then "app-orchestrator-1" is a worker, not an orchestrator.
  for (const [id, project] of Object.entries(config.projects) as Array<
    [string, OrchestratorConfig["projects"][string]]
  >) {
    const prefix = project.sessionPrefix || id;
    if (matchesPrefix(normalizedName, prefix)) return false;
  }

  if (projectId) {
    const project = config.projects[projectId];
    if (project) {
      const prefix = project.sessionPrefix || projectId;
      if (
        normalizedName === `${prefix}-orchestrator` ||
        new RegExp(`^${escapeRegex(prefix)}-orchestrator-\\d+$`).test(normalizedName)
      ) {
        return true;
      }
    }
  }

  for (const [id, project] of Object.entries(config.projects) as Array<
    [string, OrchestratorConfig["projects"][string]]
  >) {
    const prefix = project.sessionPrefix || id;
    if (
      normalizedName === `${prefix}-orchestrator` ||
      new RegExp(`^${escapeRegex(prefix)}-orchestrator-\\d+$`).test(normalizedName)
    ) {
      return true;
    }
  }

  return normalizedName.endsWith("-orchestrator");
}
