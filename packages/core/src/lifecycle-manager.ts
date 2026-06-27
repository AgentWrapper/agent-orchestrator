/**
 * Lifecycle Manager — state machine + polling loop + reaction engine.
 *
 * Periodically polls all sessions and:
 * 1. Detects state transitions (spawning → working → pr_open → etc.)
 * 2. Emits events on transitions
 * 3. Triggers reactions (auto-handle CI failures, review comments, etc.)
 * 4. Escalates to human notification when auto-handling fails
 *
 * Reference: scripts/claude-session-status, scripts/claude-review-check
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { recordActivityEvent } from "./activity-events.js";
import { resolveRuntimeName } from "./runtime-resolution.js";
import { getOrchestratorSessionId } from "./orchestrator-session-strategy.js";
import {
  ACTIVITY_STATE,
  SESSION_STATUS,
  TERMINAL_STATUSES,
  type ActivityState,
  type LifecycleManager,
  type OpenCodeSessionManager,
  type SessionId,
  type SessionStatus,
  type EventType,
  type OrchestratorEvent,
  type OrchestratorConfig,
  type ReactionConfig,
  type ReactionResult,
  type PluginRegistry,
  type Runtime,
  type Agent,
  type SCM,
  type Notifier,
  type Session,
  type CanonicalSessionLifecycle,
  type EventPriority,
  type ProjectConfig as _ProjectConfig,
  type PREnrichmentData,
  type CICheck,
  type CIFailureSummary,
  type PRInfo,
  type ReviewComment,
  type ReviewSummary,
  type ProcessProbeResult,
  isProcessProbeIndeterminate,
} from "./types.js";
import {
  buildLifecycleMetadataPatch,
  cloneLifecycle,
  deriveLegacyStatus,
} from "./lifecycle-state.js";
import { updateMetadata } from "./metadata.js";
import { getProjectSessionsDir } from "./paths.js";
import { applyDecisionToLifecycle as commitLifecycleDecisionInPlace } from "./lifecycle-transition.js";
import {
  classifyActivitySignal,
  createActivitySignal,
  formatActivitySignalEvidence,
  hasPositiveIdleEvidence,
  isWeakActivityEvidence,
} from "./activity-signal.js";
import { isAgentReportFresh, mapAgentReportToLifecycle, readAgentReport } from "./agent-report.js";
import {
  auditAgentReports,
  getReactionKeyForTrigger,
  REPORT_WATCHER_METADATA_KEYS,
} from "./report-watcher.js";
import { createCorrelationId, createProjectObserver } from "./observability.js";
import { resolveNotifierTarget } from "./notifier-resolution.js";
import { recordNotificationDelivery } from "./notification-observability.js";
import { resolveSessionRole } from "./agent-selection.js";
import {
  DETECTING_MAX_ATTEMPTS,
  createDetectingDecision,
  isDetectingTimedOut,
  parseAttemptCount,
  resolvePREnrichmentDecision,
  resolvePRLiveDecision,
  resolveProbeDecision,
  type LifecycleDecision,
} from "./lifecycle-status-decisions.js";
import { dedupePrInfos } from "./utils/pr.js";
import {
  buildCIFailureNotificationData,
  buildPRStateNotificationData,
  buildReactionEscalationNotificationData,
  buildReactionNotificationData,
  buildSessionTransitionNotificationData,
  type NotificationEventContext,
} from "./notification-data.js";

const execFileAsync = promisify(execFile);

/** Parse a duration string like "10m", "30s", "1h" to milliseconds. */
function parseDuration(str: string): number {
  const match = str.match(/^(\d+)(s|m|h)$/);
  if (!match) return 0;
  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case "s":
      return value * 1000;
    case "m":
      return value * 60_000;
    case "h":
      return value * 3_600_000;
    default:
      return 0;
  }
}

/** Reaction keys for conditions that can oscillate (e.g. CI failing→pending→failing).
 *  Their trackers survive status exit so the escalation budget accumulates
 *  across oscillations instead of resetting to zero each time.
 *  Note: "merge-conflicts" is NOT here — statusToEventType never emits
 *  "merge.conflicts", so the transition handler at line ~1892 can't reach it.
 *  Merge-conflict tracker lifecycle is managed in maybeDispatchMergeConflicts. */
const PERSISTENT_REACTION_KEYS = new Set(["ci-failed"]);

/** Number of consecutive CI-passing polls required before the ci-failed tracker
 *  (including its escalated flag) is cleared, allowing a fresh budget for the
 *  next real CI failure incident. */
const CI_PASSING_STABLE_THRESHOLD = 2;

type TransitionReaction = {
  key: string;
  result: ReactionResult | null;
  messageEnriched?: boolean;
};

type WorkspaceBranchProbe =
  | { kind: "branch"; branch: string }
  | { kind: "detached" }
  | { kind: "unavailable" };

const TRANSIENT_DETACHED_GIT_MARKERS = [
  "rebase-merge",
  "rebase-apply",
  "CHERRY_PICK_HEAD",
  "BISECT_LOG",
] as const;

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function hasTransientDetachedGitState(gitDir: string): Promise<boolean> {
  const checks = await Promise.all(
    TRANSIENT_DETACHED_GIT_MARKERS.map((marker) => pathExists(join(gitDir, marker))),
  );
  return checks.some(Boolean);
}

async function resolveGitDir(workspacePath: string): Promise<string> {
  const dotGitPath = join(workspacePath, ".git");
  const dotGitStats = await stat(dotGitPath);
  if (dotGitStats.isDirectory()) return dotGitPath;

  const dotGitContent = (await readFile(dotGitPath, "utf8")).trim();
  const gitDirMatch = dotGitContent.match(/^gitdir:\s*(.+)$/i);
  if (!gitDirMatch) {
    throw new Error(`Invalid .git pointer in workspace: ${workspacePath}`);
  }

  return resolve(dirname(dotGitPath), gitDirMatch[1].trim());
}

async function readWorkspaceBranch(workspacePath: string): Promise<WorkspaceBranchProbe> {
  let gitDir: string;
  try {
    gitDir = await resolveGitDir(workspacePath);
  } catch {
    return { kind: "unavailable" };
  }

  try {
    const head = (await readFile(join(gitDir, "HEAD"), "utf8")).trim();
    const prefix = "ref: refs/heads/";
    if (!head.startsWith(prefix)) {
      return (await hasTransientDetachedGitState(gitDir))
        ? { kind: "unavailable" }
        : { kind: "detached" };
    }

    const branch = head.slice(prefix.length).trim();
    if (branch.length > 0) {
      return { kind: "branch", branch };
    }
    return (await hasTransientDetachedGitState(gitDir))
      ? { kind: "unavailable" }
      : { kind: "detached" };
  } catch {
    return { kind: "unavailable" };
  }
}

/** Infer a reasonable priority from event type. */
function inferPriority(type: EventType): EventPriority {
  if (type.includes("stuck") || type.includes("needs_input") || type.includes("errored")) {
    return "urgent";
  }
  if (type.startsWith("summary.")) {
    return "info";
  }
  if (
    type.includes("approved") ||
    type.includes("ready") ||
    type.includes("merged") ||
    type.includes("completed")
  ) {
    return "action";
  }
  if (type.includes("fail") || type.includes("changes_requested") || type.includes("conflicts")) {
    return "warning";
  }
  return "info";
}

/**
 * Notifier names forced into every dispatch via `AO_NOTIFIERS_ALLOW`
 * (comma-separated). Mirrors the same env the plugin registry uses to register
 * an allow-listed notifier in an otherwise-disabled daemon, so a native
 * front-end gets that notifier's events without rewriting notificationRouting.
 */
function forcedNotifierNames(): string[] {
  const v = process.env["AO_NOTIFIERS_ALLOW"];
  if (!v) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Create an OrchestratorEvent with defaults filled in. */
function createEvent(
  type: EventType,
  opts: {
    sessionId: SessionId;
    projectId: string;
    message: string;
    priority?: EventPriority;
    data?: Record<string, unknown>;
  },
): OrchestratorEvent {
  return {
    id: randomUUID(),
    type,
    priority: opts.priority ?? inferPriority(type),
    sessionId: opts.sessionId,
    projectId: opts.projectId,
    timestamp: new Date(),
    message: opts.message,
    data: opts.data ?? {},
  };
}

/** Determine which event type corresponds to a status transition. */
function statusToEventType(_from: SessionStatus | undefined, to: SessionStatus): EventType | null {
  switch (to) {
    case "working":
      return "session.working";
    case "pr_open":
      return "pr.created";
    case "ci_failed":
      return "ci.failing";
    case "review_pending":
      return "review.pending";
    case "changes_requested":
      return "review.changes_requested";
    case "approved":
      return "review.approved";
    case "mergeable":
      return "merge.ready";
    case "merged":
      return "merge.completed";
    case "needs_input":
      return "session.needs_input";
    case "stuck":
      return "session.stuck";
    case "errored":
      return "session.errored";
    case "killed":
      return "session.killed";
    default:
      return null;
  }
}

/**
 * Worker statuses that must reliably reach the orchestrator session: the worker
 * has finished (done/merged) or cannot proceed without attention (needs_input/
 * stuck/errored). The engine guarantees this signal so the orchestrator learns
 * about it even when the agent forgets to `ao send` a report itself.
 */
const ORCHESTRATOR_SIGNAL_STATUSES: ReadonlySet<SessionStatus> = new Set([
  SESSION_STATUS.NEEDS_INPUT,
  SESSION_STATUS.STUCK,
  SESSION_STATUS.ERRORED,
  SESSION_STATUS.DONE,
  SESSION_STATUS.MERGED,
]);

/** Human-readable line the engine sends to the orchestrator on a worker signal. */
function buildOrchestratorSignalMessage(session: Session, status: SessionStatus): string {
  const label = session.metadata["displayName"] || session.metadata["userPrompt"] || session.id;
  const detail =
    status === SESSION_STATUS.NEEDS_INPUT
      ? "needs input and is waiting"
      : status === SESSION_STATUS.STUCK
        ? "appears stuck"
        : status === SESSION_STATUS.ERRORED
          ? "hit an error"
          : status === SESSION_STATUS.MERGED
            ? "had its PR merged"
            : "finished its work";
  return (
    `[ao] Worker "${session.id}" (${label}) ${detail} (lifecycle: ${status}). ` +
    `It will not proceed on its own — review it and decide next steps. ` +
    `(automatic lifecycle signal)`
  );
}

/**
 * Best-effort read of a worktree's current branch + last commit, for the
 * worker-completion ping. Mirrors the lightweight `git -C <path> …` plumbing
 * `hasUncommittedNonInfraWork` already uses. Resolved with allSettled so a
 * missing/empty commit history still yields the branch. Any total failure (not
 * a repo, git missing, timeout) returns null so the caller still pings — just
 * without the commit detail.
 */
async function readWorktreeHead(
  worktreePath: string,
): Promise<{ branch: string; shortSha: string; subject: string } | null> {
  try {
    const [branchRes, logRes] = await Promise.allSettled([
      execFileAsync("git", ["-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"], {
        timeout: 10_000,
      }),
      // \x1f (unit separator) won't appear in a sha or a sane subject line.
      execFileAsync("git", ["-C", worktreePath, "log", "-1", "--format=%h%x1f%s"], {
        timeout: 10_000,
      }),
    ]);
    const branch = branchRes.status === "fulfilled" ? branchRes.value.stdout.trim() : "";
    if (logRes.status !== "fulfilled") {
      return branch ? { branch, shortSha: "", subject: "" } : null;
    }
    const [shortSha = "", subject = ""] = logRes.value.stdout.trim().split("\x1f");
    return { branch, shortSha, subject };
  } catch {
    return null;
  }
}

/**
 * One-line completion ping the engine sends to the orchestrator when a worker
 * finishes its turn with committed work but did not self-report. Machine- and
 * human-friendly: leads with the worker id + branch so the orchestrator can go
 * straight to reviewing it.
 */
function buildWorkerCompletionMessage(
  session: Session,
  git: { branch: string; shortSha: string; subject: string } | null,
): string {
  const title = session.metadata["displayName"] || session.metadata["userPrompt"] || session.id;
  const branch = git?.branch || session.branch || "(unknown)";
  const commit = git && git.shortSha ? `, last commit ${git.shortSha} "${git.subject}"` : "";
  return (
    `[auto] ${session.id} finished its turn — branch ${branch}${commit}. ` +
    `Title: ${title}. Review the branch; it did not self-report.`
  );
}

function prStateToEventType(
  from: Session["lifecycle"]["pr"]["state"],
  to: Session["lifecycle"]["pr"]["state"],
): EventType | null {
  if (from === to) return null;
  switch (to) {
    case "closed":
      return "pr.closed";
    default:
      return null;
  }
}

/** PR context for event enrichment. */
type EventContext = NotificationEventContext;

/**
 * Minimal session context required for reaction execution and event enrichment.
 * Used for system-level events (like all-complete) that don't have a real session.
 */
interface ReactionSessionContext {
  id: SessionId;
  projectId: string;
  pr: Session["pr"];
  issueId: string | null;
  branch: string | null;
  metadata: Record<string, string>;
  agentInfo: Session["agentInfo"];
}

/**
 * Build event context with PR and issue information for webhook payloads.
 * This enriches events with useful metadata so external consumers (Telegram, Discord, etc.)
 * can display meaningful information without making additional API calls.
 */
function buildEventContext(
  session: Session | ReactionSessionContext,
  prEnrichmentCache: Map<string, PREnrichmentData>,
): EventContext {
  const sessionPRs = dedupePrInfos(
    "prs" in session && Array.isArray(session.prs) ? session.prs : session.pr ? [session.pr] : [],
  );

  const prs: EventContext["prs"] = sessionPRs.map((p) => {
    const cached = prEnrichmentCache.get(`${p.owner}/${p.repo}#${p.number}`);
    return {
      url: p.url,
      title: cached?.title ?? null,
      number: p.number,
      branch: p.branch,
      baseBranch: p.baseBranch,
      owner: p.owner,
      repo: p.repo,
      isDraft: p.isDraft,
    };
  });

  const pr = prs[0] ?? null;

  return {
    pr,
    prs,
    issueId: session.issueId,
    issueTitle: session.metadata["issueTitle"] ?? null,
    summary: session.agentInfo?.summary ?? null,
    branch: session.branch,
  };
}

/** Map event type to reaction config key. */
function eventToReactionKey(eventType: EventType): string | null {
  switch (eventType) {
    case "pr.closed":
      return "pr-closed";
    case "ci.failing":
      return "ci-failed";
    case "review.changes_requested":
      return "changes-requested";
    case "automated_review.found":
      return "bugbot-comments";
    case "merge.conflicts":
      return "merge-conflicts";
    case "merge.ready":
      return "approved-and-green";
    case "session.stuck":
      return "agent-stuck";
    case "session.needs_input":
      return "agent-needs-input";
    case "session.killed":
      return "agent-exited";
    case "summary.all_complete":
      return "all-complete";
    default:
      return null;
  }
}

function transitionLogLevel(status: SessionStatus): "info" | "warn" | "error" {
  const eventType = statusToEventType(undefined, status);
  if (!eventType) {
    return "info";
  }
  const priority = inferPriority(eventType);
  if (priority === "urgent") {
    return "error";
  }
  if (priority === "warning") {
    return "warn";
  }
  return "info";
}

interface DeterminedStatus {
  status: SessionStatus;
  evidence: string;
  detectingAttempts: number;
  /** True when probes produced no reliable verdict and lifecycle metadata must remain untouched. */
  skipMetadataWrite?: boolean;
  /** ISO timestamp when detecting first started. */
  detectingStartedAt?: string;
  /** Hash of evidence for unchanged-evidence detection. */
  detectingEvidenceHash?: string;
}

interface ProbeResult {
  state: "alive" | "dead" | "unknown";
  failed: boolean;
  indeterminate?: boolean;
}

function processProbeResultToProbeResult(result: ProcessProbeResult): ProbeResult {
  if (isProcessProbeIndeterminate(result)) {
    return { state: "unknown", failed: false, indeterminate: true };
  }
  return { state: result ? "alive" : "dead", failed: false };
}

function splitEvidenceSignals(evidence: string): string[] {
  return evidence
    .split(/\s+/)
    .map((signal) => signal.trim())
    .filter((signal) => signal.length > 0);
}

function primaryLifecycleReason(lifecycle: CanonicalSessionLifecycle): string {
  if (lifecycle.session.state === "detecting") return lifecycle.session.reason;
  if (lifecycle.pr.reason !== "not_created" && lifecycle.pr.reason !== "in_progress") {
    return lifecycle.pr.reason;
  }
  if (lifecycle.runtime.reason !== "process_running") {
    return lifecycle.runtime.reason;
  }
  return lifecycle.session.reason;
}

function buildTransitionObservabilityData(
  previous: CanonicalSessionLifecycle,
  next: CanonicalSessionLifecycle,
  oldStatus: SessionStatus,
  newStatus: SessionStatus,
  evidence: string,
  detectingAttempts: number,
  statusTransition: boolean,
  reaction?: { key: string; result: ReactionResult | null },
): Record<string, unknown> {
  return {
    oldStatus,
    newStatus,
    statusTransition,
    previousSessionState: previous.session.state,
    newSessionState: next.session.state,
    previousSessionReason: previous.session.reason,
    newSessionReason: next.session.reason,
    previousPRState: previous.pr.state,
    newPRState: next.pr.state,
    previousPRReason: previous.pr.reason,
    newPRReason: next.pr.reason,
    previousRuntimeState: previous.runtime.state,
    newRuntimeState: next.runtime.state,
    previousRuntimeReason: previous.runtime.reason,
    newRuntimeReason: next.runtime.reason,
    primaryReason: primaryLifecycleReason(next),
    evidence,
    signalsConsulted: splitEvidenceSignals(evidence),
    detectingAttempts,
    recoveryAction: reaction?.result?.action ?? null,
    reactionKey: reaction?.key ?? null,
    reactionSuccess: reaction?.result?.success ?? null,
    escalated: reaction?.result?.escalated ?? null,
  };
}

export interface LifecycleManagerDeps {
  config: OrchestratorConfig;
  registry: PluginRegistry;
  sessionManager: OpenCodeSessionManager;
  /** When set, only poll sessions belonging to this project. */
  projectId?: string;
}

/** Track attempt counts for reactions per session. */
interface ReactionTracker {
  attempts: number;
  firstTriggered: Date;
  /** True after this reaction has escalated. Short-circuits further dispatches
   *  until the underlying condition resolves and the tracker is explicitly cleared. */
  escalated?: boolean;
}

/** Create a LifecycleManager instance. */
export function createLifecycleManager(deps: LifecycleManagerDeps): LifecycleManager {
  const { config, registry, sessionManager, projectId: scopedProjectId } = deps;
  const observer = createProjectObserver(config, "lifecycle-manager");

  const states = new Map<SessionId, SessionStatus>();
  const activityStateCache = new Map<string, ActivityState>(); // sessionId → last observed activity
  const reactionTrackers = new Map<string, ReactionTracker>(); // "sessionId:reactionKey"
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let polling = false; // re-entrancy guard
  let allCompleteEmitted = false; // guard against repeated all_complete
  let startupReconcilePending = true; // emit a one-time orphan reconcile on the first poll
  const branchAdoptionReservations = new Map<string, SessionId>();

  /**
   * Cache for PR enrichment data within a single poll cycle.
   * Cleared at the start of each pollAll() call.
   * Key format: "${owner}/${repo}#${number}"
   */
  const prEnrichmentCache = new Map<string, PREnrichmentData>();

  function normalizeSessionPRs(session: Session): PRInfo[] {
    const candidatePRs = session.prs.length > 0 ? session.prs : session.pr ? [session.pr] : [];
    const uniquePRs = dedupePrInfos(candidatePRs);
    if (uniquePRs.length !== session.prs.length || session.pr !== (uniquePRs[0] ?? null)) {
      session.prs = uniquePRs;
      session.pr = uniquePRs[0] ?? null;
    }
    return uniquePRs;
  }

  function indexedPRMetadataCleanup(
    session: Session,
    prCount: number,
  ): Partial<Record<string, string>> {
    const updates: Partial<Record<string, string>> = {};
    for (const key of Object.keys(session.metadata)) {
      const match = key.match(/^(prEnrichment|prReviewComments)_(\d+)$/);
      if (!match) continue;
      const index = Number.parseInt(match[2], 10);
      if (Number.isNaN(index) || index >= prCount) {
        updates[key] = "";
      }
    }
    return updates;
  }

  function getPREnrichmentForSession(
    session: Session | ReactionSessionContext,
  ): PREnrichmentData | undefined {
    if (!session.pr) return undefined;
    return prEnrichmentCache.get(`${session.pr.owner}/${session.pr.repo}#${session.pr.number}`);
  }

  /** Repos where Guard 1 returned 304 in the current poll — safe to skip detectPR. */
  let prListUnchangedRepos = new Set<string>();

  /**
   * Per-session timestamp of last review backlog API check.
   * Used to throttle review thread checks to at most once per 2 minutes.
   * In-memory only — resets on restart (acceptable since it's a rate-limit hint, not state).
   */
  const lastReviewBacklogCheckAt = new Map<SessionId, number>();

  /** Throttle interval for review backlog API calls (2 minutes). */
  const REVIEW_BACKLOG_THROTTLE_MS = 2 * 60 * 1000;

  /**
   * Populate the PR enrichment cache using batch GraphQL queries.
   * This is called once per poll cycle to fetch data for all PRs efficiently.
   */
  async function populatePREnrichmentCache(sessions: Session[]): Promise<void> {
    // Clear previous cache
    prEnrichmentCache.clear();
    prListUnchangedRepos = new Set();

    // Collect all unique PRs and repos keyed by their owning session's project/plugin.
    // Repos are collected from ALL sessions (not just ones with PRs) so Guard 1 runs
    // for every active repo — enabling detectPR gating even when no PRs exist yet.
    const prsByPlugin = new Map<string, Array<NonNullable<Session["pr"]>>>();
    const reposByPlugin = new Map<string, Set<string>>();
    const seenPRKeys = new Set<string>();
    for (const session of sessions) {
      const project = config.projects[session.projectId];
      if (!project?.scm?.plugin || !project.repo) continue;

      const pluginKey = project.scm.plugin;
      if (!prsByPlugin.has(pluginKey)) {
        prsByPlugin.set(pluginKey, []);
      }
      if (!reposByPlugin.has(pluginKey)) {
        reposByPlugin.set(pluginKey, new Set());
      }
      reposByPlugin.get(pluginKey)!.add(project.repo);
      const sessionPRs = normalizeSessionPRs(session);
      if (sessionPRs.length === 0) continue;
      // Loop over all PRs in the session — supports multi-repo sessions
      // where an agent opened PRs on multiple repos.
      for (const pr of sessionPRs) {
        const actualPRRepo = `${pr.owner}/${pr.repo}`;
        if (actualPRRepo !== project.repo) {
          reposByPlugin.get(pluginKey)!.add(actualPRRepo);
        }
        const prKey = `${pr.owner}/${pr.repo}#${pr.number}`;
        if (seenPRKeys.has(prKey)) continue;
        seenPRKeys.add(prKey);
        const pluginPRs = prsByPlugin.get(pluginKey);
        if (pluginPRs) {
          pluginPRs.push(pr);
        }
      }
    }

    // Fetch enrichment data and run Guard 1 for all active repos
    for (const [pluginKey, pluginPRs] of prsByPlugin) {
      const scm = registry.get<SCM>("scm", pluginKey);
      if (!scm?.enrichSessionsPRBatch) continue;

      const pluginRepos = [...(reposByPlugin.get(pluginKey) ?? [])];
      const batchStartTime = Date.now();
      try {
        const enrichmentData = await scm.enrichSessionsPRBatch(
          pluginPRs,
          {
            recordSuccess(_data) {
              const batchDuration = Date.now() - batchStartTime;
              observer?.recordOperation({
                metric: "graphql_batch",
                operation: "batch_enrichment",
                correlationId: createCorrelationId("graphql-batch"),
                outcome: "success",
                projectId: scopedProjectId,
                durationMs: batchDuration,
                data: {
                  plugin: pluginKey,
                  prCount: pluginPRs.length,
                  prKeys: pluginPRs.map((pr) => `${pr.owner}/${pr.repo}#${pr.number}`),
                },
                level: "info",
              });
            },
            recordFailure(data) {
              const batchDuration = Date.now() - batchStartTime;
              observer?.recordOperation({
                metric: "graphql_batch",
                operation: "batch_enrichment",
                correlationId: createCorrelationId("graphql-batch"),
                outcome: "failure",
                reason: data.error,
                level: "warn",
                data: {
                  plugin: pluginKey,
                  prCount: pluginPRs.length,
                  error: data.error,
                  durationMs: batchDuration,
                },
              });
            },
            log(level, message) {
              observer?.recordDiagnostic?.({
                operation: "batch_enrichment.log",
                correlationId: createCorrelationId("graphql-batch"),
                projectId: scopedProjectId,
                message,
                level,
                data: {
                  plugin: pluginKey,
                  source: "ao-graphql-batch",
                },
              });
            },
            reportPRListUnchangedRepos(repos) {
              for (const repo of repos) {
                prListUnchangedRepos.add(repo);
              }
            },
          },
          pluginRepos,
        );

        // Merge into cache
        for (const [key, data] of enrichmentData) {
          prEnrichmentCache.set(key, data);
        }
      } catch (err) {
        // Batch fetch failed - individual calls will still work
        const errorMsg = err instanceof Error ? err.message : String(err);
        const batchCorrelationId = createCorrelationId("batch-enrichment");
        observer?.recordOperation?.({
          metric: "lifecycle_poll",
          operation: "batch_enrichment",
          correlationId: batchCorrelationId,
          outcome: "failure",
          reason: errorMsg,
          level: "warn",
          data: { plugin: pluginKey, prCount: pluginPRs.length },
        });
        recordActivityEvent({
          // Tag with scopedProjectId when the lifecycle worker is project-scoped
          // so `ao events list --project <id>` surfaces this failure. Unscoped
          // (multi-project) supervisors leave projectId null because the batch
          // crosses project boundaries — RCA there should query without --project.
          projectId: scopedProjectId,
          source: "scm",
          kind: "scm.batch_enrich_failed",
          level: "warn",
          summary: `batch_enrich failed for ${pluginPRs.length} PR(s)`,
          data: {
            plugin: pluginKey,
            prCount: pluginPRs.length,
            errorMessage: errorMsg,
          },
        });
      }
    }

    // Discover PRs for sessions that don't have one yet.
    // Only run detectPR when Guard 1 returned 200 (repo's PR list changed).
    // When Guard 1 returned 304, the repo is in prListUnchangedRepos — no new PRs exist.
    for (const session of sessions) {
      if (!session.branch) continue;
      if (
        session.metadata["prAutoDetect"] === "off" ||
        session.metadata["prAutoDetect"] === "false"
      )
        continue;
      if (session.metadata["role"] === "orchestrator" || session.id.endsWith("-orchestrator"))
        continue;
      // Skip detectPR only if we already have a PR on the configured project repo.
      // This allows detecting additional PRs on different repos (multi-repo support).
      const sessionPRs = normalizeSessionPRs(session);
      const trackedRepos = new Set(sessionPRs.map((p) => `${p.owner}/${p.repo}`));
      const projectRepoForDetect = config.projects[session.projectId]?.repo;
      // primaryPR.branch is always the session branch (metadata doesn't store per-PR branches),
      // so use the lifecycle closed-state alone to allow re-detection after a PR is rejected.
      const primaryPRIsClosed = session.lifecycle.pr.state === "closed";
      if (
        sessionPRs.length > 0 &&
        projectRepoForDetect &&
        trackedRepos.has(projectRepoForDetect) &&
        !primaryPRIsClosed
      ) {
        continue;
      }

      const project = config.projects[session.projectId];
      if (!project?.repo || !project.scm?.plugin) continue;

      // Skip if Guard 1 confirmed no PR list changes for this repo
      if (prListUnchangedRepos.has(project.repo)) continue;

      const scm = registry.get<SCM>("scm", project.scm.plugin);
      if (!scm?.detectPR) continue;

      try {
        const detectedPR = await scm.detectPR(session, project);
        if (detectedPR) {
          // Track by owner/repo/number — allows multiple PRs on the same repo
          // in the same session (e.g. agent opens PR #10 and PR #11 both on acme/main-app).
          // Only skip if we already have this exact PR number on this exact repo.
          // If the existing PR on the same repo is closed, replace it with the new one.
          const alreadyTracked = sessionPRs.some(
            (p) =>
              p.owner === detectedPR.owner &&
              p.repo === detectedPR.repo &&
              p.number === detectedPR.number
          );
          if (!alreadyTracked) {
            // Remove any closed PRs on the same repo before adding the new one.
            // Open PRs on the same repo are kept — multiple open PRs per repo are valid.
            session.prs = session.prs
              .filter(
                (p) =>
                  !(
                    p.owner === detectedPR.owner &&
                    p.repo === detectedPR.repo &&
                    p.number !== detectedPR.number &&
                    prEnrichmentCache.get(`${p.owner}/${p.repo}#${p.number}`)?.state === "closed"
                  )
              )
              .concat(detectedPR);
          }
          session.prs = dedupePrInfos(session.prs);
          // pr is always the primary (first) PR
          session.pr = session.prs[0] ?? detectedPR;
          const sessionsDir = getProjectSessionsDir(session.projectId);
          const allPrUrls = [...new Set(session.prs.map((p) => p.url))].join(",");
          updateMetadata(sessionsDir, session.id, {
            pr: session.pr.url,
            prs: allPrUrls,
          });
          recordActivityEvent({
            projectId: session.projectId,
            sessionId: session.id,
            source: "scm",
            kind: "scm.detect_pr_succeeded",
            summary: `PR #${detectedPR.number} detected`,
            data: {
              plugin: project.scm.plugin,
              prNumber: detectedPR.number,
              prUrl: detectedPR.url,
              prOwner: detectedPR.owner,
              prRepo: detectedPR.repo,
            },
          });
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        observer?.recordOperation?.({
          metric: "lifecycle_poll",
          operation: "scm.detect_pr",
          outcome: "failure",
          correlationId: createCorrelationId("detect-pr"),
          projectId: session.projectId,
          sessionId: session.id,
          reason: errorMsg,
          level: "warn",
        });
        recordActivityEvent({
          projectId: session.projectId,
          sessionId: session.id,
          source: "scm",
          kind: "scm.detect_pr_failed",
          level: "warn",
          summary: `detect_pr failed for ${session.id}`,
          data: {
            plugin: project.scm.plugin,
            errorMessage: errorMsg,
          },
        });
      }
    }
  }

  /**
   * Persist batch enrichment data to session metadata files.
   * The web dashboard reads this instead of calling GitHub API.
   */
  function persistPREnrichmentToMetadata(sessions: Session[]): void {
    for (const session of sessions) {
      const sessionPRs = normalizeSessionPRs(session);
      if (!session.pr) continue;
      const project = config.projects[session.projectId];
      if (!project) continue;
      const sessionsDir = getProjectSessionsDir(session.projectId);
      const cleanupUpdates = indexedPRMetadataCleanup(session, sessionPRs.length);
      if (Object.keys(cleanupUpdates).length > 0) {
        updateMetadata(sessionsDir, session.id, cleanupUpdates);
        session.metadata = Object.fromEntries(
          Object.entries(session.metadata).filter(([key]) => cleanupUpdates[key] === undefined),
        );
      }

      const prKey = `${session.pr.owner}/${session.pr.repo}#${session.pr.number}`;
      const cached = prEnrichmentCache.get(prKey);
      if (cached) {
        const blob = JSON.stringify({
          state: cached.state,
          ciStatus: cached.ciStatus,
          reviewDecision: cached.reviewDecision,
          mergeable: cached.mergeable,
          title: cached.title,
          additions: cached.additions,
          deletions: cached.deletions,
          isDraft: cached.isDraft,
          hasConflicts: cached.hasConflicts,
          isBehind: cached.isBehind,
          blockers: cached.blockers,
          ciChecks: cached.ciChecks?.map((c) => ({
            name: c.name,
            status: c.status,
            url: c.url,
          })),
          enrichedAt: new Date().toISOString(),
        });
        if (session.metadata["prEnrichment"] !== blob) {
          updateMetadata(sessionsDir, session.id, { prEnrichment: blob });
          session.metadata["prEnrichment"] = blob;
        }
        // Keep in-memory isDraft in sync with enrichment data
        if (cached.isDraft !== undefined && session.pr) {
          session.pr.isDraft = cached.isDraft;
        }
      }

      for (let i = 1; i < sessionPRs.length; i++) {
        const secondaryPR = sessionPRs[i];
        if (!secondaryPR) continue;
        const secondaryKey = `${secondaryPR.owner}/${secondaryPR.repo}#${secondaryPR.number}`;
        const secondaryCached = prEnrichmentCache.get(secondaryKey);
        if (!secondaryCached) continue;
        const secondaryBlob = JSON.stringify({
          state: secondaryCached.state,
          ciStatus: secondaryCached.ciStatus,
          reviewDecision: secondaryCached.reviewDecision,
          mergeable: secondaryCached.mergeable,
          title: secondaryCached.title,
          additions: secondaryCached.additions,
          deletions: secondaryCached.deletions,
          isDraft: secondaryCached.isDraft,
          hasConflicts: secondaryCached.hasConflicts,
          isBehind: secondaryCached.isBehind,
          blockers: secondaryCached.blockers,
          ciChecks: secondaryCached.ciChecks?.map((c) => ({
            name: c.name,
            status: c.status,
            url: c.url,
          })),
          enrichedAt: new Date().toISOString(),
        });
        const metaKey = `prEnrichment_${i}`;
        if (session.metadata[metaKey] !== secondaryBlob) {
          updateMetadata(sessionsDir, session.id, { [metaKey]: secondaryBlob });
          session.metadata[metaKey] = secondaryBlob;
        }
        // Keep in-memory isDraft in sync with enrichment data
        if (secondaryCached.isDraft !== undefined) {
          secondaryPR.isDraft = secondaryCached.isDraft;
        }
      }
    }
  }

  /** Check if idle time exceeds the agent-stuck threshold. */
  function isIdleBeyondThreshold(session: Session, idleTimestamp: Date): boolean {
    const stuckReaction = getReactionConfigForSession(session, "agent-stuck");
    const thresholdStr = stuckReaction?.threshold;
    if (typeof thresholdStr !== "string") return false;
    const stuckThresholdMs = parseDuration(thresholdStr);
    if (stuckThresholdMs <= 0) return false;
    const idleMs = Date.now() - idleTimestamp.getTime();
    return idleMs > stuckThresholdMs;
  }

  function isBranchOwnedByAnotherActiveWorker(
    session: Session,
    branch: string,
    siblingSessions: Session[],
    allSessionPrefixes: string[],
  ): boolean {
    return siblingSessions.some((other) => {
      if (other.id === session.id) return false;
      if (other.projectId !== session.projectId) return false;
      if (TERMINAL_STATUSES.has(other.status)) return false;

      const otherProject = config.projects[other.projectId];
      if (!otherProject) return false;

      const otherRole = resolveSessionRole(
        other.id,
        other.metadata,
        otherProject.sessionPrefix,
        allSessionPrefixes,
      );
      return otherRole === "worker" && other.branch === branch;
    });
  }

  function acquireBranchAdoptionReservation(session: Session, branch: string): string | null {
    const reservationKey = `${session.projectId}:${branch}`;
    const existingOwner = branchAdoptionReservations.get(reservationKey);
    if (existingOwner && existingOwner !== session.id) {
      return null;
    }
    branchAdoptionReservations.set(reservationKey, session.id);
    return reservationKey;
  }

  function releaseBranchAdoptionReservation(reservationKey: string, sessionId: SessionId): void {
    if (branchAdoptionReservations.get(reservationKey) === sessionId) {
      branchAdoptionReservations.delete(reservationKey);
    }
  }

  async function refreshTrackedBranch(
    session: Session,
    siblingSessions?: Session[],
  ): Promise<void> {
    const project = config.projects[session.projectId];
    if (!project) return;

    const allSessionPrefixes = Object.values(config.projects).map((p) => p.sessionPrefix);
    const sessionRole = resolveSessionRole(
      session.id,
      session.metadata,
      project.sessionPrefix,
      allSessionPrefixes,
    );
    const workspacePath = session.workspacePath;
    const canRefreshTrackedBranch =
      sessionRole === "worker" &&
      workspacePath !== null &&
      (!session.pr || session.lifecycle.pr.state === "closed");

    if (!canRefreshTrackedBranch) return;

    const branchProbe = await readWorkspaceBranch(workspacePath);
    if (branchProbe.kind === "detached") {
      if (session.branch !== null) {
        session.branch = null;
        updateSessionMetadata(session, { branch: "" });
      }
      return;
    }

    if (branchProbe.kind !== "branch" || branchProbe.branch === session.branch) {
      return;
    }

    const reservationKey = acquireBranchAdoptionReservation(session, branchProbe.branch);
    if (!reservationKey) return;

    try {
      const sessionsForConflictCheck =
        siblingSessions ?? (await sessionManager.list(session.projectId));
      if (
        !isBranchOwnedByAnotherActiveWorker(
          session,
          branchProbe.branch,
          sessionsForConflictCheck,
          allSessionPrefixes,
        )
      ) {
        session.branch = branchProbe.branch;
        updateSessionMetadata(session, { branch: branchProbe.branch });
      }
    } finally {
      releaseBranchAdoptionReservation(reservationKey, session.id);
    }
  }

  /** Determine current status for a session by polling plugins. */
  async function determineStatus(session: Session): Promise<DeterminedStatus> {
    const project = config.projects[session.projectId];
    if (!project) {
      return {
        status: session.status,
        evidence: "project_missing",
        detectingAttempts: parseAttemptCount(session.metadata["detectingAttempts"]),
      };
    }

    const lifecycle = cloneLifecycle(session.lifecycle);
    const nowIso = new Date().toISOString();
    const agentName = session.metadata["agent"];
    const agent = agentName ? registry.get<Agent>("agent", agentName) : null;
    const scm = project.scm?.plugin ? registry.get<SCM>("scm", project.scm.plugin) : null;
    let detectedIdleTimestamp: Date | null = null;
    let idleWasBlocked = false;
    const canProbeRuntimeIdentity = session.status !== SESSION_STATUS.SPAWNING;
    const currentDetectingAttempts = parseAttemptCount(session.metadata["detectingAttempts"]);
    const currentDetectingStartedAt = session.metadata["detectingStartedAt"] || undefined;
    const currentDetectingEvidenceHash = session.metadata["detectingEvidenceHash"] || undefined;

    const commit = (
      decision: LifecycleDecision = {
        status: deriveLegacyStatus(lifecycle),
        evidence: "lifecycle_commit",
        detecting: { attempts: currentDetectingAttempts },
      },
    ): DeterminedStatus => {
      commitLifecycleDecisionInPlace(lifecycle, decision, nowIso);
      session.lifecycle = lifecycle;
      session.status = decision.status;
      session.activitySignal = activitySignal;
      return {
        status: decision.status,
        evidence: decision.evidence,
        detectingAttempts: decision.detecting.attempts,
        detectingStartedAt: decision.detecting.startedAt,
        detectingEvidenceHash: decision.detecting.evidenceHash,
      };
    };

    let runtimeProbe: ProbeResult = { state: "unknown", failed: false };
    // The sdk streaming runtime owns the host process directly — runtime.isAlive
    // (socket || PID || fresh event log) is the authoritative liveness signal, and
    // there is no separate agent-CLI process to probe. Used below to stop an
    // unreliable process probe from declaring a live host exited/dead.
    const isStreamingRuntime = session.runtimeHandle?.runtimeName === "sdk";
    if (session.runtimeHandle && canProbeRuntimeIdentity) {
      const runtime = registry.get<Runtime>("runtime", resolveRuntimeName(project, config, agentName));
      if (runtime) {
        try {
          const alive = await runtime.isAlive(session.runtimeHandle);
          lifecycle.runtime.lastObservedAt = nowIso;
          runtimeProbe = { state: alive ? "alive" : "dead", failed: false };
          if (alive) {
            lifecycle.runtime.state = "alive";
            lifecycle.runtime.reason = "process_running";
          } else {
            lifecycle.runtime.state = "missing";
            lifecycle.runtime.reason =
              session.runtimeHandle.runtimeName === "tmux" ? "tmux_missing" : "process_missing";
          }
        } catch (err) {
          lifecycle.runtime.state = "probe_failed";
          lifecycle.runtime.reason = "probe_error";
          lifecycle.runtime.lastObservedAt = nowIso;
          runtimeProbe = { state: "unknown", failed: true };
          recordActivityEvent({
            projectId: session.projectId,
            sessionId: session.id,
            source: "runtime",
            kind: "runtime.probe_failed",
            level: "warn",
            summary: `runtime.isAlive probe failed for ${session.id}`,
            data: {
              runtimeName: session.runtimeHandle.runtimeName,
              errorMessage: err instanceof Error ? err.message : String(err),
            },
          });
        }
      }
    }

    let activitySignal = createActivitySignal("unavailable");
    let processProbe: ProbeResult = { state: "unknown", failed: false };
    let activityEvidence = formatActivitySignalEvidence(activitySignal);

    if (agent && (session.runtimeHandle || session.workspacePath)) {
      try {
        if (
          agent.recordActivity &&
          session.workspacePath &&
          session.runtimeHandle &&
          canProbeRuntimeIdentity
        ) {
          try {
            const runtime = registry.get<Runtime>(
              "runtime",
              resolveRuntimeName(project, config, agentName),
            );
            const terminalOutput = runtime
              ? await runtime.getOutput(session.runtimeHandle, 10)
              : "";
            if (terminalOutput) {
              await agent.recordActivity(session, terminalOutput);
            }
          } catch (error) {
            observer?.recordOperation?.({
              metric: "lifecycle_poll",
              operation: "activity.record",
              outcome: "failure",
              correlationId: createCorrelationId("lifecycle-poll"),
              projectId: session.projectId,
              sessionId: session.id,
              reason: error instanceof Error ? error.message : String(error),
              level: "warn",
            });
          }
        }

        const detectedActivity = await agent.getActivityState(session, config.readyThresholdMs);
        if (detectedActivity) {
          activitySignal = classifyActivitySignal(detectedActivity, "native");
          activityEvidence = formatActivitySignalEvidence(activitySignal);
          lifecycle.runtime.lastObservedAt = nowIso;
          const prevActivity = activityStateCache.get(session.id);
          activityStateCache.set(session.id, detectedActivity.state);
          if (prevActivity !== undefined && prevActivity !== detectedActivity.state) {
            recordActivityEvent({
              projectId: session.projectId,
              sessionId: session.id,
              source: "lifecycle",
              kind: "activity.transition",
              summary: `${prevActivity} → ${detectedActivity.state}`,
              data: { from: prevActivity, to: detectedActivity.state },
            });
          }
          if (lifecycle.runtime.state !== "missing" && lifecycle.runtime.state !== "probe_failed") {
            lifecycle.runtime.state = "alive";
            lifecycle.runtime.reason = "process_running";
          }
          if (detectedActivity.state === "waiting_input") {
            return commit({
              status: SESSION_STATUS.NEEDS_INPUT,
              evidence: activityEvidence,
              detecting: { attempts: 0 },
              sessionState: "needs_input",
              sessionReason: "awaiting_user_input",
            });
          }
          if (detectedActivity.state === "exited" && canProbeRuntimeIdentity) {
            processProbe = { state: "dead", failed: false };
            lifecycle.runtime.state = "exited";
            lifecycle.runtime.reason = "process_missing";
          }

          if (hasPositiveIdleEvidence(activitySignal)) {
            detectedIdleTimestamp = activitySignal.timestamp;
            idleWasBlocked = activitySignal.activity === "blocked";
          }
        } else if (session.runtimeHandle && canProbeRuntimeIdentity) {
          activitySignal = createActivitySignal("null", { source: "native" });
          activityEvidence = formatActivitySignalEvidence(activitySignal);
          const runtime = registry.get<Runtime>(
            "runtime",
            resolveRuntimeName(project, config, agentName),
          );
          const terminalOutput = runtime ? await runtime.getOutput(session.runtimeHandle, 10) : "";
          if (terminalOutput) {
            const activity = agent.detectActivity(terminalOutput);
            activitySignal = classifyActivitySignal({ state: activity }, "terminal");
            activityEvidence = formatActivitySignalEvidence(activitySignal);
            if (activity === "waiting_input") {
              return commit({
                status: SESSION_STATUS.NEEDS_INPUT,
                evidence: activityEvidence,
                detecting: { attempts: 0 },
                sessionState: "needs_input",
                sessionReason: "awaiting_user_input",
              });
            }

            try {
              const processAlive = await agent.isProcessRunning(session.runtimeHandle);
              processProbe = processProbeResultToProbeResult(processAlive);
              if (processAlive === false) {
                lifecycle.runtime.state = "exited";
                lifecycle.runtime.reason = "process_missing";
                lifecycle.runtime.lastObservedAt = nowIso;
              }
            } catch (err) {
              processProbe = { state: "unknown", failed: true };
              recordActivityEvent({
                projectId: session.projectId,
                sessionId: session.id,
                source: "agent",
                kind: "agent.process_probe_failed",
                level: "warn",
                summary: `agent.isProcessRunning failed for ${session.id}`,
                data: {
                  agentName,
                  where: "fallback",
                  errorMessage: err instanceof Error ? err.message : String(err),
                },
              });
            }
          }
        } else {
          activitySignal = createActivitySignal("null", { source: "native" });
          activityEvidence = formatActivitySignalEvidence(activitySignal);
        }
      } catch (err) {
        activitySignal = createActivitySignal("probe_failure", { source: "native" });
        activityEvidence = formatActivitySignalEvidence(activitySignal);
        recordActivityEvent({
          projectId: session.projectId,
          sessionId: session.id,
          source: "agent",
          kind: "agent.activity_probe_failed",
          level: "warn",
          summary: `activity probing failed for ${session.id}`,
          data: {
            agentName,
            errorMessage: err instanceof Error ? err.message : String(err),
          },
        });
        if (
          lifecycle.session.state === "stuck" ||
          lifecycle.session.state === "needs_input" ||
          lifecycle.session.state === "detecting"
        ) {
          return commit({
            status: session.status,
            evidence: activityEvidence,
            detecting: { attempts: currentDetectingAttempts },
          });
        }
        return commit(
          createDetectingDecision({
            currentAttempts: currentDetectingAttempts,
            idleWasBlocked,
            evidence: activityEvidence,
            detectingStartedAt: currentDetectingStartedAt,
            previousEvidenceHash: currentDetectingEvidenceHash,
          }),
        );
      }
    }

    if (
      processProbe.state === "unknown" &&
      !processProbe.indeterminate &&
      session.runtimeHandle &&
      canProbeRuntimeIdentity &&
      agent
    ) {
      try {
        const processAlive = await agent.isProcessRunning(session.runtimeHandle);
        processProbe = processProbeResultToProbeResult(processAlive);
        if (processAlive === false) {
          lifecycle.runtime.state = "exited";
          lifecycle.runtime.reason = "process_missing";
          lifecycle.runtime.lastObservedAt = nowIso;
        }
      } catch (err) {
        processProbe = { state: "unknown", failed: true };
        recordActivityEvent({
          projectId: session.projectId,
          sessionId: session.id,
          source: "agent",
          kind: "agent.process_probe_failed",
          level: "warn",
          summary: `agent.isProcessRunning failed for ${session.id}`,
          data: {
            agentName,
            where: "standalone",
            errorMessage: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }

    if (processProbe.indeterminate) {
      recordActivityEvent({
        projectId: session.projectId,
        sessionId: session.id,
        source: "agent",
        kind: "agent.process_probe_failed",
        level: "warn",
        summary: `agent.isProcessRunning indeterminate for ${session.id}`,
        data: {
          agentName,
          reason: "probe_indeterminate",
        },
      });
      return {
        status: session.status,
        evidence: session.metadata["lifecycleEvidence"] ?? "process_probe_indeterminate",
        detectingAttempts: currentDetectingAttempts,
        detectingStartedAt: currentDetectingStartedAt,
        detectingEvidenceHash: currentDetectingEvidenceHash,
        skipMetadataWrite: true,
      };
    }

    // Ground-truth clamp for the streaming host: when the runtime probe positively
    // reports alive, the host IS alive — never let the unreliable agent-process
    // probe (which reads "not running" for the SDK host because it isn't a claude
    // CLI) disagree it into `detecting`/`agent_process_exited`, and never let an
    // activity-derived `exited` stick. A live host wrongly marked `exited` looks
    // terminal → isRestorable → ensureOrchestrator auto-restores it WITHOUT a
    // prompt → empty resume → dies → restore again: the end→resume loop. Reverting
    // here breaks that loop and the false stuck/probe_failure at the root.
    if (isStreamingRuntime && runtimeProbe.state === "alive") {
      if (processProbe.state !== "alive") {
        processProbe = { state: "alive", failed: false };
      }
      if (lifecycle.runtime.state === "exited" || lifecycle.runtime.state === "missing") {
        lifecycle.runtime.state = "alive";
        lifecycle.runtime.reason = "process_running";
      }
    }

    const probeDecision = resolveProbeDecision({
      currentAttempts: currentDetectingAttempts,
      runtimeProbe,
      processProbe,
      canProbeRuntimeIdentity,
      activitySignal,
      activityEvidence,
      idleWasBlocked,
      detectingStartedAt: currentDetectingStartedAt,
      previousEvidenceHash: currentDetectingEvidenceHash,
    });
    if (probeDecision) {
      return commit(probeDecision);
    }

    // detectPR is handled in populatePREnrichmentCache (gated by Guard 1 ETag).
    // By this point, session.pr is already set if a PR was discovered.

    if (session.pr && scm) {
      try {
        const prKey = `${session.pr.owner}/${session.pr.repo}#${session.pr.number}`;
        const cachedData = prEnrichmentCache.get(prKey);
        if (lifecycle.pr.state === "none") {
          lifecycle.pr.state = "open";
        }
        if (lifecycle.pr.reason === "not_created") {
          lifecycle.pr.reason = "in_progress";
        }
        lifecycle.pr.number = session.pr.number;
        lifecycle.pr.url = session.pr.url;
        lifecycle.pr.lastObservedAt = nowIso;
        const shouldEscalateIdleToStuck =
          detectedIdleTimestamp !== null && hasPositiveIdleEvidence(activitySignal)
            ? isIdleBeyondThreshold(session, detectedIdleTimestamp)
            : false;

        if (cachedData) {
          // When session has multiple PRs, aggregate enrichment across all of them.
          // ci_failed if ANY fails; approved/merged only when ALL pass.
          if (session.prs.length > 1) {
            const allEnrichments = session.prs
              .map((p) => prEnrichmentCache.get(`${p.owner}/${p.repo}#${p.number}`))
              .filter((e): e is PREnrichmentData => e !== undefined);

            if (allEnrichments.length === session.prs.length) {
              const aggregated: PREnrichmentData = {
                ciStatus: allEnrichments.some((e) => e.ciStatus === "failing")
                  ? "failing"
                  : allEnrichments.every((e) => e.ciStatus === "passing" || e.ciStatus === "none")
                    ? "passing"
                    : "pending",
                reviewDecision: allEnrichments.some(
                  (e) => e.reviewDecision === "changes_requested",
                )
                  ? "changes_requested"
                  : allEnrichments.every((e) => e.reviewDecision === "approved")
                    ? "approved"
                    : allEnrichments.every((e) => e.reviewDecision === "none")
                      ? "none"
                      : "pending",
                state: allEnrichments.every((e) => e.state === "merged")
                  ? "merged"
                  : allEnrichments.some((e) => e.state === "open")
                    ? "open"
                    : "closed",
                mergeable: allEnrichments.every((e) => e.mergeable),
                blockers: [...new Set(allEnrichments.flatMap((e) => e.blockers ?? []))],
                title: cachedData.title,
                additions: cachedData.additions,
                deletions: cachedData.deletions,
                isDraft: allEnrichments.some((e) => e.isDraft),
                hasConflicts: allEnrichments.some((e) => e.hasConflicts),
                isBehind: allEnrichments.some((e) => e.isBehind),
              };
              return commit(
                resolvePREnrichmentDecision(aggregated, {
                  shouldEscalateIdleToStuck,
                  idleWasBlocked,
                  activityEvidence,
                }),
              );
            }
          }
          // Partial cache miss for multi-PR session: never decide on primary PR
          // alone — fall through to the live-API check that verifies all PRs.
          if (session.prs.length <= 1) {
            return commit(
              resolvePREnrichmentDecision(cachedData, {
                shouldEscalateIdleToStuck,
                idleWasBlocked,
                activityEvidence,
              }),
            );
          }
          // intentional fall-through to live-API block below
        }

        // Batch enrichment cache miss — fall back to getPRState for terminal
        // states (merged/closed) only. Detecting these promptly prevents
        // delayed cleanup. Non-terminal state updates wait for the next batch
        // cycle (30s) to avoid ~110 individual REST calls per 15-min window.
        try {
          if (session.prs.length > 1) {
            // Multi-PR: only terminate when ALL PRs are in a terminal state.
            const states = await Promise.all(session.prs.map((p) => scm.getPRState(p)));
            if (states.every((s) => s === "merged" || s === "closed")) {
              const prState = states.every((s) => s === "merged") ? "merged" : "closed";
              return commit(
                resolvePRLiveDecision({
                  prState,
                  ciStatus: "none",
                  reviewDecision: "none",
                  mergeable: false,
                  shouldEscalateIdleToStuck,
                  idleWasBlocked,
                  activityEvidence,
                }),
              );
            }
          } else {
            const prState = await scm.getPRState(session.pr);
            if (prState === "merged" || prState === "closed") {
              return commit(
                resolvePRLiveDecision({
                  prState,
                  ciStatus: "none",
                  reviewDecision: "none",
                  mergeable: false,
                  shouldEscalateIdleToStuck,
                  idleWasBlocked,
                  activityEvidence,
                }),
              );
            }
          }
        } catch (err) {
          // Best-effort — batch will retry next cycle. Record AE evidence so
          // RCA can answer "why didn't AO transition to merged/closed in time?"
          recordActivityEvent({
            projectId: session.projectId,
            sessionId: session.id,
            source: "scm",
            kind: "scm.poll_pr_failed",
            level: "warn",
            summary: `getPRState failed for PR #${session.pr.number}`,
            data: {
              plugin: project.scm?.plugin,
              prNumber: session.pr.number,
              prUrl: session.pr.url,
              errorMessage: err instanceof Error ? err.message : String(err),
            },
          });
        }
      } catch (error) {
        observer?.recordOperation?.({
          metric: "lifecycle_poll",
          operation: "scm.poll_pr",
          outcome: "failure",
          correlationId: createCorrelationId("lifecycle-poll"),
          projectId: session.projectId,
          sessionId: session.id,
          reason: error instanceof Error ? error.message : String(error),
          level: "warn",
        });
      }
    }

    // Fresh agent reports outrank weak inference (idle-beyond-threshold /
    // default-to-working) but runtime death, activity waiting_input, and SCM
    // ground truth already short-circuited above. Orchestrator sessions and
    // terminal states are skipped intentionally — `lifecycle.session.kind` is
    // the authoritative source (string-matching role/id suffixes misses
    // numbered orchestrator IDs like `${prefix}-orchestrator-1`).
    const agentReport = readAgentReport(session.metadata);
    if (
      agentReport &&
      isAgentReportFresh(agentReport) &&
      lifecycle.session.kind !== "orchestrator" &&
      lifecycle.session.state !== "terminated" &&
      lifecycle.session.state !== "done"
    ) {
      const mapped = mapAgentReportToLifecycle(agentReport.state);
      return commit({
        status: deriveLegacyStatus({
          ...lifecycle,
          session: {
            ...lifecycle.session,
            state: mapped.sessionState,
            reason: mapped.sessionReason,
          },
        }),
        evidence: `agent_report:${agentReport.state}`,
        detecting: { attempts: 0 },
        sessionState: mapped.sessionState,
        sessionReason: mapped.sessionReason,
      });
    }

    // A positively-alive streaming WORKER whose activity has gone `idle`
    // finished its turn cleanly with nothing left to do (no PR and no fresh agent
    // report reached the branches above). The native idle signal only fires once
    // the last turn-end JSONL entry is older than the ready threshold (~5 min),
    // so this is already a settled turn-end, not a mid-turn pause — `ready`
    // (turn done, still within the window) keeps positive-idle false and stays
    // `working`. Nothing else in the no-PR flow records this as a working→idle
    // transition, so such a worker lingered in `working` forever: the board
    // showed it under Working, and BOTH the idle-worker auto-retire and the
    // worker completion-ping — each gated on `session.state === "idle"` — never
    // fired. Record the clean turn-end as `idle` here so those downstream signals
    // can observe it. (Deliberately NOT gated on isIdleBeyondThreshold: that
    // depends on an `agent-stuck` reaction threshold many configs don't set, so
    // it would silently never fire — the native idle signal is the ground truth.)
    // Excluded:
    //   - orchestrators: they legitimately sit idle between worker turns and must
    //     persist as a live conductor → fall through, keep prior (working) state;
    //   - a `blocked` idle signal (idleWasBlocked): an errored/stuck host, not a
    //     clean turn-end → leave it to the stuck/preserve paths below;
    //   - non-streaming (tmux) hosts: handled by the stuck escalation below,
    //     whose guard already excludes streaming-alive — that path is unchanged.
    if (
      detectedIdleTimestamp &&
      hasPositiveIdleEvidence(activitySignal) &&
      isStreamingRuntime &&
      runtimeProbe.state === "alive" &&
      lifecycle.session.kind !== "orchestrator" &&
      !idleWasBlocked
    ) {
      return commit({
        status: SESSION_STATUS.IDLE,
        evidence: `idle_turn_complete ${activityEvidence}`,
        detecting: { attempts: 0 },
        sessionState: "idle",
        sessionReason: "idle_done",
      });
    }

    if (
      detectedIdleTimestamp &&
      hasPositiveIdleEvidence(activitySignal) &&
      isIdleBeyondThreshold(session, detectedIdleTimestamp) &&
      // A positively-alive streaming host that is merely idle is healthy, not
      // stuck — an orchestrator legitimately waits (idle) for its workers to
      // report, and a host that finished a turn cleanly sits idle until the next
      // `send`. Don't escalate a live host to stuck/probe_failure on idleness.
      // (A clean idle WORKER on such a host was already mapped to `idle` above;
      // this still covers orchestrators and `blocked` idle on streaming hosts.)
      !(isStreamingRuntime && runtimeProbe.state === "alive")
    ) {
      return commit({
        status: SESSION_STATUS.STUCK,
        evidence: `idle_beyond_threshold ${activityEvidence}`,
        detecting: { attempts: 0 },
        sessionState: "stuck",
        sessionReason: idleWasBlocked ? "error_in_process" : "probe_failure",
      });
    }

    if (
      isWeakActivityEvidence(activitySignal) &&
      (session.status === SESSION_STATUS.DETECTING ||
        session.status === SESSION_STATUS.STUCK ||
        session.status === SESSION_STATUS.NEEDS_INPUT ||
        lifecycle.session.state === "detecting" ||
        lifecycle.session.state === "stuck" ||
        lifecycle.session.state === "needs_input")
    ) {
      const preservingProbeFailureStuck =
        activitySignal.state === "unavailable" &&
        lifecycle.session.state === "stuck" &&
        lifecycle.session.reason === "probe_failure" &&
        runtimeProbe.state === "alive" &&
        !runtimeProbe.failed;

      if (preservingProbeFailureStuck) {
        return commit({
          status: SESSION_STATUS.DETECTING,
          evidence: activityEvidence,
          detecting: { attempts: 0 },
          sessionState: "detecting",
          sessionReason: "probe_failure",
        });
      }

      return commit({
        status: deriveLegacyStatus(lifecycle),
        evidence: activityEvidence,
        detecting: { attempts: 0 },
      });
    }

    if (
      session.status === SESSION_STATUS.SPAWNING ||
      session.status === SESSION_STATUS.DETECTING ||
      session.status === SESSION_STATUS.STUCK ||
      session.status === SESSION_STATUS.NEEDS_INPUT
    ) {
      return commit({
        status: SESSION_STATUS.WORKING,
        evidence: activityEvidence,
        detecting: { attempts: 0 },
        sessionState: "working",
        sessionReason: "task_in_progress",
      });
    }

    return commit({
      status: session.status,
      evidence: activityEvidence,
      detecting: { attempts: 0 },
    });
  }

  /** Execute a reaction for a session. */
  async function executeReaction(
    session: Session | ReactionSessionContext,
    reactionKey: string,
    reactionConfig: ReactionConfig,
  ): Promise<ReactionResult> {
    const { id: sessionId, projectId } = session;
    const trackerKey = `${sessionId}:${reactionKey}`;
    let tracker = reactionTrackers.get(trackerKey);

    if (!tracker) {
      tracker = { attempts: 0, firstTriggered: new Date() };
      reactionTrackers.set(trackerKey, tracker);
    }

    // Already escalated — wait for the condition to resolve before resuming.
    if (tracker.escalated) {
      return { reactionType: reactionKey, success: true, action: "escalated", escalated: true };
    }

    // Increment attempts before checking escalation
    tracker.attempts++;

    // Check if we should escalate
    const maxRetries = reactionConfig.retries ?? Infinity;
    const escalateAfter = reactionConfig.escalateAfter;
    let shouldEscalate = false;

    if (tracker.attempts > maxRetries) {
      shouldEscalate = true;
    }

    if (typeof escalateAfter === "string") {
      const durationMs = parseDuration(escalateAfter);
      if (durationMs > 0 && Date.now() - tracker.firstTriggered.getTime() > durationMs) {
        shouldEscalate = true;
      }
    }

    if (typeof escalateAfter === "number" && tracker.attempts > escalateAfter) {
      shouldEscalate = true;
    }

    if (shouldEscalate) {
      // Mirror the trigger checks above so the cause matches the gate that
      // actually fired. Numeric escalateAfter is an attempt-count gate, not a
      // duration; without this distinction it gets misattributed to max_duration.
      const escalationCause: "max_retries" | "max_attempts" | "max_duration" =
        tracker.attempts > maxRetries
          ? "max_retries"
          : typeof escalateAfter === "number" && tracker.attempts > escalateAfter
            ? "max_attempts"
            : "max_duration";
      const durationMs = Date.now() - tracker.firstTriggered.getTime();
      recordActivityEvent({
        projectId,
        sessionId,
        source: "reaction",
        kind: "reaction.escalated",
        level: "warn",
        summary: `reaction ${reactionKey} escalated after ${tracker.attempts} attempts`,
        data: {
          reactionKey,
          attempts: tracker.attempts,
          durationSinceFirstMs: durationMs,
          escalationCause,
        },
      });
      // Escalate to human
      const context = buildEventContext(session, prEnrichmentCache);
      const event = createEvent("reaction.escalated", {
        sessionId,
        projectId,
        message: `Reaction '${reactionKey}' escalated after ${tracker.attempts} attempts`,
        data: buildReactionEscalationNotificationData({
          eventType: "reaction.escalated",
          sessionId,
          projectId,
          context,
          reactionKey,
          action: "escalated",
          attempts: tracker.attempts,
          cause: escalationCause,
          durationMs,
          enrichment: getPREnrichmentForSession(session),
        }),
      });
      await notifyHuman(event, reactionConfig.priority ?? "urgent");

      // Mark as escalated — silences further dispatches until the underlying
      // condition resolves and clearReactionTracker() is called explicitly.
      tracker.escalated = true;

      return {
        reactionType: reactionKey,
        success: true,
        action: "escalated",
        escalated: true,
      };
    }

    // Execute the reaction action
    const action = reactionConfig.action ?? "notify";

    switch (action) {
      case "send-to-agent": {
        if (reactionConfig.message) {
          try {
            await sessionManager.send(sessionId, reactionConfig.message);
            recordActivityEvent({
              projectId,
              sessionId,
              source: "reaction",
              kind: "reaction.action_succeeded",
              summary: `send-to-agent ${reactionKey}`,
              data: { reactionKey, action: "send-to-agent", attempts: tracker.attempts },
            });
            return {
              reactionType: reactionKey,
              success: true,
              action: "send-to-agent",
              message: reactionConfig.message,
              escalated: false,
            };
          } catch (err) {
            // Send failed — allow retry on next poll cycle (don't escalate immediately)
            recordActivityEvent({
              projectId,
              sessionId,
              source: "reaction",
              kind: "reaction.send_to_agent_failed",
              level: "warn",
              summary: `send-to-agent failed for ${sessionId}`,
              data: {
                reactionKey,
                attempts: tracker.attempts,
                errorMessage: err instanceof Error ? err.message : String(err),
              },
            });
            return {
              reactionType: reactionKey,
              success: false,
              action: "send-to-agent",
              escalated: false,
            };
          }
        }
        break;
      }

      case "notify": {
        const context = buildEventContext(session, prEnrichmentCache);
        const event = createEvent("reaction.triggered", {
          sessionId,
          projectId,
          message: reactionConfig.message ?? `Reaction '${reactionKey}' triggered notification`,
          data: buildReactionNotificationData({
            eventType: "reaction.triggered",
            sessionId,
            projectId,
            context,
            reactionKey,
            action: "notify",
            enrichment: getPREnrichmentForSession(session),
          }),
        });
        await notifyHuman(event, reactionConfig.priority ?? "info");
        recordActivityEvent({
          projectId,
          sessionId,
          source: "reaction",
          kind: "reaction.action_succeeded",
          summary: `notify ${reactionKey}`,
          data: { reactionKey, action: "notify", attempts: tracker.attempts },
        });
        return {
          reactionType: reactionKey,
          success: true,
          action: "notify",
          escalated: false,
        };
      }

      case "auto-merge": {
        // Auto-merge is handled by the SCM plugin
        // For now, just notify
        const context = buildEventContext(session, prEnrichmentCache);
        const event = createEvent("reaction.triggered", {
          sessionId,
          projectId,
          message: reactionConfig.message ?? `Reaction '${reactionKey}' triggered auto-merge`,
          data: buildReactionNotificationData({
            eventType: "reaction.triggered",
            sessionId,
            projectId,
            context,
            reactionKey,
            action: "auto-merge",
            enrichment: getPREnrichmentForSession(session),
          }),
        });
        await notifyHuman(event, "action");
        recordActivityEvent({
          projectId,
          sessionId,
          source: "reaction",
          kind: "reaction.action_succeeded",
          summary: `auto-merge ${reactionKey}`,
          data: { reactionKey, action: "auto-merge", attempts: tracker.attempts },
        });
        return {
          reactionType: reactionKey,
          success: true,
          action: "auto-merge",
          escalated: false,
        };
      }
    }

    return {
      reactionType: reactionKey,
      success: false,
      action,
      escalated: false,
    };
  }

  function clearReactionTracker(sessionId: SessionId, reactionKey: string): void {
    reactionTrackers.delete(`${sessionId}:${reactionKey}`);
  }

  function getReactionConfigForSession(
    session: Session,
    reactionKey: string,
  ): ReactionConfig | null {
    const project = config.projects[session.projectId];
    const globalReaction = config.reactions[reactionKey];
    const projectReaction = project?.reactions?.[reactionKey];
    const reactionConfig = projectReaction
      ? { ...globalReaction, ...projectReaction }
      : globalReaction;
    return reactionConfig ? (reactionConfig as ReactionConfig) : null;
  }

  function updateSessionMetadata(session: Session, updates: Partial<Record<string, string>>): void {
    const project = config.projects[session.projectId];
    if (!project) return;

    const sessionsDir = getProjectSessionsDir(session.projectId);
    const lifecycleUpdates = buildLifecycleMetadataPatch(cloneLifecycle(session.lifecycle));
    const mergedUpdates = { ...updates, ...lifecycleUpdates };
    updateMetadata(sessionsDir, session.id, mergedUpdates);
    sessionManager.invalidateCache();

    const cleaned = Object.fromEntries(
      Object.entries(session.metadata).filter(([key]) => {
        const update = mergedUpdates[key];
        return update === undefined || update !== "";
      }),
    );
    for (const [key, value] of Object.entries(mergedUpdates)) {
      if (value === undefined || value === "") continue;
      cleaned[key] = value;
    }
    session.metadata = cleaned;
    session.status = deriveLegacyStatus(session.lifecycle);
  }

  /**
   * Guarantee the orchestrator session learns when one of its workers finishes
   * or gets blocked, instead of relying on the agent to `ao send` a report
   * itself (which it may forget — the completion-signal gap). Runs every poll
   * for the session and is idempotent: a metadata latch
   * (`orchestratorSignaledStatus`) fires the signal once per status episode and
   * doubles as a retry latch — on a failed delivery the latch stays unset so the
   * next poll retries until the orchestrator is reliably notified. The latch
   * resets when the worker leaves a signal-worthy status, so a later re-entry
   * (e.g. needs_input → working → needs_input) signals again.
   */
  async function signalOrchestratorIfNeeded(
    session: Session,
    newStatus: SessionStatus,
  ): Promise<void> {
    if (!ORCHESTRATOR_SIGNAL_STATUSES.has(newStatus)) {
      if (session.metadata["orchestratorSignaledStatus"]) {
        updateSessionMetadata(session, { orchestratorSignaledStatus: "" });
      }
      return;
    }

    // The orchestrator's own lifecycle isn't signaled to itself.
    if (session.metadata["role"] === "orchestrator" || session.id.endsWith("-orchestrator")) {
      return;
    }

    // Already signaled this status episode — nothing to do.
    if (session.metadata["orchestratorSignaledStatus"] === newStatus) return;

    const project = config.projects[session.projectId];
    if (!project) return;

    const orchestratorSessionId = getOrchestratorSessionId(project);
    const orchestrator = await sessionManager.get(orchestratorSessionId).catch(() => null);
    // No orchestrator running for this project, or it's already dead — nobody to
    // signal. Leave the latch unset so a relaunched orchestrator gets notified.
    if (!orchestrator || TERMINAL_STATUSES.has(orchestrator.status)) return;

    try {
      await sessionManager.send(
        orchestratorSessionId,
        buildOrchestratorSignalMessage(session, newStatus),
      );
      updateSessionMetadata(session, { orchestratorSignaledStatus: newStatus });
      recordActivityEvent({
        projectId: session.projectId,
        sessionId: session.id,
        source: "lifecycle-manager",
        kind: "orchestrator.signaled",
        summary: `signaled orchestrator: ${session.id} → ${newStatus}`,
        data: { status: newStatus, orchestrator: orchestratorSessionId },
      });
    } catch (err) {
      // Fail loud (visible) but don't drop: the latch stays unset, so the next
      // poll retries until delivery is confirmed.
      recordActivityEvent({
        projectId: session.projectId,
        sessionId: session.id,
        source: "lifecycle-manager",
        kind: "orchestrator.signal_failed",
        level: "warn",
        summary: `failed to signal orchestrator: ${session.id} → ${newStatus}`,
        data: {
          status: newStatus,
          orchestrator: orchestratorSessionId,
          reason: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  function makeFingerprint(ids: string[]): string {
    return [...ids].sort().join(",");
  }

  async function maybeDispatchReviewBacklog(
    session: Session,
    _oldStatus: SessionStatus,
    newStatus: SessionStatus,
    transitionReaction?: TransitionReaction,
  ): Promise<void> {
    const project = config.projects[session.projectId];
    if (!project || !session.pr) return;

    const scm = project.scm?.plugin ? registry.get<SCM>("scm", project.scm.plugin) : null;
    if (!scm) return;

    const humanReactionKey = "changes-requested";
    const automatedReactionKey = "bugbot-comments";

    if (TERMINAL_STATUSES.has(newStatus) || session.lifecycle.pr.state !== "open") {
      clearReactionTracker(session.id, humanReactionKey);
      clearReactionTracker(session.id, automatedReactionKey);
      lastReviewBacklogCheckAt.delete(session.id);
      updateSessionMetadata(session, {
        lastPendingReviewFingerprint: "",
        lastPendingReviewDispatchHash: "",
        lastPendingReviewDispatchAt: "",
        lastAutomatedReviewFingerprint: "",
        lastAutomatedReviewDispatchHash: "",
        lastAutomatedReviewDispatchAt: "",
      });
      return;
    }

    // Throttle review backlog API calls to at most once per 2 minutes.
    // Comments don't change faster than this in practice, and the SCM calls
    // (getReviewThreads) consumes API quota on every poll.
    //
    // Exception: bypass throttle when a transition reaction just fired for a
    // review reaction key. The enriched dispatch needs the current fingerprint
    // from the API so it can fire and record the hash in the same cycle. If we
    // throttle here, the next unthrottled poll sees a "new" fingerprint, clears
    // the reaction tracker, and fires a duplicate dispatch.
    const hasRelevantTransition =
      transitionReaction?.key === humanReactionKey ||
      transitionReaction?.key === automatedReactionKey;
    if (!hasRelevantTransition) {
      const lastCheckAt = lastReviewBacklogCheckAt.get(session.id) ?? 0;
      if (Date.now() - lastCheckAt < REVIEW_BACKLOG_THROTTLE_MS) {
        return;
      }
    }
    // Single GraphQL call for all review threads (human + bot) + review summaries.
    // Split locally by isBot for separate reaction pipelines.
    let allThreads: ReviewComment[];
    let reviewSummaries: ReviewSummary[] = [];
    try {
      if (scm.getReviewThreads) {
        const result = await scm.getReviewThreads(session.pr);
        allThreads = result.threads;
        reviewSummaries = result.reviews;
      } else {
        // Fallback for SCM plugins that don't implement getReviewThreads yet
        allThreads = await scm.getPendingComments(session.pr);
      }
    } catch (err) {
      // Failed to fetch — preserve existing metadata; record AE evidence so
      // RCA can answer "why aren't review comments being dispatched?"
      recordActivityEvent({
        projectId: session.projectId,
        sessionId: session.id,
        source: "scm",
        kind: "scm.review_fetch_failed",
        level: "warn",
        summary: `review fetch failed for PR #${session.pr.number}`,
        data: {
          plugin: project.scm?.plugin,
          prNumber: session.pr.number,
          prUrl: session.pr.url,
          errorMessage: err instanceof Error ? err.message : String(err),
        },
      });
      // Don't update the throttle timestamp so the next poll retries immediately
      // instead of being blocked for 2 minutes with the agent left on a bare notification.
      return;
    }

    // Only stamp the throttle after a successful SCM fetch. If the fetch failed,
    // we returned above so the next poll can retry without waiting 2 minutes.
    lastReviewBacklogCheckAt.set(session.id, Date.now());

    // Persist review comments + summaries to metadata for dashboard consumption
    {
      const unresolved = allThreads.filter((c) => !c.isBot);
      const reviewBlob = JSON.stringify({
        unresolvedThreads: unresolved.length,
        unresolvedComments: unresolved.map((c) => ({
          url: c.url,
          path: c.path ?? "",
          author: c.author,
          body: c.body,
        })),
        reviews: reviewSummaries.map((r) => ({
          author: r.author,
          state: r.state,
          body: r.body,
        })),
        commentsUpdatedAt: new Date().toISOString(),
      });
      if (session.metadata["prReviewComments"] !== reviewBlob) {
        updateSessionMetadata(session, { prReviewComments: reviewBlob });
      }

      // Persist per-PR review comment blobs for secondary PRs so the dashboard
      // can enrich them independently (prReviewComments_1, prReviewComments_2, …).
      const sessionPRs = normalizeSessionPRs(session);
      const cleanupUpdates = indexedPRMetadataCleanup(session, sessionPRs.length);
      if (Object.keys(cleanupUpdates).length > 0) {
        updateSessionMetadata(session, cleanupUpdates);
      }
      for (let i = 1; i < sessionPRs.length; i++) {
        const secondaryPR = sessionPRs[i];
        if (!secondaryPR) continue;
        let secondaryThreads: ReviewComment[];
        let secondaryReviews: ReviewSummary[];
        try {
          if (scm.getReviewThreads) {
            const result = await scm.getReviewThreads(secondaryPR);
            secondaryThreads = result.threads;
            secondaryReviews = result.reviews;
          } else {
            secondaryThreads = await scm.getPendingComments(secondaryPR);
            secondaryReviews = [];
          }
        } catch {
          continue;
        }
        const secondaryUnresolved = secondaryThreads.filter((c) => !c.isBot);
        const secondaryBlob = JSON.stringify({
          unresolvedThreads: secondaryUnresolved.length,
          unresolvedComments: secondaryUnresolved.map((c) => ({
            url: c.url,
            path: c.path ?? "",
            author: c.author,
            body: c.body,
          })),
          reviews: secondaryReviews.map((r) => ({
            author: r.author,
            state: r.state,
            body: r.body,
          })),
          commentsUpdatedAt: new Date().toISOString(),
        });
        const reviewMetaKey = `prReviewComments_${i}`;
        if (session.metadata[reviewMetaKey] !== secondaryBlob) {
          updateSessionMetadata(session, { [reviewMetaKey]: secondaryBlob });
        }
      }
    }

    const pendingComments = allThreads.filter((c) => !c.isBot);
    const automatedComments = allThreads.filter((c) => c.isBot);

    // --- Pending (human) review comments ---
    {
      const pendingFingerprint = makeFingerprint(pendingComments.map((comment) => comment.id));
      const lastPendingFingerprint = session.metadata["lastPendingReviewFingerprint"] ?? "";
      const lastPendingDispatchHash = session.metadata["lastPendingReviewDispatchHash"] ?? "";

      if (
        pendingFingerprint !== lastPendingFingerprint &&
        transitionReaction?.key !== humanReactionKey
      ) {
        clearReactionTracker(session.id, humanReactionKey);
      }
      if (pendingFingerprint !== lastPendingFingerprint) {
        updateSessionMetadata(session, {
          lastPendingReviewFingerprint: pendingFingerprint,
        });
      }

      if (!pendingFingerprint) {
        clearReactionTracker(session.id, humanReactionKey);
        updateSessionMetadata(session, {
          lastPendingReviewFingerprint: "",
          lastPendingReviewDispatchHash: "",
          lastPendingReviewDispatchAt: "",
        });
      } else if (pendingFingerprint !== lastPendingDispatchHash) {
        const reactionConfig = getReactionConfigForSession(session, humanReactionKey);
        if (
          reactionConfig &&
          reactionConfig.action &&
          (reactionConfig.auto !== false || reactionConfig.action === "notify")
        ) {
          const enrichedMessage = formatReviewCommentsMessage(
            pendingComments,
            "reviewer",
            reviewSummaries,
          );

          // When the transition handler already called executeReaction for this
          // key, send the enriched payload directly to avoid double-billing the
          // reaction attempt budget. A project with retries:1 would otherwise
          // escalate on the very first transition poll.
          // Only bypass for "send-to-agent" — "notify" actions must go through
          // executeReaction so they route to notifyHuman instead of the agent.
          let success = false;
          if (
            transitionReaction?.key === humanReactionKey &&
            reactionConfig.action === "send-to-agent"
          ) {
            try {
              await sessionManager.send(session.id, enrichedMessage);
              success = true;
            } catch {
              // Send failed — will retry on next unthrottled poll
            }
          } else {
            const enrichedConfig = { ...reactionConfig, message: enrichedMessage };
            const result = await executeReaction(session, humanReactionKey, enrichedConfig);
            success = result.success;
          }
          if (success) {
            updateSessionMetadata(session, {
              lastPendingReviewDispatchHash: pendingFingerprint,
              lastPendingReviewDispatchAt: new Date().toISOString(),
            });
          }
        }
      }
    }

    // --- Automated (bot) review comments ---
    {
      const automatedFingerprint = makeFingerprint(automatedComments.map((comment) => comment.id));
      const lastAutomatedFingerprint = session.metadata["lastAutomatedReviewFingerprint"] ?? "";
      const lastAutomatedDispatchHash = session.metadata["lastAutomatedReviewDispatchHash"] ?? "";

      if (automatedFingerprint !== lastAutomatedFingerprint) {
        clearReactionTracker(session.id, automatedReactionKey);
        updateSessionMetadata(session, {
          lastAutomatedReviewFingerprint: automatedFingerprint,
        });
      }

      if (!automatedFingerprint) {
        clearReactionTracker(session.id, automatedReactionKey);
        updateSessionMetadata(session, {
          lastAutomatedReviewFingerprint: "",
          lastAutomatedReviewDispatchHash: "",
          lastAutomatedReviewDispatchAt: "",
        });
      } else if (automatedFingerprint !== lastAutomatedDispatchHash) {
        const reactionConfig = getReactionConfigForSession(session, automatedReactionKey);
        if (
          reactionConfig &&
          reactionConfig.action &&
          (reactionConfig.auto !== false || reactionConfig.action === "notify")
        ) {
          const enrichedMessage = formatReviewCommentsMessage(automatedComments, "bot");

          let success = false;
          if (
            transitionReaction?.key === automatedReactionKey &&
            reactionConfig.action === "send-to-agent"
          ) {
            try {
              await sessionManager.send(session.id, enrichedMessage);
              success = true;
            } catch {
              // Send failed — will retry on next unthrottled poll
            }
          } else {
            const enrichedConfig = { ...reactionConfig, message: enrichedMessage };
            const result = await executeReaction(session, automatedReactionKey, enrichedConfig);
            success = result.success;
          }
          if (success) {
            updateSessionMetadata(session, {
              lastAutomatedReviewDispatchHash: automatedFingerprint,
              lastAutomatedReviewDispatchAt: new Date().toISOString(),
            });
          }
        }
      }
    }
  }

  /**
   * Format review comments into a message with inline data for the agent.
   * Includes file, line, author, body, and URL so the agent doesn't need
   * to re-fetch via gh api.
   */
  function formatReviewCommentsMessage(
    comments: ReviewComment[],
    source: "reviewer" | "bot",
    reviews: ReviewSummary[] = [],
  ): string {
    const lines: string[] = [];

    // Prepend review summaries (the body submitted with "Changes requested" / "Approve")
    const nonEmptyReviews = reviews.filter((r) => r.body && r.body.trim().length > 0);
    if (nonEmptyReviews.length > 0) {
      for (const r of nonEmptyReviews) {
        lines.push(`Review by @${r.author} (${r.state}):`);
        lines.push(`"${r.body.trim()}"`, "");
      }
    }

    const header =
      source === "reviewer"
        ? `The following ${comments.length} unresolved review comment(s) are on your PR (as of just now). You should not need to re-fetch this data unless you need additional context.`
        : `The following ${comments.length} automated review comment(s) are on your PR (as of just now). You should not need to re-fetch this data unless you need additional context.`;
    lines.push(header, "");
    for (let i = 0; i < comments.length; i++) {
      const c = comments[i];
      const location = c.path ? `${c.path}${c.line ? `:${c.line}` : ""}` : "(general)";
      lines.push(`${i + 1}. ${location} (@${c.author}): "${c.body}"`);
      if (c.url) lines.push(`   ${c.url}`);
      if (c.threadId) lines.push(`   Thread ID: ${c.threadId}`);
    }
    lines.push(
      "",
      "Address each comment, push fixes. Use the thread ID to resolve each thread directly after pushing. You should not need to re-fetch review data unless you need additional context beyond what is provided here.",
    );
    return lines.join("\n");
  }

  function isFailedCICheck(check: CICheck): boolean {
    return check.status === "failed" || check.conclusion?.toUpperCase() === "FAILURE";
  }

  function formatCIFailureSummaryMessage(summary: CIFailureSummary): string {
    const lines = ["CI is failing on your PR.", ""];

    for (const job of summary.failedJobs) {
      const failed = job.failedStep ? `${job.name} → ${job.failedStep}` : job.name;
      lines.push(`Failed: ${failed}`);
      lines.push(`Failure URL: ${job.runUrl}`);

      if (job.logTail) {
        const lineCount = job.logTail.split(/\r?\n/).length;
        const lineLabel = lineCount === 1 ? "line" : "lines";
        const escapedTail = escapeMarkdownCodeFenceClosers(job.logTail);
        lines.push("", `Log tail (last ${lineCount} ${lineLabel}):`, "```", escapedTail, "```");
      }

      lines.push("");
    }

    lines.push("Fix the issues and push again.");
    return lines.join("\n");
  }

  function escapeMarkdownCodeFenceClosers(logTail: string): string {
    return logTail
      .split(/\r?\n/)
      .map((line) => (line.startsWith("```") ? `\u200B${line}` : line))
      .join("\n");
  }

  function formatCIFailureChecksFallback(failedChecks: CICheck[]): string {
    const lines = ["CI checks are failing on your PR. Here are the failed checks:", ""];
    for (const check of failedChecks) {
      const status = check.conclusion ?? check.status;
      const link = check.url ? ` — ${check.url}` : "";
      lines.push(`- **${check.name}**: ${status}${link}`);
    }
    lines.push("", "Investigate the failures, fix the issues, and push again.");
    return lines.join("\n");
  }

  /**
   * Format CI failures into a human-readable message for the agent.
   * Uses SCM-provided failed job/step/log details when available and falls
   * back to check names/statuses/links for SCM plugins that do not implement it.
   */
  async function formatCIFailureMessage(
    scm: SCM,
    pr: PRInfo,
    failedChecks: CICheck[],
  ): Promise<string> {
    if (scm.getCIFailureSummary) {
      try {
        const summary = await scm.getCIFailureSummary(pr, failedChecks);
        if (summary?.failedJobs.length) {
          return formatCIFailureSummaryMessage(summary);
        }
      } catch {
        // Fall back to check names when summary enrichment fails.
      }
    }

    return formatCIFailureChecksFallback(failedChecks);
  }

  async function getFailedCIChecks(
    scm: SCM,
    pr: PRInfo,
    options: { allowFetch: boolean },
  ): Promise<CICheck[] | null> {
    const prKey = `${pr.owner}/${pr.repo}#${pr.number}`;
    const cachedEnrichment = prEnrichmentCache.get(prKey);

    let checks: CICheck[] | undefined = cachedEnrichment?.ciChecks;
    if (checks === undefined && options.allowFetch) {
      try {
        checks = await scm.getCIChecks(pr);
      } catch {
        return null;
      }
    }

    const failedChecks = checks?.filter(isFailedCICheck) ?? [];
    return failedChecks.length > 0 ? failedChecks : null;
  }

  function makeCIFailureFingerprint(failedChecks: CICheck[]): string {
    return makeFingerprint(failedChecks.map((c) => `${c.name}:${c.status}:${c.conclusion ?? ""}`));
  }

  async function maybeDispatchCIFailureDetails(
    session: Session,
    _oldStatus: SessionStatus,
    newStatus: SessionStatus,
    transitionReaction?: TransitionReaction,
  ): Promise<void> {
    const project = config.projects[session.projectId];
    if (!project || !session.pr) return;

    const scm = project.scm?.plugin ? registry.get<SCM>("scm", project.scm.plugin) : null;
    if (!scm) return;

    const ciReactionKey = "ci-failed";

    // Clear tracking when PR is closed/merged
    if (newStatus === "merged" || newStatus === "killed") {
      clearReactionTracker(session.id, ciReactionKey);
      updateSessionMetadata(session, {
        lastCIFailureFingerprint: "",
        lastCIFailureDispatchHash: "",
        lastCIFailureDispatchAt: "",
      });
      return;
    }

    // Only dispatch CI details when in ci_failed state
    if (newStatus !== "ci_failed") {
      // CI is no longer failing — clear tracking so next failure is dispatched fresh
      const lastFingerprint = session.metadata["lastCIFailureFingerprint"] ?? "";
      if (lastFingerprint) {
        clearReactionTracker(session.id, ciReactionKey);
        updateSessionMetadata(session, {
          lastCIFailureFingerprint: "",
          lastCIFailureDispatchHash: "",
          lastCIFailureDispatchAt: "",
        });
      }
      return;
    }

    const failedChecks = await getFailedCIChecks(scm, session.pr, { allowFetch: true });
    if (!failedChecks) return;

    const ciFingerprint = makeCIFailureFingerprint(failedChecks);
    const lastCIFingerprint = session.metadata["lastCIFailureFingerprint"] ?? "";
    const lastCIDispatchHash = session.metadata["lastCIFailureDispatchHash"] ?? "";

    // Reset reaction tracker when failure set changes
    if (ciFingerprint !== lastCIFingerprint && transitionReaction?.key !== ciReactionKey) {
      clearReactionTracker(session.id, ciReactionKey);
    }
    if (ciFingerprint !== lastCIFingerprint) {
      updateSessionMetadata(session, {
        lastCIFailureFingerprint: ciFingerprint,
      });
    }

    // If the transition reaction already delivered an enriched agent message,
    // or handled a non-agent action, record the dispatch hash so subsequent
    // polls don't re-send the same failure details.
    if (
      transitionReaction?.key === ciReactionKey &&
      transitionReaction.result?.success &&
      (transitionReaction.messageEnriched === true ||
        transitionReaction.result.action !== "send-to-agent")
    ) {
      updateSessionMetadata(session, {
        lastCIFailureDispatchHash: ciFingerprint,
        lastCIFailureDispatchAt: new Date().toISOString(),
      });
      return;
    }

    // Skip if we already dispatched this exact failure set
    if (ciFingerprint === lastCIDispatchHash) return;

    // Dispatch CI failure details directly via sessionManager.send() rather than
    // executeReaction() to avoid consuming the ci-failed reaction's retry budget.
    // The transition reaction owns escalation; this is a follow-up info delivery.
    const reactionConfig = getReactionConfigForSession(session, ciReactionKey);
    if (
      reactionConfig &&
      reactionConfig.action &&
      (reactionConfig.auto !== false || reactionConfig.action === "notify")
    ) {
      const detailedMessage = await formatCIFailureMessage(scm, session.pr, failedChecks);

      try {
        if (reactionConfig.action === "send-to-agent") {
          await sessionManager.send(session.id, detailedMessage);
        } else {
          // For "notify" action, send to human notifiers instead
          const context = buildEventContext(session, prEnrichmentCache);
          const event = createEvent("ci.failing", {
            sessionId: session.id,
            projectId: session.projectId,
            message: detailedMessage,
            data: buildCIFailureNotificationData({
              sessionId: session.id,
              projectId: session.projectId,
              context,
              failedChecks,
            }),
          });
          await notifyHuman(event, reactionConfig.priority ?? "warning");
        }

        updateSessionMetadata(session, {
          lastCIFailureDispatchHash: ciFingerprint,
          lastCIFailureDispatchAt: new Date().toISOString(),
        });
      } catch {
        // Send failed — will retry on next poll cycle
      }
    }
  }

  /**
   * Dispatch merge conflict notifications to the agent session.
   * Conflicts are detected from the PR enrichment cache or getMergeability()
   * and dispatched independently of the session status (conflicts can coexist
   * with ci_failed, changes_requested, etc.).
   */
  async function maybeDispatchMergeConflicts(
    session: Session,
    newStatus: SessionStatus,
  ): Promise<void> {
    const project = config.projects[session.projectId];
    if (!project || !session.pr) return;

    const scm = project.scm?.plugin ? registry.get<SCM>("scm", project.scm.plugin) : null;
    if (!scm) return;

    const conflictReactionKey = "merge-conflicts";

    // Clear tracking when PR is no longer open.
    if (session.lifecycle.pr.state !== "open" || newStatus === "killed") {
      clearReactionTracker(session.id, conflictReactionKey);
      updateSessionMetadata(session, {
        lastMergeConflictDispatched: "",
      });
      return;
    }

    // Only check for conflicts on open PRs
    if (
      newStatus !== "pr_open" &&
      newStatus !== "ci_failed" &&
      newStatus !== "review_pending" &&
      newStatus !== "changes_requested" &&
      newStatus !== "approved" &&
      newStatus !== "mergeable"
    ) {
      return;
    }

    // Check for conflicts using cached enrichment data or fallback to individual call.
    // When batch enrichment ran (cachedData is present), use its hasConflicts value
    // to avoid 3 redundant REST calls from getMergeability() — the batch already
    // fetched the mergeable/mergeStateStatus fields via GraphQL.
    const prKey = `${session.pr.owner}/${session.pr.repo}#${session.pr.number}`;
    const cachedData = prEnrichmentCache.get(prKey);

    if (!cachedData) {
      // No batch data — skip this cycle, batch will populate on next cycle (30s)
      return;
    }
    const hasConflicts = cachedData.hasConflicts ?? false;

    const lastDispatched = session.metadata["lastMergeConflictDispatched"] ?? "";

    if (hasConflicts) {
      // Already dispatched for current conflict state — skip
      if (lastDispatched === "true") return;

      const reactionConfig = getReactionConfigForSession(session, conflictReactionKey);
      if (
        reactionConfig &&
        reactionConfig.action &&
        (reactionConfig.auto !== false || reactionConfig.action === "notify")
      ) {
        try {
          // Build enriched config with dynamic base branch message.
          // Preserve "warning" priority from old direct-dispatch code unless
          // the user explicitly set a different priority in their config.
          const enrichedConfig = {
            ...reactionConfig,
            priority: reactionConfig.priority ?? ("warning" as const),
          };
          if (reactionConfig.action === "send-to-agent" && !reactionConfig.message) {
            const baseBranch = session.pr.baseBranch ?? "the default branch";
            const behindNote = cachedData.isBehind ? ` is behind ${baseBranch} and` : "";
            enrichedConfig.message = `Your PR branch${behindNote} has merge conflicts with ${baseBranch}. Rebase your branch on ${baseBranch}, resolve the conflicts, and push. You should not need to call gh for merge status unless you need additional context — this information is current.`;
          }

          const result = await executeReaction(session, conflictReactionKey, enrichedConfig);
          // Only set dedup flag for non-escalated success — escalation hands off
          // to the human, so we must NOT suppress future agent dispatches if the
          // condition recurs after the tracker resets.
          if (result.success && result.action !== "escalated") {
            updateSessionMetadata(session, {
              lastMergeConflictDispatched: "true",
            });
          }
        } catch {
          // Dispatch failed — will retry on next poll cycle
        }
      }
    } else if (lastDispatched === "true") {
      // Conflicts resolved — clear dedup flag and reaction tracker so future
      // conflicts start a fresh incident with a fresh escalation budget.
      updateSessionMetadata(session, {
        lastMergeConflictDispatched: "",
      });
      clearReactionTracker(session.id, conflictReactionKey);
    }
  }

  /** Send a notification to all configured notifiers. */
  async function notifyHuman(event: OrchestratorEvent, priority: EventPriority): Promise<void> {
    const eventWithPriority = { ...event, priority };
    // Routing decides which notifiers fire per priority. A process-scoped
    // `AO_NOTIFIERS_ALLOW` (used by native front-ends like Maestro that run a
    // single AO notifier in an otherwise-disabled daemon) is unioned in so that
    // allow-listed notifier always receives events without the front-end having
    // to also rewrite notificationRouting in the config file.
    const routed = config.notificationRouting[priority] ?? config.defaults.notifiers;
    const notifierNames = [...new Set([...routed, ...forcedNotifierNames()])];

    for (const name of notifierNames) {
      const target = resolveNotifierTarget(config, name);
      const notifier =
        registry.get<Notifier>("notifier", target.reference) ??
        registry.get<Notifier>("notifier", target.pluginName);
      if (!notifier) {
        recordNotificationDelivery({
          observer,
          event: eventWithPriority,
          target,
          outcome: "failure",
          method: "notify",
          reason: "notifier target not found",
          failureKind: "target_missing",
          recordActivityEvent: true,
        });
        continue;
      }

      try {
        await notifier.notify(eventWithPriority);
        recordNotificationDelivery({
          observer,
          event: eventWithPriority,
          target,
          outcome: "success",
          method: "notify",
        });
      } catch (err) {
        recordNotificationDelivery({
          observer,
          event: eventWithPriority,
          target,
          outcome: "failure",
          method: "notify",
          reason: err instanceof Error ? err.message : String(err),
          failureKind: "delivery_failed",
          recordActivityEvent: true,
        });
      }
    }
  }

  /**
   * When a session's PR is merged, tear down its tmux runtime, remove its
   * worktree, and archive its metadata. Guarded by an idleness check so we
   * don't kill an agent mid-task; deferred cases set `mergedPendingCleanupSince`
   * in metadata and retry on subsequent polls until the agent idles or the
   * grace window elapses.
   */
  async function maybeAutoCleanupOnMerge(session: Session): Promise<void> {
    if (session.status !== SESSION_STATUS.MERGED) return;

    // config.lifecycle is typed optional to support hand-constructed
    // configs in tests. When loaded from YAML via Zod, the schema's
    // .default({}) always populates it. The destructure below handles
    // both paths uniformly.
    const { autoCleanupOnMerge = true, mergeCleanupIdleGraceMs: graceMs = 300_000 } =
      config.lifecycle ?? {};
    if (!autoCleanupOnMerge) return;

    // Check for idleness: if the agent is still working, defer cleanup.
    const nowIso = new Date().toISOString();
    const pendingSince = session.metadata["mergedPendingCleanupSince"] || nowIso;
    const pendingSinceMs = Date.parse(pendingSince);
    const graceElapsed = Number.isFinite(pendingSinceMs)
      ? Date.now() - pendingSinceMs >= graceMs
      : false;

    const activity = session.activity;
    const agentIsBusy =
      activity === ACTIVITY_STATE.ACTIVE ||
      activity === ACTIVITY_STATE.WAITING_INPUT ||
      activity === ACTIVITY_STATE.BLOCKED;

    if (agentIsBusy && !graceElapsed) {
      if (!session.metadata["mergedPendingCleanupSince"]) {
        updateSessionMetadata(session, { mergedPendingCleanupSince: nowIso });
      }
      observer.recordOperation({
        metric: "lifecycle_poll",
        operation: "lifecycle.merge_cleanup.deferred",
        outcome: "success",
        correlationId: createCorrelationId("lifecycle-merge-cleanup"),
        projectId: session.projectId,
        sessionId: session.id,
        reason: primaryLifecycleReason(session.lifecycle),
        data: { activity, pendingSince, graceMs },
        level: "info",
      });
      recordActivityEvent({
        projectId: session.projectId,
        sessionId: session.id,
        source: "lifecycle",
        kind: "session.auto_cleanup_deferred",
        summary: `auto-cleanup deferred for ${session.id}`,
        data: {
          activity,
          // Elapsed wall-time since cleanup was first deferred. NOT a Unix
          // timestamp — naming it `pendingSinceMs` was misleading (Greptile).
          pendingElapsedMs: Number.isFinite(pendingSinceMs) ? Date.now() - pendingSinceMs : null,
          graceMs,
        },
      });
      return;
    }

    const correlationId = createCorrelationId("lifecycle-merge-cleanup");
    try {
      const result = await sessionManager.kill(session.id, {
        purgeOpenCode: true,
        reason: "pr_merged",
      });
      observer.recordOperation({
        metric: "lifecycle_poll",
        operation: "lifecycle.merge_cleanup.completed",
        outcome: "success",
        correlationId,
        projectId: session.projectId,
        sessionId: session.id,
        reason: primaryLifecycleReason(session.lifecycle),
        data: {
          cleaned: result.cleaned,
          alreadyTerminated: result.alreadyTerminated,
          graceElapsed,
          activity,
        },
        level: "info",
      });
      recordActivityEvent({
        projectId: session.projectId,
        sessionId: session.id,
        source: "lifecycle",
        kind: "session.auto_cleanup_completed",
        summary: `auto-cleanup completed for ${session.id}`,
        data: {
          cleaned: result.cleaned,
          alreadyTerminated: result.alreadyTerminated,
          graceElapsed,
          activity,
        },
      });
      states.delete(session.id);
    } catch (err) {
      // Leave `merged` status in place so the next poll retries. Preserve the
      // deferral marker so idempotent retries don't restart the grace clock.
      if (!session.metadata["mergedPendingCleanupSince"]) {
        updateSessionMetadata(session, { mergedPendingCleanupSince: nowIso });
      }
      const errorMsg = err instanceof Error ? err.message : String(err);
      observer.recordOperation({
        metric: "lifecycle_poll",
        operation: "lifecycle.merge_cleanup.failed",
        outcome: "failure",
        correlationId,
        projectId: session.projectId,
        sessionId: session.id,
        reason: errorMsg,
        level: "warn",
      });
      recordActivityEvent({
        projectId: session.projectId,
        sessionId: session.id,
        source: "lifecycle",
        kind: "session.auto_cleanup_failed",
        level: "error",
        summary: `auto-cleanup failed for ${session.id}`,
        data: { errorMessage: errorMsg },
      });
    }
  }

  /**
   * True when the worktree has uncommitted changes OTHER than the injected
   * `.claude/` and `.maestro/` infra (activity logs, metadata, discipline hooks)
   * that ao writes into every worktree. Those always show up as untracked noise;
   * counting them would mark every worker dirty and make auto-retire dead code.
   * Any failure (not a git repo, git missing, timeout) is treated as "has work"
   * so we never tear down a worktree we could not verify is clean.
   */
  async function hasUncommittedNonInfraWork(worktreePath: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync("git", ["-C", worktreePath, "status", "--porcelain"], {
        timeout: 10_000,
      });
      return (
        stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          // porcelain v1: "XY <path>" (or "XY <orig> -> <new>" for renames). The
          // path portion starts at column 3; mirror the orchestrator's agreed
          // `grep -vE '\.claude/|\.maestro/'` filter on it.
          .some((line) => {
            const pathPart = line.slice(2).trim();
            return !(pathPart.includes(".claude/") || pathPart.includes(".maestro/"));
          })
      );
    } catch {
      return true; // fail safe — an unverifiable tree is treated as dirty
    }
  }

  /**
   * Auto-retire an idle WORKER whose streaming host finished its turn cleanly.
   *
   * A worker that completes its turn on a live SDK host is clamped to a stable
   * `idle` by the streaming-host ground truth (runtime-alive clamp + the
   * "live idle is healthy, not stuck" guard). Correct for liveness, but it
   * leaves a finished worker lingering: its node host keeps running (RAM) and
   * the board shows it under Working because the runtime is still alive — the
   * operator then had to `ao session kill` it by hand. Orchestrators legitimately
   * sit idle waiting on their workers, so they are NEVER retired here. Only a
   * worker, only once it has stayed idle past a grace window (so the orchestrator
   * can still deliver a follow-up turn) with a clean worktree (no uncommitted
   * non-infra work to lose). Reaps the host and moves the card to Done via
   * sessionManager.kill — the automated equivalent of the manual kill.
   *
   * Complements the dead-runtime terminal path (#8): that handles a host that
   * vanished; this handles a host that is alive but done.
   */
  async function maybeAutoRetireIdleWorker(session: Session): Promise<void> {
    const { autoRetireIdleWorkers = true, workerIdleRetireGraceMs: graceMs = 120_000 } =
      config.lifecycle ?? {};
    // NOTE: do NOT early-return on `!autoRetireIdleWorkers`. The completion-ping
    // below must fire regardless of the retire setting; only the reap is gated.

    const lc = session.lifecycle;
    const isStreamingRuntime = session.runtimeHandle?.runtimeName === "sdk";

    // Eligibility — ALL must hold:
    //  - SDK streaming host (the only runtime that clamps a finished turn to a
    //    live `idle`; a dead host of any runtime is handled by #8's terminal path);
    //  - worker, never an orchestrator (orchestrators persist/restore);
    //  - lifecycle `idle` = a clean turn-end (NOT working/needs_input/stuck/…);
    //  - runtime positively alive (don't race #8 on a host that just died);
    //  - activity not busy (no live work, no pending question/approval);
    //  - not already terminal.
    const eligible =
      isStreamingRuntime &&
      lc.session.kind !== "orchestrator" &&
      lc.session.state === "idle" &&
      lc.runtime.state === "alive" &&
      session.activity !== ACTIVITY_STATE.ACTIVE &&
      session.activity !== ACTIVITY_STATE.WAITING_INPUT &&
      session.activity !== ACTIVITY_STATE.BLOCKED;

    const clearPendingMarker = (): void => {
      if (session.metadata["workerRetirePendingSince"]) {
        updateSessionMetadata(session, { workerRetirePendingSince: "" });
      }
    };

    if (!eligible) {
      // Became busy / got a follow-up turn / changed state → reset the grace
      // clock so a later idle period opens a fresh window.
      clearPendingMarker();
      return;
    }

    // Never retire a worker with uncommitted NON-INFRA changes: that work would
    // be lost on teardown, and `git worktree remove` would fail on a dirty tree.
    // This same "clean tree" check is also the ground truth for "the worker is
    // DONE": the turn ended (idle) AND its work is committed (nothing uncommitted
    // left to lose) — exactly the signal the completion-ping below relies on.
    if (session.workspacePath && (await hasUncommittedNonInfraWork(session.workspacePath))) {
      clearPendingMarker();
      return;
    }

    // ── Ground-truth completion ping (decoupled from retire) ──────────────────
    // The worker has genuinely finished: its streaming turn ended cleanly AND its
    // work is committed. Notify the orchestrator ONCE so it reliably learns the
    // worker is done WITHOUT the agent needing to run `ao send` itself — final
    // text in a turn ("mae-NNN: DONE") is NOT a command actually executed, and
    // that completion-signal gap is what this closes. Fires regardless of
    // `autoRetireIdleWorkers`; only the reap below is gated on that setting. Any
    // send failure is swallowed and the latch left unset (retry next poll) so it
    // never breaks the poll loop or blocks the reap.
    await maybeSendWorkerCompletionPing(session);

    // Reaping the host stays gated on the retire setting:
    // detect-done → ping [always] → (if autoRetire) grace + reap.
    if (!autoRetireIdleWorkers) return;

    // Grace window: the first eligible poll stamps the clock; retire only once
    // the worker has stayed idle past graceMs. graceMs=0 retires immediately.
    const nowIso = new Date().toISOString();
    const pendingSince = session.metadata["workerRetirePendingSince"] || nowIso;
    if (!session.metadata["workerRetirePendingSince"]) {
      updateSessionMetadata(session, { workerRetirePendingSince: nowIso });
    }
    const pendingSinceMs = Date.parse(pendingSince);
    const graceElapsed = Number.isFinite(pendingSinceMs)
      ? Date.now() - pendingSinceMs >= graceMs
      : true;
    if (!graceElapsed) return;

    const correlationId = createCorrelationId("lifecycle-worker-retire");
    try {
      const result = await sessionManager.kill(session.id, { reason: "auto_cleanup" });
      observer.recordOperation({
        metric: "lifecycle_poll",
        operation: "lifecycle.worker_retire.completed",
        outcome: "success",
        correlationId,
        projectId: session.projectId,
        sessionId: session.id,
        reason: "worker_idle_done",
        data: {
          cleaned: result.cleaned,
          alreadyTerminated: result.alreadyTerminated,
          graceMs,
        },
        level: "info",
      });
      recordActivityEvent({
        projectId: session.projectId,
        sessionId: session.id,
        source: "lifecycle",
        kind: "session.worker_auto_retired",
        summary: `idle worker auto-retired: ${session.id}`,
        data: {
          cleaned: result.cleaned,
          alreadyTerminated: result.alreadyTerminated,
          graceMs,
        },
      });
      states.delete(session.id);
    } catch (err) {
      // Leave the marker in place so the next poll retries (idempotent kill).
      const errorMsg = err instanceof Error ? err.message : String(err);
      observer.recordOperation({
        metric: "lifecycle_poll",
        operation: "lifecycle.worker_retire.failed",
        outcome: "failure",
        correlationId,
        projectId: session.projectId,
        sessionId: session.id,
        reason: errorMsg,
        level: "warn",
      });
      recordActivityEvent({
        projectId: session.projectId,
        sessionId: session.id,
        source: "lifecycle",
        kind: "session.worker_auto_retire_failed",
        level: "error",
        summary: `idle worker auto-retire failed: ${session.id}`,
        data: { errorMessage: errorMsg },
      });
    }
  }

  /**
   * Fire the one-shot worker→orchestrator completion ping. Guarded by the
   * `completionReportedAt` metadata latch so it sends at most ONCE per worker —
   * even if the worker later gets a follow-up turn and goes idle-done again (the
   * orchestrator polls the branch anyway; simplicity over re-fire). On a send
   * failure the latch is left UNSET so the next poll retries, and the error is
   * swallowed so it never breaks the poll loop or blocks the reap.
   */
  async function maybeSendWorkerCompletionPing(session: Session): Promise<void> {
    // Already pinged this worker — nothing to do.
    if (session.metadata["completionReportedAt"]) return;

    // Resolve THIS project's orchestrator: a non-terminal session whose lifecycle
    // kind is "orchestrator". At most one is expected per project; if several,
    // take the most-recently-active. None found → nobody to notify, skip silently.
    let orchestrator: Session | null = null;
    try {
      const siblings = await sessionManager.list(session.projectId);
      orchestrator =
        siblings
          .filter(
            (s) =>
              s.id !== session.id &&
              s.lifecycle?.session.kind === "orchestrator" &&
              !TERMINAL_STATUSES.has(s.status),
          )
          .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime())[0] ?? null;
    } catch {
      orchestrator = null;
    }
    if (!orchestrator) return;

    const gitHead = session.workspacePath ? await readWorktreeHead(session.workspacePath) : null;
    const message = buildWorkerCompletionMessage(session, gitHead);
    const correlationId = createCorrelationId("lifecycle-worker-completion-ping");

    try {
      await sessionManager.send(orchestrator.id, message);
      // Latch only AFTER a confirmed send, so a failed delivery retries next poll.
      updateSessionMetadata(session, { completionReportedAt: new Date().toISOString() });
      observer.recordOperation({
        metric: "lifecycle_poll",
        operation: "lifecycle.worker_completion_ping.sent",
        outcome: "success",
        correlationId,
        projectId: session.projectId,
        sessionId: session.id,
        reason: "worker_idle_done",
        data: {
          branch: gitHead?.branch || session.branch || "",
          commit: gitHead?.shortSha ?? "",
          orchestratorSessionId: orchestrator.id,
        },
        level: "info",
      });
      recordActivityEvent({
        projectId: session.projectId,
        sessionId: session.id,
        source: "lifecycle",
        kind: "session.worker_completion_ping",
        summary: `worker completion ping → orchestrator: ${session.id}`,
        data: {
          branch: gitHead?.branch || session.branch || "",
          commit: gitHead?.shortSha ?? "",
          orchestratorSessionId: orchestrator.id,
        },
      });
    } catch (err) {
      // Swallow — a send failure must never break the poll loop or block reap.
      // Latch stays unset so the next poll retries delivery.
      const errorMsg = err instanceof Error ? err.message : String(err);
      observer.recordOperation({
        metric: "lifecycle_poll",
        operation: "lifecycle.worker_completion_ping.failed",
        outcome: "failure",
        correlationId,
        projectId: session.projectId,
        sessionId: session.id,
        reason: errorMsg,
        level: "warn",
      });
    }
  }

  /** Poll a single session and handle state transitions. */
  async function checkSession(session: Session): Promise<void> {
    // Use tracked state if available; otherwise use the persisted metadata status
    // (not session.status, which list() may have already overwritten for dead runtimes).
    // This ensures transitions are detected after a lifecycle manager restart.
    const tracked = states.get(session.id);
    const oldStatus =
      tracked ?? ((session.metadata?.["status"] as SessionStatus | undefined) || session.status);
    const previousLifecycle = cloneLifecycle(session.lifecycle);
    const previousPRState = session.lifecycle.pr.state;
    const assessment = await determineStatus(session);
    if (assessment.skipMetadataWrite) {
      states.set(session.id, oldStatus);
      return;
    }
    const newStatus = assessment.status;
    const lifecycleChanged = session.metadata["lifecycle"] !== JSON.stringify(session.lifecycle);
    let transitionReaction: TransitionReaction | undefined;

    const nextLifecycleEvidence = assessment.evidence;
    const nextDetectingAttempts =
      assessment.detectingAttempts > 0 ? String(assessment.detectingAttempts) : "";
    const nextDetectingStartedAt = assessment.detectingStartedAt ?? "";
    const nextDetectingEvidenceHash = assessment.detectingEvidenceHash ?? "";
    // Escalation can happen via attempt limit OR time limit
    const isDetectingEscalated =
      newStatus === SESSION_STATUS.STUCK &&
      (assessment.detectingAttempts > DETECTING_MAX_ATTEMPTS ||
        isDetectingTimedOut(nextDetectingStartedAt));
    const nextDetectingEscalatedAt = isDetectingEscalated
      ? session.metadata["detectingEscalatedAt"] || new Date().toISOString()
      : "";

    // Emit ONCE per escalation — guarded by detectingEscalatedAt being empty.
    // Subsequent polls while session stays stuck have detectingEscalatedAt set
    // and won't re-fire (per invariant: don't repeat escalation events).
    if (isDetectingEscalated && !session.metadata["detectingEscalatedAt"]) {
      const cause: "max_attempts" | "max_duration" =
        assessment.detectingAttempts > DETECTING_MAX_ATTEMPTS ? "max_attempts" : "max_duration";
      recordActivityEvent({
        projectId: session.projectId,
        sessionId: session.id,
        source: "lifecycle",
        kind: "detecting.escalated",
        level: "warn",
        summary: `detecting → stuck via ${cause}`,
        data: {
          attempts: assessment.detectingAttempts,
          cause,
          startedAt: nextDetectingStartedAt,
        },
      });
    }

    const metadataUpdates: Record<string, string> = {};
    if (session.metadata["lifecycleEvidence"] !== nextLifecycleEvidence) {
      metadataUpdates["lifecycleEvidence"] = nextLifecycleEvidence;
    }
    if ((session.metadata["detectingAttempts"] || "") !== nextDetectingAttempts) {
      metadataUpdates["detectingAttempts"] = nextDetectingAttempts;
    }
    if ((session.metadata["detectingStartedAt"] || "") !== nextDetectingStartedAt) {
      metadataUpdates["detectingStartedAt"] = nextDetectingStartedAt;
    }
    if ((session.metadata["detectingEvidenceHash"] || "") !== nextDetectingEvidenceHash) {
      metadataUpdates["detectingEvidenceHash"] = nextDetectingEvidenceHash;
    }
    if ((session.metadata["detectingEscalatedAt"] || "") !== nextDetectingEscalatedAt) {
      metadataUpdates["detectingEscalatedAt"] = nextDetectingEscalatedAt;
    }
    if (Object.keys(metadataUpdates).length > 0) {
      updateSessionMetadata(session, metadataUpdates);
    }

    // CI resolution tracking — reset the ci-failed tracker (including its escalated
    // flag) once CI has been passing for CI_PASSING_STABLE_THRESHOLD consecutive polls.
    // This lets the next real CI failure start with a fresh budget.
    if (session.pr) {
      const prKey = `${session.pr.owner}/${session.pr.repo}#${session.pr.number}`;
      const cachedData = prEnrichmentCache.get(prKey);
      if (cachedData) {
        if (cachedData.ciStatus === "passing") {
          const stableCount = Number(session.metadata["ciPassingStableCount"] ?? "0") + 1;
          if (stableCount >= CI_PASSING_STABLE_THRESHOLD) {
            clearReactionTracker(session.id, "ci-failed");
            updateSessionMetadata(session, { ciPassingStableCount: "" });
          } else {
            updateSessionMetadata(session, { ciPassingStableCount: String(stableCount) });
          }
        } else if (session.metadata["ciPassingStableCount"]) {
          // pending or failing resets the stability window — only "passing" counts as resolution
          updateSessionMetadata(session, { ciPassingStableCount: "" });
        }
      }
    }

    if (newStatus !== oldStatus) {
      const correlationId = createCorrelationId("lifecycle-transition");
      // State transition detected
      states.set(session.id, newStatus);
      updateSessionMetadata(session, { status: newStatus });
      recordActivityEvent({
        projectId: session.projectId,
        sessionId: session.id,
        source: "lifecycle",
        kind: "lifecycle.transition",
        level: newStatus === "ci_failed" ? "warn" : "info",
        summary: `${oldStatus} → ${newStatus}`,
        data: { from: oldStatus, to: newStatus },
      });
      observer.recordOperation({
        metric: "lifecycle_poll",
        operation: "lifecycle.transition",
        outcome: "success",
        correlationId,
        projectId: session.projectId,
        sessionId: session.id,
        reason: primaryLifecycleReason(session.lifecycle),
        data: buildTransitionObservabilityData(
          previousLifecycle,
          session.lifecycle,
          oldStatus,
          newStatus,
          assessment.evidence,
          assessment.detectingAttempts,
          true,
        ),
        level: transitionLogLevel(newStatus),
      });

      // Reset allCompleteEmitted when any session becomes active again
      if (!TERMINAL_STATUSES.has(newStatus)) {
        allCompleteEmitted = false;
      }

      // Clear reaction trackers for the old status so retries reset on state changes.
      // Persistent keys (ci-failed) are excluded — their trackers survive oscillation
      // so the escalation budget accumulates across cycles. On escalation, the tracker
      // is cleared in executeReaction so future incidents get a fresh budget.
      const oldEventType = statusToEventType(undefined, oldStatus);
      if (oldEventType) {
        const oldReactionKey = eventToReactionKey(oldEventType);
        if (oldReactionKey && !PERSISTENT_REACTION_KEYS.has(oldReactionKey)) {
          clearReactionTracker(session.id, oldReactionKey);
        }
      }

      // Handle transition: notify humans and/or trigger reactions
      const eventType = statusToEventType(oldStatus, newStatus);
      if (eventType) {
        let reactionHandledNotify = false;
        const reactionKey = eventToReactionKey(eventType);

        if (reactionKey) {
          let reactionConfig = getReactionConfigForSession(session, reactionKey);
          let messageEnriched = false;

          // Enrich CI failure message with failed job/step/log details when
          // batch check data is already available. If it is not, the
          // post-transition CI dispatcher below fetches checks and sends the
          // composed message without altering lifecycle state transitions.
          if (
            reactionKey === "ci-failed" &&
            session.pr &&
            reactionConfig?.action === "send-to-agent"
          ) {
            const project = config.projects[session.projectId];
            const scm = project?.scm?.plugin ? registry.get<SCM>("scm", project.scm.plugin) : null;
            if (scm) {
              const failedChecks = await getFailedCIChecks(scm, session.pr, { allowFetch: false });
              if (failedChecks) {
                reactionConfig = {
                  ...reactionConfig,
                  message: await formatCIFailureMessage(scm, session.pr, failedChecks),
                };
                messageEnriched = true;
              }
            }
          }

          if (reactionConfig && reactionConfig.action) {
            // auto: false skips automated agent actions but still allows notifications
            if (reactionConfig.auto !== false || reactionConfig.action === "notify") {
              const reactionResult = await executeReaction(session, reactionKey, reactionConfig);
              transitionReaction = { key: reactionKey, result: reactionResult, messageEnriched };
              observer.recordOperation({
                metric: "lifecycle_poll",
                operation: "lifecycle.transition.reaction",
                outcome: reactionResult.success ? "success" : "failure",
                correlationId,
                projectId: session.projectId,
                sessionId: session.id,
                reason: primaryLifecycleReason(session.lifecycle),
                data: buildTransitionObservabilityData(
                  previousLifecycle,
                  session.lifecycle,
                  oldStatus,
                  newStatus,
                  assessment.evidence,
                  assessment.detectingAttempts,
                  true,
                  transitionReaction,
                ),
                level: reactionResult.success ? "info" : "warn",
              });
              // Reaction is handling this event — suppress immediate human notification.
              // "send-to-agent" retries + escalates on its own; "notify"/"auto-merge"
              // already call notifyHuman internally. Notifying here would bypass the
              // delayed escalation behaviour configured via retries/escalateAfter.
              reactionHandledNotify = true;
            }
          }
        }

        // For transitions not already notified by a reaction, notify humans.
        // All priorities (including "info") are routed through notificationRouting
        // so the config controls which notifiers receive each priority level.
        if (!reactionHandledNotify) {
          const priority = inferPriority(eventType);
          const context = buildEventContext(session, prEnrichmentCache);
          const event = createEvent(eventType, {
            sessionId: session.id,
            projectId: session.projectId,
            message: `${session.id}: ${oldStatus} → ${newStatus}`,
            data: buildSessionTransitionNotificationData({
              eventType,
              sessionId: session.id,
              projectId: session.projectId,
              context,
              oldStatus,
              newStatus,
              enrichment: getPREnrichmentForSession(session),
            }),
          });
          await notifyHuman(event, priority);
        }
      }
    } else {
      // No transition but track current state
      states.set(session.id, newStatus);
      if (lifecycleChanged) {
        updateSessionMetadata(session, { status: newStatus });
        observer.recordOperation({
          metric: "lifecycle_poll",
          operation: "lifecycle.sync",
          outcome: "success",
          correlationId: createCorrelationId("lifecycle-sync"),
          projectId: session.projectId,
          sessionId: session.id,
          reason: primaryLifecycleReason(session.lifecycle),
          data: buildTransitionObservabilityData(
            previousLifecycle,
            session.lifecycle,
            oldStatus,
            newStatus,
            assessment.evidence,
            assessment.detectingAttempts,
            false,
          ),
          level: transitionLogLevel(newStatus),
        });
      }
    }

    const prEventType = prStateToEventType(previousPRState, session.lifecycle.pr.state);
    if (prEventType) {
      let reactionHandledNotify = false;
      const reactionKey = eventToReactionKey(prEventType);

      if (reactionKey) {
        const reactionConfig = getReactionConfigForSession(session, reactionKey);
        if (reactionConfig && reactionConfig.action) {
          if (reactionConfig.auto !== false || reactionConfig.action === "notify") {
            await executeReaction(session, reactionKey, reactionConfig);
            reactionHandledNotify = true;
          }
        }
      }

      if (!reactionHandledNotify) {
        const context = buildEventContext(session, prEnrichmentCache);
        const prEvent = createEvent(prEventType, {
          sessionId: session.id,
          projectId: session.projectId,
          message: `${session.id}: PR ${previousPRState} → ${session.lifecycle.pr.state}`,
          data: buildPRStateNotificationData({
            eventType: prEventType,
            sessionId: session.id,
            projectId: session.projectId,
            context,
            oldPRState: previousPRState,
            newPRState: session.lifecycle.pr.state,
            enrichment: getPREnrichmentForSession(session),
          }),
        });
        await notifyHuman(prEvent, inferPriority(prEventType));
      }
    }

    // Guarantee the orchestrator learns when this worker finished or got blocked,
    // even if the agent never `ao send`s a report itself. Idempotent + retrying.
    await signalOrchestratorIfNeeded(session, newStatus);

    // Pin first quality summary for title stability
    if (
      session.agentInfo?.summary &&
      !session.agentInfo.summaryIsFallback &&
      !session.metadata["pinnedSummary"]
    ) {
      const trimmed = session.agentInfo.summary.replace(/[\n\r]/g, " ").trim();
      if (trimmed.length >= 5) {
        try {
          updateSessionMetadata(session, { pinnedSummary: trimmed });
        } catch {
          // Non-critical: title just won't be pinned this cycle
        }
      }
    }

    await Promise.allSettled([
      maybeDispatchReviewBacklog(session, oldStatus, newStatus, transitionReaction),
      maybeDispatchMergeConflicts(session, newStatus),
      maybeDispatchCIFailureDetails(session, oldStatus, newStatus, transitionReaction),
    ]);

    // Report watcher: audit agent reports for issues (#140)
    await auditAndReactToReports(session);

    // PR-merge auto-cleanup: tear down runtime + worktree + archive metadata
    // once the agent is idle (or grace window elapses). Runs last so reactions
    // and notifications observe the live session before it is destroyed.
    await maybeAutoCleanupOnMerge(session);

    // Idle-worker auto-retire: reap a finished worker's live host once it has
    // sat idle past the grace window (frees RAM + self-clears the board). Runs
    // after merge-cleanup so a merged worker takes the merge path first.
    await maybeAutoRetireIdleWorker(session);
  }

  /**
   * Audit agent reports and trigger reactions when issues are detected.
   * Called at the end of each checkSession cycle.
   */
  async function auditAndReactToReports(session: Session): Promise<void> {
    const auditResult = auditAgentReports(session);
    const now = new Date().toISOString();

    // If no trigger, clear any active trigger metadata
    if (!auditResult || !auditResult.trigger) {
      const hadActiveTrigger = session.metadata[REPORT_WATCHER_METADATA_KEYS.ACTIVE_TRIGGER];
      if (hadActiveTrigger) {
        updateSessionMetadata(session, {
          [REPORT_WATCHER_METADATA_KEYS.LAST_AUDITED_AT]: now,
          [REPORT_WATCHER_METADATA_KEYS.ACTIVE_TRIGGER]: "",
          [REPORT_WATCHER_METADATA_KEYS.TRIGGER_ACTIVATED_AT]: "",
          [REPORT_WATCHER_METADATA_KEYS.TRIGGER_COUNT]: "",
        });
      }
      return;
    }

    const reactionKey = getReactionKeyForTrigger(auditResult.trigger);
    const reactionConfig = getReactionConfigForSession(session, reactionKey);

    // Update audit metadata
    const currentTriggerCount = parseInt(
      session.metadata[REPORT_WATCHER_METADATA_KEYS.TRIGGER_COUNT] ?? "0",
      10,
    );
    const isNewTrigger =
      session.metadata[REPORT_WATCHER_METADATA_KEYS.ACTIVE_TRIGGER] !== auditResult.trigger;

    updateSessionMetadata(session, {
      [REPORT_WATCHER_METADATA_KEYS.LAST_AUDITED_AT]: now,
      [REPORT_WATCHER_METADATA_KEYS.ACTIVE_TRIGGER]: auditResult.trigger,
      [REPORT_WATCHER_METADATA_KEYS.TRIGGER_ACTIVATED_AT]: isNewTrigger
        ? now
        : (session.metadata[REPORT_WATCHER_METADATA_KEYS.TRIGGER_ACTIVATED_AT] ?? now),
      [REPORT_WATCHER_METADATA_KEYS.TRIGGER_COUNT]: String(
        isNewTrigger ? 1 : currentTriggerCount + 1,
      ),
    });

    // Log the audit finding
    observer.recordOperation({
      metric: "lifecycle_poll",
      operation: "report_watcher.audit",
      outcome: "success",
      correlationId: createCorrelationId("report-watcher"),
      projectId: session.projectId,
      sessionId: session.id,
      reason: auditResult.trigger,
      data: {
        trigger: auditResult.trigger,
        message: auditResult.message,
        timeSinceSpawnMs: auditResult.timeSinceSpawnMs,
        timeSinceReportMs: auditResult.timeSinceReportMs,
        reportState: auditResult.report?.state,
      },
      level: "warn",
    });
    // Emit ONCE per trigger activation (matches the detecting.escalated guard
    // pattern). Without this guard the audit would fire every poll cycle while
    // a trigger stays active, producing hundreds of identical events. The
    // observer.recordOperation above is unguarded by design (it's a metric);
    // the activity-event trail is for actionable evidence, not heartbeat.
    if (isNewTrigger) {
      recordActivityEvent({
        projectId: session.projectId,
        sessionId: session.id,
        source: "report-watcher",
        kind: "report_watcher.triggered",
        level: "warn",
        // Trigger is a bounded enum (no_acknowledge | stale_report |
        // agent_needs_input); auditResult.message includes free-form
        // report.note text from `ao report` and must not land in summary,
        // which is FTS-indexed and only truncated by sanitizeSummary.
        // Full message stays in `data.message` where sanitizeData redacts
        // credential URLs.
        summary: `${auditResult.trigger} triggered`,
        data: {
          trigger: auditResult.trigger,
          message: auditResult.message,
          timeSinceSpawnMs: auditResult.timeSinceSpawnMs,
          timeSinceReportMs: auditResult.timeSinceReportMs,
          reportState: auditResult.report?.state,
        },
      });
    }

    // Execute reaction if configured
    if (isNewTrigger && reactionConfig && reactionConfig.auto !== false) {
      await executeReaction(session, reactionKey, reactionConfig);
    }
  }

  /** Run one polling cycle across all sessions. */
  async function pollAll(): Promise<void> {
    const correlationId = createCorrelationId("lifecycle-poll");
    const startedAt = Date.now();
    // Re-entrancy guard: skip if previous poll is still running
    if (polling) return;
    polling = true;

    try {
      const sessions = await sessionManager.list(scopedProjectId);

      // Include sessions that are active OR whose status changed from what we last saw
      // (e.g., list() detected a dead runtime and marked it "killed" — we need to
      // process that transition even though the new status is terminal)
      const sessionsToCheck = sessions.filter((s) => {
        if (!TERMINAL_STATUSES.has(s.status)) return true;
        const tracked = states.get(s.id);
        return tracked !== undefined && tracked !== s.status;
      });

      // Startup reconcile (one-time, on the first poll after start). The in-memory
      // `states` map is empty after a daemon restart, so orphans whose runtime died
      // while the daemon was down — persisted as `detecting`/runtime_lost by
      // sm.list() enrichment (#1735) — are reconciled here. They are already part of
      // `sessionsToCheck` (detecting is non-terminal), so the checkSession pass below
      // drives them through the probe pipeline: with a prior detecting attempt they
      // terminate (runtime_lost) on this very poll; a fresh one gets one grace cycle
      // first. This is observability + intent only — no extra session list call, and
      // every terminal decision is still made by resolveProbeDecision (preserves
      // #1735). (#8)
      if (startupReconcilePending) {
        startupReconcilePending = false;
        const orphans = sessionsToCheck.filter((s) => {
          const runtimeState = s.lifecycle?.runtime.state;
          const runtimeDead = runtimeState === "missing" || runtimeState === "exited";
          const detectingRuntimeLost =
            s.lifecycle?.session.state === "detecting" &&
            s.lifecycle?.session.reason === "runtime_lost";
          return runtimeDead || detectingRuntimeLost;
        });
        if (orphans.length > 0) {
          recordActivityEvent({
            projectId: scopedProjectId,
            source: "lifecycle",
            kind: "lifecycle.startup_reconcile",
            level: "info",
            summary: `reconciling ${orphans.length} orphaned dead-runtime session(s) on startup`,
            data: { count: orphans.length, sessionIds: orphans.map((s) => s.id) },
          });
        }
      }

      await Promise.allSettled(
        sessionsToCheck.map((session) => refreshTrackedBranch(session, sessions)),
      );

      // Prime the per-poll PR enrichment cache before session checks so
      // downstream status/reaction logic can reuse batch GraphQL data.
      await populatePREnrichmentCache(sessionsToCheck);

      // Poll all sessions concurrently
      await Promise.allSettled(sessionsToCheck.map((s) => checkSession(s)));

      // Persist batch enrichment data to session metadata files so the
      // web dashboard can read it without calling GitHub API.
      persistPREnrichmentToMetadata(sessionsToCheck);

      // Prune stale entries from states, reactionTrackers, and lastReviewBacklogCheckAt
      // for sessions that no longer appear in the session list (e.g., after kill/cleanup)
      const currentSessionIds = new Set(sessions.map((s) => s.id));
      for (const trackedId of states.keys()) {
        if (!currentSessionIds.has(trackedId)) {
          states.delete(trackedId);
        }
      }
      for (const trackedId of activityStateCache.keys()) {
        if (!currentSessionIds.has(trackedId)) {
          activityStateCache.delete(trackedId);
        }
      }
      for (const trackerKey of reactionTrackers.keys()) {
        const sessionId = trackerKey.split(":")[0];
        if (sessionId && !currentSessionIds.has(sessionId)) {
          reactionTrackers.delete(trackerKey);
        }
      }
      for (const sessionId of lastReviewBacklogCheckAt.keys()) {
        if (!currentSessionIds.has(sessionId)) {
          lastReviewBacklogCheckAt.delete(sessionId);
        }
      }

      // Check if all sessions are complete (trigger reaction only once)
      const activeSessions = sessions.filter((s) => !TERMINAL_STATUSES.has(s.status));
      if (sessions.length > 0 && activeSessions.length === 0 && !allCompleteEmitted) {
        allCompleteEmitted = true;

        // Execute all-complete reaction if configured
        const reactionKey = eventToReactionKey("summary.all_complete");
        if (reactionKey) {
          const reactionConfig = config.reactions[reactionKey];
          if (reactionConfig && reactionConfig.action) {
            if (reactionConfig.auto !== false || reactionConfig.action === "notify") {
              // Create a minimal session context for system events (no PR/issue context)
              const systemSession: ReactionSessionContext = {
                id: "system" as SessionId,
                projectId: "all",
                pr: null,
                issueId: null,
                branch: null,
                metadata: {},
                agentInfo: null,
              };
              await executeReaction(systemSession, reactionKey, reactionConfig as ReactionConfig);
            }
          }
        }
      }
      if (scopedProjectId) {
        observer.recordOperation({
          metric: "lifecycle_poll",
          operation: "lifecycle.poll",
          outcome: "success",
          correlationId,
          projectId: scopedProjectId,
          durationMs: Date.now() - startedAt,
          data: { sessionCount: sessions.length, activeSessionCount: activeSessions.length },
          level: "info",
        });
        observer.setHealth({
          surface: "lifecycle.worker",
          status: "ok",
          projectId: scopedProjectId,
          correlationId,
          details: {
            projectId: scopedProjectId,
            sessionCount: sessions.length,
            activeSessionCount: activeSessions.length,
          },
        });
      }
    } catch (err) {
      const errorReason = err instanceof Error ? err.message : String(err);
      observer.recordOperation({
        metric: "lifecycle_poll",
        operation: "lifecycle.poll",
        outcome: "failure",
        correlationId,
        projectId: scopedProjectId,
        durationMs: Date.now() - startedAt,
        reason: errorReason,
        level: "error",
      });
      recordActivityEvent({
        projectId: scopedProjectId,
        source: "lifecycle",
        kind: "lifecycle.poll_failed",
        level: "error",
        // Keep summary generic — sanitizeSummary only truncates, but the FTS
        // index covers it. Error text (which can contain credential URLs from
        // git/gh subprocess output) is routed through `data` where sanitizeData
        // redacts credentials.
        summary: "poll cycle failed",
        data: {
          errorMessage: errorReason,
          durationMs: Date.now() - startedAt,
          projectScope: scopedProjectId ?? "all",
        },
      });
      observer.setHealth({
        surface: "lifecycle.worker",
        status: "error",
        projectId: scopedProjectId,
        correlationId,
        reason: errorReason,
        details: scopedProjectId ? { projectId: scopedProjectId } : { projectScope: "all" },
      });
    } finally {
      polling = false;
    }
  }

  return {
    start(intervalMs = 30_000): void {
      if (pollTimer) return; // Already running
      pollTimer = setInterval(() => void pollAll(), intervalMs);
      // Run immediately on start. This first poll also performs the orphan
      // reconcile (see startupReconcilePending in pollAll): sessions whose runtime
      // died while the daemon was down — persisted as `detecting`/runtime_lost by
      // sm.list() (#1735) — are driven through the probe pipeline so they reach a
      // terminal state instead of lingering in `detecting`. (#8)
      void pollAll();
    },

    stop(): void {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    },

    getStates(): Map<SessionId, SessionStatus> {
      return new Map(states);
    },

    async check(sessionId: SessionId): Promise<void> {
      const session = await sessionManager.get(sessionId);
      if (!session) throw new Error(`Session ${sessionId} not found`);
      await refreshTrackedBranch(session);
      // Populate batch enrichment cache for this session's PR so
      // checkSession can read from cache (no individual REST fallback).
      await populatePREnrichmentCache([session]);
      await checkSession(session);
    },
  };
}
