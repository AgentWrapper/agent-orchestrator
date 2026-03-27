/**
 * scm-bitbucket plugin — Bitbucket Cloud PRs, CI, reviews, webhooks.
 *
 * Uses the Bitbucket Cloud REST API v2.0 with API token authentication
 * (app passwords deprecated Sep 2025, removed June 2026).
 */

import { execFile } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import {
  CI_STATUS,
  type PluginModule,
  type SCM,
  type SCMWebhookEvent,
  type SCMWebhookEventKind,
  type SCMWebhookRequest,
  type SCMWebhookVerificationResult,
  type Session,
  type ProjectConfig,
  type PRInfo,
  type PRState,
  type MergeMethod,
  type CICheck,
  type CIStatus,
  type Review,
  type ReviewDecision,
  type ReviewComment,
  type ReviewSummary,
  type ReviewThreadsResult,
  type MergeReadiness,
} from "@aoagents/ao-core";
import {
  getWebhookHeader,
  parseWebhookJsonObject,
  parseWebhookTimestamp,
} from "@aoagents/ao-core/scm-webhook-utils";

import { createBitbucketClient, type BitbucketClient } from "./http-client.js";
import type {
  BbPullRequest,
  BbComment,
  BbCommitStatus,
  BbDiffstatEntry,
  BbPaginatedResponse,
} from "./types.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Bot detection patterns
// ---------------------------------------------------------------------------

const BOT_DISPLAY_NAMES = new Set([
  "Renovate Bot",
  "Dependabot",
  "Snyk Bot",
  "SonarCloud",
  "Codecov",
  "CodeClimate",
  "DeepSource",
]);

function isBot(user: { display_name: string; type: string }): boolean {
  if (user.type !== "user") return true;
  const lower = user.display_name.toLowerCase();
  if (lower.includes("bot")) return true;
  if (lower.includes("[bot]")) return true;
  for (const name of BOT_DISPLAY_NAMES) {
    if (lower === name.toLowerCase()) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseProjectRepo(projectRepo: string): [string, string] {
  const parts = projectRepo.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repo format "${projectRepo}", expected "workspace/repo-slug"`);
  }
  return [parts[0], parts[1]];
}

function repoPath(pr: PRInfo): string {
  return `/repositories/${pr.owner}/${pr.repo}`;
}

function prApiPath(pr: PRInfo): string {
  return `${repoPath(pr)}/pullrequests/${pr.number}`;
}

function parseDate(val: string | undefined | null): Date {
  if (!val) return new Date(0);
  const d = new Date(val);
  return isNaN(d.getTime()) ? new Date(0) : d;
}

function mapBbState(state: BbPullRequest["state"]): PRState {
  if (state === "OPEN") return "open";
  if (state === "MERGED") return "merged";
  return "closed"; // DECLINED, SUPERSEDED
}

function mapStatusToCheck(status: BbCommitStatus): CICheck {
  let checkStatus: CICheck["status"];
  switch (status.state) {
    case "SUCCESSFUL":
      checkStatus = "passed";
      break;
    case "FAILED":
      checkStatus = "failed";
      break;
    case "INPROGRESS":
      checkStatus = "running";
      break;
    case "STOPPED":
      checkStatus = "failed";
      break;
    default:
      checkStatus = "pending";
  }

  return {
    name: status.name || status.key,
    status: checkStatus,
    url: status.url || undefined,
    conclusion: status.state,
    startedAt: status.created_on ? new Date(status.created_on) : undefined,
    completedAt: status.updated_on ? new Date(status.updated_on) : undefined,
  };
}

function bbPrToInfo(pr: BbPullRequest, owner: string, repo: string): PRInfo {
  // source.branch can be null when the source repository (fork) has been deleted
  const branch = pr.source?.branch?.name ?? "unknown";
  const baseBranch = pr.destination?.branch?.name ?? "main";
  return {
    number: pr.id,
    url: pr.links?.html?.href ?? "",
    title: pr.title,
    owner,
    repo,
    branch,
    baseBranch,
    // Bitbucket Cloud has no native draft PR — convention is "WIP:" prefix
    isDraft: pr.title.startsWith("WIP:") || pr.title.startsWith("WIP "),
  };
}

// ---------------------------------------------------------------------------
// Webhook helpers
// ---------------------------------------------------------------------------

function getBitbucketWebhookConfig(project: ProjectConfig) {
  const webhook = project.scm?.webhook;
  return {
    enabled: webhook?.enabled !== false,
    path: webhook?.path ?? "/api/webhooks/bitbucket",
    secretEnvVar: webhook?.secretEnvVar,
    signatureHeader: webhook?.signatureHeader ?? "x-hub-signature",
    eventHeader: webhook?.eventHeader ?? "x-event-key",
    deliveryHeader: webhook?.deliveryHeader ?? "x-request-uuid",
    maxBodyBytes: webhook?.maxBodyBytes,
  };
}

function verifyBitbucketSignature(
  body: string | Uint8Array,
  secret: string,
  signatureHeader: string,
): boolean {
  if (!signatureHeader.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const provided = signatureHeader.slice("sha256=".length);
  const expectedBuffer = Buffer.from(expected, "hex");
  const providedBuffer = Buffer.from(provided, "hex");
  if (expectedBuffer.length !== providedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, providedBuffer);
}

/** Map Bitbucket x-event-key to our normalized event kind and action */
function mapBitbucketEventKey(
  eventKey: string,
): { kind: SCMWebhookEventKind; action: string } {
  switch (eventKey) {
    case "pullrequest:created":
      return { kind: "pull_request", action: "opened" };
    case "pullrequest:updated":
      return { kind: "pull_request", action: "synchronize" };
    case "pullrequest:fulfilled":
      return { kind: "pull_request", action: "merged" };
    case "pullrequest:rejected":
      return { kind: "pull_request", action: "closed" };
    case "pullrequest:approved":
      return { kind: "review", action: "approved" };
    case "pullrequest:unapproved":
      return { kind: "review", action: "dismissed" };
    case "pullrequest:changes_request_created":
      return { kind: "review", action: "changes_requested" };
    case "pullrequest:comment_created":
      return { kind: "comment", action: "created" };
    case "pullrequest:comment_updated":
      return { kind: "comment", action: "updated" };
    case "repo:push":
      return { kind: "push", action: "push" };
    case "repo:commit_status_created":
      return { kind: "ci", action: "created" };
    case "repo:commit_status_updated":
      return { kind: "ci", action: "updated" };
    default:
      return { kind: "unknown", action: eventKey };
  }
}

function parseBitbucketRepository(payload: Record<string, unknown>) {
  const repository = payload["repository"];
  if (!repository || typeof repository !== "object") return undefined;
  const repo = repository as Record<string, unknown>;
  const fullName = repo["full_name"];
  if (typeof fullName === "string" && fullName.includes("/")) {
    const parts = fullName.split("/");
    if (parts.length === 2 && parts[0] && parts[1]) {
      return { owner: parts[0], name: parts[1] };
    }
  }
  return undefined;
}

function parseBitbucketWebhookEvent(
  request: SCMWebhookRequest,
  payload: Record<string, unknown>,
  config: ReturnType<typeof getBitbucketWebhookConfig>,
): SCMWebhookEvent | null {
  const rawEventType = getWebhookHeader(request.headers, config.eventHeader);
  if (!rawEventType) return null;

  const deliveryId = getWebhookHeader(request.headers, config.deliveryHeader);
  const repository = parseBitbucketRepository(payload);
  const { kind, action } = mapBitbucketEventKey(rawEventType);

  const pullRequest =
    payload["pullrequest"] && typeof payload["pullrequest"] === "object"
      ? (payload["pullrequest"] as Record<string, unknown>)
      : undefined;

  // Extract PR number
  let prNumber: number | undefined;
  if (pullRequest && typeof pullRequest["id"] === "number") {
    prNumber = pullRequest["id"] as number;
  }

  // Extract branch
  let branch: string | undefined;
  if (pullRequest) {
    const source = pullRequest["source"] as Record<string, unknown> | undefined;
    const sourceBranch = source?.["branch"] as Record<string, unknown> | undefined;
    if (typeof sourceBranch?.["name"] === "string") {
      branch = sourceBranch["name"] as string;
    }
  }

  // Extract sha
  let sha: string | undefined;
  if (pullRequest) {
    const source = pullRequest["source"] as Record<string, unknown> | undefined;
    const commit = source?.["commit"] as Record<string, unknown> | undefined;
    if (typeof commit?.["hash"] === "string") {
      sha = commit["hash"] as string;
    }
  }

  // For push events, extract from the push payload
  if (kind === "push") {
    const push = payload["push"] as Record<string, unknown> | undefined;
    const changes = Array.isArray(push?.["changes"])
      ? (push!["changes"] as Array<Record<string, unknown>>)
      : [];
    const firstChange = changes[0];
    if (firstChange) {
      const newTarget = firstChange["new"] as Record<string, unknown> | undefined;
      if (typeof newTarget?.["name"] === "string") {
        branch = newTarget["name"] as string;
      }
      const target = newTarget?.["target"] as Record<string, unknown> | undefined;
      if (typeof target?.["hash"] === "string") {
        sha = target["hash"] as string;
      }
    }
  }

  // For CI events, extract from commit_status payload
  if (kind === "ci") {
    const commitStatus = payload["commit_status"] as Record<string, unknown> | undefined;
    const commit = commitStatus?.["commit"] as Record<string, unknown> | undefined;
    if (typeof commit?.["hash"] === "string") {
      sha = commit["hash"] as string;
    }
  }

  // Extract timestamp
  let timestamp: Date | undefined;
  if (pullRequest) {
    timestamp = parseWebhookTimestamp(pullRequest["updated_on"]);
  } else if (kind === "push") {
    const push = payload["push"] as Record<string, unknown> | undefined;
    const changes = Array.isArray(push?.["changes"])
      ? (push!["changes"] as Array<Record<string, unknown>>)
      : [];
    const firstChange = changes[0];
    const newTarget = firstChange?.["new"] as Record<string, unknown> | undefined;
    const target = newTarget?.["target"] as Record<string, unknown> | undefined;
    timestamp = parseWebhookTimestamp(target?.["date"]);
  } else if (kind === "ci") {
    const commitStatus = payload["commit_status"] as Record<string, unknown> | undefined;
    timestamp = parseWebhookTimestamp(commitStatus?.["updated_on"]);
  }

  return {
    provider: "bitbucket",
    kind,
    action,
    rawEventType,
    deliveryId,
    repository,
    prNumber,
    branch,
    sha,
    timestamp,
    data: payload,
  };
}

// ---------------------------------------------------------------------------
// SCM implementation
// ---------------------------------------------------------------------------

function createBitbucketSCM(config?: Record<string, unknown>): SCM {
  // Bitbucket Cloud deprecated App Passwords (Sep 2025) in favor of API Tokens.
  // API Tokens use Basic auth with Atlassian email + API token (same wire format).
  // We accept both: new BITBUCKET_API_TOKEN or legacy BITBUCKET_APP_PASSWORD.
  const usernameEnvVar =
    typeof config?.usernameEnvVar === "string" ? config.usernameEnvVar : "BITBUCKET_USERNAME";
  const tokenEnvVar =
    typeof config?.tokenEnvVar === "string"
      ? config.tokenEnvVar
      : typeof config?.passwordEnvVar === "string"
        ? config.passwordEnvVar
        : undefined;

  const username = process.env[usernameEnvVar];
  const token =
    tokenEnvVar
      ? process.env[tokenEnvVar]
      : process.env.BITBUCKET_API_TOKEN ?? process.env.BITBUCKET_APP_PASSWORD;

  if (!username || !token) {
    throw new Error(
      `Bitbucket credentials not found. Set ${usernameEnvVar} (Atlassian account email) ` +
        `and BITBUCKET_API_TOKEN (API token from https://id.atlassian.com/manage-profile/security/api-tokens) ` +
        `environment variables. Legacy BITBUCKET_APP_PASSWORD is also accepted but deprecated.`,
    );
  }

  const baseUrl =
    typeof config?.baseUrl === "string" ? config.baseUrl : undefined;

  const client: BitbucketClient = createBitbucketClient({
    username,
    apiToken: token,
    baseUrl,
  });

  return {
    name: "bitbucket",

    async verifyWebhook(
      request: SCMWebhookRequest,
      project: ProjectConfig,
    ): Promise<SCMWebhookVerificationResult> {
      const webhookConfig = getBitbucketWebhookConfig(project);
      if (!webhookConfig.enabled) {
        return { ok: false, reason: "Webhook is disabled for this project" };
      }
      if (request.method.toUpperCase() !== "POST") {
        return { ok: false, reason: "Webhook requests must use POST" };
      }
      if (
        webhookConfig.maxBodyBytes !== undefined &&
        Buffer.byteLength(request.body, "utf8") > webhookConfig.maxBodyBytes
      ) {
        return { ok: false, reason: "Webhook payload exceeds configured maxBodyBytes" };
      }

      const eventType = getWebhookHeader(request.headers, webhookConfig.eventHeader);
      if (!eventType) {
        return { ok: false, reason: `Missing ${webhookConfig.eventHeader} header` };
      }

      const deliveryId = getWebhookHeader(request.headers, webhookConfig.deliveryHeader);
      const secretName = webhookConfig.secretEnvVar;
      if (!secretName) {
        return { ok: true, deliveryId, eventType };
      }

      const secret = process.env[secretName];
      if (!secret) {
        return { ok: false, reason: `Webhook secret env var ${secretName} is not configured` };
      }

      const signature = getWebhookHeader(request.headers, webhookConfig.signatureHeader);
      if (!signature) {
        return { ok: false, reason: `Missing ${webhookConfig.signatureHeader} header` };
      }

      if (!verifyBitbucketSignature(request.rawBody ?? request.body, secret, signature)) {
        return {
          ok: false,
          reason: "Webhook signature verification failed",
          deliveryId,
          eventType,
        };
      }

      return { ok: true, deliveryId, eventType };
    },

    async parseWebhook(
      request: SCMWebhookRequest,
      project: ProjectConfig,
    ): Promise<SCMWebhookEvent | null> {
      const webhookConfig = getBitbucketWebhookConfig(project);
      const payload = parseWebhookJsonObject(request.body);
      return parseBitbucketWebhookEvent(request, payload, webhookConfig);
    },

    async detectPR(session: Session, project: ProjectConfig): Promise<PRInfo | null> {
      if (!session.branch || !project.repo) return null;
      const [ws, repo] = parseProjectRepo(project.repo);

      try {
        const safeBranch = session.branch.replace(/"/g, '\\"');
        const q = `source.branch.name="${safeBranch}" AND state="OPEN"`;
        const resp = await client.get<BbPaginatedResponse<BbPullRequest>>(
          `/repositories/${ws}/${repo}/pullrequests`,
          { q, pagelen: "1" },
        );

        if (!resp.values || resp.values.length === 0) return null;
        return bbPrToInfo(resp.values[0], ws, repo);
      } catch (err) {
        // Re-throw auth errors so the user knows credentials are wrong
        if (err instanceof Error && (err.message.includes("(401)") || err.message.includes("(403)"))) {
          throw err;
        }
        return null;
      }
    },

    async resolvePR(reference: string, project: ProjectConfig): Promise<PRInfo> {
      if (!project.repo) {
        throw new Error("Cannot resolve PR: project has no repo configured");
      }
      const [ws, repo] = parseProjectRepo(project.repo);
      const pr = await client.get<BbPullRequest>(
        `/repositories/${ws}/${repo}/pullrequests/${reference}`,
      );
      return bbPrToInfo(pr, ws, repo);
    },

    async assignPRToCurrentUser(_pr: PRInfo): Promise<void> {
      // Bitbucket Cloud PRs have no "assignee" concept — only reviewers
      // (who review) and participants (who interact). Adding the PR author
      // as a reviewer would be semantically wrong. The core handles this
      // gracefully when the method is a no-op (claim-pr logs a warning).
    },

    async checkoutPR(pr: PRInfo, workspacePath: string): Promise<boolean> {
      const exec = (args: string[]) =>
        execFileAsync("git", args, {
          cwd: workspacePath,
          maxBuffer: 10 * 1024 * 1024,
          timeout: 30_000,
        });

      const { stdout: currentBranch } = await exec(["branch", "--show-current"]);
      if (currentBranch.trim() === pr.branch) return false;

      const { stdout: dirty } = await exec(["status", "--porcelain"]);
      if (dirty.trim()) {
        throw new Error(
          `Workspace has uncommitted changes; cannot switch to PR branch "${pr.branch}" safely`,
        );
      }

      // Fetch the source branch and force-update the local ref (handles
      // both new branches and existing branches that need updating)
      await exec(["fetch", "origin", pr.branch]);
      await exec(["checkout", "-B", pr.branch, `origin/${pr.branch}`]);
      return true;
    },

    async getPRState(pr: PRInfo): Promise<PRState> {
      const data = await client.get<BbPullRequest>(prApiPath(pr));
      return mapBbState(data.state);
    },

    async getPRSummary(pr: PRInfo) {
      const [data, diffstats] = await Promise.all([
        client.get<BbPullRequest>(prApiPath(pr)),
        client.paginate<BbDiffstatEntry>(`${prApiPath(pr)}/diffstat`, { pagelen: "100" }),
      ]);

      let additions = 0;
      let deletions = 0;
      for (const entry of diffstats) {
        additions += entry.lines_added ?? 0;
        deletions += entry.lines_removed ?? 0;
      }

      return {
        state: mapBbState(data.state),
        title: data.title ?? "",
        additions,
        deletions,
        changedFiles: diffstats.length,
      };
    },

    async mergePR(pr: PRInfo, method: MergeMethod = "squash"): Promise<void> {
      let mergeStrategy: string;
      switch (method) {
        case "merge":
          mergeStrategy = "merge_commit";
          break;
        case "rebase":
          mergeStrategy = "fast_forward";
          break;
        case "squash":
        default:
          mergeStrategy = "squash";
      }

      await client.post(`${prApiPath(pr)}/merge`, {
        merge_strategy: mergeStrategy,
        close_source_branch: true,
      });
    },

    async closePR(pr: PRInfo): Promise<void> {
      await client.post(`${prApiPath(pr)}/decline`);
    },

    async getCIChecks(pr: PRInfo): Promise<CICheck[]> {
      // Get HEAD commit SHA from the PR
      const data = await client.get<BbPullRequest>(prApiPath(pr));
      const sha = data.source?.commit?.hash;
      if (!sha) return []; // source branch/commit may be null (deleted fork)

      try {
        const statuses = await client.paginate<BbCommitStatus>(
          `${repoPath(pr)}/commit/${sha}/statuses/build`,
          { pagelen: "50" },
        );
        return statuses.map(mapStatusToCheck);
      } catch (err) {
        // The /commit/{sha}/statuses/build endpoint returns 403 with
        // scoped API tokens (Bitbucket-side limitation). Return empty
        // instead of failing the entire enrichment pipeline.
        if (err instanceof Error && err.message.includes("(403)")) {
          return [];
        }
        throw err;
      }
    },

    async getCISummary(pr: PRInfo): Promise<CIStatus> {
      let checks: CICheck[];
      try {
        checks = await this.getCIChecks(pr);
      } catch {
        try {
          const state = await this.getPRState(pr);
          if (state === "merged" || state === "closed") return "none";
        } catch {
          // Cannot determine state either; fail closed.
        }
        return "failing";
      }
      if (checks.length === 0) return "none";

      const hasFailing = checks.some((c) => c.status === "failed");
      if (hasFailing) return "failing";

      const hasPending = checks.some((c) => c.status === "pending" || c.status === "running");
      if (hasPending) return "pending";

      const hasPassing = checks.some((c) => c.status === "passed");
      if (!hasPassing) return "none";

      return "passing";
    },

    async getReviews(pr: PRInfo): Promise<Review[]> {
      const data = await client.get<BbPullRequest>(prApiPath(pr));
      const reviewers = (data.participants ?? []).filter((p) => p.role === "REVIEWER");

      return reviewers.map((p) => {
        let state: Review["state"];
        if (p.state === "approved") {
          state = "approved";
        } else if (p.state === "changes_requested") {
          state = "changes_requested";
        } else {
          state = "commented";
        }

        return {
          author: p.user?.display_name ?? "unknown",
          state,
          submittedAt: parseDate(data.updated_on),
        };
      });
    },

    async getReviewDecision(pr: PRInfo): Promise<ReviewDecision> {
      const data = await client.get<BbPullRequest>(prApiPath(pr));
      const reviewers = (data.participants ?? []).filter((p) => p.role === "REVIEWER");

      if (reviewers.length === 0) return "none";

      const hasChangesRequested = reviewers.some((p) => p.state === "changes_requested");
      if (hasChangesRequested) return "changes_requested";

      const hasApproved = reviewers.some((p) => p.state === "approved");
      if (hasApproved) return "approved";

      return "pending";
    },

    async getPendingComments(pr: PRInfo): Promise<ReviewComment[]> {
      const comments = await client.paginate<BbComment>(
        `${prApiPath(pr)}/comments`,
        { pagelen: "50" },
      );

      return comments
        .filter((c) => {
          if (c.deleted) return false;
          if (!c.inline) return false; // only file-level (inline) comments
          if (c.resolution !== null && c.resolution !== undefined) return false; // resolved
          if (isBot(c.user)) return false;
          return true;
        })
        .map((c) => ({
          id: String(c.id),
          author: c.user.display_name,
          body: c.content?.raw ?? "",
          path: c.inline?.path,
          line: c.inline?.to ?? c.inline?.from ?? undefined,
          isResolved: false,
          createdAt: parseDate(c.created_on),
          url: c.links?.html?.href ?? "",
        }));
    },

    async getReviewThreads(pr: PRInfo): Promise<ReviewThreadsResult> {
      const comments = await client.paginate<BbComment>(
        `${prApiPath(pr)}/comments`,
        { pagelen: "50" },
      );

      // Unresolved inline review threads (both human and bot), tagged with isBot.
      const threads: ReviewComment[] = comments
        .filter((c) => {
          if (c.deleted) return false;
          if (!c.inline) return false; // only file-level (inline) comments
          if (c.resolution !== null && c.resolution !== undefined) return false; // resolved
          return true;
        })
        .map((c) => ({
          id: String(c.id),
          author: c.user.display_name,
          body: c.content?.raw ?? "",
          path: c.inline?.path,
          line: c.inline?.to ?? c.inline?.from ?? undefined,
          isResolved: false,
          createdAt: parseDate(c.created_on),
          url: c.links?.html?.href ?? "",
          isBot: isBot(c.user),
        }));

      // Bitbucket has no first-class review summary concept like GitHub.
      const reviews: ReviewSummary[] = [];

      return { threads, reviews };
    },

    async getMergeability(pr: PRInfo): Promise<MergeReadiness> {
      const data = await client.get<BbPullRequest>(prApiPath(pr));
      const state = mapBbState(data.state);

      if (state === "merged") {
        return {
          mergeable: true,
          ciPassing: true,
          approved: true,
          noConflicts: true,
          blockers: [],
        };
      }

      if (state === "closed") {
        return {
          mergeable: false,
          ciPassing: false,
          approved: false,
          noConflicts: true,
          blockers: ["PR is closed (declined/superseded)"],
        };
      }

      const blockers: string[] = [];

      // CI
      const ciStatus = await this.getCISummary(pr);
      const ciPassing = ciStatus === CI_STATUS.PASSING || ciStatus === CI_STATUS.NONE;
      if (!ciPassing) {
        blockers.push(`CI is ${ciStatus}`);
      }

      // Reviews
      const reviewDecision = await this.getReviewDecision(pr);
      const approved = reviewDecision === "approved";
      if (reviewDecision === "changes_requested") {
        blockers.push("Changes requested in review");
      } else if (reviewDecision === "pending") {
        blockers.push("Review pending");
      }

      // Conflicts — Bitbucket doesn't expose merge conflicts directly in the
      // PR object, but we can attempt a dry-run merge check. For simplicity,
      // assume no conflicts if the PR is in OPEN state (the merge endpoint
      // will fail if there are actual conflicts).
      const noConflicts = true;

      // Draft (convention-based)
      const isDraft = data.title.startsWith("WIP:") || data.title.startsWith("WIP ");
      if (isDraft) {
        blockers.push("PR is marked as WIP (draft)");
      }

      return {
        mergeable: blockers.length === 0,
        ciPassing,
        approved,
        noConflicts,
        blockers,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin module export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "bitbucket",
  slot: "scm" as const,
  description: "Bitbucket Cloud SCM — PRs, CI, reviews, webhooks",
  version: "0.1.0",
};

export function create(config?: Record<string, unknown>): SCM {
  return createBitbucketSCM(config);
}

export default { manifest, create } satisfies PluginModule<SCM>;
