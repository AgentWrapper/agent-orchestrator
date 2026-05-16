/**
 * Dashboard-specific types for the web UI.
 *
 * Core types (SessionStatus, ActivityState, CIStatus, ReviewDecision, etc.)
 * are re-exported from @aoagents/ao-core. Dashboard-specific types
 * extend/flatten the core types for client-side rendering (e.g. DashboardPR
 * flattens core PRInfo + MergeReadiness + CICheck[] + ReviewComment[]).
 */

// Re-export core types used directly by the dashboard
export type {
  SessionStatus,
  ActivityState,
  ActivitySignalState,
  ActivitySignalSource,
  CIStatus,
  ReviewDecision,
  MergeReadiness,
  PRState,
  CanonicalSessionState,
  CanonicalSessionReason,
  CanonicalPRState,
  CanonicalPRReason,
  CanonicalRuntimeState,
  CanonicalRuntimeReason,
  DashboardAttentionZoneMode,
} from "@aoagents/ao-core/types";

import {
  ACTIVITY_STATE,
  SESSION_STATUS,
  CI_STATUS,
  TERMINAL_STATUSES,
  TERMINAL_ACTIVITIES,
  NON_RESTORABLE_STATUSES,
  type CICheck as CoreCICheck,
  type MergeReadiness,
  type CIStatus,
  type SessionStatus,
  type ActivityState,
  type ActivitySignalState,
  type ActivitySignalSource,
  type ReviewDecision,
  type CanonicalSessionState,
  type CanonicalSessionReason,
  type CanonicalPRState,
  type CanonicalPRReason,
  type CanonicalRuntimeState,
  type CanonicalRuntimeReason,
  type DashboardAttentionZoneMode,
} from "@aoagents/ao-core/types";
import type { AgentReportedState } from "@aoagents/ao-core";

// Re-export for use in client components
export { CI_STATUS, TERMINAL_STATUSES, TERMINAL_ACTIVITIES, NON_RESTORABLE_STATUSES };

/**
 * Attention zone priority level, ordered by human action urgency.
 *
 * Detailed levels (5-zone Kanban):
 * 1. merge   — PR approved + CI green. One click to clear. Highest ROI.
 * 2. respond — Agent waiting for human input. Quick unblock, agent resumes.
 * 3. review  — CI failed, changes requested, conflicts. Needs investigation.
 * 4. pending — Waiting on external (reviewer, CI). Nothing to do right now.
 * 5. working — Agents doing their thing. Don't interrupt.
 * 6. done    — Merged or terminated. Archive.
 *
 * Simple levels (4-zone Kanban, default): respond + review collapse into a
 * single `action` zone. The card-level badges still expose the underlying
 * granular state (ci_failed, needs_input, changes_requested).
 */
export type AttentionLevel =
  | "merge"
  | "action"
  | "respond"
  | "review"
  | "pending"
  | "working"
  | "done";

/**
 * Flattened session for dashboard rendering.
 * Maps to core Session but uses string dates (JSON-serializable for SSR/client boundary)
 * and inlines PR state.
 *
 * TODO: When wiring to real data, add a serialization layer that converts
 * core Session (Date objects) → DashboardSession (string dates).
 */
export interface DashboardSession {
  id: string;
  projectId: string;
  status: SessionStatus;
  activity: ActivityState | null;
  activitySignal?: DashboardActivitySignal;
  lifecycle?: DashboardLifecycle;
  branch: string | null;
  issueId: string | null; // Deprecated: use issueUrl instead
  issueUrl: string | null; // Full issue URL
  issueLabel: string | null; // Human-readable label (e.g., "INT-1327", "#42")
  issueTitle: string | null; // Full issue title (e.g., "Add user authentication flow")
  userPrompt: string | null; // Prompt used when spawning without an issue
  /**
   * Stable display name derived from task context at spawn time. Populated
   * from issue title, user prompt, or orchestrator system prompt. Used as a
   * fallback in {@link getSessionTitle} above the humanized branch so sessions
   * remain identifiable even when PR/issue enrichment is unavailable.
   */
  displayName: string | null;
  /**
   * True when `displayName` was explicitly set by the user via the rename UI.
   * Auto-derived spawn-time values leave this false. {@link getSessionTitle}
   * uses it to decide whether `displayName` should beat live PR/issue titles.
   */
  displayNameUserSet: boolean;
  summary: string | null;
  /** True when the summary is a low-quality fallback (e.g. truncated spawn prompt) */
  summaryIsFallback: boolean;
  createdAt: string;
  lastActivityAt: string;
  pr: DashboardPR | null;
  metadata: Record<string, string>;
  agentReportAudit?: DashboardAgentReportAuditEntry[];
  attentionLevel?: AttentionLevel;
}

export interface DashboardAgentReportAuditSnapshot {
  legacyStatus: SessionStatus;
  sessionState: CanonicalSessionState;
  sessionReason: CanonicalSessionReason;
  lastTransitionAt: string | null;
}

export interface DashboardAgentReportAuditEntry {
  timestamp: string;
  actor: string;
  source: "acknowledge" | "report";
  reportState: AgentReportedState;
  note?: string;
  accepted: boolean;
  rejectionReason?: string;
  before: DashboardAgentReportAuditSnapshot;
  after: DashboardAgentReportAuditSnapshot;
}

export interface DashboardActivitySignal {
  state: ActivitySignalState;
  activity: ActivityState | null;
  timestamp: string | null;
  source: ActivitySignalSource;
  detail?: string;
}

export interface DashboardLifecycleFacet<
  TState extends string = string,
  TReason extends string = string,
> {
  state: TState;
  reason: TReason;
  label: string;
  reasonLabel: string;
}

export interface DashboardLifecycle {
  sessionState: CanonicalSessionState;
  sessionReason: CanonicalSessionReason;
  prState: CanonicalPRState;
  prReason: CanonicalPRReason;
  runtimeState: CanonicalRuntimeState;
  runtimeReason: CanonicalRuntimeReason;
  session: DashboardLifecycleFacet<CanonicalSessionState, CanonicalSessionReason> & {
    startedAt?: string | null;
    completedAt?: string | null;
    terminatedAt?: string | null;
    lastTransitionAt?: string | null;
  };
  pr: DashboardLifecycleFacet<CanonicalPRState, CanonicalPRReason> & {
    number?: number | null;
    url?: string | null;
    lastObservedAt?: string | null;
  };
  runtime: DashboardLifecycleFacet<CanonicalRuntimeState, CanonicalRuntimeReason> & {
    lastObservedAt?: string | null;
  };
  legacyStatus: SessionStatus;
  evidence: string | null;
  detectingAttempts: number;
  detectingEscalatedAt: string | null;
  summary: string;
  guidance: string | null;
}

/**
 * Flattened PR for dashboard rendering.
 * Aggregates core PRInfo + PRState + CICheck[] + MergeReadiness + ReviewComment[].
 */
export interface DashboardPR {
  number: number;
  url: string;
  title: string;
  owner: string;
  repo: string;
  branch: string;
  baseBranch: string;
  isDraft: boolean;
  state: "open" | "merged" | "closed";
  additions: number;
  deletions: number;
  changedFiles?: number;
  ciStatus: CIStatus;
  ciChecks: DashboardCICheck[];
  reviewDecision: ReviewDecision;
  mergeability: DashboardMergeability;
  unresolvedThreads: number;
  unresolvedComments: DashboardUnresolvedComment[];
  /** Whether this PR has been enriched with live SCM data (or cache hit).
   *  `false` means only basic data from the session metadata is available. */
  enriched?: boolean;
}

/**
 * Mirrors core CICheck but omits Date fields (not JSON-serializable).
 * Core CICheck also has conclusion, startedAt, completedAt.
 */
export interface DashboardCICheck {
  name: string;
  status: CoreCICheck["status"];
  url?: string;
}

/**
 * Same shape as core MergeReadiness — re-exported for convenience.
 */
export type DashboardMergeability = MergeReadiness;

export interface DashboardUnresolvedComment {
  url: string;
  path: string;
  author: string;
  body: string;
}

export interface DashboardStats {
  totalSessions: number;
  workingSessions: number;
  openPRs: number;
  needsReview: number;
}

export interface DashboardOrchestratorLink {
  id: string;
  projectId: string;
  projectName: string;
}

/**
 * Returns true when this PR's enrichment data couldn't be fetched due to
 * API rate limiting. When true, CI status / review decision / mergeability
 * may be stale defaults — don't make decisions based on them.
 */
export function isPRRateLimited(pr: DashboardPR): boolean {
  return pr.mergeability.blockers.includes("API rate limited or unavailable");
}

/** Returns true when a PR has not yet been enriched with live SCM data.
 *  Only returns true for explicit `false` — undefined (legacy data) is treated as enriched. */
export function isPRUnenriched(pr: DashboardPR): boolean {
  return pr.enriched === false;
}

/**
 * Returns true when a PR is open and all merge criteria are met.
 * Does NOT return true for merged or closed PRs — those are already done.
 */
export function isPRMergeReady(pr: DashboardPR): boolean {
  return (
    pr.state === "open" &&
    pr.mergeability.mergeable &&
    pr.mergeability.ciPassing &&
    pr.mergeability.approved &&
    pr.mergeability.noConflicts
  );
}

function humanizeLifecycleToken(token: string): string {
  return token.replace(/_/g, " ");
}

export function getSessionTruthLabel(session: DashboardSession): string {
  return session.lifecycle?.session?.label ?? humanizeLifecycleToken(session.status);
}

export function getSessionTruthReasonLabel(session: DashboardSession): string | null {
  return session.lifecycle?.session?.reasonLabel ?? null;
}

export function getPRTruthLabel(session: DashboardSession): string {
  if (session.lifecycle?.pr?.label) return session.lifecycle.pr.label;
  return session.pr?.state ? humanizeLifecycleToken(session.pr.state) : "not created";
}

export function getPRTruthReasonLabel(session: DashboardSession): string | null {
  return session.lifecycle?.pr?.reasonLabel ?? null;
}

export function getRuntimeTruthLabel(session: DashboardSession): string {
  return session.lifecycle?.runtime?.label ?? "unknown";
}

export function getRuntimeTruthReasonLabel(session: DashboardSession): string | null {
  return session.lifecycle?.runtime?.reasonLabel ?? null;
}

export function getLifecycleGuidance(session: DashboardSession): string | null {
  return session.lifecycle?.guidance ?? null;
}

export function getLifecycleEvidence(session: DashboardSession): string | null {
  return session.lifecycle?.evidence ?? session.metadata["lifecycleEvidence"] ?? null;
}

function resolveActivitySignal(session: DashboardSession): DashboardActivitySignal {
  if (session.activitySignal) {
    return session.activitySignal;
  }

  if (session.activity === null) {
    return {
      state: "unavailable",
      activity: null,
      timestamp: null,
      source: "none",
    };
  }

  if (session.activity === "idle" || session.activity === "blocked") {
    return {
      state: "stale",
      activity: session.activity,
      timestamp: null,
      source: "none",
      detail: "missing_timestamp",
    };
  }

  return {
    state: "valid",
    activity: session.activity,
    timestamp: null,
    source: "none",
  };
}

export function getActivitySignalLabel(session: DashboardSession): string {
  const signal = resolveActivitySignal(session);
  switch (signal.state) {
    case "valid":
      return signal.activity ? humanizeLifecycleToken(signal.activity) : "valid";
    case "stale":
      return signal.activity ? `${humanizeLifecycleToken(signal.activity)} (stale)` : "stale";
    case "null":
      return "no activity signal";
    case "unavailable":
      return "activity unavailable";
    case "probe_failure":
      return "activity probe failed";
  }
}

export function getActivitySignalReasonLabel(session: DashboardSession): string | null {
  const signal = resolveActivitySignal(session);
  const parts = [
    signal.source !== "none" ? `source ${signal.source}` : null,
    signal.timestamp ? `observed ${signal.timestamp}` : null,
    signal.detail ? humanizeLifecycleToken(signal.detail) : null,
  ].filter((value): value is string => value !== null);
  return parts.length > 0 ? parts.join(" • ") : null;
}

export function isDashboardSessionTerminated(session: DashboardSession): boolean {
  if (session.lifecycle) {
    return session.lifecycle.sessionState === "terminated";
  }
  return session.status === "terminated" || session.status === "killed";
}

export function isDashboardSessionDone(session: DashboardSession): boolean {
  if (session.lifecycle) {
    return (
      session.lifecycle.sessionState === "done" ||
      isDashboardSessionTerminated(session) ||
      session.lifecycle.prState === "merged"
    );
  }
  if (
    session.status === "merged" ||
    session.status === "killed" ||
    session.status === "cleanup" ||
    session.status === "done" ||
    session.status === "terminated"
  ) {
    return true;
  }
  return session.pr?.state === "merged";
}

export function isDashboardSessionTerminal(session: DashboardSession): boolean {
  if (session.lifecycle) {
    return (
      isDashboardSessionDone(session) ||
      session.lifecycle.runtimeState === "missing" ||
      session.lifecycle.runtimeState === "exited"
    );
  }
  return (
    TERMINAL_STATUSES.has(session.status) ||
    (session.activity !== null && TERMINAL_ACTIVITIES.has(session.activity))
  );
}

export function isDashboardRuntimeEnded(session: DashboardSession): boolean {
  if (session.lifecycle) {
    return (
      session.lifecycle.runtimeState === "missing" || session.lifecycle.runtimeState === "exited"
    );
  }
  return (
    TERMINAL_STATUSES.has(session.status) ||
    (session.activity !== null && TERMINAL_ACTIVITIES.has(session.activity))
  );
}

export function isDashboardSessionRestorable(session: DashboardSession): boolean {
  if (session.lifecycle) {
    const terminalByCoreTruth =
      session.lifecycle.sessionState === "done" ||
      isDashboardSessionTerminated(session) ||
      session.lifecycle.runtimeState === "missing" ||
      session.lifecycle.runtimeState === "exited";
    return (
      terminalByCoreTruth && session.lifecycle.prState !== "merged" && session.status !== "merged"
    );
  }
  if (!isDashboardSessionTerminal(session)) return false;
  return session.pr?.state !== "merged" && session.status !== "merged";
}

/**
 * Determines which attention zone a session belongs to.
 *
 * @param session - the session to classify
 * @param mode - "detailed" (default) returns the granular 5-zone result.
 *               "simple" collapses respond + review into a single "action"
 *               zone for the 4-column Kanban layout.
 *
 * Note: the function defaults to "detailed" so card-level callers
 * (SessionCard, BottomSheet, ProjectSidebar, etc.) keep their granular
 * behavior. Only the Dashboard kanban grouping passes "simple" when the
 * config opts into the 4-zone layout.
 */
export function getAttentionLevel(
  session: DashboardSession,
  mode: DashboardAttentionZoneMode = "detailed",
): AttentionLevel {
  const level = getDetailedAttentionLevel(session);
  if (mode === "simple" && (level === "respond" || level === "review")) {
    return "action";
  }
  return level;
}

function getDetailedAttentionLevel(session: DashboardSession): AttentionLevel {
  // ── Done: terminal states ─────────────────────────────────────────
  if (isDashboardSessionDone(session)) {
    return "done";
  }

  // ── Merge: PR is ready — one click to clear ───────────────────────
  // Check this early: if the PR is mergeable, that's the most valuable
  // action for the human regardless of agent activity.
  if (
    session.lifecycle?.prReason === "merge_ready" ||
    session.lifecycle?.prReason === "approved" ||
    session.status === "mergeable" ||
    session.status === "approved"
  ) {
    return "merge";
  }
  if (session.pr && !isPRUnenriched(session.pr) && session.pr.mergeability.mergeable) {
    return "merge";
  }

  // ── Respond: agent is waiting for human input ─────────────────────
  // Check status-based error conditions first — these are authoritative
  // and should not be masked by a stale activity value.
  if (
    session.lifecycle?.sessionState === "detecting" ||
    session.lifecycle?.sessionState === "needs_input" ||
    session.lifecycle?.sessionState === "stuck" ||
    session.status === SESSION_STATUS.ERRORED ||
    session.status === SESSION_STATUS.NEEDS_INPUT ||
    session.status === SESSION_STATUS.STUCK
  ) {
    return "respond";
  }
  if (
    session.activity === ACTIVITY_STATE.WAITING_INPUT ||
    session.activity === ACTIVITY_STATE.BLOCKED
  ) {
    return "respond";
  }
  // Exited agent with non-terminal status = crashed, needs human attention
  if (session.activity === ACTIVITY_STATE.EXITED) {
    return "respond";
  }

  // ── Review: problems that need investigation ──────────────────────
  if (
    session.lifecycle?.prReason === "ci_failing" ||
    session.lifecycle?.prReason === "changes_requested" ||
    session.status === "ci_failed" ||
    session.status === "changes_requested"
  ) {
    return "review";
  }
  if (session.pr && !isPRRateLimited(session.pr) && !isPRUnenriched(session.pr)) {
    const pr = session.pr;
    if (pr.ciStatus === CI_STATUS.FAILING) return "review";
    if (pr.reviewDecision === "changes_requested") return "review";
    if (!pr.mergeability.noConflicts) return "review";
  }

  // ── Pending: waiting on external (reviewer, CI) ───────────────────
  if (
    session.lifecycle?.prReason === "review_pending" ||
    session.lifecycle?.prReason === "closed_unmerged" ||
    session.status === "review_pending"
  ) {
    return "pending";
  }
  if (session.pr && !isPRRateLimited(session.pr) && !isPRUnenriched(session.pr)) {
    const pr = session.pr;
    if (!pr.isDraft && pr.unresolvedThreads > 0) return "pending";
    if (!pr.isDraft && (pr.reviewDecision === "pending" || pr.reviewDecision === "none")) {
      return "pending";
    }
  }

  // ── Working: agents doing their thing ─────────────────────────────
  return "working";
}
