import type {
  PluginModule,
  Tracker,
  Issue,
  IssueFilters,
  IssueUpdate,
  CreateIssueInput,
  ProjectConfig,
} from "@aoagents/ao-core";
import { JiraClient, adfToMarkdown, type JiraIssue, type JiraUser } from "./jira-client.js";

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export const manifest = {
  name: "jira" as const,
  slot: "tracker" as const,
  description: "Tracker plugin: Jira Cloud issue tracker",
  version: "0.1.0",
};

// ---------------------------------------------------------------------------
// Helpers — read per-project config from project.tracker
// ---------------------------------------------------------------------------

function getBaseUrl(project: ProjectConfig): string {
  return (
    (project.tracker?.["baseUrl"] as string | undefined) ??
    process.env.JIRA_BASE_URL ??
    ""
  );
}

function getEmail(project: ProjectConfig): string | undefined {
  return (project.tracker?.["email"] as string | undefined) ?? process.env.JIRA_EMAIL;
}

function getApiToken(project: ProjectConfig): string | undefined {
  return (project.tracker?.["apiToken"] as string | undefined) ?? process.env.JIRA_API_TOKEN;
}

function getProjectKey(project: ProjectConfig): string {
  return (project.tracker?.["projectKey"] as string | undefined) ?? "";
}

function getJql(project: ProjectConfig): string | undefined {
  return project.tracker?.["jql"] as string | undefined;
}

function getStatusMap(project: ProjectConfig): Record<string, string> {
  return (project.tracker?.["statusMap"] as Record<string, string> | undefined) ?? {};
}

function getBranchPrefix(project: ProjectConfig): string {
  return (project.tracker?.["branchPrefix"] as string | undefined) ?? "feat";
}

function getIssueType(project: ProjectConfig): string {
  return (project.tracker?.["issueType"] as string | undefined) ?? "Task";
}

// ---------------------------------------------------------------------------
// Jira → AO mapping
// ---------------------------------------------------------------------------

function mapState(
  jiraStatus: string,
  statusCategoryKey?: string,
): Issue["state"] {
  // Normalize typographic quotes (U+2018/2019) to ASCII apostrophe —
  // Jira Cloud's built-in "Won't Do" resolution uses U+2019, not U+0027.
  const lower = jiraStatus.toLowerCase().replace(/[\u2018\u2019]/g, "'");
  // Name-based overrides — cancelled/rejected are still "done" in Jira's
  // statusCategory but we want to surface them as "cancelled" in AO.
  if (
    lower === "cancelled" ||
    lower === "canceled" ||
    lower === "rejected" ||
    lower === "dismissed" ||
    lower === "won't do" ||
    lower === "wont do" ||
    lower === "will not do"
  ) {
    return "cancelled";
  }
  // Prefer Jira's statusCategory — canonical across custom workflows.
  if (statusCategoryKey) {
    const cat = statusCategoryKey.toLowerCase();
    if (cat === "done") return "closed";
    if (cat === "indeterminate") return "in_progress";
    if (cat === "new" || cat === "undefined") return "open";
  }
  // Fall back to name-based matching for workflows without statusCategory.
  if (lower === "done" || lower === "closed" || lower === "resolved") return "closed";
  if (lower === "in progress" || lower === "in review") return "in_progress";
  return "open";
}

function mapIssue(issue: JiraIssue, baseUrl: string): Issue {
  return {
    id: issue.key,
    title: issue.fields.summary,
    description: adfToMarkdown(issue.fields.description),
    url: `${baseUrl.replace(/\/+$/, "")}/browse/${issue.key}`,
    state: mapState(
      issue.fields.status.name,
      issue.fields.status.statusCategory?.key,
    ),
    labels: issue.fields.labels ?? [],
    assignee: issue.fields.assignee?.displayName,
    priority: mapPriority(issue.fields.priority?.name),
  };
}

function mapPriority(name?: string | null): number | undefined {
  if (!name) return undefined;
  const lower = name.toLowerCase();
  if (lower === "highest" || lower === "critical") return 1;
  if (lower === "high") return 2;
  if (lower === "medium") return 3;
  if (lower === "low") return 4;
  if (lower === "lowest") return 5;
  return undefined;
}

/**
 * Sanitize a string for use as a git branch name segment.
 * Replaces runs of characters git rejects (spaces, ~^:?*[\..@{) with `-`,
 * strips leading/trailing dots and dashes, and collapses repeats.
 */
function sanitizeForBranch(value: string): string {
  return value
    .replace(/[\s~^:?*[\]\\@{}'"`()]+/g, "-")
    .replace(/\.+/g, ".")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

function extractSprintNumber(sprintName: string): string {
  const match = /sprint[\s\-_]*(\d+)/i.exec(sprintName);
  if (match) return match[1];
  // Fallback: sanitize the raw sprint name so it's safe as a git branch
  // segment. Sprint names like "Planning Phase" or "Alpha 2" would
  // otherwise produce invalid branch names containing spaces.
  const sanitized = sanitizeForBranch(sprintName);
  return sanitized || "unknown";
}

// ---------------------------------------------------------------------------
// Assignee resolution — exact match only, skip on ambiguity
// ---------------------------------------------------------------------------

/**
 * Resolve a human-readable assignee string (display name, email, or accountId)
 * to a Jira Cloud accountId. Returns undefined when there is no single exact
 * match — callers should skip the assignee write rather than risk a wrong
 * assignment.
 */
async function resolveAssigneeAccountId(
  client: JiraClient,
  assignee: string,
): Promise<string | undefined> {
  const users = await client.searchUsers(assignee);
  const lower = assignee.toLowerCase();
  const exactMatches = users.filter((u: JiraUser) =>
    [u.displayName, u.emailAddress, u.accountId].some(
      (value) => typeof value === "string" && value.toLowerCase() === lower,
    ),
  );
  if (exactMatches.length !== 1) return undefined;
  return exactMatches[0]?.accountId ?? undefined;
}

// ---------------------------------------------------------------------------
// Tracker implementation
// ---------------------------------------------------------------------------

export function create(): Tracker {
  // Client cache keyed by baseUrl+email (supports multiple Jira instances and
  // credential rotation). Credentials are read fresh on every call so the
  // plugin can register before .env is loaded and still pick up env vars later.
  const clients = new Map<string, JiraClient>();

  function getClient(project: ProjectConfig): JiraClient {
    const baseUrl = getBaseUrl(project);
    const email = getEmail(project);
    const apiToken = getApiToken(project);
    if (!baseUrl) throw new Error("Jira tracker: baseUrl is required (project.tracker.baseUrl or JIRA_BASE_URL env)");
    if (!email) throw new Error("Jira tracker: email is required (project.tracker.email or JIRA_EMAIL env)");
    if (!apiToken) throw new Error("Jira tracker: apiToken is required (project.tracker.apiToken or JIRA_API_TOKEN env)");

    // Cache key includes apiToken so rotating the token invalidates the
    // cached client (the baked-in Authorization header is otherwise stale).
    const cacheKey = `${baseUrl}|${email}|${apiToken}`;
    let client = clients.get(cacheKey);
    if (!client) {
      // Evict stale entries for the same baseUrl+email with a different
      // token — otherwise rotating credentials in a long-running process
      // leaks old JiraClient instances (each holding an expired
      // Authorization header) into the Map unboundedly.
      const identityPrefix = `${baseUrl}|${email}|`;
      for (const existingKey of clients.keys()) {
        if (existingKey.startsWith(identityPrefix) && existingKey !== cacheKey) {
          clients.delete(existingKey);
        }
      }
      client = new JiraClient({ baseUrl, email, apiToken });
      clients.set(cacheKey, client);
    }
    return client;
  }

  // Cache active sprint per projectKey (resolved lazily)
  const sprintCache = new Map<string, string | null>();

  async function resolveActiveSprint(project: ProjectConfig): Promise<string | null> {
    const projectKey = getProjectKey(project);
    if (!projectKey) return null;

    const cached = sprintCache.get(projectKey);
    if (cached !== undefined) return cached;

    try {
      const client = getClient(project);
      const boardId = await client.findBoardId(projectKey);
      if (boardId) {
        const sprint = await client.getActiveSprint(boardId);
        // Definitive result (sprint name or null for "no active sprint")
        // — safe to cache.
        sprintCache.set(projectKey, sprint);
        return sprint;
      }
      // Board lookup succeeded but found no board — stable state, cache it.
      sprintCache.set(projectKey, null);
      return null;
    } catch {
      // Transient failure (missing creds, network, API downtime). Do NOT
      // cache — otherwise a single failed call permanently disables sprint
      // resolution (and branchName drops the Sprint prefix) for the life
      // of this tracker instance. Returning null lets this call degrade
      // gracefully while leaving the cache open for a retry on the next
      // call.
      return null;
    }
  }

  const tracker: Tracker = {
    name: "jira",

    async getIssue(identifier: string, project: ProjectConfig): Promise<Issue> {
      await resolveActiveSprint(project);
      const client = getClient(project);
      const issue = await client.getIssue(identifier);
      return mapIssue(issue, getBaseUrl(project));
    },

    async isCompleted(identifier: string, project: ProjectConfig): Promise<boolean> {
      const client = getClient(project);
      const issue = await client.getIssue(identifier);
      const state = mapState(
        issue.fields.status.name,
        issue.fields.status.statusCategory?.key,
      );
      return state === "closed" || state === "cancelled";
    },

    issueUrl(identifier: string, project: ProjectConfig): string {
      const baseUrl = getBaseUrl(project);
      return `${baseUrl.replace(/\/+$/, "")}/browse/${identifier}`;
    },

    issueLabel(url: string, _project: ProjectConfig): string {
      const match = /\/browse\/([A-Z][\w]+-\d+)/.exec(url);
      return match?.[1] ?? url;
    },

    branchName(identifier: string, project: ProjectConfig): string {
      const prefix = getBranchPrefix(project);
      const projectKey = getProjectKey(project);
      const sprintName = sprintCache.get(projectKey);
      if (sprintName) {
        const sprintNum = extractSprintNumber(sprintName);
        return `${prefix}/Sprint${sprintNum}/${identifier}`;
      }
      return `${prefix}/${identifier}`;
    },

    async generatePrompt(identifier: string, project: ProjectConfig): Promise<string> {
      const issue = await tracker.getIssue(identifier, project);
      const lines: string[] = [];

      lines.push(`Jira issue ${identifier}: ${issue.title}`);
      lines.push(`URL: ${issue.url}`);

      if (issue.labels.length > 0) {
        lines.push(`Labels: ${issue.labels.join(", ")}`);
      }
      if (issue.priority !== undefined) {
        lines.push(`Priority: ${issue.priority}`);
      }
      if (issue.description) {
        lines.push("");
        lines.push("## Description");
        lines.push("");
        lines.push(issue.description);
      }

      return lines.join("\n");
    },

    async listIssues(
      filters: IssueFilters,
      project: ProjectConfig,
    ): Promise<Issue[]> {
      const client = getClient(project);
      const effectiveJql = buildJql(getJql(project), getProjectKey(project), filters);
      const limit = filters.limit ?? 50;
      const issues = await client.searchIssues(effectiveJql, limit);
      return issues.map((i) => mapIssue(i, getBaseUrl(project)));
    },

    async updateIssue(
      identifier: string,
      update: IssueUpdate,
      project: ProjectConfig,
    ): Promise<void> {
      const client = getClient(project);
      const statusMap = getStatusMap(project);

      if (update.state) {
        // Prefer explicit statusMap when configured, fall back to runtime
        // transition resolution via Jira transition metadata + heuristics.
        const transitionName = statusMap[update.state];
        if (transitionName) {
          await client.transitionIssue(identifier, transitionName);
        } else {
          const transitionId = await client.findTransitionByState(identifier, update.state);
          if (transitionId) {
            await client.executeTransition(identifier, transitionId);
          }
        }
      }
      // Labels are a single list on the Jira side, so add+remove must be
      // resolved in one read-modify-write cycle. Two independent cycles
      // would race (second fetch may predate first PUT, losing the add).
      const hasAdds = update.labels && update.labels.length > 0;
      const hasRemoves = update.removeLabels && update.removeLabels.length > 0;
      if (hasAdds || hasRemoves) {
        const issue = await client.getIssue(identifier);
        const existing = issue.fields.labels ?? [];
        const removeSet = new Set(update.removeLabels ?? []);
        const merged = [
          ...new Set([
            ...existing.filter((l) => !removeSet.has(l)),
            ...(update.labels ?? []),
          ]),
        ];
        await client.updateIssue(identifier, { labels: merged });
      }
      if (update.assignee) {
        const accountId = await resolveAssigneeAccountId(client, update.assignee);
        if (accountId) {
          await client.updateIssue(identifier, {
            assignee: { accountId },
          });
        }
        // Skip silently when no exact match — safer than a wrong assignment.
      }
      if (update.comment) {
        await client.addComment(identifier, update.comment);
      }
    },

    async createIssue(
      input: CreateIssueInput,
      project: ProjectConfig,
    ): Promise<Issue> {
      const client = getClient(project);
      const projectKey = getProjectKey(project);

      const fields: Record<string, unknown> = {
        summary: input.title,
        description: {
          version: 1,
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: input.description || " " }],
            },
          ],
        },
      };
      if (projectKey) {
        fields.project = { key: projectKey };
      }
      fields.issuetype = { name: getIssueType(project) };
      if (input.labels && input.labels.length > 0) {
        fields.labels = input.labels;
      }
      if (input.assignee) {
        const accountId = await resolveAssigneeAccountId(client, input.assignee);
        if (accountId) {
          fields.assignee = { accountId };
        }
        // Skip silently when no exact match — safer than a wrong assignment.
      }

      const result = await client.createIssue(fields);
      return tracker.getIssue(result.key, project);
    },
  };

  return tracker;
}

// ---------------------------------------------------------------------------
// JQL builder
// ---------------------------------------------------------------------------

/**
 * Escape a value for safe interpolation inside a JQL double-quoted string.
 * JQL uses backslash escaping for `"` and `\` within quoted strings.
 * See https://support.atlassian.com/jira-software-cloud/docs/jql-fields/
 */
function jqlQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function buildJql(
  customJql: string | undefined,
  projectKey: string,
  filters: IssueFilters,
): string {
  if (customJql) return customJql;

  const clauses: string[] = [];
  if (projectKey) {
    clauses.push(`project = ${jqlQuote(projectKey)}`);
  }
  if (filters.state && filters.state !== "all") {
    if (filters.state === "open") {
      clauses.push(`statusCategory != "Done"`);
    } else {
      clauses.push(`statusCategory = "Done"`);
    }
  }
  if (filters.labels && filters.labels.length > 0) {
    for (const label of filters.labels) {
      clauses.push(`labels = ${jqlQuote(label)}`);
    }
  }
  if (filters.assignee) {
    clauses.push(`assignee = ${jqlQuote(filters.assignee)}`);
  }

  return clauses.length > 0
    ? clauses.join(" AND ") + " ORDER BY priority ASC, created DESC"
    : "ORDER BY created DESC";
}

// ---------------------------------------------------------------------------
// Detect
// ---------------------------------------------------------------------------

export function detect(): boolean {
  return !!(process.env.JIRA_BASE_URL && process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export default { manifest, create, detect } satisfies PluginModule<Tracker>;
