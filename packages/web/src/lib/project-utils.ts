import { isOrchestratorSession } from "@aoagents/ao-core/types";
import { matchesSessionPrefix } from "./session-utils";

type ProjectWithPrefix = { sessionPrefix?: string };
type SessionLike = { id: string; projectId: string; metadata?: Record<string, string> };

/**
 * Check if a session belongs to a specific project.
 * Matches by projectId or sessionPrefix (same logic as resolveProject).
 *
 * @param session - Session with id and projectId
 * @param projectId - The project key to match against
 * @param projects - Projects config mapping
 */
function matchesProject(
  session: SessionLike,
  projectId: string,
  projects: Record<string, ProjectWithPrefix>,
): boolean {
  if (session.projectId === projectId) return true;
  const project = projects[projectId];
  if (project?.sessionPrefix && matchesSessionPrefix(session.id, project.sessionPrefix)) {
    return true;
  }
  return projects[session.projectId]?.sessionPrefix === projectId;
}

export function filterProjectSessions<T extends SessionLike>(
  sessions: T[],
  projectFilter: string | null | undefined,
  projects: Record<string, ProjectWithPrefix>,
): T[] {
  if (!projectFilter || projectFilter === "all") return sessions;
  return sessions.filter((session) => matchesProject(session, projectFilter, projects));
}

/** Build a project-scoped href, falling back to ?project=all when no project is active. */
export function getProjectScopedHref(
  basePath: "/" | "/prs",
  projectId: string | undefined,
): string {
  return projectId ? `${basePath}?project=${encodeURIComponent(projectId)}` : `${basePath}?project=all`;
}

export function filterWorkerSessions<T extends SessionLike>(
  sessions: T[],
  projectFilter: string | null | undefined,
  projects: Record<string, ProjectWithPrefix>,
): T[] {
  const allSessionPrefixes = Object.entries(projects).map(
    ([projectId, p]) => p.sessionPrefix ?? projectId,
  );
  const workers = sessions.filter(
    (s) =>
      !isOrchestratorSession(
        s,
        projects[s.projectId]?.sessionPrefix ?? s.projectId,
        allSessionPrefixes,
      ),
  );
  return filterProjectSessions(workers, projectFilter, projects);
}
