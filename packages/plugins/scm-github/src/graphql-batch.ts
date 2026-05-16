/**
 * GraphQL Batch PR Enrichment
 *
 * Efficiently fetches data for multiple PRs using GraphQL aliases.
 * Reduces API calls from N×3 to 1 (or a few if batching needed).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  execGhObserved,
  type BatchObserver,
  type CICheck,
  type CIStatus,
  type PREnrichmentData,
  type PRInfo,
  type PRState,
  type ReviewDecision,
} from "@aoagents/ao-core";
import { LRUCache } from "./lru-cache.js";

let execFileAsync = promisify(execFile);
let execGhAsync = async (args: string[], timeout: number, operation: string): Promise<string> =>
  execGhObserved(args, { component: "scm-github-batch", operation }, timeout);

/**
 * Set execFileAsync for testing.
 * Allows mocking the underlying execFile in unit tests.
 *
 * NOTE: This bypasses the gh tracer (execGhObserved). Tests that need to
 * verify tracer behavior should mock execGhObserved directly or use
 * setExecGhAsync instead.
 */
export function setExecFileAsync(fn: typeof execFileAsync): void {
  execFileAsync = fn;
  execGhAsync = async (args: string[], timeout: number): Promise<string> => {
    const { stdout } = await execFileAsync("gh", args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout,
    });
    return stdout.trim();
  };
}

/**
 * Set execGhAsync for testing — preserves tracer in the call chain.
 * Use this when testing code that should exercise the traced execution path.
 */
export function setExecGhAsync(
  fn: (args: string[], timeout: number, operation: string) => Promise<string>,
): void {
  execGhAsync = fn;
}

/**
 * Configuration constants for cache sizing.
 * LRU cache automatically evicts oldest entries when these limits are reached.
 */
const MAX_PR_LIST_ETAGS = 100;  // Number of repos to cache
const MAX_COMMIT_STATUS_ETAGS = 500;  // Number of commits to cache
const MAX_REVIEW_COMMENTS_ETAGS = 500;  // Number of PRs to cache review ETags
const MAX_PR_METADATA = 200;  // Number of PRs to cache full data

/**
 * ETag cache for REST API endpoints.
 * Used to avoid expensive GraphQL queries when nothing has changed.
 *
 * Keys:
 * - PR list: "prList:{owner}/{repo}"
 * - Commit status: "commit:{owner}/{repo}#{sha}"
 */
interface ETagCache {
  prList: LRUCache<string, string>; // Key: "owner/repo", Value: ETag
  commitStatus: LRUCache<string, string>; // Key: "owner/repo#sha", Value: ETag
  reviewComments: LRUCache<string, string>; // Key: "owner/repo#number", Value: ETag
}

/**
 * Global ETag cache instance.
 * This is shared across all batch enrichment calls within the process lifecycle.
 * The cache persists between polling cycles to avoid redundant REST/GraphQL calls.
 *
 * Uses LRU eviction to ensure bounded memory usage.
 */
const etagCache: ETagCache = {
  prList: new LRUCache(MAX_PR_LIST_ETAGS),
  commitStatus: new LRUCache(MAX_COMMIT_STATUS_ETAGS),
  reviewComments: new LRUCache(MAX_REVIEW_COMMENTS_ETAGS),
};

/**
 * Result of checking if PR data has changed via ETag guards.
 */
interface ETagGuardResult {
  shouldRefresh: boolean;
  details: string[];
  /** Repos where Guard 1 returned 304 — no PR list changes, detectPR can be skipped. */
  prListUnchangedRepos: Set<string>;
}

/** Result of enrichSessionsPRBatch including Guard 1 PR-discovery info. */
export interface BatchEnrichmentResult {
  enrichment: Map<string, PREnrichmentData>;
  /** Repos where Guard 1 returned 304 — safe to skip detectPR. */
  prListUnchangedRepos: Set<string>;
}

/**
 * Clear all ETag cache entries.
 * Useful for testing or when forcing a refresh.
 */
export function clearETagCache(): void {
  etagCache.prList.clear();
  etagCache.commitStatus.clear();
  etagCache.reviewComments.clear();
}

/**
 * Get PR list ETag for a repository.
 */
export function getPRListETag(owner: string, repo: string): string | undefined {
  return etagCache.prList.get(`${owner}/${repo}`);
}

/**
 * Get commit status ETag for a specific commit.
 */
export function getCommitStatusETag(
  owner: string,
  repo: string,
  sha: string,
): string | undefined {
  return etagCache.commitStatus.get(`${owner}/${repo}#${sha}`);
}

/**
 * Set PR list ETag for a repository.
 * Exported for testing.
 */
export function setPRListETag(owner: string, repo: string, etag: string): void {
  etagCache.prList.set(`${owner}/${repo}`, etag);
}

/**
 * Set commit status ETag for a specific commit.
 * Exported for testing.
 */
export function setCommitStatusETag(
  owner: string,
  repo: string,
  sha: string,
  etag: string,
): void {
  etagCache.commitStatus.set(`${owner}/${repo}#${sha}`, etag);
}

/**
 * Cache for PR metadata needed for ETag guard decisions.
 * Stores head SHA and CI status for each PR.
 * Key: "${owner}/${repo}#${number}"
 *
 * Uses LRU eviction to ensure bounded memory usage.
 */
const prMetadataCache = new LRUCache<
  string,
  { headSha: string | null; ciStatus: CIStatus }
>(MAX_PR_METADATA);

/**
 * Cache for full PR enrichment data.
 * Stores the complete PREnrichmentData object for each PR.
 * Used when ETag guard indicates no refresh is needed.
 * Key: "${owner}/${repo}#${number}"
 *
 * Uses LRU eviction to ensure bounded memory usage.
 */
const prEnrichmentDataCache = new LRUCache<string, PREnrichmentData>(MAX_PR_METADATA);

/**
 * Update PR metadata cache with latest enrichment data.
 * Called after successful GraphQL batch enrichment.
 */
function updatePRMetadataCache(
  prKey: string,
  enrichment: PREnrichmentData,
  headSha: string | null,
): void {
  prMetadataCache.set(prKey, {
    headSha,
    ciStatus: enrichment.ciStatus,
  });
  // Also cache the full enrichment data for ETag guard bypass
  prEnrichmentDataCache.set(prKey, enrichment);
}

/**
 * 2-Guard ETag Strategy: Check if PR enrichment cache needs refreshing.
 *
 * Before running expensive GraphQL batch queries, use two lightweight REST API
 * ETag checks to detect if anything actually changed:
 *
 * Guard 1: PR List ETag Check (per repo)
 *   - Detects: New commits, PR title/body edits, labels changes, reviews, PR state changes
 *   - Misses: CI status changes
 *
 * Guard 2: Commit Status ETag Check (per PR with cached metadata)
 *   - Checks ALL PRs with cached metadata and head SHA
 *   - Detects: CI check starts, passes, fails, or external status updates
 *   - Critical for catching CI transitions (failing -> passing, passing -> failing, etc.)
 *
 * @param prs - PRs to check
 * @returns true if GraphQL batch should run, false if nothing changed
 */
export async function shouldRefreshPREnrichment(
  prs: PRInfo[],
  extraRepos: string[] = [],
  observer?: BatchObserver,
): Promise<ETagGuardResult> {
  const details: string[] = [];
  let shouldRefresh = false;

  // Group PRs by repository for Guard 1 (PR list check)
  const repos = new Map<string, PRInfo[]>();

  for (const pr of prs) {
    const repoKey = `${pr.owner}/${pr.repo}`;
    if (!repos.has(repoKey)) {
      repos.set(repoKey, []);
    }
    const repoPrs = repos.get(repoKey);
    if (repoPrs) {
      repoPrs.push(pr);
    }
  }

  // Include repos from PR-less sessions so Guard 1 runs for them too
  for (const repoKey of extraRepos) {
    if (!repos.has(repoKey)) {
      repos.set(repoKey, []);
    }
  }

  if (repos.size === 0) {
    return { shouldRefresh: false, details: ["No repos to check"], prListUnchangedRepos: new Set() };
  }

  // Guard 1: Check PR list ETag for each repository
  let guard1DetectedChanges = false;
  const prListUnchangedRepos = new Set<string>();
  for (const [repoKey] of repos) {
    const [owner, repo] = repoKey.split("/");
    const prListChanged = await checkPRListETag(owner, repo, observer);
    if (prListChanged) {
      guard1DetectedChanges = true;
      shouldRefresh = true;
      details.push(`PR list changed for ${repoKey} (Guard 1)`);
    } else {
      prListUnchangedRepos.add(repoKey);
    }
  }

  // Guard 2: Check commit status ETag only when Guard 1 didn't detect changes
  // We check ALL PRs (not just pending) to catch CI status transitions:
  // - failing -> passing (PR becomes merge-ready)
  // - passing -> failing (PR becomes unmergeable)
  // - pending -> passing/failing (CI completes)
  // - passing -> pending (new CI run starts)
  //
  // Guard 2 is only needed when Guard 1 returns 304 (no PR list changes).
  // If Guard 1 detected changes, we're going to refresh all PRs anyway.
  if (!guard1DetectedChanges) {
    for (const pr of prs) {
      const prKey = `${pr.owner}/${pr.repo}#${pr.number}`;
      const cached = prMetadataCache.get(prKey);

      // Check for incomplete cache (cached but no headSha)
      // This happens when PR was cached but headSha wasn't captured
      // We need to refresh to get complete data including headSha
      if (cached && cached.headSha === null) {
        shouldRefresh = true;
        details.push(`First time seeing PR #${pr.number} (Guard 2: no cached head SHA)`);
        continue;
      }

      // Only check commit status ETag if we have cached data with a non-null head SHA
      if (!cached || !cached.headSha) {
        // No cached metadata - skip Guard 2. Since Guard 1 didn't detect changes
        // and we have no cached data, there's nothing to check.
        continue;
      }

      const statusChanged = await checkCommitStatusETag(
        pr.owner,
        pr.repo,
        cached.headSha,
        observer,
      );
      if (statusChanged) {
        shouldRefresh = true;
        details.push(
          `CI status changed for ${pr.owner}/${pr.repo}#${pr.number} (Guard 2)`,
        );
      }
    }
  }

  return { shouldRefresh, details, prListUnchangedRepos };
}

/**
 * Get cached PR metadata for testing.
 */
export function getPRMetadataCache(): Map<
  string,
  { headSha: string | null; ciStatus: CIStatus }
> {
  return prMetadataCache.toMap();
}

/**
 * Get cached PR enrichment data for testing.
 */
export function getPREnrichmentDataCache(): Map<string, PREnrichmentData> {
  return prEnrichmentDataCache.toMap();
}

/**
 * Set PR metadata for testing.
 */
export function setPRMetadata(
  key: string,
  metadata: { headSha: string | null; ciStatus: CIStatus },
): void {
  prMetadataCache.set(key, metadata);
}

/**
 * Clear PR metadata cache for testing.
 */
export function clearPRMetadataCache(): void {
  prMetadataCache.clear();
  prEnrichmentDataCache.clear();
}

/**
 * Interface for errors with cause property (ES2022+).
 * Used for better error tracking when cause is not available in older environments.
 */
interface ErrorWithCause extends Error {
  cause?: unknown;
}

/**
 * Pre-flight check to verify gh CLI is available and authenticated.
 * This prevents silent failures during GraphQL batch queries.
 */
async function verifyGhCLI(): Promise<void> {
  try {
    await execFileAsync("gh", ["--version"], { timeout: 5000 });
  } catch {
    const error = new Error(
      "gh CLI not available or not authenticated. GraphQL batch enrichment requires gh CLI to be installed and configured.",
    ) as ErrorWithCause;
    error.cause = "GH_CLI_UNAVAILABLE";
    throw error;
  }
}

/**
 * Maximum number of PRs to query in a single GraphQL batch.
 * GitHub has limits on query complexity and we stay well under this limit.
 */
export const MAX_BATCH_SIZE = 25;

/**
 * Check if an HTTP response contains a 304 Not Modified status.
 * Handles HTTP/1.1, HTTP/2, and HTTP/2.0 status lines.
 */
function is304(output: string): boolean {
  return /HTTP\/[\d.]+ 304/i.test(output);
}

/**
 * Extract stdout/stderr from an execFile error object.
 * gh cli puts the HTTP response in stdout even on exit code 1 (e.g. 304).
 */
function extractErrorOutput(err: unknown): string | null {
  const e = err as { stdout?: unknown; stderr?: unknown };
  const stdout = typeof e.stdout === "string" ? e.stdout : "";
  const stderr = typeof e.stderr === "string" ? e.stderr : "";
  const combined = stdout + stderr;
  return combined.length > 0 ? combined : null;
}

/**
 * Extract ETag from HTTP response output.
 * Used on both 200 and 304 paths — RFC 7232 allows servers to rotate
 * the validator on a 304, so we must re-read the ETag even when unchanged.
 */
function extractETag(output: string): string | undefined {
  const match = output.match(/etag:\s*(.+)/i);
  return match ? match[1].trim() : undefined;
}

/**
 * Guard 1: PR List ETag Check (per repo)
 *
 * Detects if PR metadata has changed in a repository using REST ETag.
 *
 * - Endpoint: GET /repos/{owner}/{repo}/pulls?state=open&sort=updated&direction=desc
 * - Detects: New commits, PR title/body edits, label changes, reviews, PR state changes
 * - Misses: CI status changes (handled by Guard 2)
 *
 * @returns true if PR list has changed (200 OK), false if unchanged (304 Not Modified)
 */
async function checkPRListETag(
  owner: string,
  repo: string,
  observer?: BatchObserver,
): Promise<boolean> {
  const repoKey = `${owner}/${repo}`;
  const cachedETag = etagCache.prList.get(repoKey);

  // Build gh CLI args for REST API call
  const url = `repos/${repoKey}/pulls?state=open&sort=updated&direction=desc&per_page=1`;
  const args = ["api", "--method", "GET", url, "-i"]; // -i includes headers

  // Add If-None-Match header if we have a cached ETag
  if (cachedETag) {
    args.push("-H", `If-None-Match: ${cachedETag}`);
  }

  try {
    const output = await execGhAsync(args, 10_000, "gh.api.guard-pr-list");

    // Check for HTTP 304 Not Modified response
    if (is304(output)) {
      // Re-read ETag on 304 — RFC 7232 allows rotated validators
      const rotatedETag = extractETag(output);
      if (rotatedETag) setPRListETag(owner, repo, rotatedETag);
      return false;
    }

    // Extract new ETag from response headers
    const newETag = extractETag(output);
    if (newETag) {
      setPRListETag(owner, repo, newETag);
    }

    // PR list changed - cost: 1 REST point
    return true;
  } catch (err) {
    // gh exits code 1 on 304 Not Modified — check stdout/stderr for the status line
    const output = extractErrorOutput(err);
    if (output && is304(output)) {
      const rotatedETag = extractETag(output);
      if (rotatedETag) setPRListETag(owner, repo, rotatedETag);
      return false;
    }

    const errorMsg = err instanceof Error ? err.message : String(err);
    // HTTP 304 may surface as an error message without stdout/stderr (e.g. gh cli versions
    // that don't populate stdout on non-zero exit). Use is304() anchored to the HTTP status
    // line to avoid false positives from URL paths like "pulls/304/comments".
    if (is304(errorMsg)) {
      return false;
    }
    observer?.log("warn", `[ETag Guard 1] PR list check failed for ${repoKey}: ${errorMsg}`);
    return true; // Assume changed to be safe
  }
}

/**
 * Guard 2: Check-Runs ETag Check (per PR with cached head SHA)
 *
 * Detects if CI status has changed for a specific commit using REST ETag.
 *
 * - Endpoint: GET /repos/{owner}/{repo}/commits/{head_sha}/check-runs
 *   Uses the check-runs endpoint (not legacy /status) because the batch
 *   query reads `statusCheckRollup` which aggregates check-runs. Pure-Actions
 *   repos only update check-runs, not the legacy combined-status endpoint.
 * - Detects: CI check starts, passes, fails, or external status updates
 *
 * @returns true if CI status has changed (200 OK), false if unchanged (304 Not Modified)
 */
async function checkCommitStatusETag(
  owner: string,
  repo: string,
  sha: string,
  observer?: BatchObserver,
): Promise<boolean> {
  const commitKey = `${owner}/${repo}#${sha}`;
  const cachedETag = etagCache.commitStatus.get(commitKey);

  // Use check-runs endpoint (not legacy /status) to match statusCheckRollup
  // data source. per_page=1 keeps the response small — we only need the ETag.
  const url = `repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=1`;
  const args = ["api", "--method", "GET", url, "-i"]; // -i includes headers

  // Add If-None-Match header if we have a cached ETag
  if (cachedETag) {
    args.push("-H", `If-None-Match: ${cachedETag}`);
  }

  try {
    const output = await execGhAsync(args, 10_000, "gh.api.guard-commit-status");

    // Check for HTTP 304 Not Modified response
    if (is304(output)) {
      const rotatedETag = extractETag(output);
      if (rotatedETag) setCommitStatusETag(owner, repo, sha, rotatedETag);
      return false;
    }

    // Extract new ETag from response headers
    const newETag = extractETag(output);
    if (newETag) {
      setCommitStatusETag(owner, repo, sha, newETag);
    }

    // CI status changed - cost: 1 REST point
    return true;
  } catch (err) {
    // gh exits code 1 on 304 Not Modified — check stdout/stderr for the status line
    const output = extractErrorOutput(err);
    if (output && is304(output)) {
      const rotatedETag = extractETag(output);
      if (rotatedETag) setCommitStatusETag(owner, repo, sha, rotatedETag);
      return false;
    }

    const errorMsg = err instanceof Error ? err.message : String(err);
    if (is304(errorMsg)) {
      return false;
    }
    observer?.log("warn", `[ETag Guard 2] Commit status check failed for ${commitKey}: ${errorMsg}`);
    return true; // Assume changed to be safe
  }
}

/**
 * Guard 3: Review Comments ETag Check (per PR)
 *
 * Detects if inline review comments have changed on a PR.
 * Used to gate the getReviewThreads GraphQL call — if no new comments
 * exist (304), the cached result is reused without a GraphQL call.
 *
 * - Endpoint: GET /repos/{owner}/{repo}/pulls/{number}/comments
 *   No per_page limit — the ETag covers the full resource. With per_page=1,
 *   the ETag only covers the first page, so new comments on page 2+ would
 *   never bust the validator. Typical PR comment counts are small (<100)
 *   so the unbounded list is fine.
 * - Detects: New review comments, edited comments, deleted comments
 * - Cost: 0 REST points on 304, 1 REST point on 200
 */
export async function checkReviewCommentsETag(
  owner: string,
  repo: string,
  prNumber: number,
  observer?: BatchObserver,
): Promise<boolean> {
  const cacheKey = `${owner}/${repo}#${prNumber}`;
  const cachedETag = etagCache.reviewComments.get(cacheKey);

  const url = `repos/${owner}/${repo}/pulls/${prNumber}/comments`;
  const args = ["api", "--method", "GET", url, "-i"];

  if (cachedETag) {
    args.push("-H", `If-None-Match: ${cachedETag}`);
  }

  try {
    const output = await execGhAsync(args, 10_000, "gh.api.guard-review-comments");

    if (is304(output)) {
      const rotatedETag = extractETag(output);
      if (rotatedETag) etagCache.reviewComments.set(cacheKey, rotatedETag);
      return false;
    }

    const newETag = extractETag(output);
    if (newETag) {
      etagCache.reviewComments.set(cacheKey, newETag);
    }

    return true;
  } catch (err) {
    const output = extractErrorOutput(err);
    if (output && is304(output)) {
      const rotatedETag = extractETag(output);
      if (rotatedETag) etagCache.reviewComments.set(cacheKey, rotatedETag);
      return false;
    }

    const errorMsg = err instanceof Error ? err.message : String(err);
    if (is304(errorMsg)) {
      return false;
    }
    observer?.log("warn", `[ETag Guard 3] Review comments check failed for ${cacheKey}: ${errorMsg}`);
    return true; // Assume changed to be safe
  }
}

/**
 * GraphQL fields to fetch for each PR.
 * This includes all data needed for orchestrator status detection.
 * Includes head SHA for ETag Guard 2 (commit status checks).
 */
const PR_FIELDS = `
  title
  state
  additions
  deletions
  isDraft
  mergeable
  mergeStateStatus
  reviewDecision
  headRefName
  headRefOid
  commits(last: 1) {
    nodes {
      commit {
        statusCheckRollup {
          state
          # 11 keeps per-PR node cost under budget for 25-PR batch queries
          # (total cost ≤5000). Repos with >11 checks lose individual check
          # visibility, but the rollup "state" still reflects all checks —
          # overall pass/fail detection remains correct.
          contexts(first: 11) {
            nodes {
              ... on CheckRun {
                name
                status
                conclusion
                detailsUrl
              }
              ... on StatusContext {
                context
                state
                targetUrl
              }
            }
            pageInfo {
              hasNextPage
            }
          }
        }
      }
    }
  }
`;

/**
 * Generate a GraphQL batch query for multiple PRs using aliases.
 *
 * Each PR gets a unique alias (pr0, pr1, pr2...) and the query
 * fetches the same fields for each PR.
 */
export function generateBatchQuery(prs: PRInfo[]): {
  query: string;
  variables: Record<string, unknown>;
} {
  // Handle empty array - return empty query to be handled by caller
  if (prs.length === 0) {
    return {
      query: "",
      variables: {},
    };
  }

  const selections: string[] = [];
  const variables: Record<string, unknown> = {};

  prs.forEach((pr, i) => {
    const alias = `pr${i}`;
    // Using inline fragments to handle nullable repository type
    selections.push(`
      ${alias}: repository(owner: $${alias}Owner, name: $${alias}Name) {
        ... on Repository {
          pullRequest(number: $${alias}Number) { ${PR_FIELDS} }
        }
      }
    `);
    variables[`${alias}Owner`] = pr.owner;
    variables[`${alias}Name`] = pr.repo;
    variables[`${alias}Number`] = pr.number;
  });

  const variableDefs = Object.entries(variables)
    .map(([key, value]) => `$${key}: ${typeof value === "number" ? "Int!" : "String!"}`)
    .join(", ");

  return {
    query: `query BatchPRs(${variableDefs}) {
      ${selections.join("\n")}
      rateLimit { cost remaining resetAt }
    }`,
    variables,
  };
}

/**
 * Execute a GraphQL batch query using the gh CLI.
 *
 * @throws Error if the query fails with GraphQL errors or parsing issues.
 */
async function executeBatchQuery(
  prs: PRInfo[],
): Promise<Record<string, unknown>> {
  const { query, variables } = generateBatchQuery(prs);

  // Handle empty array - no query needed
  if (!query || prs.length === 0) {
    return {};
  }

  // Pre-flight check to verify gh CLI is available
  await verifyGhCLI();

  // Build gh CLI arguments with variables
  const varArgs: string[] = [];
  for (const [key, value] of Object.entries(variables)) {
    if (typeof value === "string") {
      varArgs.push("-f", `${key}=${value}`);
    } else {
      varArgs.push("-F", `${key}=${value}`);
    }
  }

  const args = ["api", "graphql", "-i", ...varArgs, "-f", `query=${query}`];

  // Scale timeout based on batch size to prevent large batches from timing out
  // Base: 30s, +2s per PR beyond first 10
  const batchSize = prs.length;
  const adaptiveTimeout = 30_000 + Math.max(0, (batchSize - 10) * 2000);

  const stdout = await execGhAsync(args, adaptiveTimeout, "gh.api.graphql-batch");

  // With -i, stdout contains HTTP headers + blank line + JSON body.
  // Split at first blank line to get the JSON body for parsing.
  // The tracer (execGhObserved) already parses the headers for its trace row.
  const blankLineIdx = stdout.indexOf("\r\n\r\n");
  const altBlankLineIdx = stdout.indexOf("\n\n");
  const splitIdx =
    blankLineIdx >= 0 && (altBlankLineIdx < 0 || blankLineIdx < altBlankLineIdx)
      ? blankLineIdx + 4
      : altBlankLineIdx >= 0
        ? altBlankLineIdx + 2
        : 0;
  const body = splitIdx > 0 ? stdout.slice(splitIdx) : stdout;

  const result: {
    data?: Record<string, unknown>;
    errors?: Array<{ message: string; path?: string[] }>;
  } = JSON.parse(body.trim());

  // Check for GraphQL errors and throw to allow individual API fallback
  if (result.errors && result.errors.length > 0) {
    const errorMsg = result.errors.map((e) => e.message).join("; ");
    throw new Error(`GraphQL query errors: ${errorMsg}`);
  }

  return (result.data ?? {}) as Record<string, unknown>;
}

/**
 * Parse individual CI check contexts from statusCheckRollup.contexts.nodes.
 * Handles both CheckRun (GitHub Actions) and StatusContext (legacy status checks).
 */
function parseCheckContexts(contexts: unknown): CICheck[] {
  if (!contexts || typeof contexts !== "object") return [];

  const nodes = (contexts as Record<string, unknown>)["nodes"];
  if (!Array.isArray(nodes)) return [];

  const checks: CICheck[] = [];
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const n = node as Record<string, unknown>;

    // CheckRun node (GitHub Actions)
    if (typeof n["name"] === "string" && typeof n["status"] === "string") {
      const rawStatus = (n["status"] as string).toUpperCase();
      // Uppercase conclusion to match REST getCIChecks/getCIChecksFromStatusRollup format
      // so fingerprints are consistent regardless of which data source is used.
      const rawConclusion =
        typeof n["conclusion"] === "string" ? (n["conclusion"] as string).toUpperCase() : null;

      let status: CICheck["status"];
      if (rawStatus === "COMPLETED") {
        if (rawConclusion === "SUCCESS") {
          status = "passed";
        } else if (
          rawConclusion === "SKIPPED" ||
          rawConclusion === "NEUTRAL" ||
          rawConclusion === "STALE" ||
          rawConclusion === "NOT_REQUIRED" ||
          rawConclusion === "NONE"
        ) {
          // Mirror mapRawCheckStateToStatus() in the REST path: all non-failure
          // terminal conclusions that are not SUCCESS map to "skipped".
          status = "skipped";
        } else if (
          rawConclusion === "FAILURE" ||
          rawConclusion === "TIMED_OUT" ||
          rawConclusion === "CANCELLED" ||
          rawConclusion === "ACTION_REQUIRED" ||
          rawConclusion === "ERROR"
        ) {
          // Explicit failure conclusions — mirrors the failure list in mapRawCheckStateToStatus()
          status = "failed";
        } else {
          // STARTUP_FAILURE and any other unrecognized conclusion → "skipped",
          // matching mapRawCheckStateToStatus()'s default return "skipped" in the REST path.
          status = "skipped";
        }
      } else if (rawStatus === "IN_PROGRESS") {
        // Only IN_PROGRESS maps to "running" — matches mapRawCheckStateToStatus() in REST path
        status = "running";
      } else {
        // QUEUED, WAITING, and any other non-COMPLETED status → "pending"
        // (REST path maps QUEUED/WAITING to "pending", not "running")
        status = "pending";
      }

      checks.push({
        name: n["name"] as string,
        status,
        // Store the uppercased conclusion to match REST format
        conclusion: rawConclusion ?? undefined,
        url: typeof n["detailsUrl"] === "string" ? (n["detailsUrl"] as string) : undefined,
      });
      continue;
    }

    // StatusContext node (legacy commit statuses)
    if (typeof n["context"] === "string" && typeof n["state"] === "string") {
      const rawState = (n["state"] as string).toUpperCase();
      let status: CICheck["status"];
      if (rawState === "SUCCESS") {
        status = "passed";
      } else if (rawState === "FAILURE" || rawState === "ERROR") {
        status = "failed";
      } else {
        status = "pending";
      }

      // Set conclusion to match the REST getCIChecksFromStatusRollup format
      // (which sets conclusion = rawState.toUpperCase()) so fingerprints are
      // consistent regardless of which data source is used.
      checks.push({
        name: n["context"] as string,
        status,
        conclusion: rawState,
        url: typeof n["targetUrl"] === "string" ? (n["targetUrl"] as string) : undefined,
      });
    }
  }

  return checks;
}

/**
 * Parse raw CI state from status check rollup.
 *
 * Uses only the top-level aggregate state to determine overall CI status.
 * Individual check details are parsed separately via parseCheckContexts().
 */
function parseCIState(
  statusCheckRollup: unknown,
): CIStatus {
  if (!statusCheckRollup || typeof statusCheckRollup !== "object") {
    return "none";
  }

  const rollup = statusCheckRollup as Record<string, unknown>;
  const state = typeof rollup["state"] === "string" ? rollup["state"].toUpperCase() : "";

  // Map GitHub's statusCheckRollup.state to our CIStatus enum
  // This top-level state aggregates all individual checks and is
  // significantly cheaper than fetching contexts (10 points vs 50+ per PR)
  if (state === "SUCCESS") return "passing";
  if (state === "FAILURE") return "failing";
  if (state === "ERROR") return "failing";
  if (state === "PENDING" || state === "EXPECTED") return "pending";
  if (state === "TIMED_OUT" || state === "CANCELLED" || state === "ACTION_REQUIRED")
    return "failing";
  if (state === "QUEUED" || state === "IN_PROGRESS" || state === "WAITING")
    return "pending";

  return "none";
}

/**
 * Parse review decision from GraphQL response.
 */
function parseReviewDecision(reviewDecision: unknown): ReviewDecision {
  const decision = typeof reviewDecision === "string" ? reviewDecision.toUpperCase() : "";
  if (decision === "APPROVED") return "approved";
  if (decision === "CHANGES_REQUESTED") return "changes_requested";
  if (decision === "REVIEW_REQUIRED") return "pending";
  return "none";
}

/**
 * Parse PR state from GraphQL response.
 */
function parsePRState(state: unknown): PRState {
  const s = typeof state === "string" ? state.toUpperCase() : "";
  if (s === "MERGED") return "merged";
  if (s === "CLOSED") return "closed";
  return "open";
}

/**
 * Extract enrichment data from a single PR result.
 *
 * Returns the enrichment data along with the head SHA for ETag caching.
 */
function extractPREnrichment(
  pullRequest: unknown,
): { data: PREnrichmentData; headSha: string | null } | null {
  if (!pullRequest || typeof pullRequest !== "object") {
    return null;
  }

  const pr = pullRequest as Record<string, unknown>;

  // Check for at least one required field to validate this is a valid PR object
  if (
    pr["state"] === undefined &&
    pr["title"] === undefined &&
    pr["commits"] === undefined
  ) {
    return null;
  }

  const state = parsePRState(pr["state"]);

  // Extract basic info
  const title = typeof pr["title"] === "string" ? pr["title"] : undefined;
  const additions = typeof pr["additions"] === "number" ? pr["additions"] : 0;
  const deletions = typeof pr["deletions"] === "number" ? pr["deletions"] : 0;
  const isDraft = pr["isDraft"] === true;

  // Extract head SHA for ETag Guard 2
  const headSha =
    typeof pr["headRefOid"] === "string"
      ? pr["headRefOid"]
      : typeof pr["headSha"] === "string"
        ? pr["headSha"]
        : null;

  // Extract merge info
  const mergeable = pr["mergeable"];
  const mergeStateStatus =
    typeof pr["mergeStateStatus"] === "string"
      ? pr["mergeStateStatus"].toUpperCase()
      : "";
  const hasConflicts = mergeable === "CONFLICTING";
  const isBehind = mergeStateStatus === "BEHIND";

  // Extract review decision
  const reviewDecision = parseReviewDecision(pr["reviewDecision"]);

  // Extract CI status and individual checks from commits
  const commits = pr["commits"] as
    | { nodes?: Array<{ commit?: { statusCheckRollup?: Record<string, unknown> } }> }
    | undefined;
  const statusCheckRollup = commits?.nodes?.[0]?.commit?.statusCheckRollup;
  const ciStatus = statusCheckRollup ? parseCIState(statusCheckRollup) : "none";

  // Only include ciChecks when the list is complete (no truncation).
  // contexts(first: 20) silently truncates PRs with >20 checks — when truncated,
  // the failing check may be missing, so we set ciChecks to undefined to force
  // the getCIChecks() REST fallback in maybeDispatchCIFailureDetails.
  const contextsField = statusCheckRollup?.["contexts"] as
    | Record<string, unknown>
    | undefined;
  const pageInfo = contextsField?.["pageInfo"];
  const contextsHasNextPage =
    pageInfo !== null &&
    pageInfo !== undefined &&
    typeof pageInfo === "object" &&
    (pageInfo as Record<string, unknown>)["hasNextPage"] === true;
  const ciChecks =
    contextsField && !contextsHasNextPage
      ? parseCheckContexts(contextsField)
      : undefined;

  // Build blockers list
  const blockers: string[] = [];
  if (ciStatus === "failing") blockers.push("CI is failing");
  if (reviewDecision === "changes_requested")
    blockers.push("Changes requested in review");
  if (reviewDecision === "pending") blockers.push("Review required");
  if (hasConflicts) blockers.push("Merge conflicts");
  if (isBehind) blockers.push("Branch is behind base branch");
  if (isDraft) blockers.push("PR is still a draft");

  // Determine if mergeable based on all conditions
  // Merged/closed PRs are not considered mergeable for new changes
  const isMergeableState = state === "open";
  // Treat ciStatus "none" as passing (no CI checks configured), matching individual getMergeability
  const ciPassing = ciStatus === "passing" || ciStatus === "none";
  const mergeReady =
    isMergeableState &&
    ciPassing &&
    (reviewDecision === "approved" || reviewDecision === "none") &&
    !hasConflicts &&
    !isBehind &&
    !isDraft;

  const data: PREnrichmentData = {
    state,
    ciStatus,
    reviewDecision,
    mergeable: mergeReady,
    title,
    additions,
    deletions,
    isDraft,
    hasConflicts,
    isBehind,
    blockers,
    ...(ciChecks !== undefined ? { ciChecks } : {}),
  };

  return { data, headSha };
}

/**
 * Main batch enrichment function with 2-Guard ETag Strategy.
 *
 * Before running expensive GraphQL batch queries, uses two lightweight REST API
 * ETag checks to detect if anything actually changed:
 *
 * 1. Guard 1: PR List ETag Check (per repo)
 *    - Detects PR metadata changes (commits, reviews, labels, state)
 *    - Cost: 1 REST point if changed, 0 if unchanged (304)
 *
 * 2. Guard 2: Commit Status ETag Check (per PR with pending CI)
 *    - Detects CI status changes for PRs with pending CI
 *    - Cost: 1 REST point if changed, 0 if unchanged (304)
 *
 * If guards indicate no changes, skips GraphQL entirely (saves ~50 points per batch).
 * If any guard detects a change, runs GraphQL batch queries.
 *
 * Returns a Map keyed by "${owner}/${repo}#${number}" for efficient lookup.
 */
export async function enrichSessionsPRBatch(
  prs: PRInfo[],
  observer?: BatchObserver,
  repos: string[] = [],
): Promise<BatchEnrichmentResult> {
  const result = new Map<string, PREnrichmentData>();

  // Step 1: Check if we need to refresh using 2-Guard ETag Strategy
  // Guard 1 runs for all repos (including those with no PRs yet) so the
  // lifecycle manager knows whether detectPR can be skipped.
  const guardResult = await shouldRefreshPREnrichment(prs, repos, observer);

  // Report which repos had no PR list changes so the lifecycle can skip detectPR
  observer?.reportPRListUnchangedRepos?.(guardResult.prListUnchangedRepos);

  if (!guardResult.shouldRefresh) {
    // No changes detected - try to return cached data
    // If any PRs are missing from cache, we need to fetch them via GraphQL
    const missingPRs: PRInfo[] = [];

    for (const pr of prs) {
      const prKey = `${pr.owner}/${pr.repo}#${pr.number}`;
      const cachedData = prEnrichmentDataCache.get(prKey);
      if (cachedData) {
        result.set(prKey, cachedData);
      } else {
        missingPRs.push(pr);
      }
    }

    if (missingPRs.length === 0) {
      // All PRs cached - return cached data
      observer?.log(
        "info",
        `[ETag Guard] Skipping GraphQL batch - all ${result.size} PRs cached. Reasons: ${guardResult.details.join(", ")}`,
      );
      return { enrichment: result, prListUnchangedRepos: guardResult.prListUnchangedRepos };
    }

    // Some PRs not cached - fetch missing PRs via GraphQL
    observer?.log(
      "info",
      `[ETag Guard] Partial cache: ${result.size} cached, ${missingPRs.length} missing. Fetching missing PRs via GraphQL.`,
    );
    prs = missingPRs; // Update to only fetch missing PRs
    // Continue to GraphQL batch processing below
  }

  // Step 2: Split into batches if we have too many PRs
  const batches: PRInfo[][] = [];
  for (let i = 0; i < prs.length; i += MAX_BATCH_SIZE) {
    batches.push(prs.slice(i, i + MAX_BATCH_SIZE));
  }

  // Step 3: Execute each batch
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    const prCountBefore = result.size;
    const batchStartTime = Date.now();
    let batchDuration: number;

    try {
      const data = await executeBatchQuery(batch);
      batchDuration = Date.now() - batchStartTime;

      // Extract results for each PR in the batch
      batch.forEach((pr, index) => {
        const alias = `pr${index}`;
        const prKey = `${pr.owner}/${pr.repo}#${pr.number}`;
        const repositoryData = data[alias] as { pullRequest?: unknown } | undefined;

        if (repositoryData?.pullRequest) {
          const extracted = extractPREnrichment(repositoryData.pullRequest);
          if (extracted) {
            const { data: enrichment, headSha } = extracted;
            result.set(prKey, enrichment);
            // Update PR metadata cache for future ETag checks
            updatePRMetadataCache(prKey, enrichment, headSha);
          }
        } else {
          // PR not found (deleted/closed/permission issue)
          // Don't add to result or cache.
          // This allows lifecycle-manager to fall back to individual API calls
          // which can better handle permissions/edge cases.
          // The batch will succeed with fewer PRs, and missing PRs
          // will trigger the fallback path on the next poll.
        }
      });

      // Log observability metric for successful batch
      const prCountAfter = result.size;
      if (prCountAfter > prCountBefore) {
        const successData = {
          batchIndex,
          totalBatches: batches.length,
          prCount: prCountAfter - prCountBefore,
          durationMs: batchDuration,
        };
        observer?.recordSuccess(successData);
        observer?.log("info", `[GraphQL Batch Success] Batch ${batchIndex + 1}/${batches.length} succeeded: added ${prCountAfter - prCountBefore} PRs to cache (${batchDuration}ms)`);
      }
    } catch (err) {
      // Calculate duration even on failure
      batchDuration = Date.now() - batchStartTime;

      // Record failure for observability
      const errorMsg = err instanceof Error ? err.message : String(err);
      observer?.recordFailure({
        batchIndex,
        totalBatches: batches.length,
        prCount: batch.length,
        error: errorMsg,
        durationMs: batchDuration,
      });

      // Log error for observability but don't fail entirely
      observer?.log("error", `[GraphQL Batch] Batch enrichment partially failed: ${errorMsg}`);

      // Don't add placeholder entries to result or cache.
      // This allows lifecycle-manager to fall back to individual API calls
      // for PRs in the failed batch on the next poll.
      // Return only the partial results we successfully fetched.
      // Continue to next batch instead of throwing to allow partial success.

      // Continue with next batch
    }
  }

  return { enrichment: result, prListUnchangedRepos: guardResult.prListUnchangedRepos };
}

// Export internal functions for testing
export {
  parseCIState,
  parseReviewDecision,
  parsePRState,
  extractPREnrichment,
  checkPRListETag,
  checkCommitStatusETag,
  // shouldRefreshPREnrichment is already exported as async function
  updatePRMetadataCache,
};

// Export types for testing
export type { ETagCache, ETagGuardResult };
