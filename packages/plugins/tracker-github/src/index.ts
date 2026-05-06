/**
 * tracker-github plugin — GitHub Issues as an issue tracker.
 *
 * Uses the `gh` CLI for all GitHub API interactions.
 */

import {
  execGhObserved,
  memoizeAsync,
  type PluginModule,
  type Tracker,
  type Issue,
  type IssueFilters,
  type IssueUpdate,
  type CreateIssueInput,
  type ProjectConfig,
} from "@aoagents/ao-core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function gh(args: string[]): Promise<string> {
  try {
    return await execGhObserved(args, { component: "tracker-github" }, 30_000);
  } catch (err) {
    throw new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${(err as Error).message}`, {
      cause: err,
    });
  }
}

/**
 * Process-scoped gh auth check shared with scm-github via the same cache key
 * (`gh-cli-auth`). Both plugins call into this — the second caller hits the
 * cached promise and adds zero subprocess overhead.
 */
async function checkGhCliAuth(): Promise<void> {
  return memoizeAsync("gh-cli-auth", async () => {
    try {
      await gh(["--version"]);
    } catch {
      throw new Error("GitHub CLI (gh) is not installed. Install it: https://cli.github.com/");
    }
    try {
      await gh(["auth", "status"]);
    } catch {
      throw new Error("GitHub CLI is not authenticated. Run: gh auth login");
    }
  });
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

async function ghIssueViewJson(identifier: string, project: ProjectConfig): Promise<string> {
  const repo = requireRepo(project);
  const fieldsWithStateReason = "number,title,body,url,state,stateReason,labels,assignees";
  try {
    return await gh([
      "issue",
      "view",
      identifier,
      "--repo",
      repo,
      "--json",
      fieldsWithStateReason,
    ]);
  } catch (err) {
    if (!isUnknownJsonFieldError(err, "stateReason")) throw err;
    return gh([
      "issue",
      "view",
      identifier,
      "--repo",
      repo,
      "--json",
      "number,title,body,url,state,labels,assignees",
    ]);
  }
}

async function ghIssueListJson(args: string[]): Promise<string> {
  const withStateReason = [
    ...args,
    "--json",
    "number,title,body,url,state,stateReason,labels,assignees",
  ];
  try {
    return await gh(withStateReason);
  } catch (err) {
    if (!isUnknownJsonFieldError(err, "stateReason")) throw err;
    return gh([...args, "--json", "number,title,body,url,state,labels,assignees"]);
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

// ---------------------------------------------------------------------------
// Tracker implementation
// ---------------------------------------------------------------------------

function requireRepo(project: ProjectConfig): string {
  if (!project.repo) {
    throw new Error("GitHub tracker requires a 'repo' field in project config");
  }
  return project.repo;
}

// Issue cache: 5 min TTL, bounded to 500 entries. Issue metadata (title, body,
// labels, state) rarely changes during a session, and the lifecycle worker
// polls `getIssue` / `isCompleted` repeatedly — same (repo, id) seen 64+ times
// per 5-session tier-5 run in our traces.
const ISSUE_CACHE_TTL_MS = 5 * 60_000;
const ISSUE_CACHE_MAX = 500;

interface CachedIssue {
  issue: Issue;
  expiresAt: number;
}

function issueCacheKey(repo: string, identifier: string): string {
  return `${repo}#${identifier.replace(/^#/, "")}`;
}

function createGitHubTracker(): Tracker {
  const issueCache = new Map<string, CachedIssue>();
  const inflight = new Map<string, Promise<Issue>>();

  function readCachedIssue(repo: string, identifier: string): Issue | null {
    const key = issueCacheKey(repo, identifier);
    const entry = issueCache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      issueCache.delete(key);
      return null;
    }
    return entry.issue;
  }

  function writeCachedIssue(repo: string, identifier: string, issue: Issue): void {
    if (issueCache.size >= ISSUE_CACHE_MAX) {
      const oldest = issueCache.keys().next().value;
      if (oldest !== undefined) issueCache.delete(oldest);
    }
    issueCache.set(issueCacheKey(repo, identifier), {
      issue,
      expiresAt: Date.now() + ISSUE_CACHE_TTL_MS,
    });
  }

  function invalidateCachedIssue(repo: string, identifier: string): void {
    issueCache.delete(issueCacheKey(repo, identifier));
  }

  const tracker: Tracker = {
    name: "github",

    async getIssue(identifier: string, project: ProjectConfig): Promise<Issue> {
      const repo = requireRepo(project);
      const cached = readCachedIssue(repo, identifier);
      if (cached) return cached;

      // Deduplicate concurrent requests for the same issue
      const key = issueCacheKey(repo, identifier);
      const pending = inflight.get(key);
      if (pending) return pending;

      const promise = (async () => {
        const raw = await ghIssueViewJson(identifier, project);

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

        const issue: Issue = {
          id: String(data.number),
          title: data.title,
          description: data.body ?? "",
          url: data.url,
          state: mapState(data.state, data.stateReason),
          labels: data.labels.map((l) => l.name),
          assignee: data.assignees[0]?.login,
        };

        writeCachedIssue(repo, identifier, issue);
        return issue;
      })();

      inflight.set(key, promise);
      try {
        return await promise;
      } finally {
        inflight.delete(key);
      }
    },

    async isCompleted(identifier: string, project: ProjectConfig): Promise<boolean> {
      // Route through getIssue so the cache covers the hot isCompleted poll path too.
      // "closed" and "cancelled" (CLOSED + NOT_PLANNED stateReason) both count as completed.
      const issue = await tracker.getIssue(identifier, project);
      return issue.state === "closed" || issue.state === "cancelled";
    },

    issueUrl(identifier: string, project: ProjectConfig): string {
      const num = identifier.replace(/^#/, "");
      return `https://github.com/${requireRepo(project)}/issues/${num}`;
    },

    issueLabel(url: string, _project: ProjectConfig): string {
      // Extract issue number from GitHub URL
      // Example: https://github.com/owner/repo/issues/42 → "#42"
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
        `You are working on GitHub issue #${issue.id}: ${issue.title}`,
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
        "The issue context above is complete and current. You should not need to call gh issue view unless you need additional context beyond what is provided here.",
        "",
        "Please implement the changes described in this issue. When done, commit and push your changes.",
      );

      return lines.join("\n");
    },

    async listIssues(filters: IssueFilters, project: ProjectConfig): Promise<Issue[]> {
      const args = [
        "issue",
        "list",
        "--repo",
        requireRepo(project),
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

      const raw = await ghIssueListJson(args);
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
      const repo = requireRepo(project);
      // Any mutation invalidates the cached Issue for this (repo, identifier).
      invalidateCachedIssue(repo, identifier);
      // Handle state change — GitHub Issues only supports open/closed.
      // "in_progress" is not a GitHub state, so it is intentionally a no-op.
      if (update.state === "closed") {
        await gh(["issue", "close", identifier, "--repo", repo]);
      } else if (update.state === "open") {
        await gh(["issue", "reopen", identifier, "--repo", repo]);
      }

      // Handle label removal
      if (update.removeLabels && update.removeLabels.length > 0) {
        await gh([
          "issue",
          "edit",
          identifier,
          "--repo",
          repo,
          "--remove-label",
          update.removeLabels.join(","),
        ]);
      }

      // Handle label changes
      if (update.labels && update.labels.length > 0) {
        await gh([
          "issue",
          "edit",
          identifier,
          "--repo",
          repo,
          "--add-label",
          update.labels.join(","),
        ]);
      }

      // Handle assignee changes
      if (update.assignee) {
        await gh([
          "issue",
          "edit",
          identifier,
          "--repo",
          repo,
          "--add-assignee",
          update.assignee,
        ]);
      }

      // Handle comment
      if (update.comment) {
        await gh([
          "issue",
          "comment",
          identifier,
          "--repo",
          repo,
          "--body",
          update.comment,
        ]);
      }
    },

    async createIssue(input: CreateIssueInput, project: ProjectConfig): Promise<Issue> {
      const args = [
        "issue",
        "create",
        "--repo",
        requireRepo(project),
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
      const url = await gh(args);

      // Extract issue number from URL and fetch full details
      const match = url.match(/\/issues\/(\d+)/);
      if (!match) {
        throw new Error(`Failed to parse issue URL from gh output: ${url}`);
      }
      const number = match[1];

      return tracker.getIssue(number, project);
    },

    async preflight(): Promise<void> {
      // Memoize across plugins: tracker-github and scm-github both check the
      // same gh CLI / auth state. Sharing key "gh-cli-auth" via process-cache
      // means both plugins' preflights resolve to the same in-flight check
      // (or cached result) — halving execs on the happy path and giving one
      // error message instead of two on the failure path.
      await checkGhCliAuth();
    },
  };

  return tracker;
}

// ---------------------------------------------------------------------------
// Plugin module export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "github",
  slot: "tracker" as const,
  description: "Tracker plugin: GitHub Issues",
  version: "0.1.0",
};

export function create(): Tracker {
  return createGitHubTracker();
}

export default { manifest, create } satisfies PluginModule<Tracker>;
