/**
 * Dashboard-specific types for the web UI.
 *
 * Core types (SessionStatus, ActivityState, CIStatus, ReviewDecision, etc.)
 * are re-exported from @composio/ao-core. Dashboard-specific types
 * extend/flatten the core types for client-side rendering (e.g. DashboardPR
 * flattens core PRInfo + MergeReadiness + CICheck[] + ReviewComment[]).
 */

// Re-export core types used directly by the dashboard
export type {
  SessionStatus,
  ActivityState,
  CIStatus,
  ReviewDecision,
  MergeReadiness,
  PRState,
} from "@composio/ao-core/types";

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
  type ReviewDecision,
} from "@composio/ao-core/types";

// Re-export for use in client components
export { TERMINAL_STATUSES, TERMINAL_ACTIVITIES, NON_RESTORABLE_STATUSES };

/**
 * Attention zone priority level, ordered by human action urgency:
 *
 * 1. merge   — PR approved + CI green. One click to clear. Highest ROI.
 * 2. respond — Agent waiting for human input. Quick unblock, agent resumes.
 * 3. review  — CI failed, changes requested, conflicts. Needs investigation.
 * 4. pending — Waiting on external (reviewer, CI). Nothing to do right now.
 * 5. working — Agents doing their thing. Don't interrupt.
 * 6. done    — Merged or terminated. Archive.
 */
export type AttentionLevel = "merge" | "respond" | "review" | "pending" | "working" | "done";

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
  branch: string | null;
  issueId: string | null; // Deprecated: use issueUrl instead
  issueUrl: string | null; // Full issue URL
  issueLabel: string | null; // Human-readable label (e.g., "INT-1327", "#42")
  issueTitle: string | null; // Full issue title (e.g., "Add user authentication flow")
  summary: string | null;
  /** True when the summary is a low-quality fallback (e.g. truncated spawn prompt) */
  summaryIsFallback: boolean;
  createdAt: string;
  lastActivityAt: string;
  pr: DashboardPR | null;
  metadata: Record<string, string>;
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
  ciStatus: CIStatus;
  ciChecks: DashboardCICheck[];
  reviewDecision: ReviewDecision;
  mergeability: DashboardMergeability;
  unresolvedThreads: number;
  unresolvedComments: DashboardUnresolvedComment[];
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

/** Shape of a single session in SSE events. */
export interface SSESessionEntry {
  id: string;
  status: SessionStatus;
  activity: ActivityState | null;
  attentionLevel: AttentionLevel;
  lastActivityAt: string;
}

/** SSE snapshot event from /api/events — full state replacement. */
export interface SSESnapshotEvent {
  type: "snapshot";
  sessions: SSESessionEntry[];
}

/**
 * SSE diff event from /api/events — incremental update.
 * Only contains sessions that changed since the last event.
 * `removed` lists session IDs that no longer exist.
 */
export interface SSEDiffEvent {
  type: "diff";
  updated: SSESessionEntry[];
  removed: string[];
}

/** SSE activity update event from /api/events */
export interface SSEActivityEvent {
  type: "session.activity";
  sessionId: string;
  activity: ActivityState | null;
  status: SessionStatus;
  attentionLevel: AttentionLevel;
  timestamp: string;
}

/**
 * Returns true when this PR's enrichment data couldn't be fetched due to
 * API rate limiting. When true, CI status / review decision / mergeability
 * may be stale defaults — don't make decisions based on them.
 */
export function isPRRateLimited(pr: DashboardPR): boolean {
  return pr.mergeability.blockers.includes("API rate limited or unavailable");
}

/** Determines which attention zone a session belongs to */
export function getAttentionLevel(session: DashboardSession): AttentionLevel {
  // ── Done: terminal states ─────────────────────────────────────────
  if (
    session.status === "merged" ||
    session.status === "killed" ||
    session.status === "cleanup" ||
    session.status === "done" ||
    session.status === "terminated"
  ) {
    return "done";
  }
  if (session.pr) {
    if (session.pr.state === "merged" || session.pr.state === "closed") {
      return "done";
    }
  }

  // ── Merge: PR is ready — one click to clear ───────────────────────
  // Check this early: if the PR is mergeable, that's the most valuable
  // action for the human regardless of agent activity.
  if (session.status === "mergeable" || session.status === "approved") {
    return "merge";
  }
  if (session.pr?.mergeability.mergeable) {
    return "merge";
  }

  // ── Respond: agent is waiting for human input ─────────────────────
  // Check status-based error conditions first — these are authoritative
  // and should not be masked by a stale activity value.
  if (
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
  if (session.status === "ci_failed" || session.status === "changes_requested") {
    return "review";
  }
  if (session.pr && !isPRRateLimited(session.pr)) {
    const pr = session.pr;
    if (pr.ciStatus === CI_STATUS.FAILING) return "review";
    if (pr.reviewDecision === "changes_requested") return "review";
    if (!pr.mergeability.noConflicts) return "review";
  }

  // ── Pending: waiting on external (reviewer, CI) ───────────────────
  if (session.status === "review_pending") {
    return "pending";
  }
  if (session.pr && !isPRRateLimited(session.pr)) {
    const pr = session.pr;
    if (!pr.isDraft && pr.unresolvedThreads > 0) return "pending";
    if (!pr.isDraft && (pr.reviewDecision === "pending" || pr.reviewDecision === "none")) {
      return "pending";
    }
  }

  // ── Working: agents doing their thing ─────────────────────────────
  return "working";
}
