/**
 * scm-github plugin — GitHub PRs, CI checks, reviews, merge readiness.
 *
 * Uses the `gh` CLI for all GitHub API interactions.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  CI_STATUS,
  type PluginModule,
  type SCM,
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
  type AutomatedComment,
  type MergeReadiness,
  type BatchPRStatus,
} from "@composio/ao-core";

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

async function gh(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("gh", args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    });
    return stdout.trim();
  } catch (err) {
    throw new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${(err as Error).message}`, {
      cause: err,
    });
  }
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

function createGitHubSCM(): SCM {
  return {
    name: "github",

    async detectPR(session: Session, project: ProjectConfig): Promise<PRInfo | null> {
      if (!session.branch) return null;

      const parts = project.repo.split("/");
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error(`Invalid repo format "${project.repo}", expected "owner/repo"`);
      }
      const [owner, repo] = parts;
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

        const pr = prs[0];
        return {
          number: pr.number,
          url: pr.url,
          title: pr.title,
          owner,
          repo,
          branch: pr.headRefName,
          baseBranch: pr.baseRefName,
          isDraft: pr.isDraft,
        };
      } catch {
        return null;
      }
    },

    async getPRState(pr: PRInfo): Promise<PRState> {
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
      const flag = method === "rebase" ? "--rebase" : method === "merge" ? "--merge" : "--squash";

      await gh(["pr", "merge", String(pr.number), "--repo", repoFlag(pr), flag, "--delete-branch"]);
    },

    async closePR(pr: PRInfo): Promise<void> {
      await gh(["pr", "close", String(pr.number), "--repo", repoFlag(pr)]);
    },

    async getCIChecks(pr: PRInfo): Promise<CICheck[]> {
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
          let status: CICheck["status"];
          const state = c.state?.toUpperCase();

          // gh pr checks returns state directly: SUCCESS, FAILURE, PENDING, QUEUED, etc.
          if (state === "PENDING" || state === "QUEUED") {
            status = "pending";
          } else if (state === "IN_PROGRESS") {
            status = "running";
          } else if (state === "SUCCESS") {
            status = "passed";
          } else if (
            state === "FAILURE" ||
            state === "TIMED_OUT" ||
            state === "CANCELLED" ||
            state === "ACTION_REQUIRED"
          ) {
            status = "failed";
          } else if (state === "SKIPPED" || state === "NEUTRAL") {
            status = "skipped";
          } else {
            // Unknown state on a check — fail closed for safety
            status = "failed";
          }

          return {
            name: c.name,
            status,
            url: c.link || undefined,
            conclusion: state || undefined, // Store original state for debugging
            startedAt: c.startedAt ? new Date(c.startedAt) : undefined,
            completedAt: c.completedAt ? new Date(c.completedAt) : undefined,
          };
        });
      } catch (err) {
        // Propagate so callers (getCISummary) can decide how to handle.
        // Do NOT silently return [] — that causes a fail-open where CI
        // appears healthy when we simply failed to fetch check status.
        throw new Error("Failed to fetch CI checks", { cause: err });
      }
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
    },

    async getPendingComments(pr: PRInfo): Promise<ReviewComment[]> {
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
              author: c.author?.login ?? "unknown",
              body: c.body,
              path: c.path || undefined,
              line: c.line ?? undefined,
              isResolved: t.isResolved,
              createdAt: parseDate(c.createdAt),
              url: c.url,
            };
          });
      } catch {
        return [];
      }
    },

    async getAutomatedComments(pr: PRInfo): Promise<AutomatedComment[]> {
      try {
        // Fetch all review comments with max page size (100 is GitHub's limit)
        const raw = await gh([
          "api",
          "-F",
          "per_page=100",
          `repos/${repoFlag(pr)}/pulls/${pr.number}/comments`,
        ]);

        const comments: Array<{
          id: number;
          user: { login: string };
          body: string;
          path: string;
          line: number | null;
          original_line: number | null;
          created_at: string;
          html_url: string;
        }> = JSON.parse(raw);

        return comments
          .filter((c) => BOT_AUTHORS.has(c.user?.login ?? ""))
          .map((c) => {
            // Determine severity from body content
            let severity: AutomatedComment["severity"] = "info";
            const bodyLower = c.body.toLowerCase();
            if (
              bodyLower.includes("error") ||
              bodyLower.includes("bug") ||
              bodyLower.includes("critical") ||
              bodyLower.includes("potential issue")
            ) {
              severity = "error";
            } else if (
              bodyLower.includes("warning") ||
              bodyLower.includes("suggest") ||
              bodyLower.includes("consider")
            ) {
              severity = "warning";
            }

            return {
              id: String(c.id),
              botName: c.user?.login ?? "unknown",
              body: c.body,
              path: c.path || undefined,
              line: c.line ?? c.original_line ?? undefined,
              severity,
              createdAt: parseDate(c.created_at),
              url: c.html_url,
            };
          });
      } catch {
        return [];
      }
    },

    async getMergeability(pr: PRInfo): Promise<MergeReadiness> {
      // GitHub returns mergeable=null for merged PRs, which is not useful.
      // We only skip checks for merged PRs. Closed PRs still need accurate status.
      const state = await this.getPRState(pr);
      if (state === "merged") {
        return {
          mergeable: true,
          ciPassing: true,
          approved: true,
          noConflicts: true,
          blockers: [],
        };
      }

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

      const ciStatus = await this.getCISummary(pr);
      const reviewDecision = parseReviewDecision(data.reviewDecision);
      return buildMergeReadiness(data, ciStatus, reviewDecision);
    },

    async getBatchPRStatus(prs: PRInfo[]): Promise<Map<number, BatchPRStatus>> {
      const results = new Map<number, BatchPRStatus>();
      if (prs.length === 0) return results;

      // Group PRs by owner/repo — typically all the same repo, but handle multiple
      const byRepo = new Map<string, PRInfo[]>();
      for (const pr of prs) {
        const key = `${pr.owner}/${pr.repo}`;
        let list = byRepo.get(key);
        if (!list) {
          list = [];
          byRepo.set(key, list);
        }
        list.push(pr);
      }

      // Build and execute one GraphQL query per repo
      for (const [, groupedPRs] of byRepo) {
        const owner = groupedPRs[0].owner;
        const repo = groupedPRs[0].repo;

        // Deduplicate by PR number (callers may pass the same PR multiple times)
        const repoPRs = [...new Map(groupedPRs.map((pr) => [pr.number, pr])).values()];

        // Build parameterized GraphQL query with aliased PR fragments.
        // Each PR number is passed as a typed variable ($pr0: Int!, $pr1: Int!)
        // rather than interpolated into the query string (per CLAUDE.md security rules).
        const varDecls = repoPRs.map((_, i) => `$pr${i}: Int!`).join(", ");
        const prFragments = repoPRs
          .map(
            (_, i) => `pr${i}: pullRequest(number: $pr${i}) {
          number
          state
          reviewDecision
          mergeable
          mergeStateStatus
          isDraft
          commits(last: 1) {
            nodes {
              commit {
                statusCheckRollup {
                  state
                }
              }
            }
          }
        }`,
          )
          .join("\n        ");

        const query = `query($owner: String!, $name: String!, ${varDecls}) {
      repository(owner: $owner, name: $name) {
        ${prFragments}
      }
    }`;

        // Build gh CLI args: -f for string vars, -F for typed (integer) vars
        const ghArgs = [
          "api",
          "graphql",
          "-f",
          `owner=${owner}`,
          "-f",
          `name=${repo}`,
          "-f",
          `query=${query}`,
        ];
        for (let i = 0; i < repoPRs.length; i++) {
          ghArgs.push("-F", `pr${i}=${repoPRs[i].number}`);
        }

        try {
          const raw = await gh(ghArgs);

          const data: {
            data: { repository: Record<string, BatchPRNode> };
          } = JSON.parse(raw);

          const repoData = data.data.repository;

          for (let i = 0; i < repoPRs.length; i++) {
            const prData = repoData[`pr${i}`];
            if (!prData) continue;

            const prState = parsePRState(prData.state);
            const ciStatus = parseCIState(prData.commits);
            const reviewDecision = parseReviewDecision(prData.reviewDecision);
            const mergeability = buildMergeReadiness(prData, ciStatus, reviewDecision);

            results.set(prData.number, {
              state: prState,
              ciStatus,
              reviewDecision,
              mergeability,
            });
          }
        } catch {
          // Query failed for this repo — callers will fall back to individual calls
        }
      }

      return results;
    },
  };
}

// ---------------------------------------------------------------------------
// Batch query helpers
// ---------------------------------------------------------------------------

/** Shape of a single PR node in the batched GraphQL response. */
interface BatchPRNode {
  number: number;
  state: string;
  reviewDecision: string | null;
  mergeable: string;
  mergeStateStatus: string;
  isDraft: boolean;
  commits: {
    nodes: Array<{
      commit: {
        statusCheckRollup: { state: string } | null;
      };
    }>;
  };
}

function parsePRState(state: string): PRState {
  const s = state.toUpperCase();
  if (s === "MERGED") return "merged";
  if (s === "CLOSED") return "closed";
  return "open";
}

function parseCIState(commits: BatchPRNode["commits"]): CIStatus {
  const lastCommit = commits.nodes[0];
  if (!lastCommit) return "none";
  const rollup = lastCommit.commit.statusCheckRollup;
  if (!rollup) return "none";

  const s = rollup.state.toUpperCase();
  if (s === "SUCCESS") return "passing";
  if (s === "FAILURE" || s === "ERROR") return "failing";
  if (s === "PENDING" || s === "EXPECTED") return "pending";
  return "none";
}

function parseReviewDecision(decision: string | null): ReviewDecision {
  const d = (decision ?? "").toUpperCase();
  if (d === "APPROVED") return "approved";
  if (d === "CHANGES_REQUESTED") return "changes_requested";
  if (d === "REVIEW_REQUIRED") return "pending";
  return "none";
}

function buildMergeReadiness(
  prData: {
    mergeable: string;
    mergeStateStatus: string;
    isDraft: boolean;
  },
  ciStatus: CIStatus,
  reviewDecision: ReviewDecision,
): MergeReadiness {
  const blockers: string[] = [];

  const ciPassing = ciStatus === CI_STATUS.PASSING || ciStatus === CI_STATUS.NONE;
  if (!ciPassing) {
    blockers.push(`CI is ${ciStatus}`);
  }

  const approved = reviewDecision === "approved";
  if (reviewDecision === "changes_requested") {
    blockers.push("Changes requested in review");
  } else if (reviewDecision === "pending") {
    blockers.push("Review required");
  }

  const mergeable = (prData.mergeable ?? "").toUpperCase();
  const mergeState = (prData.mergeStateStatus ?? "").toUpperCase();
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

  if (prData.isDraft) {
    blockers.push("PR is still a draft");
  }

  return {
    mergeable: blockers.length === 0,
    ciPassing,
    approved,
    noConflicts,
    blockers,
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
