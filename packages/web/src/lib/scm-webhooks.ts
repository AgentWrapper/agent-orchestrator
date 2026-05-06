import "server-only";

import {
  TERMINAL_STATUSES,
  type OrchestratorConfig,
  type PluginRegistry,
  type ProjectConfig,
  type SCM,
  type SCMWebhookEvent,
  type SCMWebhookRequest,
  type Session,
} from "@aoagents/ao-core";

export interface WebhookProjectMatch {
  projectId: string;
  project: ProjectConfig;
  scm: SCM;
}

function requestHeadersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function getProjectWebhookPath(project: ProjectConfig): string | null {
  if (!project.scm?.webhook || project.scm.webhook.enabled === false) return null;
  return project.scm.webhook.path ?? `/api/webhooks/${project.scm.plugin}`;
}

export function findWebhookProjects(
  config: OrchestratorConfig,
  registry: PluginRegistry,
  pathname: string,
): WebhookProjectMatch[] {
  return Object.entries(config.projects).flatMap(([projectId, project]) => {
    if (!project.repo || !project.scm?.plugin) return [];
    const webhookPath = getProjectWebhookPath(project);
    if (!webhookPath || webhookPath !== pathname) return [];
    const scm = registry.get<SCM>("scm", project.scm.plugin);
    if (!scm?.parseWebhook || !scm.verifyWebhook) return [];
    return [{ projectId, project, scm }];
  });
}

export function eventMatchesProject(event: SCMWebhookEvent, project: ProjectConfig): boolean {
  if (!event.repository) return false;
  if (!project.repo) return false;
  return (
    `${event.repository.owner}/${event.repository.name}`.toLowerCase() ===
    project.repo.toLowerCase()
  );
}

export function findAffectedSessions(
  sessions: Session[],
  projectId: string,
  event: SCMWebhookEvent,
): Session[] {
  return sessions.filter((session) => {
    if (session.projectId !== projectId) return false;
    if (TERMINAL_STATUSES.has(session.status)) return false;
    if (event.prNumber !== undefined && session.pr?.number === event.prNumber) return true;
    if (event.branch && session.branch === event.branch) return true;
    return false;
  });
}

export function buildWebhookRequest(
  request: Request,
  body: string,
  rawBody: Uint8Array,
): SCMWebhookRequest {
  const url = new URL(request.url);
  return {
    method: request.method,
    headers: requestHeadersToRecord(request.headers),
    body,
    rawBody,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams.entries()),
  };
}
