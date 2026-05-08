import {
  isTerminalSession,
  type Issue,
  type IssueAutomationConfig,
  type OpenCodeSessionManager,
  type ProjectConfig,
  type Tracker,
} from "./types.js";

export const DEFAULT_ISSUE_AUTOMATION_TRIGGER_LABEL = "ao:auto";
export const DEFAULT_ISSUE_AUTOMATION_SPAWNED_LABEL = "ao:spawned";
export const DEFAULT_ISSUE_AUTOMATION_INTERVAL_SECONDS = 60;

const projectLocks = new Set<string>();

export interface IssueAutomationSettings {
  triggerLabel: string;
  spawnedLabel: string;
  intervalSeconds: number;
}

export interface PollIssueAutomationInput {
  projectId: string;
  project: ProjectConfig;
  tracker: Tracker;
  sessionManager: OpenCodeSessionManager;
}

export interface PollIssueAutomationResult {
  spawned: number;
  skipped: number;
}

export function getIssueAutomationSettings(
  config: IssueAutomationConfig | undefined,
): IssueAutomationSettings {
  return {
    triggerLabel: config?.triggerLabel ?? DEFAULT_ISSUE_AUTOMATION_TRIGGER_LABEL,
    spawnedLabel: config?.spawnedLabel ?? DEFAULT_ISSUE_AUTOMATION_SPAWNED_LABEL,
    intervalSeconds: config?.intervalSeconds ?? DEFAULT_ISSUE_AUTOMATION_INTERVAL_SECONDS,
  };
}

function normalizeIssueId(issueId: string | null | undefined): string | null {
  const trimmed = issueId?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^#/, "").toLowerCase();
}

function hasLabel(issue: Issue, label: string): boolean {
  return issue.labels.some((candidate) => candidate.toLowerCase() === label.toLowerCase());
}

async function getActiveIssueIds(
  sessionManager: OpenCodeSessionManager,
  projectId: string,
): Promise<Set<string>> {
  const sessions = await sessionManager.list(projectId);
  return new Set(
    sessions
      .filter((session) => !isTerminalSession(session))
      .map((session) => normalizeIssueId(session.issueId))
      .filter((issueId): issueId is string => Boolean(issueId)),
  );
}

export async function pollIssueAutomationProject(
  input: PollIssueAutomationInput,
): Promise<PollIssueAutomationResult> {
  const { projectId, project, tracker, sessionManager } = input;
  if (!project.issueAutomation?.enabled) return { spawned: 0, skipped: 0 };
  if (!tracker.listIssues || !tracker.updateIssue) return { spawned: 0, skipped: 0 };
  if (projectLocks.has(projectId)) return { spawned: 0, skipped: 0 };

  projectLocks.add(projectId);
  try {
    const settings = getIssueAutomationSettings(project.issueAutomation);
    const issues = await tracker.listIssues(
      { state: "open", labels: [settings.triggerLabel], limit: 50 },
      project,
    );
    let activeIssueIds = await getActiveIssueIds(sessionManager, projectId);
    let spawned = 0;
    let skipped = 0;

    for (const issue of issues) {
      const issueId = normalizeIssueId(issue.id);
      if (!issueId) {
        skipped++;
        continue;
      }

      if (!hasLabel(issue, settings.triggerLabel) || hasLabel(issue, settings.spawnedLabel)) {
        skipped++;
        continue;
      }

      activeIssueIds = await getActiveIssueIds(sessionManager, projectId);
      if (activeIssueIds.has(issueId)) {
        skipped++;
        continue;
      }

      await sessionManager.spawn({ projectId, issueId: issue.id });
      await tracker.updateIssue(issue.id, { labels: [settings.spawnedLabel] }, project);
      activeIssueIds.add(issueId);
      spawned++;
    }

    return { spawned, skipped };
  } finally {
    projectLocks.delete(projectId);
  }
}
