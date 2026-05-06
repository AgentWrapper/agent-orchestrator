import type { ProjectConfig } from "./types.js";

export interface SpawnTarget {
  projectId: string;
  issueId: string;
}

/**
 * Parse a possibly-prefixed issue reference into a `{ projectId, issueId }` pair.
 *
 * When the reference is of the form `<prefix>/<rest>` and `<prefix>` matches a
 * configured project id or `sessionPrefix`, the spawn is routed to that project
 * with `<rest>` as the issue id. Otherwise the reference is treated as a plain
 * issue id and the fallback project is used.
 *
 * - Matching is case-sensitive — yaml keys and `sessionPrefix` values are
 *   compared literally.
 * - Exact project-id match wins over `sessionPrefix` match (yaml keys are
 *   unique; `sessionPrefix` values are not guaranteed to be).
 * - Returns `null` when no prefix routing matches and no fallback is provided.
 * - Empty `<rest>` (trailing slash) is treated as no prefix — the full string
 *   is passed through as the issue id.
 */
export function resolveSpawnTarget(
  projects: Record<string, ProjectConfig>,
  issueRef: string,
  fallbackProjectId?: string,
): SpawnTarget | null {
  const slashIdx = issueRef.indexOf("/");
  if (slashIdx > 0 && slashIdx < issueRef.length - 1) {
    const prefix = issueRef.slice(0, slashIdx);
    const rest = issueRef.slice(slashIdx + 1);

    // hasOwn guards against prototype keys (`__proto__`, `constructor`, …)
    // incorrectly matching via inheritance from Object.prototype.
    if (Object.prototype.hasOwnProperty.call(projects, prefix)) {
      return { projectId: prefix, issueId: rest };
    }
    for (const [pid, project] of Object.entries(projects)) {
      if (project.sessionPrefix === prefix) {
        return { projectId: pid, issueId: rest };
      }
    }
  }

  if (!fallbackProjectId) return null;
  return { projectId: fallbackProjectId, issueId: issueRef };
}
