/**
 * scm-gitlab plugin — GitLab MRs, CI pipelines, reviews, merge readiness.
 *
 * Uses the `glab` CLI for GitLab API interactions.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import {
  CI_STATUS,
  type PluginModule,
  type SCM,
  type SCMWebhookEvent,
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
  parseWebhookBranchRef,
  parseWebhookJsonObject,
  parseWebhookTimestamp,
} from "@aoagents/ao-core/scm-webhook-utils";

import { glab, parseJSON, stripHost } from "./glab-utils.js";

const BOT_AUTHORS = new Set([
  "gitlab-bot",
  "ghost",
  "dependabot[bot]",
  "renovate[bot]",
  "sast-bot",
  "codeclimate[bot]",
  "sonarcloud[bot]",
  "snyk-bot",
]);

function isBot(username: string): boolean {
  return (
    BOT_AUTHORS.has(username) || /^project_\d+_bot/.test(username) || username.endsWith("[bot]")
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function repoFlag(pr: PRInfo): string {
  return `${pr.owner}/${pr.repo}`;
}

function parseDate(val: string | undefined | null): Date {
  if (!val) return new Date(0);
  const d = new Date(val);
  return isNaN(d.getTime()) ? new Date(0) : d;
}

function extractHostFromOwner(owner: string): string | undefined {
  const parts = owner.split("/");
  const first = parts[0];
  return first && first.includes(".") && parts.length >= 2 ? first : undefined;
}

function encodeProjectId(owner: string, repo: string): string {
  return encodeURIComponent(stripHost(`${owner}/${repo}`));
}

function mapJobStatus(status: string): CICheck["status"] {
  switch (status) {
    case "pending":
    case "waiting_for_resource":
    case "preparing":
    case "created":
    case "scheduled":
    case "manual":
      return "pending";
    case "running":
      return "running";
    case "success":
      return "passed";
    case "failed":
    case "canceled":
      return "failed";
    case "skipped":
      return "skipped";
    default:
      return "failed";
  }
}

function mapPRState(state: string): PRState {
  const s = state.toLowerCase();
  if (s === "merged") return "merged";
  if (s === "closed") return "closed";
  return "open";
}


function getGitLabWebhookConfig(project: ProjectConfig) {
  const webhook = project.scm?.webhook;
  return {
    enabled: webhook?.enabled !== false,
    path: webhook?.path ?? "/api/webhooks/gitlab",
    secretEnvVar: webhook?.secretEnvVar,
    signatureHeader: webhook?.signatureHeader ?? "x-gitlab-token",
    eventHeader: webhook?.eventHeader ?? "x-gitlab-event",
    deliveryHeader: webhook?.deliveryHeader ?? "x-gitlab-event-uuid",
    maxBodyBytes: webhook?.maxBodyBytes,
  };
}

function verifyGitLabToken(secret: string, providedToken: string): boolean {
  const toDigest = (value: string): Buffer => createHash("sha256").update(value).digest();
  return timingSafeEqual(toDigest(secret), toDigest(providedToken));
}

function parseGitLabRepository(payload: Record<string, unknown>) {
  const project = payload["project"];
  if (!project || typeof project !== "object") return undefined;
  const projectRecord = project as Record<string, unknown>;
  const pathWithNamespace = projectRecord["path_with_namespace"];
  if (typeof pathWithNamespace === "string" && pathWithNamespace.length > 0) {
    const parts = pathWithNamespace.split("/");
    if (parts.length >= 2) {
      const name = parts[parts.length - 1];
      const owner = parts.slice(0, -1).join("/");
      if (owner && name) return { owner, name };
    }
  }
  const namespace =
    typeof projectRecord["namespace"] === "string" ? projectRecord["namespace"] : undefined;
  const name = typeof projectRecord["path"] === "string" ? projectRecord["path"] : undefined;
  if (!namespace || !name) return undefined;
  return { owner: namespace, name };
}

function isGitLabTagRef(
  payload: Record<string, unknown>,
  objectAttributes: Record<string, unknown> | undefined,
): boolean {
  return (
    objectAttributes?.["tag"] === true ||
    payload["ref_type"] === "tag" ||
    payload["object_kind"] === "tag_push"
  );
}

function parseGitLabCiBranch(
  payload: Record<string, unknown>,
  objectAttributes: Record<string, unknown> | undefined,
): string | undefined {
  const isTag = isGitLabTagRef(payload, objectAttributes);
  if (isTag) return undefined;
  return parseWebhookBranchRef(payload["ref"] ?? objectAttributes?.["ref"]);
}

function parseGitLabPushBranch(
  payload: Record<string, unknown>,
  objectAttributes: Record<string, unknown> | undefined,
): string | undefined {
  const isTag = isGitLabTagRef(payload, objectAttributes);
  if (isTag) return undefined;
  const refValue = payload["ref"];
  return parseWebhookBranchRef(refValue);
}

function parseGitLabWebhookEvent(
  request: SCMWebhookRequest,
  payload: Record<string, unknown>,
  config: ReturnType<typeof getGitLabWebhookConfig>,
): SCMWebhookEvent | null {
  const rawEventType = getWebhookHeader(request.headers, config.eventHeader);
  if (!rawEventType) return null;

  const normalizedEventType = rawEventType.toLowerCase();
  const deliveryId = getWebhookHeader(request.headers, config.deliveryHeader);
  const repository = parseGitLabRepository(payload);
  const objectAttributes =
    payload["object_attributes"] && typeof payload["object_attributes"] === "object"
      ? (payload["object_attributes"] as Record<string, unknown>)
      : undefined;
  const action =
    typeof objectAttributes?.["action"] === "string"
      ? (objectAttributes["action"] as string)
      : typeof payload["action"] === "string"
        ? (payload["action"] as string)
        : rawEventType;

  if (normalizedEventType === "merge request hook" || payload["object_kind"] === "merge_request") {
    const mergeRequest =
      payload["object_attributes"] && typeof payload["object_attributes"] === "object"
        ? (payload["object_attributes"] as Record<string, unknown>)
        : undefined;
    if (!mergeRequest) return null;
    return {
      provider: "gitlab",
      kind: "pull_request",
      action,
      rawEventType,
      deliveryId,
      repository,
      prNumber:
        typeof mergeRequest["iid"] === "number"
          ? (mergeRequest["iid"] as number)
          : typeof mergeRequest["id"] === "number"
            ? (mergeRequest["id"] as number)
            : undefined,
      branch: parseWebhookBranchRef(mergeRequest["source_branch"]),
      sha:
        typeof mergeRequest["last_commit"] === "object" && mergeRequest["last_commit"]
          ? ((mergeRequest["last_commit"] as Record<string, unknown>)["id"] as string | undefined)
          : undefined,
      timestamp: parseWebhookTimestamp(mergeRequest["updated_at"]),
      data: payload,
    };
  }

  if (normalizedEventType === "note hook" || payload["object_kind"] === "note") {
    const mergeRequest =
      payload["merge_request"] && typeof payload["merge_request"] === "object"
        ? (payload["merge_request"] as Record<string, unknown>)
        : undefined;
    const noteableType = objectAttributes?.["noteable_type"];
    if (!mergeRequest || noteableType !== "MergeRequest") return null;
    return {
      provider: "gitlab",
      kind: "comment",
      action,
      rawEventType,
      deliveryId,
      repository,
      prNumber:
        typeof mergeRequest["iid"] === "number" ? (mergeRequest["iid"] as number) : undefined,
      branch: parseWebhookBranchRef(mergeRequest["source_branch"]),
      sha:
        typeof mergeRequest["last_commit"] === "object" && mergeRequest["last_commit"]
          ? ((mergeRequest["last_commit"] as Record<string, unknown>)["id"] as string | undefined)
          : undefined,
      timestamp: parseWebhookTimestamp(
        objectAttributes?.["updated_at"] ?? objectAttributes?.["created_at"],
      ),
      data: payload,
    };
  }

  if (
    normalizedEventType === "pipeline hook" ||
    normalizedEventType === "job hook" ||
    payload["object_kind"] === "pipeline" ||
    payload["object_kind"] === "build"
  ) {
    return {
      provider: "gitlab",
      kind: "ci",
      action,
      rawEventType,
      deliveryId,
      repository,
      prNumber:
        typeof payload["merge_request"] === "object" && payload["merge_request"]
          ? (((payload["merge_request"] as Record<string, unknown>)["iid"] as number | undefined) ??
            ((payload["merge_request"] as Record<string, unknown>)["id"] as number | undefined))
          : undefined,
      branch: parseGitLabCiBranch(payload, objectAttributes),
      sha:
        typeof payload["checkout_sha"] === "string"
          ? (payload["checkout_sha"] as string)
          : typeof payload["sha"] === "string"
            ? (payload["sha"] as string)
            : typeof objectAttributes?.["sha"] === "string"
              ? (objectAttributes["sha"] as string)
              : undefined,
      timestamp: parseWebhookTimestamp(
        objectAttributes?.["finished_at"] ??
          objectAttributes?.["updated_at"] ??
          payload["commit_timestamp"] ??
          payload["updated_at"],
      ),
      data: payload,
    };
  }

  if (
    normalizedEventType === "push hook" ||
    normalizedEventType === "tag push hook" ||
    payload["object_kind"] === "push" ||
    payload["object_kind"] === "tag_push"
  ) {
    return {
      provider: "gitlab",
      kind: "push",
      action,
      rawEventType,
      deliveryId,
      repository,
      branch: parseGitLabPushBranch(payload, objectAttributes),
      sha:
        typeof payload["after"] === "string"
          ? (payload["after"] as string)
          : typeof payload["checkout_sha"] === "string"
            ? (payload["checkout_sha"] as string)
            : undefined,
      timestamp: parseWebhookTimestamp(payload["event_created_at"] ?? payload["commit_timestamp"]),
      data: payload,
    };
  }

  return {
    provider: "gitlab",
    kind: "unknown",
    action,
    rawEventType,
    deliveryId,
    repository,
    timestamp: parseWebhookTimestamp(
      objectAttributes?.["updated_at"] ?? payload["event_created_at"],
    ),
    data: payload,
  };
}

interface GitLabNote {
  id: number;
  author: { username: string };
  body: string;
  resolvable: boolean;
  resolved: boolean;
  position?: { new_path?: string; new_line?: number | null };
  created_at: string;
}

interface GitLabDiscussion {
  id: string;
  notes: GitLabNote[];
}

function mrApiPath(pr: PRInfo): string {
  return `projects/${encodeProjectId(pr.owner, pr.repo)}/merge_requests/${pr.number}`;
}

async function fetchDiscussions(
  pr: PRInfo,
  hostname: string | undefined,
  context: string,
): Promise<GitLabDiscussion[]> {
  const raw = await glab(["api", `${mrApiPath(pr)}/discussions?per_page=100`], hostname);
  return parseJSON<GitLabDiscussion[]>(raw, context);
}

// ---------------------------------------------------------------------------
// SCM implementation
// ---------------------------------------------------------------------------

function createGitLabSCM(config?: Record<string, unknown>): SCM {
  const configHostname = typeof config?.host === "string" ? config.host : undefined;

  function resolveHostname(pr?: PRInfo): string | undefined {
    return configHostname ?? (pr ? extractHostFromOwner(pr.owner) : undefined);
  }

  return {
    name: "gitlab",

    async verifyWebhook(
      request: SCMWebhookRequest,
      project: ProjectConfig,
    ): Promise<SCMWebhookVerificationResult> {
      const webhookConfig = getGitLabWebhookConfig(project);
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

      const providedToken = getWebhookHeader(request.headers, webhookConfig.signatureHeader);
      if (!providedToken) {
        return { ok: false, reason: `Missing ${webhookConfig.signatureHeader} header` };
      }

      if (!verifyGitLabToken(secret, providedToken)) {
        return {
          ok: false,
          reason: "Webhook token verification failed",
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
      const webhookConfig = getGitLabWebhookConfig(project);
      const payload = parseWebhookJsonObject(request.body);
      return parseGitLabWebhookEvent(request, payload, webhookConfig);
    },

    async detectPR(session: Session, project: ProjectConfig): Promise<PRInfo | null> {
      if (!session.branch || !project.repo) return null;

      const parts = project.repo.split("/");
      if (parts.length < 2 || !parts[0] || !parts[1]) {
        throw new Error(`Invalid repo format "${project.repo}", expected "owner/repo"`);
      }
      const owner = parts.slice(0, -1).join("/");
      const repo = parts[parts.length - 1];

      try {
        const raw = await glab(
          [
            "mr",
            "list",
            "--source-branch",
            session.branch,
            "--repo",
            project.repo,
            "-F",
            "json",
            "-P",
            "1",
          ],
          resolveHostname(),
        );

        const mrs = parseJSON<
          Array<{
            iid: number;
            web_url: string;
            title: string;
            source_branch: string;
            target_branch: string;
            draft: boolean;
          }>
        >(raw, `detectPR for branch "${session.branch}"`);

        if (mrs.length === 0) return null;

        const mr = mrs[0];
        return {
          number: mr.iid,
          url: mr.web_url,
          title: mr.title,
          owner,
          repo,
          branch: mr.source_branch,
          baseBranch: mr.target_branch,
          isDraft: mr.draft ?? false,
        };
      } catch (err) {
        console.warn(`detectPR: failed for branch "${session.branch}": ${(err as Error).message}`);
        return null;
      }
    },

    async getPRState(pr: PRInfo): Promise<PRState> {
      const raw = await glab(
        ["mr", "view", String(pr.number), "--repo", repoFlag(pr), "-F", "json"],
        resolveHostname(pr),
      );
      const data = parseJSON<{ state: string }>(raw, `getPRState for MR !${pr.number}`);
      return mapPRState(data.state);
    },

    async getPRSummary(pr: PRInfo) {
      const raw = await glab(
        ["mr", "view", String(pr.number), "--repo", repoFlag(pr), "-F", "json"],
        resolveHostname(pr),
      );
      const data = parseJSON<{ state: string; title: string }>(
        raw,
        `getPRSummary for MR !${pr.number}`,
      );
      return {
        state: mapPRState(data.state),
        title: data.title ?? "",
        additions: 0,
        deletions: 0,
      };
    },

    async mergePR(pr: PRInfo, method: MergeMethod = "squash"): Promise<void> {
      const args = ["mr", "merge", String(pr.number), "--repo", repoFlag(pr)];
      if (method === "squash") args.push("--squash");
      else if (method === "rebase") args.push("--rebase");
      args.push("-d", "-y");
      await glab(args, resolveHostname(pr));
    },

    async closePR(pr: PRInfo): Promise<void> {
      await glab(["mr", "close", String(pr.number), "--repo", repoFlag(pr)], resolveHostname(pr));
    },

    async getCIChecks(pr: PRInfo): Promise<CICheck[]> {
      try {
        const apiBase = mrApiPath(pr);
        const hostname = resolveHostname(pr);

        const pipelinesRaw = await glab(["api", `${apiBase}/pipelines`], hostname);
        const pipelines = parseJSON<Array<{ id: number }>>(
          pipelinesRaw,
          `getCIChecks pipelines for MR !${pr.number}`,
        );
        if (pipelines.length === 0) return [];

        const latestPipelineId = pipelines[0].id;
        const projectId = encodeProjectId(pr.owner, pr.repo);

        const jobsRaw = await glab(
          ["api", `projects/${projectId}/pipelines/${latestPipelineId}/jobs`],
          hostname,
        );
        const jobs = parseJSON<
          Array<{
            name: string;
            status: string;
            web_url: string;
            started_at: string | null;
            finished_at: string | null;
          }>
        >(jobsRaw, `getCIChecks jobs for pipeline ${latestPipelineId}`);

        return jobs.map((j) => ({
          name: j.name,
          status: mapJobStatus(j.status),
          url: j.web_url || undefined,
          conclusion: j.status || undefined,
          startedAt: j.started_at ? new Date(j.started_at) : undefined,
          completedAt: j.finished_at ? new Date(j.finished_at) : undefined,
        }));
      } catch (err) {
        throw new Error("Failed to fetch CI checks", { cause: err });
      }
    },

    async getCISummary(pr: PRInfo): Promise<CIStatus> {
      let checks: CICheck[];
      try {
        checks = await this.getCIChecks(pr);
      } catch (err) {
        console.warn(
          `getCISummary: CI check fetch failed for MR !${pr.number}: ${(err as Error).message}`,
        );
        try {
          const state = await this.getPRState(pr);
          if (state === "merged" || state === "closed") return "none";
        } catch (innerErr) {
          console.warn(
            `getCISummary: PR state fallback also failed for MR !${pr.number}: ${(innerErr as Error).message}`,
          );
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
      const hostname = resolveHostname(pr);
      const reviews: Review[] = [];

      const approvalsRaw = await glab(["api", `${mrApiPath(pr)}/approvals`], hostname);
      const approvals = parseJSON<{
        approved_by: Array<{ user: { username: string } }>;
      }>(approvalsRaw, `getReviews approvals for MR !${pr.number}`);

      const approvedUsers = new Set<string>();
      for (const a of approvals.approved_by ?? []) {
        const author = a.user?.username ?? "unknown";
        approvedUsers.add(author);
        reviews.push({ author, state: "approved", submittedAt: new Date(0) });
      }

      try {
        const discussions = await fetchDiscussions(
          pr,
          hostname,
          `getReviews discussions for MR !${pr.number}`,
        );

        const requestedAuthors = new Set<string>();
        for (const d of discussions) {
          const note = d.notes[0];
          if (!note) continue;
          if (!note.resolvable || note.resolved) continue;
          const author = note.author?.username ?? "";
          if (isBot(author) || approvedUsers.has(author) || requestedAuthors.has(author)) continue;
          requestedAuthors.add(author);
          reviews.push({
            author,
            state: "changes_requested",
            submittedAt: parseDate(note.created_at),
          });
        }
      } catch (err) {
        console.warn(
          `getReviews: discussions fetch failed for MR !${pr.number}: ${(err as Error).message}`,
        );
      }

      return reviews;
    },

    async getReviewDecision(pr: PRInfo): Promise<ReviewDecision> {
      const raw = await glab(["api", `${mrApiPath(pr)}/approvals`], resolveHostname(pr));
      const data = parseJSON<{ approved: boolean; approvals_left: number }>(
        raw,
        `getReviewDecision for MR !${pr.number}`,
      );

      if (data.approved) return "approved";
      if (data.approvals_left > 0) return "pending";
      return "none";
    },

    async getPendingComments(pr: PRInfo): Promise<ReviewComment[]> {
      const discussions = await fetchDiscussions(
        pr,
        resolveHostname(pr),
        `getPendingComments for MR !${pr.number}`,
      );

      const comments: ReviewComment[] = [];
      for (const d of discussions) {
        const note = d.notes[0];
        if (!note) continue;
        if (!note.resolvable || note.resolved) continue;
        if (isBot(note.author?.username ?? "")) continue;

        comments.push({
          id: String(note.id),
          author: note.author?.username ?? "unknown",
          body: note.body,
          path: note.position?.new_path || undefined,
          line: note.position?.new_line ?? undefined,
          isResolved: false,
          createdAt: parseDate(note.created_at),
          url: "",
        });
      }
      return comments;
    },

    async getReviewThreads(pr: PRInfo): Promise<ReviewThreadsResult> {
      const hostname = resolveHostname(pr);
      const discussions = await fetchDiscussions(
        pr,
        hostname,
        `getReviewThreads for MR !${pr.number}`,
      );

      // Unresolved threads — includes both human and bot comments (with isBot flag)
      const threads: ReviewComment[] = [];
      for (const d of discussions) {
        const note = d.notes[0];
        if (!note) continue;
        if (!note.resolvable || note.resolved) continue;

        const author = note.author?.username ?? "unknown";
        threads.push({
          id: String(note.id),
          threadId: d.id,
          author,
          body: note.body,
          path: note.position?.new_path || undefined,
          line: note.position?.new_line ?? undefined,
          isResolved: false,
          createdAt: parseDate(note.created_at),
          url: "",
          isBot: isBot(author),
        });
      }

      // Review summaries from approvals
      const reviews: ReviewSummary[] = [];
      try {
        const approvalsRaw = await glab(["api", `${mrApiPath(pr)}/approvals`], hostname);
        const approvals = parseJSON<{
          approved_by: Array<{ user: { username: string } }>;
        }>(approvalsRaw, `getReviewThreads approvals for MR !${pr.number}`);

        for (const a of approvals.approved_by ?? []) {
          reviews.push({
            author: a.user?.username ?? "unknown",
            state: "APPROVED",
            body: "",
            submittedAt: new Date(0),
          });
        }
      } catch {
        // Best-effort — threads are the critical data
      }

      return { threads, reviews };
    },

    async getMergeability(pr: PRInfo): Promise<MergeReadiness> {
      const hostname = resolveHostname(pr);

      const mrRaw = await glab(
        ["mr", "view", String(pr.number), "--repo", repoFlag(pr), "-F", "json"],
        hostname,
      );
      const mrData = parseJSON<{ state: string; draft: boolean }>(
        mrRaw,
        `getMergeability mr view for MR !${pr.number}`,
      );

      const state = mapPRState(mrData.state);
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
          blockers: ["MR is closed"],
        };
      }

      const apiRaw = await glab(["api", mrApiPath(pr)], hostname);
      const apiData = parseJSON<{
        merge_status: string;
        has_conflicts: boolean;
        blocking_discussions_resolved: boolean;
      }>(apiRaw, `getMergeability api for MR !${pr.number}`);

      const blockers: string[] = [];

      const ciStatus = await this.getCISummary(pr);
      const ciPassing = ciStatus === CI_STATUS.PASSING || ciStatus === CI_STATUS.NONE;
      if (!ciPassing) {
        blockers.push(`CI is ${ciStatus}`);
      }

      const reviewDecision = await this.getReviewDecision(pr);
      const approved = reviewDecision === "approved";
      if (reviewDecision === "pending") {
        blockers.push("Approval required");
      }

      const noConflicts = !apiData.has_conflicts;
      if (!noConflicts) {
        blockers.push("Merge conflicts");
      }

      if (apiData.merge_status === "cannot_be_merged" && noConflicts) {
        blockers.push("Merge status: cannot be merged");
      } else if (apiData.merge_status === "checking") {
        blockers.push("Merge status unknown (GitLab is computing)");
      }

      if (!apiData.blocking_discussions_resolved) {
        blockers.push("Unresolved discussions blocking merge");
      }

      if (mrData.draft) {
        blockers.push("MR is still a draft");
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
  name: "gitlab",
  slot: "scm" as const,
  description: "SCM plugin: GitLab MRs, CI pipelines, reviews, merge readiness",
  version: "0.1.0",
};

export function create(config?: Record<string, unknown>): SCM {
  return createGitLabSCM(config);
}

export default { manifest, create } satisfies PluginModule<SCM>;
