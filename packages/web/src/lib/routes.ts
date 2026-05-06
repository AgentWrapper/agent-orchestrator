export function projectDashboardPath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}`;
}

export function projectSessionPath(projectId: string, sessionId: string): string {
  return `${projectDashboardPath(projectId)}/sessions/${encodeURIComponent(sessionId)}`;
}

export function projectSessionHashPath(projectId: string, sessionId: string, hash: string): string {
  return `${projectSessionPath(projectId, sessionId)}${hash}`;
}
