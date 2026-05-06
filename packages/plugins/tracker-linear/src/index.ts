/**
 * tracker-linear plugin — Linear as an issue tracker.
 *
 * Uses the Linear GraphQL API with either:
 * - LINEAR_API_KEY (direct API access)
 * - COMPOSIO_API_KEY (via Composio SDK's LINEAR_RUN_QUERY_OR_MUTATION tool)
 *
 * Auto-detects which key is available and routes accordingly.
 */

import { request } from "node:https";
import type {
  PluginModule,
  Tracker,
  Issue,
  IssueFilters,
  IssueUpdate,
  CreateIssueInput,
  ProjectConfig,
} from "@aoagents/ao-core";
import type { Composio } from "@composio/core";

// ---------------------------------------------------------------------------
// Transport abstraction
// ---------------------------------------------------------------------------

/**
 * A function that sends a GraphQL query/mutation and returns the parsed data.
 * Both the direct Linear API and Composio SDK transports implement this.
 */
type GraphQLTransport = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;

// ---------------------------------------------------------------------------
// Direct Linear API transport
// ---------------------------------------------------------------------------

const LINEAR_API_URL = "https://api.linear.app/graphql";

function getApiKey(): string {
  const key = process.env["LINEAR_API_KEY"];
  if (!key) {
    throw new Error(
      "LINEAR_API_KEY environment variable is required for the Linear tracker plugin",
    );
  }
  return key;
}

interface LinearResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

function createDirectTransport(): GraphQLTransport {
  return <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
    const apiKey = getApiKey();
    const body = JSON.stringify({ query, variables });

    return new Promise<T>((resolve, reject) => {
      const url = new URL(LINEAR_API_URL);
      let settled = false;
      const settle = (fn: () => void) => {
        if (!settled) {
          settled = true;
          fn();
        }
      };

      const req = request(
        {
          hostname: url.hostname,
          path: url.pathname,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: apiKey,
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("error", (err: Error) => settle(() => reject(err)));
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            settle(() => {
              try {
                const text = Buffer.concat(chunks).toString("utf-8");
                const status = res.statusCode ?? 0;
                if (status < 200 || status >= 300) {
                  reject(new Error(`Linear API returned HTTP ${status}: ${text.slice(0, 200)}`));
                  return;
                }
                const json: LinearResponse<T> = JSON.parse(text);
                if (json.errors && json.errors.length > 0) {
                  reject(new Error(`Linear API error: ${json.errors[0].message}`));
                  return;
                }
                if (!json.data) {
                  reject(new Error("Linear API returned no data"));
                  return;
                }
                resolve(json.data);
              } catch (err) {
                reject(err);
              }
            });
          });
        },
      );

      req.setTimeout(30_000, () => {
        settle(() => {
          req.destroy();
          reject(new Error("Linear API request timed out after 30s"));
        });
      });

      req.on("error", (err) => settle(() => reject(err)));
      req.write(body);
      req.end();
    });
  };
}

// ---------------------------------------------------------------------------
// Composio SDK transport
// ---------------------------------------------------------------------------

type ComposioTools = Composio["tools"];

function createComposioTransport(apiKey: string, entityId: string): GraphQLTransport {
  // Lazy-load the Composio client — cached as a promise so the constructor
  // is called only once, even under concurrent requests.
  let clientPromise: Promise<ComposioTools> | undefined;

  function getClient(): Promise<ComposioTools> {
    if (!clientPromise) {
      clientPromise = (async () => {
        try {
          const { Composio } = await import("@composio/core");
          const client = new Composio({ apiKey });
          return client.tools;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (
            msg.includes("Cannot find module") ||
            msg.includes("Cannot find package") ||
            msg.includes("ERR_MODULE_NOT_FOUND")
          ) {
            throw new Error(
              "Composio SDK (@composio/core) is not installed. " +
                "Install it with: pnpm add @composio/core",
              { cause: err },
            );
          }
          throw err;
        }
      })();
    }
    return clientPromise;
  }

  return async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
    const tools = await getClient();

    const resultPromise = tools.execute("LINEAR_RUN_QUERY_OR_MUTATION", {
      entityId,
      arguments: {
        query_or_mutation: query,
        variables: variables ? JSON.stringify(variables) : "{}",
      },
    });

    // Apply 30s timeout for parity with the direct transport
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error("Composio Linear API request timed out after 30s"));
      }, 30_000);
    });

    // Whichever promise loses the race is left without a handler.
    // Attach no-op .catch() to both so the loser doesn't trigger an
    // unhandled promise rejection. This does not affect Promise.race —
    // it still propagates the winning rejection normally.
    resultPromise.catch(() => {});
    timeoutPromise.catch(() => {});

    try {
      const result = await Promise.race([resultPromise, timeoutPromise]);

      if (!result.successful) {
        throw new Error(`Composio Linear API error: ${result.error ?? "unknown error"}`);
      }

      if (!result.data) {
        throw new Error("Composio Linear API returned no data");
      }

      return result.data as T;
    } finally {
      clearTimeout(timer);
    }
  };
}

// ---------------------------------------------------------------------------
// Types for Linear responses
// ---------------------------------------------------------------------------

interface LinearIssueNode {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  priority: number;
  branchName?: string | null;
  state: {
    name: string;
    type: string; // "triage" | "backlog" | "unstarted" | "started" | "completed" | "canceled"
  };
  labels: {
    nodes: Array<{ name: string }>;
  };
  assignee: {
    name: string;
    displayName: string;
  } | null;
  team: {
    key: string;
  };
}

// ---------------------------------------------------------------------------
// State mapping
// ---------------------------------------------------------------------------

function mapLinearState(stateType: string): Issue["state"] {
  switch (stateType) {
    case "completed":
      return "closed";
    case "canceled":
      return "cancelled";
    case "started":
      return "in_progress";
    default:
      // triage, backlog, unstarted
      return "open";
  }
}

// ---------------------------------------------------------------------------
// Issue fields fragment
// ---------------------------------------------------------------------------

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  url
  priority
  branchName
  state { name type }
  labels { nodes { name } }
  assignee { name displayName }
  team { key }
`;

// ---------------------------------------------------------------------------
// Tracker implementation
// ---------------------------------------------------------------------------

function createLinearTracker(query: GraphQLTransport): Tracker {
  return {
    name: "linear",

    async getIssue(identifier: string, _project: ProjectConfig): Promise<Issue> {
      const data = await query<{ issue: LinearIssueNode }>(
        `query($id: String!) {
          issue(id: $id) {
            ${ISSUE_FIELDS}
          }
        }`,
        { id: identifier },
      );

      const node = data.issue;
      return {
        id: node.identifier,
        title: node.title,
        description: node.description ?? "",
        url: node.url,
        state: mapLinearState(node.state.type),
        labels: node.labels.nodes.map((l) => l.name),
        assignee: node.assignee?.displayName ?? node.assignee?.name,
        priority: node.priority,
        branchName: node.branchName ?? undefined,
      };
    },

    async isCompleted(identifier: string, _project: ProjectConfig): Promise<boolean> {
      const data = await query<{ issue: { state: { type: string } } }>(
        `query($id: String!) {
          issue(id: $id) {
            state { type }
          }
        }`,
        { id: identifier },
      );

      const stateType = data.issue.state.type;
      return stateType === "completed" || stateType === "canceled";
    },

    issueUrl(identifier: string, project: ProjectConfig): string {
      const slug = project.tracker?.["workspaceSlug"] as string | undefined;
      if (slug) {
        return `https://linear.app/${slug}/issue/${identifier}`;
      }
      // Fallback: Linear also supports /issue/ URLs that redirect,
      // but they require authentication
      return `https://linear.app/issue/${identifier}`;
    },

    issueLabel(url: string, _project: ProjectConfig): string {
      // Extract identifier from Linear URL
      // Examples:
      //   https://linear.app/composio/issue/INT-1327
      //   https://linear.app/issue/INT-1327
      const match = url.match(/\/issue\/([A-Z]+-\d+)/);
      if (match) {
        return match[1];
      }
      // Fallback: return the last segment of the URL
      const parts = url.split("/");
      return parts[parts.length - 1] || url;
    },

    branchName(identifier: string, _project: ProjectConfig): string {
      // Linear convention: feat/INT-1330
      return `feat/${identifier}`;
    },

    async generatePrompt(identifier: string, project: ProjectConfig): Promise<string> {
      const issue = await this.getIssue(identifier, project);
      const lines = [
        `You are working on Linear ticket ${issue.id}: ${issue.title}`,
        `Issue URL: ${issue.url}`,
        "",
      ];

      if (issue.labels.length > 0) {
        lines.push(`Labels: ${issue.labels.join(", ")}`);
      }

      if (issue.priority !== undefined) {
        const priorityNames: Record<number, string> = {
          0: "No priority",
          1: "Urgent",
          2: "High",
          3: "Normal",
          4: "Low",
        };
        lines.push(`Priority: ${priorityNames[issue.priority] ?? String(issue.priority)}`);
      }

      if (issue.description) {
        lines.push("## Description", "", issue.description);
      }

      lines.push(
        "",
        "Please implement the changes described in this ticket. When done, commit and push your changes.",
      );

      return lines.join("\n");
    },

    async listIssues(filters: IssueFilters, project: ProjectConfig): Promise<Issue[]> {
      // Build filter object using GraphQL variables to prevent injection
      const filter: Record<string, unknown> = {};
      const variables: Record<string, unknown> = {};

      if (filters.state === "closed") {
        filter["state"] = { type: { in: ["completed", "canceled"] } };
      } else if (filters.state !== "all") {
        // Default to open (exclude completed/canceled) to match tracker-github
        filter["state"] = { type: { nin: ["completed", "canceled"] } };
      }

      if (filters.assignee) {
        filter["assignee"] = { displayName: { eq: filters.assignee } };
      }

      if (filters.labels && filters.labels.length > 0) {
        filter["labels"] = { name: { in: filters.labels } };
      }

      // Add team filter if available from project config
      const teamId = project.tracker?.["teamId"];
      if (teamId) {
        filter["team"] = { id: { eq: teamId } };
      }

      variables["filter"] = Object.keys(filter).length > 0 ? filter : undefined;
      variables["first"] = filters.limit ?? 30;

      const data = await query<{
        issues: { nodes: LinearIssueNode[] };
      }>(
        `query($filter: IssueFilter, $first: Int!) {
          issues(filter: $filter, first: $first) {
            nodes {
              ${ISSUE_FIELDS}
            }
          }
        }`,
        variables,
      );

      return data.issues.nodes.map((node) => ({
        id: node.identifier,
        title: node.title,
        description: node.description ?? "",
        url: node.url,
        state: mapLinearState(node.state.type),
        labels: node.labels.nodes.map((l) => l.name),
        assignee: node.assignee?.displayName ?? node.assignee?.name,
        priority: node.priority,
        branchName: node.branchName ?? undefined,
      }));
    },

    async updateIssue(
      identifier: string,
      update: IssueUpdate,
      _project: ProjectConfig,
    ): Promise<void> {
      // Linear's issue() query accepts both UUID and short identifier (e.g. "INT-1330").
      // We resolve to UUID here for use in mutations.
      const issueData = await query<{
        issue: { id: string; team: { id: string } };
      }>(
        `query($id: String!) {
          issue(id: $id) {
            id
            team { id }
          }
        }`,
        { id: identifier },
      );

      const issueUuid = issueData.issue.id;
      const teamId = issueData.issue.team.id;

      // Handle state change
      if (update.state) {
        // Need to find the correct workflow state ID
        const statesData = await query<{
          workflowStates: { nodes: Array<{ id: string; name: string; type: string }> };
        }>(
          `query($teamId: ID!) {
            workflowStates(filter: { team: { id: { eq: $teamId } } }) {
              nodes { id name type }
            }
          }`,
          { teamId },
        );

        const targetType =
          update.state === "closed"
            ? "completed"
            : update.state === "open"
              ? "unstarted"
              : "started";

        const targetState = statesData.workflowStates.nodes.find((s) => s.type === targetType);

        if (!targetState) {
          throw new Error(`No workflow state of type "${targetType}" found for team ${teamId}`);
        }

        await query(
          `mutation($id: String!, $stateId: String!) {
            issueUpdate(id: $id, input: { stateId: $stateId }) {
              success
            }
          }`,
          { id: issueUuid, stateId: targetState.id },
        );
      }

      // Handle assignee
      if (update.assignee) {
        const usersData = await query<{
          users: { nodes: Array<{ id: string; displayName: string; name: string }> };
        }>(
          `query($filter: UserFilter) {
            users(filter: $filter) {
              nodes { id displayName name }
            }
          }`,
          { filter: { displayName: { eq: update.assignee } } },
        );

        const user = usersData.users.nodes[0];
        if (user) {
          await query(
            `mutation($id: String!, $assigneeId: String!) {
              issueUpdate(id: $id, input: { assigneeId: $assigneeId }) {
                success
              }
            }`,
            { id: issueUuid, assigneeId: user.id },
          );
        }
      }

      // Handle labels (additive — merge with existing labels to match tracker-github behavior)
      if (update.labels && update.labels.length > 0) {
        // Fetch existing label IDs on the issue
        const existingData = await query<{
          issue: { labels: { nodes: Array<{ id: string }> } };
        }>(
          `query($id: String!) {
            issue(id: $id) {
              labels { nodes { id } }
            }
          }`,
          { id: issueUuid },
        );
        const existingIds = new Set(existingData.issue.labels.nodes.map((l) => l.id));

        // Resolve new label names to IDs
        const labelsData = await query<{
          issueLabels: { nodes: Array<{ id: string; name: string }> };
        }>(
          `query($teamId: ID) {
            issueLabels(filter: { team: { id: { eq: $teamId } } }) {
              nodes { id name }
            }
          }`,
          { teamId },
        );

        const labelMap = new Map(labelsData.issueLabels.nodes.map((l) => [l.name, l.id]));
        for (const name of update.labels) {
          const id = labelMap.get(name);
          if (id) existingIds.add(id);
        }

        await query(
          `mutation($id: String!, $labelIds: [String!]!) {
            issueUpdate(id: $id, input: { labelIds: $labelIds }) {
              success
            }
          }`,
          { id: issueUuid, labelIds: [...existingIds] },
        );
      }

      // Handle comment
      if (update.comment) {
        await query(
          `mutation($issueId: String!, $body: String!) {
            commentCreate(input: { issueId: $issueId, body: $body }) {
              success
            }
          }`,
          { issueId: issueUuid, body: update.comment },
        );
      }
    },

    async createIssue(input: CreateIssueInput, project: ProjectConfig): Promise<Issue> {
      const teamId = project.tracker?.["teamId"];
      if (!teamId) {
        throw new Error("Linear tracker requires 'teamId' in project tracker config");
      }

      const variables: Record<string, unknown> = {
        title: input.title,
        description: input.description ?? "",
        teamId,
      };

      if (input.priority !== undefined) {
        variables["priority"] = input.priority;
      }

      const data = await query<{
        issueCreate: {
          success: boolean;
          issue: LinearIssueNode;
        };
      }>(
        `mutation($title: String!, $description: String!, $teamId: String!, $priority: Int) {
          issueCreate(input: {
            title: $title,
            description: $description,
            teamId: $teamId,
            priority: $priority
          }) {
            success
            issue {
              ${ISSUE_FIELDS}
            }
          }
        }`,
        variables,
      );

      const node = data.issueCreate.issue;
      const issue: Issue = {
        id: node.identifier,
        title: node.title,
        description: node.description ?? "",
        url: node.url,
        state: mapLinearState(node.state.type),
        labels: node.labels.nodes.map((l) => l.name),
        assignee: node.assignee?.displayName ?? node.assignee?.name,
        priority: node.priority,
        branchName: node.branchName ?? undefined,
      };

      // Assign after creation (Linear's issueCreate uses assigneeId, not display name)
      if (input.assignee) {
        try {
          const usersData = await query<{
            users: { nodes: Array<{ id: string; displayName: string; name: string }> };
          }>(
            `query($filter: UserFilter) {
              users(filter: $filter) {
                nodes { id displayName name }
              }
            }`,
            { filter: { displayName: { eq: input.assignee } } },
          );

          const user = usersData.users.nodes[0];
          if (user) {
            await query(
              `mutation($id: String!, $assigneeId: String!) {
                issueUpdate(id: $id, input: { assigneeId: $assigneeId }) {
                  success
                }
              }`,
              { id: node.id, assigneeId: user.id },
            );
            issue.assignee = input.assignee;
          }
        } catch {
          // Assignee is best-effort
        }
      }

      // Add labels after creation (Linear's issueCreate doesn't accept label names directly)
      if (input.labels && input.labels.length > 0) {
        try {
          // Look up label IDs by name for the team
          const labelsData = await query<{
            issueLabels: { nodes: Array<{ id: string; name: string }> };
          }>(
            `query($teamId: ID) {
              issueLabels(filter: { team: { id: { eq: $teamId } } }) {
                nodes { id name }
              }
            }`,
            { teamId },
          );

          const labelMap = new Map(labelsData.issueLabels.nodes.map((l) => [l.name, l.id]));
          const appliedLabels: string[] = [];
          const labelIds: string[] = [];
          for (const name of input.labels) {
            const id = labelMap.get(name);
            if (id) {
              labelIds.push(id);
              appliedLabels.push(name);
            }
          }

          if (labelIds.length > 0) {
            await query(
              `mutation($id: String!, $labelIds: [String!]!) {
                issueUpdate(id: $id, input: { labelIds: $labelIds }) {
                  success
                }
              }`,
              { id: node.id, labelIds },
            );
            // Reflect only the labels that actually exist in Linear
            issue.labels = appliedLabels;
          }
        } catch {
          // Labels are best-effort; don't fail the whole creation
        }
      }

      return issue;
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin module export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "linear",
  slot: "tracker" as const,
  description: "Tracker plugin: Linear issue tracker",
  version: "0.1.0",
};

export function create(): Tracker {
  const composioKey = process.env["COMPOSIO_API_KEY"];
  if (composioKey) {
    const entityId = process.env["COMPOSIO_ENTITY_ID"] ?? "default";
    return createLinearTracker(createComposioTransport(composioKey, entityId));
  }
  return createLinearTracker(createDirectTransport());
}

export default { manifest, create } satisfies PluginModule<Tracker>;
