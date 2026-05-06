/**
 * tracker-forgejo plugin — Forgejo Issues as an issue tracker.
 *
 * Uses the `gh` CLI for all Forgejo API interactions.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  PluginModule,
  Tracker,
  Issue,
  IssueFilters,
  IssueUpdate,
  CreateIssueInput,
  ProjectConfig,
} from "@aoagents/ao-core";

const execFileAsync = promisify(execFile);

type ForgejoIssue = {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: string;
  labels?: Array<{ name?: string }>;
  assignees?: Array<{ login?: string }>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function gh(args: string[], hostname?: string): Promise<string> {
  const env = hostname ? { ...process.env, GH_HOST: hostname } : process.env;
  try {
    const { stdout } = await execFileAsync("gh", args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
      env,
    });
    return stdout.trim();
  } catch (err) {
    throw new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${(err as Error).message}`, {
      cause: err,
    });
  }
}

function repoHost(repo: string): string | undefined {
  const parts = repo.split("/");
  const first = parts[0];
  return first && first.includes(".") && parts.length >= 3 ? first : undefined;
}

function stripHost(repo: string): string {
  const parts = repo.split("/");
  if (parts[0] && parts[0].includes(".") && parts.length >= 3) {
    return parts.slice(1).join("/");
  }
  return repo;
}

function parseProjectRepo(projectRepo: string): [string, string] {
  const normalized = stripHost(projectRepo);
  const parts = normalized.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repo format "${projectRepo}", expected "owner/repo"`);
  }
  return [parts[0], parts[1]];
}

function requireRepo(project: ProjectConfig): string {
  if (!project.repo) {
    throw new Error("Forgejo tracker requires a 'repo' field in project config");
  }
  return project.repo;
}

function defaultForgejoHost(): string | undefined {
  const envHost = process.env["GH_HOST"]?.trim();
  if (!envHost) return undefined;
  return envHost;
}

function projectConfiguredHost(project: ProjectConfig): string | undefined {
  const trackerHost = (project.tracker as Record<string, unknown> | undefined)?.["host"];
  if (typeof trackerHost === "string" && trackerHost.trim().length > 0) {
    return trackerHost.trim();
  }

  const scmHost = (project.scm as Record<string, unknown> | undefined)?.["host"];
  if (typeof scmHost === "string" && scmHost.trim().length > 0) {
    return scmHost.trim();
  }

  return (project.repo ? repoHost(project.repo) : undefined) ?? defaultForgejoHost();
}

function getErrorText(err: unknown): string {
  if (!(err instanceof Error)) return "";

  const details: string[] = [err.message];
  const withIo = err as Error & { stderr?: string; stdout?: string; cause?: unknown };
  if (typeof withIo.stderr === "string") details.push(withIo.stderr);
  if (typeof withIo.stdout === "string") details.push(withIo.stdout);
  if (withIo.cause instanceof Error) details.push(getErrorText(withIo.cause));

  return details.join("\n").toLowerCase();
}

function isUnknownJsonFieldError(err: unknown, fieldName: string): boolean {
  const text = getErrorText(err);
  if (!text) return false;

  const unknownFieldSignals =
    text.includes("unknown json field") ||
    text.includes("unknown field") ||
    text.includes("invalid field");

  return unknownFieldSignals && text.includes(fieldName.toLowerCase());
}

async function ghIssueViewJson(
  identifier: string,
  project: ProjectConfig,
  hostname?: string,
): Promise<string> {
  const projectRepo = requireRepo(project);
  const fieldsWithStateReason = "number,title,body,url,state,stateReason,labels,assignees";
  try {
    return await gh([
      "issue",
      "view",
      identifier,
      "--repo",
      projectRepo,
      "--json",
      fieldsWithStateReason,
    ], hostname);
  } catch (err) {
    if (!isUnknownJsonFieldError(err, "stateReason")) throw err;
    return gh([
      "issue",
      "view",
      identifier,
      "--repo",
      projectRepo,
      "--json",
      "number,title,body,url,state,labels,assignees",
    ], hostname);
  }
}

async function ghIssueListJson(args: string[], hostname?: string): Promise<string> {
  const withStateReason = [
    ...args,
    "--json",
    "number,title,body,url,state,stateReason,labels,assignees",
  ];
  try {
    return await gh(withStateReason, hostname);
  } catch (err) {
    if (!isUnknownJsonFieldError(err, "stateReason")) throw err;
    return gh([...args, "--json", "number,title,body,url,state,labels,assignees"], hostname);
  }
}

function mapState(ghState: string, stateReason?: string | null): Issue["state"] {
  const s = ghState.toUpperCase();
  if (s === "CLOSED") {
    if (stateReason?.toUpperCase() === "NOT_PLANNED") return "cancelled";
    return "closed";
  }
  return "open";
}

function resolveForgejoToken(): string | undefined {
  const candidates = [
    process.env["FORGEJO_TOKEN"],
    process.env["GITEA_TOKEN"],
    process.env["GH_TOKEN"],
    process.env["GITHUB_TOKEN"],
  ];
  return candidates.find((v) => typeof v === "string" && v.trim().length > 0)?.trim();
}

function issueFromForgejoApi(data: ForgejoIssue): Issue {
  return {
    id: String(data.number),
    title: data.title,
    description: data.body ?? "",
    url: data.html_url,
    state: mapState(data.state),
    labels: (data.labels ?? []).map((l) => l.name ?? "").filter(Boolean),
    assignee: data.assignees?.[0]?.login,
  };
}

/** Match the `gh` CLI timeout in execCli — keeps degraded networks from hanging callers. */
const FORGEJO_API_TIMEOUT_MS = 30_000;

/**
 * Build a Forgejo API base URL that respects an explicit `http://` or
 * `https://` scheme on the configured host. HTTPS remains the default when
 * no scheme is given, but explicit `http://` is honored so on-prem deployments
 * without TLS can still be reached.
 */
function forgejoApiBaseUrl(hostname: string): string {
  const trimmed = hostname.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/\/+$/, "");
  }
  return `https://${trimmed.replace(/\/+$/, "")}`;
}

async function forgejoApi(
  hostname: string,
  token: string,
  method: string,
  path: string,
  query?: Record<string, string | number | boolean | undefined>,
  body?: unknown,
): Promise<unknown> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  const url = `${forgejoApiBaseUrl(hostname)}/api/v1${path}${params.size > 0 ? `?${params.toString()}` : ""}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FORGEJO_API_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(
        `Forgejo API ${method} ${path} timed out after ${FORGEJO_API_TIMEOUT_MS}ms`,
        { cause: err },
      );
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Forgejo API ${method} ${path} failed: ${response.status} ${text}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

// ---------------------------------------------------------------------------
// Tracker implementation
// ---------------------------------------------------------------------------

function createForgejoTracker(config?: Record<string, unknown>): Tracker {
  const configuredHost = typeof config?.host === "string" ? config.host : undefined;
  const token = resolveForgejoToken();

  function resolveHost(project: ProjectConfig): string | undefined {
    if (configuredHost && configuredHost.trim().length > 0) {
      return configuredHost.trim();
    }
    return projectConfiguredHost(project);
  }

  return {
    name: "forgejo",

    async getIssue(identifier: string, project: ProjectConfig): Promise<Issue> {
      const projectRepo = requireRepo(project);
      const hostname = resolveHost(project);
      if (hostname && token) {
        const issueNumber = Number(identifier.replace(/^#/, ""));
        const [owner, repo] = parseProjectRepo(projectRepo);
        const data = (await forgejoApi(
          hostname,
          token,
          "GET",
          `/repos/${owner}/${repo}/issues/${issueNumber}`,
        )) as ForgejoIssue;
        return issueFromForgejoApi(data);
      }

      const raw = await ghIssueViewJson(identifier, project, hostname);

      const data: {
        number: number;
        title: string;
        body: string;
        url: string;
        state: string;
        stateReason?: string | null;
        labels: Array<{ name: string }>;
        assignees: Array<{ login: string }>;
      } = JSON.parse(raw);

      return {
        id: String(data.number),
        title: data.title,
        description: data.body ?? "",
        url: data.url,
        state: mapState(data.state, data.stateReason),
        labels: data.labels.map((l) => l.name),
        assignee: data.assignees[0]?.login,
      };
    },

    async isCompleted(identifier: string, project: ProjectConfig): Promise<boolean> {
      const hostname = resolveHost(project);
      if (hostname && token) {
        const issue = await this.getIssue(identifier, project);
        return issue.state === "closed" || issue.state === "cancelled";
      }

      const raw = await gh([
        "issue",
        "view",
        identifier,
        "--repo",
        requireRepo(project),
        "--json",
        "state",
      ], hostname);
      const data: { state: string } = JSON.parse(raw);
      return data.state.toUpperCase() === "CLOSED";
    },

    issueUrl(identifier: string, project: ProjectConfig): string {
      const num = identifier.replace(/^#/, "");
      const host = resolveHost(project) ?? "forgejo.example";
      return `https://${host}/${stripHost(requireRepo(project))}/issues/${num}`;
    },

    issueLabel(url: string, _project: ProjectConfig): string {
      // Extract issue number from Forgejo URL
      // Example: https://forgejo.example/owner/repo/issues/42 → "#42"
      const match = url.match(/\/issues\/(\d+)/);
      if (match) {
        return `#${match[1]}`;
      }
      // Fallback: return the last segment of the URL
      const parts = url.split("/");
      const lastPart = parts[parts.length - 1];
      return lastPart ? `#${lastPart}` : url;
    },

    branchName(identifier: string, _project: ProjectConfig): string {
      const num = identifier.replace(/^#/, "");
      return `feat/issue-${num}`;
    },

    async generatePrompt(identifier: string, project: ProjectConfig): Promise<string> {
      const issue = await this.getIssue(identifier, project);
      const lines = [
        `You are working on Forgejo issue #${issue.id}: ${issue.title}`,
        `Issue URL: ${issue.url}`,
        "",
      ];

      if (issue.labels.length > 0) {
        lines.push(`Labels: ${issue.labels.join(", ")}`);
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
      const projectRepo = requireRepo(project);
      const hostname = resolveHost(project);
      if (hostname && token) {
        const [owner, repo] = parseProjectRepo(projectRepo);
        const state =
          filters.state === "all" ? "all" : filters.state === "closed" ? "closed" : "open";
        const data = (await forgejoApi(
          hostname,
          token,
          "GET",
          `/repos/${owner}/${repo}/issues`,
          {
            state,
            limit: filters.limit ?? 30,
            labels: filters.labels && filters.labels.length > 0 ? filters.labels.join(",") : undefined,
            assignee: filters.assignee,
          },
        )) as ForgejoIssue[];

        return data.map(issueFromForgejoApi);
      }

      const args = [
        "issue",
        "list",
        "--repo",
        projectRepo,
        "--limit",
        String(filters.limit ?? 30),
      ];

      if (filters.state === "closed") {
        args.push("--state", "closed");
      } else if (filters.state === "all") {
        args.push("--state", "all");
      } else {
        args.push("--state", "open");
      }

      if (filters.labels && filters.labels.length > 0) {
        args.push("--label", filters.labels.join(","));
      }

      if (filters.assignee) {
        args.push("--assignee", filters.assignee);
      }

      const raw = await ghIssueListJson(args, hostname);
      const issues: Array<{
        number: number;
        title: string;
        body: string;
        url: string;
        state: string;
        stateReason?: string | null;
        labels: Array<{ name: string }>;
        assignees: Array<{ login: string }>;
      }> = JSON.parse(raw);

      return issues.map((data) => ({
        id: String(data.number),
        title: data.title,
        description: data.body ?? "",
        url: data.url,
        state: mapState(data.state, data.stateReason),
        labels: data.labels.map((l) => l.name),
        assignee: data.assignees[0]?.login,
      }));
    },

    async updateIssue(
      identifier: string,
      update: IssueUpdate,
      project: ProjectConfig,
    ): Promise<void> {
      const projectRepo = requireRepo(project);
      const hostname = resolveHost(project);
      if (hostname && token) {
        const issueNumber = Number(identifier.replace(/^#/, ""));
        const [owner, repo] = parseProjectRepo(projectRepo);

        if (update.state === "closed") {
          await forgejoApi(hostname, token, "PATCH", `/repos/${owner}/${repo}/issues/${issueNumber}`, undefined, {
            state: "closed",
          });
        } else if (update.state === "open") {
          await forgejoApi(hostname, token, "PATCH", `/repos/${owner}/${repo}/issues/${issueNumber}`, undefined, {
            state: "open",
          });
        }

        if (update.labels && update.labels.length > 0) {
          const repoLabels = (await forgejoApi(
            hostname,
            token,
            "GET",
            `/repos/${owner}/${repo}/labels`,
            { limit: 100 },
          )) as Array<{ id?: number; name?: string }>;
          const labelIdByName = new Map<string, number>();
          for (const repoLabel of repoLabels) {
            if (typeof repoLabel.name === "string" && typeof repoLabel.id === "number") {
              labelIdByName.set(repoLabel.name, repoLabel.id);
            }
          }

          const labelIds = update.labels.map((labelName) => labelIdByName.get(labelName));
          const missingLabels = update.labels.filter((_, index) => labelIds[index] === undefined);
          if (missingLabels.length > 0) {
            throw new Error(
              `Unable to resolve Forgejo label IDs for: ${missingLabels.join(", ")}`,
            );
          }

          await forgejoApi(hostname, token, "PATCH", `/repos/${owner}/${repo}/issues/${issueNumber}`, undefined, {
            labels: labelIds,
          });
        }

        if (update.assignee) {
          await forgejoApi(
            hostname,
            token,
            "POST",
            `/repos/${owner}/${repo}/issues/${issueNumber}/assignees`,
            undefined,
            {
              assignees: [update.assignee],
            },
          );
        }

        if (update.comment) {
          await forgejoApi(
            hostname,
            token,
            "POST",
            `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
            undefined,
            {
              body: update.comment,
            },
          );
        }

        return;
      }

      // Handle state change — Forgejo Issues only supports open/closed.
      // "in_progress" is not a Forgejo state, so it is intentionally a no-op.
      if (update.state === "closed") {
        await gh(["issue", "close", identifier, "--repo", projectRepo], hostname);
      } else if (update.state === "open") {
        await gh(["issue", "reopen", identifier, "--repo", projectRepo], hostname);
      }

      // Handle label removal
      if (update.removeLabels && update.removeLabels.length > 0) {
        await gh([
          "issue",
          "edit",
          identifier,
          "--repo",
          projectRepo,
          "--remove-label",
          update.removeLabels.join(","),
        ], hostname);
      }

      // Handle label changes
      if (update.labels && update.labels.length > 0) {
        await gh([
          "issue",
          "edit",
          identifier,
          "--repo",
          projectRepo,
          "--add-label",
          update.labels.join(","),
        ], hostname);
      }

      // Handle assignee changes
      if (update.assignee) {
        await gh([
          "issue",
          "edit",
          identifier,
          "--repo",
          projectRepo,
          "--add-assignee",
          update.assignee,
        ], hostname);
      }

      // Handle comment
      if (update.comment) {
        await gh([
          "issue",
          "comment",
          identifier,
          "--repo",
          projectRepo,
          "--body",
          update.comment,
        ], hostname);
      }
    },

    async createIssue(input: CreateIssueInput, project: ProjectConfig): Promise<Issue> {
      const projectRepo = requireRepo(project);
      const hostname = resolveHost(project);
      if (hostname && token) {
        const [owner, repo] = parseProjectRepo(projectRepo);
        const data = (await forgejoApi(
          hostname,
          token,
          "POST",
          `/repos/${owner}/${repo}/issues`,
          undefined,
          {
            title: input.title,
            body: input.description ?? "",
            ...(input.labels && input.labels.length > 0 ? { labels: input.labels } : {}),
            ...(input.assignee ? { assignees: [input.assignee] } : {}),
          },
        )) as ForgejoIssue;
        return issueFromForgejoApi(data);
      }

      const args = [
        "issue",
        "create",
        "--repo",
        projectRepo,
        "--title",
        input.title,
        "--body",
        input.description ?? "",
      ];

      if (input.labels && input.labels.length > 0) {
        args.push("--label", input.labels.join(","));
      }

      if (input.assignee) {
        args.push("--assignee", input.assignee);
      }

      // gh issue create outputs the URL of the new issue
      const url = await gh(args, hostname);

      // Extract issue number from URL and fetch full details
      const match = url.match(/\/issues\/(\d+)/);
      if (!match) {
        throw new Error(`Failed to parse issue URL from gh output: ${url}`);
      }
      const number = match[1];

      return this.getIssue(number, project);
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin module export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "forgejo",
  slot: "tracker" as const,
  description: "Tracker plugin: Forgejo Issues",
  version: "0.1.0",
};

export function create(config?: Record<string, unknown>): Tracker {
  return createForgejoTracker(config);
}

export default { manifest, create } satisfies PluginModule<Tracker>;
