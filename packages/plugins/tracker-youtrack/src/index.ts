/**
 * tracker-youtrack plugin — JetBrains YouTrack as an issue tracker.
 *
 * Uses the YouTrack REST API via fetch().
 * Auth: YOUTRACK_TOKEN env var (Bearer token).
 * Requires YOUTRACK_HOST env var (e.g. https://mycompany.youtrack.cloud).
 */

import type {
  PluginModule,
  Tracker,
  Issue,
  IssueFilters,
  IssueUpdate,
  CreateIssueInput,
  ProjectConfig,
} from "@aoagents/ao-core";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function getHost(project: ProjectConfig): string {
  const fromConfig = project.tracker?.["host"] as string | undefined;
  const fromEnv = process.env["YOUTRACK_HOST"];
  const host = fromConfig ?? fromEnv;
  if (!host) {
    throw new Error(
      "YouTrack host is required: set YOUTRACK_HOST env var or tracker.host in project config",
    );
  }
  // Strip trailing slash
  return host.replace(/\/+$/, "");
}

function getToken(): string {
  const token = process.env["YOUTRACK_TOKEN"];
  if (!token) {
    throw new Error(
      "YOUTRACK_TOKEN environment variable is required for the YouTrack tracker plugin",
    );
  }
  return token;
}

// ---------------------------------------------------------------------------
// Fetch helper
// ---------------------------------------------------------------------------

async function youtrackFetch<T>(
  host: string,
  path: string,
  options: { method?: string; body?: Record<string, unknown> } = {},
): Promise<T> {
  const url = `${host}/api${path}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const fetchOptions: RequestInit = {
      method: options.method ?? "GET",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${getToken()}`,
      },
    };

    if (options.body) {
      fetchOptions.headers = {
        ...fetchOptions.headers,
        "Content-Type": "application/json",
      };
      fetchOptions.body = JSON.stringify(options.body);
    }

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `YouTrack API returned HTTP ${response.status}: ${text.slice(0, 200)}`,
      );
    }

    const data: unknown = await response.json();
    return data as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run a YouTrack command against a single issue.
 *
 */
async function executeCommand(
  host: string,
  identifier: string,
  query: string,
): Promise<void> {
  await youtrackFetch(host, `/commands`, {
    method: "POST",
    body: { query, issues: [{ idReadable: identifier }] },
  });
}

// ---------------------------------------------------------------------------
// YouTrack API types
// ---------------------------------------------------------------------------

interface YouTrackIssue {
  id: string;
  idReadable: string;
  summary: string;
  description: string | null;
  resolved: number | null;
  tags?: Array<{ id: string; name: string }>;
  customFields: YouTrackCustomField[];
}

interface YouTrackCustomField {
  name: string;
  $type: string;
  value: YouTrackFieldValue | YouTrackFieldValue[] | null;
}

interface YouTrackFieldValue {
  name?: string;
  login?: string;
  $type?: string;
  [key: string]: unknown;
}

interface YouTrackProject {
  id: string;
  shortName: string;
  name: string;
}

// ---------------------------------------------------------------------------
// State mapping
// ---------------------------------------------------------------------------

/** Extract a custom field value by name from an issue */
function getCustomFieldValue(
  issue: YouTrackIssue,
  fieldName: string,
): YouTrackFieldValue | null {
  const field = issue.customFields.find((f) => f.name === fieldName);
  if (!field || !field.value) return null;
  if (Array.isArray(field.value)) return field.value[0] ?? null;
  return field.value;
}

function mapYouTrackState(issue: YouTrackIssue): Issue["state"] {
  if (issue.resolved !== null) return "closed";
  const stateValue = getCustomFieldValue(issue, "State");
  if (!stateValue?.name) return "open";

  const name = stateValue.name.toLowerCase();
  if (
    name.includes("done") ||
    name.includes("fixed") ||
    name.includes("closed") ||
    name.includes("complete") ||
    name.includes("verified") ||
    name.includes("resolved")
  ) {
    return "closed";
  }
  if (
    name.includes("in progress") ||
    name.includes("open") ||
    name.includes("in review") ||
    name.includes("testing")
  ) {
    return "in_progress";
  }
  return "open";
}

function mapYouTrackPriority(issue: YouTrackIssue): number | undefined {
  const priorityValue = getCustomFieldValue(issue, "Priority");
  if (!priorityValue?.name) return undefined;

  const name = priorityValue.name.toLowerCase();
  if (name.includes("critical") || name.includes("show-stopper")) return 1;
  if (name.includes("major") || name.includes("high")) return 2;
  if (name.includes("normal") || name.includes("medium")) return 3;
  if (name.includes("minor") || name.includes("low")) return 4;
  return undefined;
}

function getAssignee(issue: YouTrackIssue): string | undefined {
  const assigneeValue = getCustomFieldValue(issue, "Assignee");
  return assigneeValue?.login ?? assigneeValue?.name ?? undefined;
}

function getLabels(issue: YouTrackIssue): string[] {
  return (issue.tags ?? [])
    .map((t) => t.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
}

// ---------------------------------------------------------------------------
// Issue fields query param
// ---------------------------------------------------------------------------

const ISSUE_FIELDS =
  "id,idReadable,summary,description,resolved,tags(id,name),customFields(name,$type,value(name,login,$type))";

// ---------------------------------------------------------------------------
// Tracker implementation
// ---------------------------------------------------------------------------

function createYouTrackTracker(): Tracker {
  return {
    name: "youtrack",

    async getIssue(identifier: string, project: ProjectConfig): Promise<Issue> {
      const host = getHost(project);
      const issue = await youtrackFetch<YouTrackIssue>(
        host,
        `/issues/${identifier}?fields=${ISSUE_FIELDS}`,
      );

      return {
        id: issue.idReadable,
        title: issue.summary,
        description: issue.description ?? "",
        url: `${host}/issue/${issue.idReadable}`,
        state: mapYouTrackState(issue),
        labels: getLabels(issue),
        assignee: getAssignee(issue),
        priority: mapYouTrackPriority(issue),
      };
    },

    async isCompleted(identifier: string, project: ProjectConfig): Promise<boolean> {
      const host = getHost(project);
      const issue = await youtrackFetch<YouTrackIssue>(
        host,
        `/issues/${identifier}?fields=id,resolved,customFields(name,$type,value(name,$type))`,
      );
      return issue.resolved !== null;
    },

    issueUrl(identifier: string, project: ProjectConfig): string {
      const host = getHost(project);
      return `${host}/issue/${identifier}`;
    },

    issueLabel(url: string, _project: ProjectConfig): string {
      // Extract issue ID from YouTrack URL
      // Example: https://mycompany.youtrack.cloud/issue/PROJ-123 -> PROJ-123
      const match = url.match(/\/issue\/([A-Za-z]+-\d+)/);
      return match ? match[1] : url;
    },

    branchName(identifier: string, _project: ProjectConfig): string {
      return `feat/${identifier}`;
    },

    async generatePrompt(identifier: string, project: ProjectConfig): Promise<string> {
      const issue = await this.getIssue(identifier, project);
      const lines = [
        `You are working on YouTrack issue ${issue.id}: ${issue.title}`,
        `Issue URL: ${issue.url}`,
        "",
      ];

      if (issue.labels.length > 0) {
        lines.push(`Tags: ${issue.labels.join(", ")}`);
      }

      if (issue.priority !== undefined) {
        const priorityNames: Record<number, string> = {
          1: "Critical",
          2: "Major",
          3: "Normal",
          4: "Minor",
        };
        lines.push(`Priority: ${priorityNames[issue.priority] ?? String(issue.priority)}`);
      }

      if (issue.description) {
        lines.push("## Description", "", issue.description);
      }

      lines.push(
        "",
        "Please implement the changes described in this issue. When done, commit and push your changes.",
      );

      return lines.join("\n");
    },

    async listIssues(filters: IssueFilters, project: ProjectConfig): Promise<Issue[]> {
      const host = getHost(project);
      const projectShortName = project.tracker?.["projectId"] as string | undefined;

      // Build YouTrack query string
      const queryParts: string[] = [];

      if (projectShortName) {
        queryParts.push(`project: {${projectShortName}}`);
      }

      if (filters.state === "closed") {
        queryParts.push("State: {Resolved}");
      } else if (filters.state === "open") {
        queryParts.push("State: -Resolved");
      }
      // "all" = no state filter

      if (filters.assignee) {
        queryParts.push(`Assignee: {${filters.assignee}}`);
      }

      if (filters.labels && filters.labels.length > 0) {
        for (const label of filters.labels) {
          queryParts.push(`tag: {${label}}`);
        }
      }

      const query = queryParts.join(" ");
      const limit = filters.limit ?? 30;

      const url = `/issues?fields=${ISSUE_FIELDS}&$top=${limit}&query=${encodeURIComponent(query)}`;
      const issues = await youtrackFetch<YouTrackIssue[]>(host, url);

      return issues.map((issue) => ({
        id: issue.idReadable,
        title: issue.summary,
        description: issue.description ?? "",
        url: `${host}/issue/${issue.idReadable}`,
        state: mapYouTrackState(issue),
        labels: getLabels(issue),
        assignee: getAssignee(issue),
        priority: mapYouTrackPriority(issue),
      }));
    },

    async updateIssue(
      identifier: string,
      update: IssueUpdate,
      project: ProjectConfig,
    ): Promise<void> {
      const host = getHost(project);

      // Handle state change using command API
      if (update.state) {
        let command: string;
        if (update.state === "closed") {
          command = "State Resolved";
        } else if (update.state === "in_progress") {
          command = "State In Progress";
        } else {
          command = "State Open";
        }

        await executeCommand(host, identifier, command);
      }

      // Handle assignee
      if (update.assignee) {
        await executeCommand(host, identifier, `Assignee ${update.assignee}`);
      }

      // Handle labels — map to YouTrack tags via the command API.
      // Tag names must NOT be wrapped in quotes: the /api/commands parser
      // treats double quotes as literal characters in the tag name and would
      // create a brand-new tag like `"agent:backlog"` instead of resolving the
      // existing one. Each tag is a separate command call so that one failing
      // command does not abort the rest.
      if (update.labels && update.labels.length > 0) {
        for (const label of update.labels) {
          await executeCommand(host, identifier, `tag ${label}`);
        }
      }

      if (update.removeLabels && update.removeLabels.length > 0) {
        for (const label of update.removeLabels) {
          await executeCommand(host, identifier, `remove tag ${label}`);
        }
      }

      // Handle comment
      if (update.comment) {
        await youtrackFetch(host, `/issues/${identifier}/comments`, {
          method: "POST",
          body: { text: update.comment },
        });
      }
    },

    async createIssue(input: CreateIssueInput, project: ProjectConfig): Promise<Issue> {
      const host = getHost(project);
      const projectId = project.tracker?.["projectId"] as string | undefined;
      if (!projectId) {
        throw new Error(
          "YouTrack tracker requires 'projectId' in project tracker config",
        );
      }

      // Resolve project internal ID
      const projects = await youtrackFetch<YouTrackProject[]>(
        host,
        `/admin/projects?fields=id,shortName,name&query=${encodeURIComponent(projectId)}`,
      );
      const targetProject = projects.find((p) => p.shortName === projectId);
      if (!targetProject) {
        throw new Error(`YouTrack project "${projectId}" not found`);
      }

      const body: Record<string, unknown> = {
        summary: input.title,
        description: input.description ?? "",
        project: { id: targetProject.id },
      };

      const created = await youtrackFetch<YouTrackIssue>(host, `/issues?fields=${ISSUE_FIELDS}`, {
        method: "POST",
        body,
      });

      // Apply assignee and priority via a single chained command (single-token values
      // chain safely with spaces).
      const commands: string[] = [];
      if (input.assignee) {
        commands.push(`Assignee ${input.assignee}`);
      }
      if (input.priority !== undefined) {
        const priorityNames: Record<number, string> = {
          1: "Critical",
          2: "Major",
          3: "Normal",
          4: "Minor",
        };
        const priorityName = priorityNames[input.priority];
        if (priorityName) {
          commands.push(`Priority ${priorityName}`);
        }
      }

      if (commands.length > 0) {
        try {
          await executeCommand(host, created.idReadable, commands.join(" "));
        } catch {
          // Commands are best-effort; creation already succeeded
        }
      }

      // Tags must be applied as separate command calls — chaining multiple
      // `tag` commands in one query confuses the parser. Names go unquoted
      // (see updateIssue() comment for why).
      if (input.labels && input.labels.length > 0) {
        for (const label of input.labels) {
          try {
            await executeCommand(host, created.idReadable, `tag ${label}`);
          } catch {
            // Best-effort
          }
        }
      }

      return {
        id: created.idReadable,
        title: created.summary,
        description: created.description ?? "",
        url: `${host}/issue/${created.idReadable}`,
        state: mapYouTrackState(created),
        labels: getLabels(created),
        assignee: input.assignee,
        priority: input.priority,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin module export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "youtrack",
  slot: "tracker" as const,
  description: "Tracker plugin: JetBrains YouTrack",
  version: "0.1.0",
};

export function create(): Tracker {
  return createYouTrackTracker();
}

export default { manifest, create } satisfies PluginModule<Tracker>;