/**
 * scm-github plugin — GitHub PRs, CI checks, reviews, merge readiness.
 *
 * Uses the `gh` CLI for all GitHub API interactions.
 */

import { execFile } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import {
  CI_STATUS,
  execGhObserved,
  memoizeAsync,
  type PluginModule,
  type PreflightContext,
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
  type PREnrichmentData,
  type BatchObserver,
} from "@aoagents/ao-core";
import {
  enrichSessionsPRBatch as enrichSessionsPRBatchImpl,
  checkReviewCommentsETag,
} from "./graphql-batch.js";
import {
  getWebhookHeader,
  parseWebhookBranchRef,
  parseWebhookJsonObject,
  parseWebhookTimestamp,
} from "@aoagents/ao-core/scm-webhook-utils";

const execFileAsync = promisify(execFile);

/** Known bot logins that produce automated review comments */
const BOT_AUTHORS = new Set([
  "cursor[bot]",
  "github-actions[bot]",
  "codecov[bot]",
  "sonarcloud[bot]",
  "dependabot[bot]",
  "renovate[bot]",
  "codeclimate[bot]",
  "deepsource-autofix[bot]",
  "snyk-bot",
  "lgtm-com[bot]",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ExecCommand = "gh" | "git";

async function execCli(bin: ExecCommand, args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(bin, args, {
      ...(cwd ? { cwd } : {}),
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    });
    return stdout.trim();
  } catch (err) {
    throw new Error(`${bin} ${args.slice(0, 3).join(" ")} failed: ${(err as Error).message}`, {
      cause: err,
    });
  }
}

async function gh(args: string[]): Promise<string> {
  return execGhObserved(args, { component: "scm-github" }, 30_000);
}

async function ghInDir(args: string[], cwd: string): Promise<string> {
  return execGhObserved(args, { component: "scm-github", cwd }, 30_000);
}

async function git(args: string[], cwd: string): Promise<string> {
  return execCli("git", args, cwd);
}

function parseProjectRepo(projectRepo: string): [string, string] {
  const parts = projectRepo.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repo format "${projectRepo}", expected "owner/repo"`);
  }
  return [parts[0], parts[1]];
}

function prInfoFromView(
  data: {
    number: number;
    url: string;
    title: string;
    headRefName: string;
    baseRefName: string;
    isDraft: boolean;
  },
  projectRepo: string,
): PRInfo {
  const [owner, repo] = parseProjectRepo(projectRepo);

  return {
    number: data.number,
    url: data.url,
    title: data.title,
    owner,
    repo,
    branch: data.headRefName,
    baseBranch: data.baseRefName,
    isDraft: data.isDraft,
  };
}

function isUnsupportedPrChecksJsonError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /pr checks/i.test(err.message) && /unknown json field/i.test(err.message);
}

function mapRawCheckStateToStatus(rawState: string | undefined): CICheck["status"] {
  const state = (rawState ?? "").toUpperCase();
  if (state === "IN_PROGRESS") return "running";
  if (
    state === "PENDING" ||
    state === "QUEUED" ||
    state === "REQUESTED" ||
    state === "WAITING" ||
    state === "EXPECTED"
  ) {
    return "pending";
  }
  if (state === "SUCCESS") return "passed";
  if (
    state === "FAILURE" ||
    state === "TIMED_OUT" ||
    state === "CANCELLED" ||
    state === "ACTION_REQUIRED" ||
    state === "ERROR"
  ) {
    return "failed";
  }
  if (
    state === "SKIPPED" ||
    state === "NEUTRAL" ||
    state === "STALE" ||
    state === "NOT_REQUIRED" ||
    state === "NONE" ||
    state === ""
  ) {
    return "skipped";
  }

  return "skipped";
}

async function getCIChecksFromStatusRollup(pr: PRInfo): Promise<CICheck[]> {
  const raw = await gh([
    "pr",
    "view",
    String(pr.number),
    "--repo",
    repoFlag(pr),
    "--json",
    "statusCheckRollup",
  ]);

  const data: { statusCheckRollup?: unknown[] } = JSON.parse(raw);
  const rollup = Array.isArray(data.statusCheckRollup) ? data.statusCheckRollup : [];

  return rollup
    .map((entry): CICheck | null => {
      if (!entry || typeof entry !== "object") return null;
      const row = entry as Record<string, unknown>;
      const name =
        (typeof row["name"] === "string" && row["name"]) ||
        (typeof row["context"] === "string" && row["context"]);
      if (!name) return null;

      const rawState =
        typeof row["conclusion"] === "string"
          ? row["conclusion"]
          : typeof row["state"] === "string"
            ? row["state"]
            : typeof row["status"] === "string"
              ? row["status"]
              : undefined;

      const url =
        (typeof row["link"] === "string" && row["link"]) ||
        (typeof row["detailsUrl"] === "string" && row["detailsUrl"]) ||
        (typeof row["targetUrl"] === "string" && row["targetUrl"]) ||
        undefined;

      const startedAtRaw =
        typeof row["startedAt"] === "string"
          ? row["startedAt"]
          : typeof row["createdAt"] === "string"
            ? row["createdAt"]
            : undefined;
      const completedAtRaw =
        typeof row["completedAt"] === "string" ? row["completedAt"] : undefined;

      const check: CICheck = {
        name,
        status: mapRawCheckStateToStatus(rawState),
        conclusion: typeof rawState === "string" ? rawState.toUpperCase() : undefined,
        startedAt: startedAtRaw ? new Date(startedAtRaw) : undefined,
        completedAt: completedAtRaw ? new Date(completedAtRaw) : undefined,
      };

      if (url) {
        check.url = url;
      }

      return check;
    })
    .filter((check): check is CICheck => check !== null);
}

function getGitHubWebhookConfig(project: ProjectConfig) {
  const webhook = project.scm?.webhook;
  return {
    enabled: webhook?.enabled !== false,
    path: webhook?.path ?? "/api/webhooks/github",
    secretEnvVar: webhook?.secretEnvVar,
    signatureHeader: webhook?.signatureHeader ?? "x-hub-signature-256",
    eventHeader: webhook?.eventHeader ?? "x-github-event",
    deliveryHeader: webhook?.deliveryHeader ?? "x-github-delivery",
    maxBodyBytes: webhook?.maxBodyBytes,
  };
}

function verifyGitHubSignature(
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

function parseGitHubRepository(payload: Record<string, unknown>) {
  const repository = payload["repository"];
  if (!repository || typeof repository !== "object") return undefined;
  const repo = repository as Record<string, unknown>;
  const ownerValue = repo["owner"];
  const ownerLogin =
    ownerValue && typeof ownerValue === "object"
      ? (ownerValue as Record<string, unknown>)["login"]
      : undefined;
  const owner = typeof ownerLogin === "string" ? ownerLogin : undefined;
  const name = typeof repo["name"] === "string" ? repo["name"] : undefined;
  if (!owner || !name) return undefined;
  return { owner, name };
}

function parseGitHubWebhookEvent(
  request: SCMWebhookRequest,
  payload: Record<string, unknown>,
  config: ReturnType<typeof getGitHubWebhookConfig>,
): SCMWebhookEvent | null {
  const rawEventType = getWebhookHeader(request.headers, config.eventHeader);
  if (!rawEventType) return null;

  const deliveryId = getWebhookHeader(request.headers, config.deliveryHeader);
  const repository = parseGitHubRepository(payload);
  const action = typeof payload["action"] === "string" ? payload["action"] : rawEventType;

  if (rawEventType === "pull_request") {
    const pullRequest = payload["pull_request"];
    if (!pullRequest || typeof pullRequest !== "object") return null;
    const pr = pullRequest as Record<string, unknown>;
    const head = pr["head"] as Record<string, unknown> | undefined;
    return {
      provider: "github",
      kind: "pull_request",
      action,
      rawEventType,
      deliveryId,
      repository,
      prNumber:
        typeof payload["number"] === "number"
          ? (payload["number"] as number)
          : typeof pr["number"] === "number"
            ? (pr["number"] as number)
            : undefined,
      branch: typeof head?.["ref"] === "string" ? head["ref"] : undefined,
      sha: typeof head?.["sha"] === "string" ? head["sha"] : undefined,
      timestamp: parseWebhookTimestamp(pr["updated_at"]),
      data: payload,
    };
  }

  if (rawEventType === "pull_request_review" || rawEventType === "pull_request_review_comment") {
    const pullRequest = payload["pull_request"];
    if (!pullRequest || typeof pullRequest !== "object") return null;
    const pr = pullRequest as Record<string, unknown>;
    const head = pr["head"] as Record<string, unknown> | undefined;
    return {
      provider: "github",
      kind: rawEventType === "pull_request_review" ? "review" : "comment",
      action,
      rawEventType,
      deliveryId,
      repository,
      prNumber:
        typeof payload["number"] === "number"
          ? (payload["number"] as number)
          : typeof pr["number"] === "number"
            ? (pr["number"] as number)
            : undefined,
      branch: typeof head?.["ref"] === "string" ? head["ref"] : undefined,
      sha: typeof head?.["sha"] === "string" ? head["sha"] : undefined,
      timestamp:
        rawEventType === "pull_request_review"
          ? parseWebhookTimestamp(
              (payload["review"] as Record<string, unknown> | undefined)?.["submitted_at"],
            )
          : parseWebhookTimestamp(
              (payload["comment"] as Record<string, unknown> | undefined)?.["updated_at"] ??
                (payload["comment"] as Record<string, unknown> | undefined)?.["created_at"],
            ),
      data: payload,
    };
  }

  if (rawEventType === "issue_comment") {
    const issue = payload["issue"];
    if (!issue || typeof issue !== "object") return null;
    const issueRecord = issue as Record<string, unknown>;
    if (!("pull_request" in issueRecord)) return null;
    return {
      provider: "github",
      kind: "comment",
      action,
      rawEventType,
      deliveryId,
      repository,
      prNumber: typeof issueRecord["number"] === "number" ? issueRecord["number"] : undefined,
      timestamp: parseWebhookTimestamp(
        (payload["comment"] as Record<string, unknown> | undefined)?.["updated_at"] ??
          (payload["comment"] as Record<string, unknown> | undefined)?.["created_at"],
      ),
      data: payload,
    };
  }

  if (rawEventType === "check_run" || rawEventType === "check_suite") {
    const check = payload[rawEventType] as Record<string, unknown> | undefined;
    const pullRequests = Array.isArray(check?.["pull_requests"])
      ? (check?.["pull_requests"] as Array<Record<string, unknown>>)
      : [];
    const firstPR = pullRequests[0];
    return {
      provider: "github",
      kind: "ci",
      action,
      rawEventType,
      deliveryId,
      repository,
      prNumber: typeof firstPR?.["number"] === "number" ? firstPR["number"] : undefined,
      branch:
        typeof check?.["head_branch"] === "string"
          ? (check["head_branch"] as string)
          : typeof (check?.["check_suite"] as Record<string, unknown> | undefined)?.[
                "head_branch"
              ] === "string"
            ? ((check?.["check_suite"] as Record<string, unknown>)["head_branch"] as string)
            : undefined,
      sha: typeof check?.["head_sha"] === "string" ? (check["head_sha"] as string) : undefined,
      timestamp: parseWebhookTimestamp(check?.["updated_at"]),
      data: payload,
    };
  }

  if (rawEventType === "status") {
    const branches = Array.isArray(payload["branches"])
      ? (payload["branches"] as Array<Record<string, unknown>>)
      : [];
    return {
      provider: "github",
      kind: "ci",
      action: typeof payload["state"] === "string" ? (payload["state"] as string) : action,
      rawEventType,
      deliveryId,
      repository,
      branch: parseWebhookBranchRef(branches[0]?.["name"] ?? payload["ref"]),
      sha: typeof payload["sha"] === "string" ? (payload["sha"] as string) : undefined,
      timestamp: parseWebhookTimestamp(payload["updated_at"]),
      data: payload,
    };
  }

  if (rawEventType === "push") {
    const headCommit =
      payload["head_commit"] && typeof payload["head_commit"] === "object"
        ? (payload["head_commit"] as Record<string, unknown>)
        : undefined;
    return {
      provider: "github",
      kind: "push",
      action,
      rawEventType,
      deliveryId,
      repository,
      branch: parseWebhookBranchRef(payload["ref"]),
      sha: typeof payload["after"] === "string" ? (payload["after"] as string) : undefined,
      timestamp: parseWebhookTimestamp(headCommit?.["timestamp"] ?? payload["updated_at"]),
      data: payload,
    };
  }

  return {
    provider: "github",
    kind: "unknown",
    action,
    rawEventType,
    deliveryId,
    repository,
    timestamp: parseWebhookTimestamp(payload["updated_at"]),
    data: payload,
  };
}

function repoFlag(pr: PRInfo): string {
  return `${pr.owner}/${pr.repo}`;
}

function parseDate(val: string | undefined | null): Date {
  if (!val) return new Date(0);
  const d = new Date(val);
  return isNaN(d.getTime()) ? new Date(0) : d;
}

// ---------------------------------------------------------------------------
// SCM implementation
// ---------------------------------------------------------------------------

// In-process PR cache. Per-method TTLs balance call reduction against
// staleness. Tightest TTLs (5s) on the fastest-changing decision-critical
// fields (state, CI, mergeability) — well under one poll cycle. Slightly
// looser (10s) on review-state and review-comments which tolerate up to
// 10-30s staleness per the agreed policy and benefit measurably from a
// looser window in trace replay. detectPR uses 30s because once a PR is
// discovered for a branch, that fact is stable for the session — and 5s was
// far below the per-branch poll cadence (~30s), making the cache near-useless.
// detectPR caches positive results only (never []) so a freshly created PR
// is discovered on the very next poll.
const PR_CACHE_TTL_MS = {
  resolvePR: 60_000, // identity metadata (number, url, title, branch refs, isDraft)
  getPRState: 5_000, // open / merged / closed
  getPRSummary: 5_000, // state + title + additions/deletions
  getReviews: 10_000, // review array (state, body, author)
  getReviewDecision: 10_000, // approved / changes_requested / pending
  getCIChecks: 5_000, // CI check list (name, state, link, timestamps)
  getMergeability: 5_000, // composite merge readiness
  getPendingComments: 10_000, // unresolved review threads (GraphQL)
  detectPR: 30_000, // positive hits only — branch-PR mapping is stable once known
} as const;

const PR_CACHE_MAX_ENTRIES = 1000;

type PRCacheMethod = keyof typeof PR_CACHE_TTL_MS;

function createGitHubSCM(): SCM {
  // Per-instance cache so each createGitHubSCM() returns an isolated cache —
  // tests get clean state on each create() call.
  const prCache = new Map<string, { value: unknown; expiresAt: number }>();
  // ETag-controlled cache for review threads + reviews. Freshness is managed by
  // Guard 3 (checkReviewCommentsETag) — not a TTL timer.
  const reviewThreadsCache = new Map<string, ReviewThreadsResult>();
  // Instance-level observer captured from enrichSessionsPRBatch calls.
  // Used by getReviewThreads (which can't accept observer via the SCM interface)
  // to log non-304 errors that would otherwise be swallowed by lifecycle's catch.
  let instanceObserver: BatchObserver | undefined;

  function prCacheKey(owner: string, repo: string, prKey: string, method: PRCacheMethod): string {
    return `${owner}/${repo}#${prKey}:${method}`;
  }

  function readPRCache<T>(key: string): T | null {
    const entry = prCache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      prCache.delete(key);
      return null;
    }
    return entry.value as T;
  }

  function writePRCache<T>(key: string, value: T, ttlMs: number): void {
    if (prCache.size >= PR_CACHE_MAX_ENTRIES) {
      const oldest = prCache.keys().next().value;
      if (oldest !== undefined) prCache.delete(oldest);
    }
    prCache.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  // Wipe every method's cache entry for a specific PR. Called on writes
  // (pr edit/merge/close) to avoid serving stale state after our own mutation.
  // Also wipes the branch-keyed detectPR entry since mergePR deletes the branch.
  function invalidatePRCache(pr: PRInfo): void {
    const prefix = `${pr.owner}/${pr.repo}#${pr.number}:`;
    for (const key of prCache.keys()) {
      if (key.startsWith(prefix)) prCache.delete(key);
    }
    prCache.delete(prCacheKey(pr.owner, pr.repo, pr.branch, "detectPR"));
    reviewThreadsCache.delete(`${pr.owner}/${pr.repo}#${pr.number}`);
  }

  async function withPRCache<T>(
    owner: string,
    repo: string,
    prKey: string,
    method: PRCacheMethod,
    fetcher: () => Promise<T>,
  ): Promise<T> {
    const key = prCacheKey(owner, repo, prKey, method);
    const cached = readPRCache<T>(key);
    if (cached !== null) return cached;
    const value = await fetcher();
    writePRCache(key, value, PR_CACHE_TTL_MS[method]);
    return value;
  }

  return {
    name: "github",

    async verifyWebhook(
      request: SCMWebhookRequest,
      project: ProjectConfig,
    ): Promise<SCMWebhookVerificationResult> {
      const config = getGitHubWebhookConfig(project);
      if (!config.enabled) {
        return { ok: false, reason: "Webhook is disabled for this project" };
      }
      if (request.method.toUpperCase() !== "POST") {
        return { ok: false, reason: "Webhook requests must use POST" };
      }
      if (
        config.maxBodyBytes !== undefined &&
        Buffer.byteLength(request.body, "utf8") > config.maxBodyBytes
      ) {
        return { ok: false, reason: "Webhook payload exceeds configured maxBodyBytes" };
      }

      const eventType = getWebhookHeader(request.headers, config.eventHeader);
      if (!eventType) {
        return { ok: false, reason: `Missing ${config.eventHeader} header` };
      }

      const deliveryId = getWebhookHeader(request.headers, config.deliveryHeader);
      const secretName = config.secretEnvVar;
      if (!secretName) {
        return { ok: true, deliveryId, eventType };
      }

      const secret = process.env[secretName];
      if (!secret) {
        return { ok: false, reason: `Webhook secret env var ${secretName} is not configured` };
      }

      const signature = getWebhookHeader(request.headers, config.signatureHeader);
      if (!signature) {
        return { ok: false, reason: `Missing ${config.signatureHeader} header` };
      }

      if (!verifyGitHubSignature(request.rawBody ?? request.body, secret, signature)) {
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
      const config = getGitHubWebhookConfig(project);
      const payload = parseWebhookJsonObject(request.body);
      return parseGitHubWebhookEvent(request, payload, config);
    },

    async detectPR(session: Session, project: ProjectConfig): Promise<PRInfo | null> {
      if (!session.branch || !project.repo) return null;
      parseProjectRepo(project.repo);
      const [owner, repoName] = project.repo.split("/");
      // Positive-only cache: never cache [] (null). A just-created PR must
      // surface on the next poll, so we pay the gh call for misses but save
      // every call after the PR is discovered.
      const cacheK = prCacheKey(owner ?? "", repoName ?? "", session.branch, "detectPR");
      const cached = readPRCache<PRInfo>(cacheK);
      if (cached !== null) return cached;
      try {
        const raw = await gh([
          "pr",
          "list",
          "--repo",
          project.repo,
          "--head",
          session.branch,
          "--json",
          "number,url,title,headRefName,baseRefName,isDraft",
          "--limit",
          "1",
        ]);

        const prs: Array<{
          number: number;
          url: string;
          title: string;
          headRefName: string;
          baseRefName: string;
          isDraft: boolean;
        }> = JSON.parse(raw);

        if (prs.length === 0) return null;

        const info = prInfoFromView(prs[0], project.repo);
        writePRCache(cacheK, info, PR_CACHE_TTL_MS.detectPR);
        return info;
      } catch {
        return null;
      }
    },

    async resolvePR(reference: string, project: ProjectConfig): Promise<PRInfo> {
      if (!project.repo) {
        throw new Error("Cannot resolve PR: project has no repo configured");
      }
      const repo = project.repo;
      const [owner, repoName] = repo.split("/");
      // Cache by reference (number, branch, or URL — caller-provided).
      // Identity metadata (number, url, title, branch refs, isDraft) is stable
      // for the life of a PR; 60s TTL is safely under any user-noticeable window.
      return withPRCache(owner ?? "", repoName ?? "", `ref=${reference}`, "resolvePR", async () => {
        const raw = await gh([
          "pr",
          "view",
          reference,
          "--repo",
          repo,
          "--json",
          "number,url,title,headRefName,baseRefName,isDraft",
        ]);

        const data: {
          number: number;
          url: string;
          title: string;
          headRefName: string;
          baseRefName: string;
          isDraft: boolean;
        } = JSON.parse(raw);

        return prInfoFromView(data, repo);
      });
    },

    async assignPRToCurrentUser(pr: PRInfo): Promise<void> {
      await gh(["pr", "edit", String(pr.number), "--repo", repoFlag(pr), "--add-assignee", "@me"]);
      invalidatePRCache(pr);
    },

    async checkoutPR(pr: PRInfo, workspacePath: string): Promise<boolean> {
      const currentBranch = await git(["branch", "--show-current"], workspacePath);
      if (currentBranch === pr.branch) return false;

      const dirty = await git(["status", "--porcelain"], workspacePath);
      if (dirty) {
        throw new Error(
          `Workspace has uncommitted changes; cannot switch to PR branch "${pr.branch}" safely`,
        );
      }

      await ghInDir(["pr", "checkout", String(pr.number), "--repo", repoFlag(pr)], workspacePath);
      return true;
    },

    async getPRState(pr: PRInfo): Promise<PRState> {
      // 5s TTL — state is decision-influencing (lifecycle uses it for cleanup),
      // but 5s is well under one poll cycle so the lifecycle worker still sees
      // freshly observed transitions on its next pass.
      return withPRCache(pr.owner, pr.repo, String(pr.number), "getPRState", async () => {
        const raw = await gh([
          "pr",
          "view",
          String(pr.number),
          "--repo",
          repoFlag(pr),
          "--json",
          "state",
        ]);
        const data: { state: string } = JSON.parse(raw);
        const s = data.state.toUpperCase();
        if (s === "MERGED") return "merged";
        if (s === "CLOSED") return "closed";
        return "open";
      });
    },

    async getPRSummary(pr: PRInfo) {
      // 5s TTL — includes state, so same freshness contract as getPRState.
      // Title and additions/deletions change rarely; they ride along.
      return withPRCache(pr.owner, pr.repo, String(pr.number), "getPRSummary", async () => {
        const raw = await gh([
          "pr",
          "view",
          String(pr.number),
          "--repo",
          repoFlag(pr),
          "--json",
          "state,title,additions,deletions",
        ]);
        const data: {
          state: string;
          title: string;
          additions: number;
          deletions: number;
        } = JSON.parse(raw);
        const s = data.state.toUpperCase();
        const state: PRState = s === "MERGED" ? "merged" : s === "CLOSED" ? "closed" : "open";
        return {
          state,
          title: data.title ?? "",
          additions: data.additions ?? 0,
          deletions: data.deletions ?? 0,
        };
      });
    },

    async mergePR(pr: PRInfo, method: MergeMethod = "squash"): Promise<void> {
      const flag = method === "rebase" ? "--rebase" : method === "merge" ? "--merge" : "--squash";

      await gh(["pr", "merge", String(pr.number), "--repo", repoFlag(pr), flag, "--delete-branch"]);
      invalidatePRCache(pr);
    },

    async closePR(pr: PRInfo): Promise<void> {
      await gh(["pr", "close", String(pr.number), "--repo", repoFlag(pr)]);
      invalidatePRCache(pr);
    },

    async getCIChecks(pr: PRInfo): Promise<CICheck[]> {
      // 5s TTL — CI state can flip quickly; within one poll cycle is acceptable
      // per the agreed fast-changing-fields policy. Fallback to statusCheckRollup
      // for older gh CLI versions happens inside the fetcher and rides on the
      // same cache entry.
      return withPRCache(pr.owner, pr.repo, String(pr.number), "getCIChecks", async () => {
        try {
          const raw = await gh([
            "pr",
            "checks",
            String(pr.number),
            "--repo",
            repoFlag(pr),
            "--json",
            "name,state,link,startedAt,completedAt",
          ]);

          const checks: Array<{
            name: string;
            state: string;
            link: string;
            startedAt: string;
            completedAt: string;
          }> = JSON.parse(raw);

          return checks.map((c) => {
            const state = c.state?.toUpperCase();

            return {
              name: c.name,
              status: mapRawCheckStateToStatus(state),
              url: c.link || undefined,
              conclusion: state || undefined,
              startedAt: c.startedAt ? new Date(c.startedAt) : undefined,
              completedAt: c.completedAt ? new Date(c.completedAt) : undefined,
            };
          });
        } catch (err) {
          if (isUnsupportedPrChecksJsonError(err)) {
            return getCIChecksFromStatusRollup(pr);
          }
          throw new Error("Failed to fetch CI checks", { cause: err });
        }
      });
    },

    async getCISummary(pr: PRInfo): Promise<CIStatus> {
      let checks: CICheck[];
      try {
        checks = await this.getCIChecks(pr);
      } catch {
        // Before fail-closing, check if the PR is merged/closed —
        // GitHub may not return check data for those, and reporting
        // "failing" for a merged PR is wrong.
        try {
          const state = await this.getPRState(pr);
          if (state === "merged" || state === "closed") return "none";
        } catch {
          // Can't determine state either; fall through to fail-closed.
        }
        // Fail closed for open PRs: report as failing rather than
        // "none" (which getMergeability treats as passing).
        return "failing";
      }
      if (checks.length === 0) return "none";

      const hasFailing = checks.some((c) => c.status === "failed");
      if (hasFailing) return "failing";

      const hasPending = checks.some((c) => c.status === "pending" || c.status === "running");
      if (hasPending) return "pending";

      // Only report passing if at least one check actually passed
      // (not all skipped)
      const hasPassing = checks.some((c) => c.status === "passed");
      if (!hasPassing) return "none";

      return "passing";
    },

    async getReviews(pr: PRInfo): Promise<Review[]> {
      // 5s TTL — review array. Reviewers are async, so the lifecycle worker
      // sees a new review on its next poll cycle within 5s of the cache expiring.
      return withPRCache(pr.owner, pr.repo, String(pr.number), "getReviews", async () => {
        const raw = await gh([
          "pr",
          "view",
          String(pr.number),
          "--repo",
          repoFlag(pr),
          "--json",
          "reviews",
        ]);
        const data: {
          reviews: Array<{
            author: { login: string };
            state: string;
            body: string;
            submittedAt: string;
          }>;
        } = JSON.parse(raw);

        return data.reviews.map((r) => {
          let state: Review["state"];
          const s = r.state?.toUpperCase();
          if (s === "APPROVED") state = "approved";
          else if (s === "CHANGES_REQUESTED") state = "changes_requested";
          else if (s === "DISMISSED") state = "dismissed";
          else if (s === "PENDING") state = "pending";
          else state = "commented";

          return {
            author: r.author?.login ?? "unknown",
            state,
            body: r.body || undefined,
            submittedAt: parseDate(r.submittedAt),
          };
        });
      });
    },

    async getReviewDecision(pr: PRInfo): Promise<ReviewDecision> {
      // 5s TTL — review decision is decision-influencing (gates merge), kept
      // tight so a fresh "approved" surfaces within one poll cycle.
      return withPRCache(pr.owner, pr.repo, String(pr.number), "getReviewDecision", async () => {
        const raw = await gh([
          "pr",
          "view",
          String(pr.number),
          "--repo",
          repoFlag(pr),
          "--json",
          "reviewDecision",
        ]);
        const data: { reviewDecision: string } = JSON.parse(raw);

        const d = (data.reviewDecision ?? "").toUpperCase();
        if (d === "APPROVED") return "approved";
        if (d === "CHANGES_REQUESTED") return "changes_requested";
        if (d === "REVIEW_REQUIRED") return "pending";
        return "none";
      });
    },

    async getPendingComments(pr: PRInfo): Promise<ReviewComment[]> {
      // 5s TTL — review threads are decision-influencing (gates whether AO
      // reacts to new comments). Within one poll cycle is acceptable. Note:
      // ETag does not work on /graphql per Experiment 2 (G2), so TTL is the
      // only practical lever here.
      return withPRCache(pr.owner, pr.repo, String(pr.number), "getPendingComments", async () => {
        try {
          // Use GraphQL with variables to get review threads with actual isResolved status
          const raw = await gh([
          "api",
          "graphql",
          "-f",
          `owner=${pr.owner}`,
          "-f",
          `name=${pr.repo}`,
          "-F",
          `number=${pr.number}`,
          "-f",
          `query=query($owner: String!, $name: String!, $number: Int!) {
            repository(owner: $owner, name: $name) {
              pullRequest(number: $number) {
                reviewThreads(first: 100) {
                  nodes {
                    id
                    isResolved
                    comments(first: 1) {
                      nodes {
                        id
                        author { login }
                        body
                        path
                        line
                        url
                        createdAt
                      }
                    }
                  }
                }
              }
            }
          }`,
        ]);

        const data: {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: Array<{
                    id: string;
                    isResolved: boolean;
                    comments: {
                      nodes: Array<{
                        id: string;
                        author: { login: string } | null;
                        body: string;
                        path: string | null;
                        line: number | null;
                        url: string;
                        createdAt: string;
                      }>;
                    };
                  }>;
                };
              };
            };
          };
        } = JSON.parse(raw);

        const threads = data.data.repository.pullRequest.reviewThreads.nodes;

        return threads
          .filter((t) => {
            if (t.isResolved) return false; // only pending (unresolved) threads
            const c = t.comments.nodes[0];
            if (!c) return false; // skip threads with no comments
            const author = c.author?.login ?? "";
            return !BOT_AUTHORS.has(author);
          })
          .map((t) => {
            const c = t.comments.nodes[0];
            return {
              id: c.id,
              threadId: t.id,
              author: c.author?.login ?? "unknown",
              body: c.body,
              path: c.path || undefined,
              line: c.line ?? undefined,
              isResolved: t.isResolved,
              createdAt: parseDate(c.createdAt),
              url: c.url,
            };
          });
        } catch (err) {
          throw new Error("Failed to fetch pending comments", { cause: err });
        }
      });
    },

    async getReviewThreads(pr: PRInfo): Promise<ReviewThreadsResult> {
      const cacheKey = `${pr.owner}/${pr.repo}#${pr.number}`;

      // Guard 3: check if review comments changed via REST ETag
      const reviewsChanged = await checkReviewCommentsETag(pr.owner, pr.repo, pr.number, instanceObserver);
      if (!reviewsChanged) {
        const cached = reviewThreadsCache.get(cacheKey);
        if (cached) return cached;
      }

      try {
        const rawWithHeaders = await gh([
          "api",
          "graphql",
          "-i",
          "-f",
          `owner=${pr.owner}`,
          "-f",
          `name=${pr.repo}`,
          "-F",
          `number=${pr.number}`,
          "-f",
          `query=query($owner: String!, $name: String!, $number: Int!) {
            repository(owner: $owner, name: $name) {
              pullRequest(number: $number) {
                reviewThreads(last: 100) {
                  nodes {
                    id
                    isResolved
                    comments(first: 1) {
                      nodes {
                        id
                        author { login }
                        body
                        path
                        line
                        url
                        createdAt
                      }
                    }
                  }
                }
                reviews(last: 5) {
                  nodes {
                    author { login }
                    state
                    body
                    submittedAt
                  }
                }
              }
            }
            rateLimit { cost remaining resetAt }
          }`,
        ]);
        // Strip HTTP headers from -i response to get JSON body
        const raw = rawWithHeaders.replace(/^[\s\S]*?\r?\n\r?\n/, "");

        const data: {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: Array<{
                    id: string;
                    isResolved: boolean;
                    comments: {
                      nodes: Array<{
                        id: string;
                        author: { login: string } | null;
                        body: string;
                        path: string | null;
                        line: number | null;
                        url: string;
                        createdAt: string;
                      }>;
                    };
                  }>;
                };
                reviews: {
                  nodes: Array<{
                    author: { login: string } | null;
                    state: string;
                    body: string;
                    submittedAt: string;
                  }>;
                };
              };
            };
          };
        } = JSON.parse(raw);

        const threadNodes = data.data.repository.pullRequest.reviewThreads.nodes;
        const reviewNodes = data.data.repository.pullRequest.reviews.nodes;

        const threads: ReviewComment[] = threadNodes
          .filter((t) => {
            if (t.isResolved) return false;
            const c = t.comments.nodes[0];
            return !!c;
          })
          .map((t) => {
            const c = t.comments.nodes[0];
            const author = c.author?.login ?? "unknown";
            return {
              id: c.id,
              threadId: t.id,
              author,
              body: c.body,
              path: c.path || undefined,
              line: c.line ?? undefined,
              isResolved: t.isResolved,
              createdAt: parseDate(c.createdAt),
              url: c.url,
              isBot: BOT_AUTHORS.has(author),
            };
          });

        const reviews: ReviewSummary[] = reviewNodes
          .filter((r) => r.body && r.body.trim().length > 0)
          .map((r) => ({
            author: r.author?.login ?? "unknown",
            state: r.state,
            body: r.body,
            submittedAt: parseDate(r.submittedAt),
          }));

        const result: ReviewThreadsResult = { threads, reviews };
        reviewThreadsCache.set(cacheKey, result);
        return result;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        instanceObserver?.log("warn", `[getReviewThreads] Failed for ${cacheKey}: ${errorMsg}`);
        throw new Error("Failed to fetch review threads", { cause: err });
      }
    },

    async getMergeability(pr: PRInfo): Promise<MergeReadiness> {
      // 5s TTL — composite merge readiness. Internal getPRState/getCISummary
      // calls are also cached (5s each) so even on cache miss this is cheap.
      // Cached entry covers the full computed result so duplicate poll-cycle
      // calls don't re-derive blockers.
      return withPRCache(pr.owner, pr.repo, String(pr.number), "getMergeability", async () => {
        const blockers: string[] = [];

        // First, check if the PR is merged
        // GitHub returns mergeable=null for merged PRs, which is not useful
        // Note: We only skip checks for merged PRs. Closed PRs still need accurate status.
        const state = await this.getPRState(pr);
        if (state === "merged") {
          // For merged PRs, return a clean result without querying mergeable status
          return {
            mergeable: true,
            ciPassing: true,
            approved: true,
            noConflicts: true,
            blockers: [],
          };
        }

        // Fetch PR details with merge state
        const raw = await gh([
          "pr",
          "view",
          String(pr.number),
          "--repo",
          repoFlag(pr),
          "--json",
          "mergeable,reviewDecision,mergeStateStatus,isDraft",
        ]);

        const data: {
          mergeable: string;
          reviewDecision: string;
          mergeStateStatus: string;
          isDraft: boolean;
        } = JSON.parse(raw);

        // CI
        const ciStatus = await this.getCISummary(pr);
        const ciPassing = ciStatus === CI_STATUS.PASSING || ciStatus === CI_STATUS.NONE;
        if (!ciPassing) {
          blockers.push(`CI is ${ciStatus}`);
        }

        // Reviews
        const reviewDecision = (data.reviewDecision ?? "").toUpperCase();
        const approved = reviewDecision === "APPROVED";
        if (reviewDecision === "CHANGES_REQUESTED") {
          blockers.push("Changes requested in review");
        } else if (reviewDecision === "REVIEW_REQUIRED") {
          blockers.push("Review required");
        }

        // Conflicts / merge state
        const mergeable = (data.mergeable ?? "").toUpperCase();
        const mergeState = (data.mergeStateStatus ?? "").toUpperCase();
        const noConflicts = mergeable === "MERGEABLE";
        if (mergeable === "CONFLICTING") {
          blockers.push("Merge conflicts");
        } else if (mergeable === "UNKNOWN" || mergeable === "") {
          blockers.push("Merge status unknown (GitHub is computing)");
        }
        if (mergeState === "BEHIND") {
          blockers.push("Branch is behind base branch");
        } else if (mergeState === "BLOCKED") {
          blockers.push("Merge is blocked by branch protection");
        } else if (mergeState === "UNSTABLE") {
          blockers.push("Required checks are failing");
        }

        // Draft
        if (data.isDraft) {
          blockers.push("PR is still a draft");
        }

        return {
          mergeable: blockers.length === 0,
          ciPassing,
          approved,
          noConflicts,
          blockers,
        };
      });
    },

    /**
     * Batch fetch PR data for multiple PRs using GraphQL.
     * This is an optimization for the orchestrator polling loop.
     *
     * Instead of making 3 separate API calls for each PR (getPRState,
     * getCISummary, getReviewDecision), we fetch all data for all PRs
     * in one GraphQL query using aliases.
     *
     * This reduces API calls from N×3 to 1 (or a few if batching needed).
     */
    async enrichSessionsPRBatch(
      prs: PRInfo[],
      observer?: BatchObserver,
      repos?: string[],
    ): Promise<Map<string, PREnrichmentData>> {
      if (observer) instanceObserver = observer;
      const batchResult = await enrichSessionsPRBatchImpl(prs, observer, repos);
      return batchResult.enrichment;
    },

    async preflight(context: PreflightContext): Promise<void> {
      // SCM is only exercised at spawn time when --claim-pr is set. Skip the
      // gh-auth check otherwise so spawns that don't touch PRs don't require
      // gh credentials. Lifecycle polling has its own auth handling.
      if (!context.intent.willClaimExistingPR) return;
      // Memoize across plugins: shares the "gh-cli-auth" cache key with
      // tracker-github so spawns that touch both only run gh --version + gh
      // auth status once total, not twice.
      await memoizeAsync("gh-cli-auth", async () => {
        try {
          await execFileAsync("gh", ["--version"]);
        } catch {
          throw new Error("GitHub CLI (gh) is not installed. Install it: https://cli.github.com/");
        }
        try {
          await execFileAsync("gh", ["auth", "status"]);
        } catch {
          throw new Error("GitHub CLI is not authenticated. Run: gh auth login");
        }
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin module export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "github",
  slot: "scm" as const,
  description: "SCM plugin: GitHub PRs, CI checks, reviews, merge readiness",
  version: "0.1.0",
};

export function create(): SCM {
  return createGitHubSCM();
}

export default { manifest, create } satisfies PluginModule<SCM>;
