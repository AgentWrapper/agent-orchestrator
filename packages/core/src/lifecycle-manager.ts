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

import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { recordActivityEvent } from "./activity-events.js";
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
import { resolveAgentSelection, resolveSessionRole } from "./agent-selection.js";
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
interface EventPRContext {
  url: string;
  /** Actual PR title from enrichment cache. null until cache is populated. */
  title: string | null;
  number: number;
  branch: string;
}

/** Event context with PR and issue information for webhook payloads. */
interface EventContext {
  pr: EventPRContext | null;
  issueId: string | null;
  issueTitle: string | null;
  /** Agent task summary (NOT the PR title). May describe the work before a PR exists. */
  summary: string | null;
  branch: string | null;
}

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
  let pr: EventPRContext | null = null;

  if (session.pr) {
    const prKey = `${session.pr.owner}/${session.pr.repo}#${session.pr.number}`;
    const cached = prEnrichmentCache.get(prKey);

    pr = {
      url: session.pr.url,
      title: cached?.title ?? null,
      number: session.pr.number,
      branch: session.pr.branch,
    };
  }

  return {
    pr,
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
  const branchAdoptionReservations = new Map<string, SessionId>();

  /**
   * Cache for PR enrichment data within a single poll cycle.
   * Cleared at the start of each pollAll() call.
   * Key format: "${owner}/${repo}#${number}"
   */
  const prEnrichmentCache = new Map<string, PREnrichmentData>();

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

      if (!session.pr) continue;

      const prKey = `${session.pr.owner}/${session.pr.repo}#${session.pr.number}`;
      if (seenPRKeys.has(prKey)) continue;
      seenPRKeys.add(prKey);

      const pluginPRs = prsByPlugin.get(pluginKey);
      if (pluginPRs) {
        pluginPRs.push(session.pr);
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
      if (session.metadata["prAutoDetect"] === "off" || session.metadata["prAutoDetect"] === "false") continue;
      if (session.metadata["role"] === "orchestrator" || session.id.endsWith("-orchestrator"))
        continue;
      if (
        session.pr &&
        !(session.lifecycle.pr.state === "closed" && session.pr.branch !== session.branch)
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
          session.pr = detectedPR;
          const sessionsDir = getProjectSessionsDir(session.projectId);
          updateMetadata(sessionsDir, session.id, { pr: detectedPR.url });
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
      if (!session.pr) continue;
      const project = config.projects[session.projectId];
      if (!project) continue;

      const prKey = `${session.pr.owner}/${session.pr.repo}#${session.pr.number}`;
      const cached = prEnrichmentCache.get(prKey);
      if (!cached) continue;

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

      if (session.metadata["prEnrichment"] === blob) continue;

      const sessionsDir = getProjectSessionsDir(session.projectId);
      updateMetadata(sessionsDir, session.id, { prEnrichment: blob });
      session.metadata["prEnrichment"] = blob;
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
    const allSessionPrefixes = Object.values(config.projects).map((p) => p.sessionPrefix);
    const sessionRole = resolveSessionRole(
      session.id,
      session.metadata,
      project.sessionPrefix,
      allSessionPrefixes,
    );
    const agentName = resolveAgentSelection({
      role: sessionRole,
      project,
      defaults: config.defaults,
      persistedAgent: session.metadata["agent"],
    }).agentName;
    const agent = registry.get<Agent>("agent", agentName);
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
    if (session.runtimeHandle && canProbeRuntimeIdentity) {
      const runtime = registry.get<Runtime>("runtime", project.runtime ?? config.defaults.runtime);
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
              project.runtime ?? config.defaults.runtime,
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
            project.runtime ?? config.defaults.runtime,
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
          return commit(
            resolvePREnrichmentDecision(cachedData, {
              shouldEscalateIdleToStuck,
              idleWasBlocked,
              activityEvidence,
            }),
          );
        }

        // Batch enrichment cache miss — fall back to getPRState for terminal
        // states (merged/closed) only. Detecting these promptly prevents
        // delayed cleanup. Non-terminal state updates wait for the next batch
        // cycle (30s) to avoid ~110 individual REST calls per 15-min window.
        try {
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
        status: deriveLegacyStatus(
          {
            ...lifecycle,
            session: {
              ...lifecycle.session,
              state: mapped.sessionState,
              reason: mapped.sessionReason,
            },
          },
        ),
        evidence: `agent_report:${agentReport.state}`,
        detecting: { attempts: 0 },
        sessionState: mapped.sessionState,
        sessionReason: mapped.sessionReason,
      });
    }

    if (
      detectedIdleTimestamp &&
      hasPositiveIdleEvidence(activitySignal) &&
      isIdleBeyondThreshold(session, detectedIdleTimestamp)
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
          durationSinceFirstMs: Date.now() - tracker.firstTriggered.getTime(),
          escalationCause,
        },
      });
      // Escalate to human
      const context = buildEventContext(session, prEnrichmentCache);
      const event = createEvent("reaction.escalated", {
        sessionId,
        projectId,
        message: `Reaction '${reactionKey}' escalated after ${tracker.attempts} attempts`,
        data: { reactionKey, attempts: tracker.attempts, context, schemaVersion: 2 },
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
          message: `Reaction '${reactionKey}' triggered notification`,
          data: { reactionKey, context, schemaVersion: 2 },
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
          message: `Reaction '${reactionKey}' triggered auto-merge`,
          data: { reactionKey, context, schemaVersion: 2 },
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
    const lifecycleUpdates = buildLifecycleMetadataPatch(
      cloneLifecycle(session.lifecycle),
    );
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
            data: { failedChecks: failedChecks.map((c) => c.name), context, schemaVersion: 2 },
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
    const notifierNames = config.notificationRouting[priority] ?? config.defaults.notifiers;

    for (const name of notifierNames) {
      const target = resolveNotifierTarget(config, name);
      const notifier =
        registry.get<Notifier>("notifier", target.reference) ??
        registry.get<Notifier>("notifier", target.pluginName);
      if (notifier) {
        try {
          await notifier.notify(eventWithPriority);
        } catch {
          // Notifier failed — not much we can do
        }
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
          pendingElapsedMs: Number.isFinite(pendingSinceMs)
            ? Date.now() - pendingSinceMs
            : null,
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
            data: { oldStatus, newStatus, context, schemaVersion: 2 },
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
          data: {
            oldPRState: previousPRState,
            newPRState: session.lifecycle.pr.state,
            // prNumber/prUrl kept for backward compat — drop in schemaVersion 3
            prNumber: session.lifecycle.pr.number,
            prUrl: session.lifecycle.pr.url,
            context,
            schemaVersion: 2,
          },
        });
        await notifyHuman(prEvent, inferPriority(prEventType));
      }
    }

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
      // Run immediately on start
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
