import type { PortfolioProject, PortfolioSession } from "./types.js";
import { listPortfolioSessions } from "./portfolio-session-service.js";

export function resolvePortfolioProject(
  portfolio: PortfolioProject[],
  projectId: string,
): PortfolioProject | undefined {
  return portfolio.find((project) => project.id === projectId);
}

export async function resolvePortfolioSession(
  portfolio: PortfolioProject[],
  projectId: string,
  sessionId: string,
): Promise<PortfolioSession | undefined> {
  const project = resolvePortfolioProject(portfolio, projectId);
  if (!project) return undefined;

  const sessions = await listPortfolioSessions([project]);
  return sessions.find((entry) => entry.session.id === sessionId);
}

export function derivePortfolioProjectId(
  configProjectKey: string,
  existingIds: Set<string>,
): string {
  if (!existingIds.has(configProjectKey)) return configProjectKey;

  let suffix = 2;
  while (existingIds.has(`${configProjectKey}-${suffix}`)) {
    suffix++;
  }
  return `${configProjectKey}-${suffix}`;
}
