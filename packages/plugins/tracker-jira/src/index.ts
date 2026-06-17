/**
 * tracker-jira plugin — Jira Cloud as an issue tracker.
 *
 * Uses the Jira Cloud REST API v3 with Basic auth (email + API token).
 *
 * Configuration (via project.tracker in YAML):
 *   tracker:
 *     plugin: jira
 *     domain: mycompany          # or mycompany.atlassian.net
 *     projectKey: PROJ            # optional, for JQL filtering
 *
 * Environment variables:
 *   JIRA_DOMAIN     — Jira Cloud domain (fallback if not in config)
 *   JIRA_EMAIL      — Account email for Basic auth
 *   JIRA_API_TOKEN  — API token for Basic auth
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

import { createJiraClient, type JiraClient } from "./http-client.js";
import type {
  JiraIssue,
  JiraSearchResponse,
  JiraTransitionsResponse,
  JiraCreateIssueResponse,
} from "./types.js";
import { adfToPlainText, plainTextToAdf } from "./adf.js";

// ---------------------------------------------------------------------------
// JQL escaping — prevent injection via filter values
// ---------------------------------------------------------------------------

function escapeJql(value: string): string {
  // JQL strings are delimited by double quotes. Escape backslashes first,
  // then double quotes, newlines, and tabs to prevent breakout.
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

// ---------------------------------------------------------------------------
// State mapping
// ---------------------------------------------------------------------------

function mapJiraState(statusCategoryKey: string): Issue["state"] {
  switch (statusCategoryKey) {
    case "done":
      return "closed";
    case "indeterminate":
      return "in_progress";
    case "new":
    default:
      return "open";
  }
}

// ---------------------------------------------------------------------------
// Domain resolution helper
// ---------------------------------------------------------------------------

function resolveDomain(domain: string): string {
  // If already a full domain, return as-is
  if (domain.includes(".")) return domain;
  return `${domain}.atlassian.net`;
}

// ---------------------------------------------------------------------------
// Jira issue → core Issue mapper
// ---------------------------------------------------------------------------

function toIssue(jira: JiraIssue, domain: string): Issue {
  const fullDomain = resolveDomain(domain);
  return {
    id: jira.key,
    title: jira.fields.summary,
    description: adfToPlainText(jira.fields.description),
    url: `https://${fullDomain}/browse/${jira.key}`,
    state: mapJiraState(jira.fields?.status?.statusCategory?.key ?? "new"),
    labels: jira.fields.labels ?? [],
    assignee: jira.fields.assignee?.displayName,
    priority: (() => { const pId = parseInt(jira.fields?.priority?.id ?? "", 10); return isNaN(pId) ? undefined : pId; })(),
  };
}

// ---------------------------------------------------------------------------
// Tracker implementation
// ---------------------------------------------------------------------------

function createJiraTracker(client: JiraClient, domain: string, projectKey?: string, config?: Record<string, unknown>): Tracker {
  const fullDomain = resolveDomain(domain);

  return {
    name: "jira",

    async getIssue(identifier: string, _project: ProjectConfig): Promise<Issue> {
      const jira = await client.get<JiraIssue>(
        `/issue/${identifier}`,
        { fields: "summary,status,description,labels,assignee,priority,project" },
      );
      return toIssue(jira, domain);
    },

    async isCompleted(identifier: string, _project: ProjectConfig): Promise<boolean> {
      const jira = await client.get<JiraIssue>(
        `/issue/${identifier}`,
        { fields: "status" },
      );
      return jira.fields?.status?.statusCategory?.key === "done";
    },

    issueUrl(identifier: string, _project: ProjectConfig): string {
      return `https://${fullDomain}/browse/${identifier}`;
    },

    issueLabel(url: string, _project: ProjectConfig): string {
      // Extract issue key from Jira URL
      // Examples:
      //   https://mycompany.atlassian.net/browse/PROJ-123
      //   https://mycompany.atlassian.net/browse/PROJ-123?extra=params
      const match = url.match(/\/browse\/([A-Z][A-Z0-9_]+-\d+)/);
      if (match) {
        return match[1];
      }
      // Fallback: return the last path segment
      const parts = url.split("/");
      return parts[parts.length - 1] || url;
    },

    branchName(identifier: string, _project: ProjectConfig): string {
      return `feat/${identifier}`;
    },

    async generatePrompt(identifier: string, _project: ProjectConfig): Promise<string> {
      // Fetch raw Jira issue to get priority name (not just numeric ID)
      const jira = await client.get<JiraIssue>(
        `/issue/${identifier}`,
        { fields: "summary,status,description,labels,assignee,priority,project,comment" },
      );

      const lines = [
        `You are working on Jira issue ${jira.key}: ${jira.fields.summary}`,
        `Issue URL: ${this.issueUrl(identifier, _project)}`,
        "",
      ];

      if (jira.fields.labels && jira.fields.labels.length > 0) {
        lines.push(`Labels: ${jira.fields.labels.join(", ")}`);
      }

      const priorityName = jira.fields?.priority?.name;
      if (priorityName) {
        lines.push(`Priority: ${priorityName}`);
      }

      const status = jira.fields?.status?.name;
      if (status) {
        lines.push(`Status: ${status}`);
      }

      if (jira.fields.description) {
        lines.push("", "## Description", "", adfToPlainText(jira.fields.description));
      }

      // Include comments for additional context
      const comments = jira.fields.comment?.comments;
      if (comments && comments.length > 0) {
        lines.push("", "## Comments");
        for (const c of comments.slice(-5)) { // last 5 comments
          const author = c.author?.displayName ?? "Unknown";
          const body = c.body ? adfToPlainText(c.body) : "";
          if (body) {
            lines.push("", `**${author}:**`, body);
          }
        }
      }

      lines.push(
        "",
        "Please implement the changes described in this issue. When done, commit and push your changes.",
      );

      return lines.join("\n");
    },

    async listIssues(filters: IssueFilters, _project: ProjectConfig): Promise<Issue[]> {
      // Build JQL from filters — escape values to prevent JQL injection
      const clauses: string[] = [];

      if (projectKey) {
        clauses.push(`project = "${escapeJql(projectKey)}"`);
      }

      if (filters.state === "open") {
        clauses.push(`statusCategory != "Done"`);
      } else if (filters.state === "closed") {
        clauses.push(`statusCategory = "Done"`);
      }
      // "all" → no state filter

      if (filters.labels && filters.labels.length > 0) {
        const labelList = filters.labels.map((l) => `"${escapeJql(l)}"`).join(", ");
        clauses.push(`labels in (${labelList})`);
      }

      if (filters.assignee) {
        clauses.push(`assignee = "${escapeJql(filters.assignee)}"`);
      }

      const jql = clauses.length > 0 ? clauses.join(" AND ") : "ORDER BY created DESC";
      const maxResults = filters.limit ?? 30;

      // Jira Cloud deprecated /search (GET) in favor of /search/jql (POST)
      // See: https://developer.atlassian.com/changelog/#CHANGE-2046
      const resp = await client.post<JiraSearchResponse>("/search/jql", {
        jql: clauses.length > 0 ? jql + " ORDER BY created DESC" : jql,
        maxResults,
        fields: ["summary", "status", "description", "labels", "assignee", "priority", "project"],
      });

      return (resp.issues ?? []).map((issue) => toIssue(issue, domain));
    },

    async updateIssue(
      identifier: string,
      update: IssueUpdate,
      _project: ProjectConfig,
    ): Promise<void> {
      // Handle state change via transitions
      if (update.state) {
        const transResp = await client.get<JiraTransitionsResponse>(
          `/issue/${identifier}/transitions`,
        );

        const targetCategoryKey =
          update.state === "closed"
            ? "done"
            : update.state === "in_progress"
              ? "indeterminate"
              : "new";

        const transition = (transResp.transitions ?? []).find(
          (t) => t.to.statusCategory.key === targetCategoryKey,
        );

        if (!transition) {
          const available = (transResp.transitions ?? [])
            .map((t) => `"${t.name}" (${t.to.statusCategory.key})`)
            .join(", ");
          throw new Error(
            `No Jira transition found to move issue ${identifier} to state "${update.state}" ` +
              `(target category: ${targetCategoryKey}). Available transitions: ${available}`,
          );
        }

        await client.post(`/issue/${identifier}/transitions`, {
          transition: { id: transition.id },
        });
      }

      // Handle labels (merge existing + new, remove removeLabels)
      if (
        (update.labels && update.labels.length > 0) ||
        (update.removeLabels && update.removeLabels.length > 0)
      ) {
        // Fetch current labels
        const current = await client.get<JiraIssue>(
          `/issue/${identifier}`,
          { fields: "labels" },
        );
        const existingLabels = new Set(current.fields.labels ?? []);

        // Add new labels
        if (update.labels) {
          for (const label of update.labels) {
            existingLabels.add(label);
          }
        }

        // Remove labels
        if (update.removeLabels) {
          for (const label of update.removeLabels) {
            existingLabels.delete(label);
          }
        }

        await client.put(`/issue/${identifier}`, {
          fields: { labels: [...existingLabels] },
        });
      }

      // Handle comment
      if (update.comment) {
        await client.post(`/issue/${identifier}/comment`, {
          body: plainTextToAdf(update.comment),
        });
      }

      // Handle assignee — needs accountId lookup, log warning for now
      if (update.assignee) {
        // Jira requires accountId, not display name. Direct assignment by name
        // is not supported without a user search. Log a warning.
        // eslint-disable-next-line no-console -- intentional operational warning
        console.warn(
          `[tracker-jira] Assignee update for "${update.assignee}" skipped: ` +
            `Jira requires accountId for assignment. Use the Jira UI or provide accountId directly.`,
        );
      }
    },

    async createIssue(input: CreateIssueInput, _project: ProjectConfig): Promise<Issue> {
      const pKey = projectKey;
      if (!pKey) {
        throw new Error(
          "Jira tracker requires 'projectKey' in project tracker config to create issues",
        );
      }

      const fields: Record<string, unknown> = {
        project: { key: pKey },
        summary: input.title,
        description: plainTextToAdf(input.description ?? ""),
        issuetype: { name: typeof config?.issueType === "string" ? config.issueType : "Task" },
        labels: input.labels ?? [],
      };

      if (input.priority) {
        fields["priority"] = { id: String(input.priority) };
      }

      const created = await client.post<JiraCreateIssueResponse>("/issue", { fields });

      // Fetch the full issue to return a complete Issue object
      const jira = await client.get<JiraIssue>(
        `/issue/${created.key}`,
        { fields: "summary,status,description,labels,assignee,priority,project" },
      );
      return toIssue(jira, domain);
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin module export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "jira",
  slot: "tracker" as const,
  description: "Jira Cloud tracker — issues, JQL search, transitions",
  version: "0.1.0",
};

export function create(config?: Record<string, unknown>): Tracker {
  // Resolve domain
  const domain =
    (config?.["domain"] as string | undefined) ??
    process.env["JIRA_DOMAIN"];
  if (!domain) {
    throw new Error(
      "Jira tracker requires 'domain' in tracker config or JIRA_DOMAIN environment variable",
    );
  }

  // Resolve email
  const emailEnvVar = (config?.["emailEnvVar"] as string | undefined) ?? "JIRA_EMAIL";
  const email = process.env[emailEnvVar];
  if (!email) {
    throw new Error(
      `Jira tracker requires ${emailEnvVar} environment variable`,
    );
  }

  // Resolve API token
  const tokenEnvVar = (config?.["tokenEnvVar"] as string | undefined) ?? "JIRA_API_TOKEN";
  const apiToken = process.env[tokenEnvVar];
  if (!apiToken) {
    throw new Error(
      `Jira tracker requires ${tokenEnvVar} environment variable`,
    );
  }

  // Optional project key for filtering
  const projectKey = config?.["projectKey"] as string | undefined;

  const client = createJiraClient({ domain, email, apiToken });

  return createJiraTracker(client, domain, projectKey, config);
}

export default { manifest, create } satisfies PluginModule<Tracker>;
