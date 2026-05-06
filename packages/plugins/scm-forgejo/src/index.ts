/**
 * scm-forgejo plugin — Forgejo PRs, CI checks, reviews, merge readiness.
 *
 * Uses the `gh` CLI for all Forgejo API interactions.
 */

import { execFile } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
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
  type MergeReadiness,
  type PREnrichmentData,
  type BatchObserver,
} from "@aoagents/ao-core";
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

async function execCli(
  bin: ExecCommand,
  args: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(bin, args, {
      ...(cwd ? { cwd } : {}),
      ...(env ? { env } : {}),
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

async function ghExec(args: string[], hostname?: string): Promise<string> {
  const env = hostname ? { ...process.env, GH_HOST: hostname } : undefined;
  return execCli("gh", args, undefined, env);
}

async function ghExecInDir(args: string[], cwd: string, hostname?: string): Promise<string> {
  const env = hostname ? { ...process.env, GH_HOST: hostname } : undefined;
  return execCli("gh", args, cwd, env);
}

async function git(args: string[], cwd: string): Promise<string> {
  return execCli("git", args, cwd);
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

async function getCIChecksFromStatusRollup(
  pr: PRInfo,
  ghCli: (args: string[]) => Promise<string>,
): Promise<CICheck[]> {
  const raw = await ghCli([
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

function getForgejoWebhookConfig(project: ProjectConfig) {
  const webhook = project.scm?.webhook;
  return {
    enabled: webhook?.enabled !== false,
    path: webhook?.path ?? "/api/webhooks/forgejo",
    secretEnvVar: webhook?.secretEnvVar,
    // Forgejo sends X-Forgejo-Signature with a *raw* hex digest by default, and
    // X-Hub-Signature-256 with a `sha256=`-prefixed digest for GitHub-compat.
    // Default to the native header; deployments wiring GitHub-compat receivers
    // can override via project.scm.webhook.signatureHeader.
    signatureHeader: webhook?.signatureHeader ?? "x-forgejo-signature",
    eventHeader: webhook?.eventHeader ?? "x-forgejo-event",
    deliveryHeader: webhook?.deliveryHeader ?? "x-forgejo-delivery",
    maxBodyBytes: webhook?.maxBodyBytes,
  };
}

function verifyForgejoSignature(
  body: string | Uint8Array,
  secret: string,
  signatureHeader: string,
): boolean {
  // Accept both Forgejo-native (raw hex) and GitHub-compat (`sha256=hex`) digests.
  const provided = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice("sha256=".length)
    : signatureHeader;
  if (!provided || !/^[0-9a-f]+$/i.test(provided)) return false;

  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  const providedBuffer = Buffer.from(provided, "hex");
  if (expectedBuffer.length !== providedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, providedBuffer);
}

function parseForgejoRepository(payload: Record<string, unknown>) {
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

function parseForgejoWebhookEvent(
  request: SCMWebhookRequest,
  payload: Record<string, unknown>,
  config: ReturnType<typeof getForgejoWebhookConfig>,
): SCMWebhookEvent | null {
  const rawEventType = getWebhookHeader(request.headers, config.eventHeader);
  if (!rawEventType) return null;

  const deliveryId = getWebhookHeader(request.headers, config.deliveryHeader);
  const repository = parseForgejoRepository(payload);
  const action = typeof payload["action"] === "string" ? payload["action"] : rawEventType;

  if (rawEventType === "pull_request") {
    const pullRequest = payload["pull_request"];
    if (!pullRequest || typeof pullRequest !== "object") return null;
    const pr = pullRequest as Record<string, unknown>;
    const head = pr["head"] as Record<string, unknown> | undefined;
    return {
      provider: "forgejo",
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
      provider: "forgejo",
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
      provider: "forgejo",
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
      provider: "forgejo",
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
      provider: "forgejo",
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
      provider: "forgejo",
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
    provider: "forgejo",
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

function createForgejoSCM(config?: Record<string, unknown>): SCM {
  const hostname = typeof config?.host === "string" ? config.host : undefined;
  const token = resolveForgejoToken();
  const useRest = Boolean(hostname && token);
  const gh = (args: string[]) => ghExec(args, hostname);
  const ghInDir = (args: string[], cwd: string) => ghExecInDir(args, cwd, hostname);

  return {
    name: "forgejo",

    async verifyWebhook(
      request: SCMWebhookRequest,
      project: ProjectConfig,
    ): Promise<SCMWebhookVerificationResult> {
      const config = getForgejoWebhookConfig(project);
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

      if (!verifyForgejoSignature(request.rawBody ?? request.body, secret, signature)) {
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
      const config = getForgejoWebhookConfig(project);
      const payload = parseWebhookJsonObject(request.body);
      return parseForgejoWebhookEvent(request, payload, config);
    },

    async detectPR(session: Session, project: ProjectConfig): Promise<PRInfo | null> {
      if (!session.branch || !project.repo) return null;
      const projectRepo = project.repo;
      const [owner, repo] = parseProjectRepo(projectRepo);

      if (useRest && hostname && token) {
        try {
          const pulls = (await forgejoApi(
            hostname,
            token,
            "GET",
            `/repos/${owner}/${repo}/pulls`,
            {
              state: "open",
              limit: 50,
            },
          )) as Array<Record<string, unknown>>;

          const match = pulls.find((pr) => {
            const head = pr["head"] as Record<string, unknown> | undefined;
            return (head?.["ref"] as string | undefined) === session.branch;
          });

          if (!match) return null;

          return {
            number: Number(match["number"]),
            url: String(match["html_url"] ?? ""),
            title: String(match["title"] ?? ""),
            owner,
            repo,
            branch: String((match["head"] as Record<string, unknown> | undefined)?.["ref"] ?? ""),
            baseBranch: String((match["base"] as Record<string, unknown> | undefined)?.["ref"] ?? ""),
            isDraft: Boolean(match["draft"]),
          };
        } catch {
          return null;
        }
      }

      try {
        const raw = await gh([
          "pr",
          "list",
          "--repo",
          projectRepo,
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

        return prInfoFromView(prs[0], projectRepo);
      } catch {
        return null;
      }
    },

    async resolvePR(reference: string, project: ProjectConfig): Promise<PRInfo> {
      if (!project.repo) {
        throw new Error("Cannot resolve PR: project has no repo configured");
      }
      const projectRepo = project.repo;

      if (useRest && hostname && token) {
        const [owner, repo] = parseProjectRepo(projectRepo);
        const numberMatch = reference.match(/(\d+)$/);
        if (!numberMatch) {
          throw new Error(`Unsupported PR reference for Forgejo REST mode: ${reference}`);
        }
        const prNumber = Number(numberMatch[1]);
        const data = (await forgejoApi(
          hostname,
          token,
          "GET",
          `/repos/${owner}/${repo}/pulls/${prNumber}`,
        )) as Record<string, unknown>;

        return {
          number: Number(data["number"]),
          url: String(data["html_url"] ?? ""),
          title: String(data["title"] ?? ""),
          owner,
          repo,
          branch: String((data["head"] as Record<string, unknown> | undefined)?.["ref"] ?? ""),
          baseBranch: String((data["base"] as Record<string, unknown> | undefined)?.["ref"] ?? ""),
          isDraft: Boolean(data["draft"]),
        };
      }

      const raw = await gh([
        "pr",
        "view",
        reference,
        "--repo",
        projectRepo,
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

      return prInfoFromView(data, projectRepo);
    },

    async assignPRToCurrentUser(pr: PRInfo): Promise<void> {
      if (useRest && hostname && token) {
        const user = (await forgejoApi(hostname, token, "GET", "/user")) as Record<string, unknown>;
        const login = String(user["login"] ?? "");
        if (!login) throw new Error("Unable to determine current Forgejo user login");
        await forgejoApi(
          hostname,
          token,
          "POST",
          `/repos/${pr.owner}/${pr.repo}/issues/${pr.number}/assignees`,
          undefined,
          { assignees: [login] },
        );
        return;
      }

      await gh(["pr", "edit", String(pr.number), "--repo", repoFlag(pr), "--add-assignee", "@me"]);
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
      if (useRest && hostname && token) {
        const data = (await forgejoApi(
          hostname,
          token,
          "GET",
          `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`,
        )) as Record<string, unknown>;
        if (Boolean(data["merged"])) return "merged";
        const state = String(data["state"] ?? "").toUpperCase();
        if (state === "CLOSED") return "closed";
        return "open";
      }

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
    },

    async getPRSummary(pr: PRInfo) {
      if (useRest && hostname && token) {
        const data = (await forgejoApi(
          hostname,
          token,
          "GET",
          `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`,
        )) as Record<string, unknown>;
        const merged = Boolean(data["merged"]);
        const stateRaw = String(data["state"] ?? "").toUpperCase();
        const state: PRState = merged ? "merged" : stateRaw === "CLOSED" ? "closed" : "open";
        return {
          state,
          title: String(data["title"] ?? ""),
          additions: Number(data["additions"] ?? 0),
          deletions: Number(data["deletions"] ?? 0),
        };
      }

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
    },

    async mergePR(pr: PRInfo, method: MergeMethod = "squash"): Promise<void> {
      if (useRest && hostname && token) {
        const doMethod = method === "rebase" ? "rebase" : method === "merge" ? "merge" : "squash";
        await forgejoApi(
          hostname,
          token,
          "POST",
          `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/merge`,
          undefined,
          { Do: doMethod, do: doMethod },
        );
        return;
      }

      const flag = method === "rebase" ? "--rebase" : method === "merge" ? "--merge" : "--squash";

      await gh(["pr", "merge", String(pr.number), "--repo", repoFlag(pr), flag, "--delete-branch"]);
    },

    async closePR(pr: PRInfo): Promise<void> {
      if (useRest && hostname && token) {
        await forgejoApi(
          hostname,
          token,
          "PATCH",
          `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`,
          undefined,
          { state: "closed" },
        );
        return;
      }

      await gh(["pr", "close", String(pr.number), "--repo", repoFlag(pr)]);
    },

    async getCIChecks(pr: PRInfo): Promise<CICheck[]> {
      if (useRest && hostname && token) {
        const prData = (await forgejoApi(
          hostname,
          token,
          "GET",
          `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`,
        )) as Record<string, unknown>;
        const sha = String((prData["head"] as Record<string, unknown> | undefined)?.["sha"] ?? "");
        if (!sha) return [];

        const statusData = (await forgejoApi(
          hostname,
          token,
          "GET",
          `/repos/${pr.owner}/${pr.repo}/commits/${sha}/status`,
        )) as Record<string, unknown>;
        const statuses = Array.isArray(statusData["statuses"])
          ? (statusData["statuses"] as Array<Record<string, unknown>>)
          : [];

        return statuses.map((row) => {
          const rawState = String(row["state"] ?? "").toUpperCase();
          return {
            name: String(row["context"] ?? row["target_url"] ?? "status"),
            status: mapRawCheckStateToStatus(rawState),
            url: (row["target_url"] as string | undefined) || undefined,
            conclusion: rawState || undefined,
            startedAt: row["created_at"] ? new Date(String(row["created_at"])) : undefined,
            completedAt: row["updated_at"] ? new Date(String(row["updated_at"])) : undefined,
          } satisfies CICheck;
        });
      }

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
          return getCIChecksFromStatusRollup(pr, gh);
        }
        throw new Error("Failed to fetch CI checks", { cause: err });
      }
    },

    async getCISummary(pr: PRInfo): Promise<CIStatus> {
      let checks: CICheck[];
      try {
        checks = await this.getCIChecks(pr);
      } catch {
        // Before fail-closing, check if the PR is merged/closed —
        // Forgejo may not return check data for those, and reporting
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
      if (useRest && hostname && token) {
        const data = (await forgejoApi(
          hostname,
          token,
          "GET",
          `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`,
        )) as Array<Record<string, unknown>>;

        return data.map((r) => {
          const s = String(r["state"] ?? "").toUpperCase();
          let state: Review["state"];
          if (s === "APPROVED") state = "approved";
          else if (s === "CHANGES_REQUESTED") state = "changes_requested";
          else if (s === "DISMISSED") state = "dismissed";
          else if (s === "PENDING") state = "pending";
          else state = "commented";

          return {
            author: String((r["user"] as Record<string, unknown> | undefined)?.["login"] ?? "unknown"),
            state,
            body: (r["body"] as string | undefined) || undefined,
            submittedAt: parseDate((r["submitted_at"] as string | undefined) ?? null),
          };
        });
      }

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
    },

    async getReviewDecision(pr: PRInfo): Promise<ReviewDecision> {
      if (useRest && hostname && token) {
        const reviews = await this.getReviews(pr);
        const latestByAuthor = new Map<string, Review>();
        for (const review of reviews) {
          latestByAuthor.set(review.author, review);
        }
        const latest = Array.from(latestByAuthor.values());
        if (latest.some((r) => r.state === "changes_requested")) return "changes_requested";
        if (latest.some((r) => r.state === "approved")) return "approved";
        return latest.length > 0 ? "pending" : "none";
      }

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
      // PENDING and REVIEW_REQUIRED both mean "review still needed" — collapsing
      // PENDING into "none" let lifecycle treat reviewable PRs as no-review-required
      // and skip the review_pending status.
      if (d === "REVIEW_REQUIRED" || d === "PENDING") return "pending";
      return "none";
    },

    async getPendingComments(pr: PRInfo): Promise<ReviewComment[]> {
      try {
        if (useRest && hostname && token) {
          const perPage = 100;
          const comments: Array<{
            id: number;
            user: { login: string } | null;
            body: string;
            path: string | null;
            line: number | null;
            in_reply_to_id?: number | null;
            created_at: string;
            html_url: string;
          }> = [];

          for (let page = 1; ; page++) {
            const pageComments = (await forgejoApi(
              hostname,
              token,
              "GET",
              `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/comments`,
              { per_page: perPage, page },
            )) as Array<{
              id: number;
              user: { login: string } | null;
              body: string;
              path: string | null;
              line: number | null;
              in_reply_to_id?: number | null;
              created_at: string;
              html_url: string;
            }>;

            if (pageComments.length === 0) break;
            comments.push(...pageComments);
            if (pageComments.length < perPage) break;
          }

          return comments
            .filter((c) => !BOT_AUTHORS.has(c.user?.login ?? "") && c.in_reply_to_id == null)
            .map((c) => ({
              id: String(c.id),
              author: c.user?.login ?? "unknown",
              body: c.body,
              path: c.path || undefined,
              line: c.line ?? undefined,
              isResolved: false,
              createdAt: parseDate(c.created_at),
              url: c.html_url,
            }));
        }

        const perPage = 100;
        const comments: Array<{
          id: number;
          user: { login: string } | null;
          body: string;
          path: string | null;
          line: number | null;
          in_reply_to_id?: number | null;
          created_at: string;
          html_url: string;
        }> = [];

        for (let page = 1; ; page++) {
          const raw = await gh([
            "api",
            "--method",
            "GET",
            `repos/${repoFlag(pr)}/pulls/${pr.number}/comments?per_page=${perPage}&page=${page}`,
          ]);
          const pageComments: Array<{
            id: number;
            user: { login: string } | null;
            body: string;
            path: string | null;
            line: number | null;
            in_reply_to_id?: number | null;
            created_at: string;
            html_url: string;
          }> = JSON.parse(raw);

          if (pageComments.length === 0) {
            break;
          }

          comments.push(...pageComments);
          if (pageComments.length < perPage) {
            break;
          }
        }

        return comments
          .filter((c) => !BOT_AUTHORS.has(c.user?.login ?? "") && c.in_reply_to_id == null)
          .map((c) => ({
            id: String(c.id),
            author: c.user?.login ?? "unknown",
            body: c.body,
            path: c.path || undefined,
            line: c.line ?? undefined,
            isResolved: false,
            createdAt: parseDate(c.created_at),
            url: c.html_url,
          }));
      } catch (err) {
        throw new Error("Failed to fetch pending comments", { cause: err });
      }
    },

    async getMergeability(pr: PRInfo): Promise<MergeReadiness> {
      const blockers: string[] = [];

      // First, check if the PR is merged
      // Forgejo returns mergeable=null for merged PRs, which is not useful
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

      const data = useRest && hostname && token
        ? ((await forgejoApi(
            hostname,
            token,
            "GET",
            `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`,
          )) as Record<string, unknown>)
        : (JSON.parse(
            await gh([
              "pr",
              "view",
              String(pr.number),
              "--repo",
              repoFlag(pr),
              "--json",
              "mergeable,reviewDecision,mergeStateStatus,isDraft",
            ]),
          ) as Record<string, unknown>);

      // CI
      const ciStatus = await this.getCISummary(pr);
      const ciPassing = ciStatus === CI_STATUS.PASSING || ciStatus === CI_STATUS.NONE;
      if (!ciPassing) {
        blockers.push(`CI is ${ciStatus}`);
      }

      // Reviews
      const reviewDecision = useRest
        ? ((await this.getReviewDecision(pr)) as string).toUpperCase()
        : String(data["reviewDecision"] ?? "").toUpperCase();
      const approved = reviewDecision === "APPROVED";
      if (reviewDecision === "CHANGES_REQUESTED") {
        blockers.push("Changes requested in review");
      } else if (reviewDecision === "REVIEW_REQUIRED" || reviewDecision === "PENDING") {
        blockers.push("Review required");
      }

      // Conflicts / merge state
      const mergeableRaw = data["mergeable"];
      const mergeable =
        typeof mergeableRaw === "boolean"
          ? mergeableRaw
            ? "MERGEABLE"
            : "CONFLICTING"
          : String(mergeableRaw ?? "").toUpperCase();
      const mergeState = String(data["mergeStateStatus"] ?? "").toUpperCase();
      const noConflicts = mergeable === "MERGEABLE";
      if (mergeable === "CONFLICTING") {
        blockers.push("Merge conflicts");
      } else if (mergeable === "UNKNOWN" || mergeable === "") {
        blockers.push("Merge status unknown (Forgejo is computing)");
      }
      if (mergeState === "BEHIND") {
        blockers.push("Branch is behind base branch");
      } else if (mergeState === "BLOCKED") {
        blockers.push("Merge is blocked by branch protection");
      } else if (mergeState === "UNSTABLE") {
        blockers.push("Required checks are failing");
      }

      // Draft
      if (Boolean(data["isDraft"] ?? data["draft"])) {
        blockers.push("PR is still a draft");
      }

      return {
        mergeable: blockers.length === 0,
        ciPassing,
        approved,
        noConflicts,
        blockers,
      };
    },

    /**
     * Forgejo/Gitea does not provide GitHub-compatible GraphQL support.
     *
     * Return an empty map to signal "no batch data", allowing callers to
     * use the existing per-PR REST fallback path without noisy GraphQL errors.
     */
    async enrichSessionsPRBatch(
      _prs: PRInfo[],
      observer?: BatchObserver,
    ): Promise<Map<string, PREnrichmentData>> {
      observer?.log(
        "debug",
        "Forgejo SCM batch enrichment is disabled: GraphQL endpoint is not supported",
      );
      return new Map<string, PREnrichmentData>();
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin module export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "forgejo",
  slot: "scm" as const,
  description: "SCM plugin: Forgejo PRs, CI checks, reviews, merge readiness",
  version: "0.1.0",
};

export function create(config?: Record<string, unknown>): SCM {
  return createForgejoSCM(config);
}

export default { manifest, create } satisfies PluginModule<SCM>;
