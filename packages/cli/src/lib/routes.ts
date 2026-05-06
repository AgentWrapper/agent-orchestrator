export function projectSessionUrl(port: number, projectId: string, sessionId: string): string {
  return `http://localhost:${port}/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`;
}
