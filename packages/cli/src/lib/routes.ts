import { dashboardUrl } from "./dashboard-url.js";

export function projectSessionUrl(port: number, projectId: string, sessionId: string): string {
  return `${dashboardUrl(port)}/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`;
}
