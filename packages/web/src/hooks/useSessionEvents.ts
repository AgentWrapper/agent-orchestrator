"use client";

import { useEffect, useReducer, useRef, useCallback } from "react";
import type { SessionPatch } from "@/lib/mux-protocol";
import {
  getAttentionLevel,
  isPRRateLimited,
  type ActivityState,
  type AttentionLevel,
  type DashboardAttentionZoneMode,
  type DashboardSession,
  type SessionStatus,
} from "@/lib/types";
import { fetchJsonWithTimeout } from "@/lib/client-fetch";

/** Debounce before fetching full session list after membership change. */
const MEMBERSHIP_REFRESH_DELAY_MS = 120;
/** Re-fetch full session list if no refresh has happened in this interval. */
const STALE_REFRESH_INTERVAL_MS = 15000;
const LIVE_REFRESH_TIMEOUT_MS = 6000;

function isAbortLikeError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === "AbortError";
  }

  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return message.includes("aborted") || message.includes("aborterror");
  }

  return false;
}

const VALID_ATTENTION_LEVELS = new Set<AttentionLevel>([
  "merge",
  "action",
  "respond",
  "review",
  "pending",
  "working",
  "done",
]) satisfies ReadonlySet<AttentionLevel>;
const VALID_ACTIVITY_STATES = new Set<ActivityState>([
  "active",
  "ready",
  "idle",
  "waiting_input",
  "blocked",
  "exited",
]) satisfies ReadonlySet<ActivityState>;
const VALID_SESSION_STATUSES = new Set<SessionStatus>([
  "spawning",
  "working",
  "detecting",
  "pr_open",
  "ci_failed",
  "review_pending",
  "changes_requested",
  "approved",
  "mergeable",
  "merged",
  "cleanup",
  "needs_input",
  "stuck",
  "errored",
  "killed",
  "idle",
  "done",
  "terminated",
]) satisfies ReadonlySet<SessionStatus>;

/** Server-computed attention levels from the latest snapshot. */
export type AttentionMap = Readonly<Record<string, AttentionLevel>>;

interface State {
  sessions: DashboardSession[];
  /** Attention levels from the latest snapshot (server-computed, includes PR state). */
  attentionLevels: AttentionMap;
  /**
   * True after a real success signal from the live path: HTTP 200 `/api/sessions`
   * refresh or a mux snapshot — not inferred from WS connect state, which fires
   * before any session data arrives.
   */
  liveSessionsResolved: boolean;
  /** Live error from the session transport (WS patch fetch failure). Null when healthy. */
  loadError: string | null;
}

type Action =
  | {
      type: "reset";
      sessions: DashboardSession[];
      attentionLevels?: AttentionMap;
      liveResolved?: boolean;
    }
  | { type: "snapshot"; patches: SessionPatch[] }
  | { type: "setLoadError"; error: string | null };

function isSamePR(
  previous: NonNullable<DashboardSession["pr"]>,
  incoming: NonNullable<DashboardSession["pr"]>,
): boolean {
  return (
    previous.url === incoming.url ||
    (previous.owner === incoming.owner &&
      previous.repo === incoming.repo &&
      previous.number === incoming.number)
  );
}

function ciChecksAgreeWithStatus(
  checks: NonNullable<DashboardSession["pr"]>["ciChecks"],
  status: NonNullable<DashboardSession["pr"]>["ciStatus"],
): boolean {
  if (checks.length === 0) return true;
  if (status === "passing") {
    return checks.every((check) => check.status === "passed" || check.status === "skipped");
  }
  if (status === "failing") return checks.some((check) => check.status === "failed");
  if (status === "pending") {
    return (
      checks.some((check) => check.status === "pending" || check.status === "running") &&
      checks.every((check) => check.status !== "failed")
    );
  }
  return false;
}

function preserveEnrichedPRDetails(
  previous: DashboardSession | undefined,
  incoming: DashboardSession,
): DashboardSession {
  if (!previous?.pr || !incoming.pr) return incoming;
  if (incoming.pr.enriched !== false || previous.pr.enriched === false) return incoming;
  if (!isSamePR(previous.pr, incoming.pr)) return incoming;
  if (isPRRateLimited(incoming.pr)) return incoming;

  const incomingMergeReady =
    incoming.attentionLevel === "merge" ||
    incoming.lifecycle?.prReason === "merge_ready" ||
    incoming.lifecycle?.prReason === "approved" ||
    incoming.status === "mergeable" ||
    incoming.status === "approved";
  const incomingApproved =
    incoming.lifecycle?.prReason === "approved" || incoming.status === "approved";
  const incomingCIFailed =
    incoming.lifecycle?.prReason === "ci_failing" || incoming.status === "ci_failed";
  const incomingChangesRequested =
    incoming.lifecycle?.prReason === "changes_requested" ||
    incoming.status === "changes_requested";
  const incomingReviewPending =
    incoming.lifecycle?.prReason === "review_pending" || incoming.status === "review_pending";
  const ciStatus = incomingMergeReady
    ? "passing"
    : incomingCIFailed
      ? "failing"
      : incoming.pr.ciStatus;
  const reviewDecision = incomingApproved
    ? "approved"
    : incomingChangesRequested
      ? "changes_requested"
      : incomingReviewPending
        ? "pending"
        : incoming.pr.reviewDecision;
  const mergeability = incomingMergeReady
    ? {
        ...previous.pr.mergeability,
        mergeable: true,
        ciPassing: true,
        noConflicts: incoming.pr.mergeability.noConflicts,
        blockers: incoming.pr.mergeability.blockers,
        approved: incomingApproved || reviewDecision === "approved",
      }
    : incoming.pr.mergeability;
  const ciChecks =
    incoming.pr.ciChecks.length > 0 || !ciChecksAgreeWithStatus(previous.pr.ciChecks, ciStatus)
      ? incoming.pr.ciChecks
      : previous.pr.ciChecks;

  return {
    ...incoming,
    pr: {
      ...previous.pr,
      number: incoming.pr.number,
      url: incoming.pr.url,
      owner: incoming.pr.owner,
      repo: incoming.pr.repo,
      branch: incoming.pr.branch,
      baseBranch: incoming.pr.baseBranch,
      isDraft: incoming.pr.isDraft,
      state: incoming.pr.state,
      ciStatus,
      ciChecks,
      reviewDecision,
      mergeability,
      unresolvedThreads: incoming.pr.unresolvedThreads,
      unresolvedComments: incoming.pr.unresolvedComments,
    },
  };
}

function preserveEnrichedPRs(
  previousSessions: DashboardSession[],
  incomingSessions: DashboardSession[],
): DashboardSession[] {
  const previousById = new Map(previousSessions.map((session) => [session.id, session]));
  return incomingSessions.map((session) =>
    preserveEnrichedPRDetails(previousById.get(session.id), session),
  );
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "setLoadError":
      return state.loadError === action.error ? state : { ...state, loadError: action.error };
    case "reset":
      return {
        ...state,
        sessions: preserveEnrichedPRs(state.sessions, action.sessions),
        ...(action.liveResolved ? { liveSessionsResolved: true, loadError: null } : {}),
        ...(action.attentionLevels !== undefined
          ? { attentionLevels: action.attentionLevels }
          : {}),
      };
    case "snapshot": {
      const patchMap = new Map(action.patches.map((p) => [p.id, p]));
      let changed = false;
      const next = state.sessions.map((s) => {
        const patch = patchMap.get(s.id);
        if (!patch) return s;
        if (
          s.status === patch.status &&
          s.activity === patch.activity &&
          s.lastActivityAt === patch.lastActivityAt
        ) {
          return s;
        }
        changed = true;
        return {
          ...s,
          status: VALID_SESSION_STATUSES.has(patch.status as SessionStatus)
            ? (patch.status as SessionStatus)
            : s.status,
          activity:
            patch.activity !== null && VALID_ACTIVITY_STATES.has(patch.activity as ActivityState)
              ? (patch.activity as ActivityState)
              : null,
          lastActivityAt: patch.lastActivityAt,
        };
      });

      // Build attention level map from server-computed values
      const levels: Record<string, AttentionLevel> = {};
      for (const p of action.patches) {
        if (!VALID_ATTENTION_LEVELS.has(p.attentionLevel as AttentionLevel)) {
          console.warn("[useSessionEvents] Unknown attentionLevel from server:", p.attentionLevel);
          continue;
        }
        levels[p.id] = p.attentionLevel as AttentionLevel;
      }

      const sessionsChanged = changed;
      const levelsChanged =
        Object.keys(levels).length !== Object.keys(state.attentionLevels).length ||
        action.patches.some((p) => state.attentionLevels[p.id] !== p.attentionLevel);

      if (!sessionsChanged && !levelsChanged) {
        if (state.liveSessionsResolved) return state;
        return { ...state, liveSessionsResolved: true };
      }

      return {
        ...state,
        sessions: sessionsChanged ? next : state.sessions,
        attentionLevels: levelsChanged ? levels : state.attentionLevels,
        liveSessionsResolved: true,
      };
    }
  }
}

function createMembershipKey(
  sessions: Array<Pick<DashboardSession, "id">> | SessionPatch[],
): string {
  return sessions
    .map((session) => session.id)
    .sort()
    .join("\0");
}

export interface UseSessionEventsOptions {
  initialSessions: DashboardSession[];
  project?: string;
  muxSessions?: Array<{
    id: string;
    status: string;
    activity: string | null;
    attentionLevel: AttentionLevel;
    lastActivityAt: string;
  }>;
  initialAttentionLevels?: AttentionMap;
  muxLastError?: string | null;
  disabled?: boolean;
  attentionZones: DashboardAttentionZoneMode;
}

export function useSessionEvents(options: UseSessionEventsOptions): State {
  const {
    initialSessions,
    project,
    muxSessions,
    initialAttentionLevels,
    muxLastError,
    disabled = false,
    attentionZones,
  } = options;
  const refreshScopeKey = `${project ?? ""}\0${disabled ? "disabled" : "enabled"}\0${attentionZones}`;
  const [state, dispatch] = useReducer(reducer, {
    sessions: initialSessions,
    attentionLevels: initialAttentionLevels ?? ({} as AttentionMap),
    liveSessionsResolved: false,
    loadError: null,
  });
  const sessionsRef = useRef(state.sessions);
  const initialAttentionLevelsRef = useRef(initialAttentionLevels);
  initialAttentionLevelsRef.current = initialAttentionLevels;
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingMembershipKeyRef = useRef<string | null>(null);
  const lastRefreshAtRef = useRef(0);
  const lastFetchStartedAtRef = useRef(0);
  const activeRefreshControllerRef = useRef<AbortController | null>(null);
  const refreshScopeKeyRef = useRef(refreshScopeKey);
  refreshScopeKeyRef.current = refreshScopeKey;
  const pageUnloadingRef = useRef(false);

  // Reset state when server-rendered props change (e.g. full page refresh)
  useEffect(() => {
    sessionsRef.current = state.sessions;
  }, [state.sessions]);

  useEffect(() => {
    dispatch({
      type: "reset",
      sessions: initialSessions,
      attentionLevels: initialAttentionLevelsRef.current ?? ({} as AttentionMap),
    });
  }, [initialSessions]);

  useEffect(() => {
    pageUnloadingRef.current = false;

    const markPageUnloading = () => {
      pageUnloadingRef.current = true;
    };

    window.addEventListener("pagehide", markPageUnloading);
    window.addEventListener("beforeunload", markPageUnloading);

    return () => {
      window.removeEventListener("pagehide", markPageUnloading);
      window.removeEventListener("beforeunload", markPageUnloading);
    };
  }, []);

  useEffect(() => {
    // Abort or discard refreshes when the semantic request scope changes.
    // This keeps old project/attention-zone/disabled responses from resetting
    // newer state while preserving the no-abort behavior for mux snapshot churn.
    pendingMembershipKeyRef.current = null;
    lastFetchStartedAtRef.current = 0;
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
    activeRefreshControllerRef.current?.abort();
    activeRefreshControllerRef.current = null;
  }, [refreshScopeKey]);

  // Define scheduleRefresh with useCallback so both effects can use it
  const scheduleRefresh = useCallback(() => {
    // Skip scheduling if a timer is already pending
    if (refreshTimerRef.current) return;
    // Skip if a fetch was already started recently (< 500ms ago)
    if (Date.now() - lastFetchStartedAtRef.current < 500) return;
    // Skip if a fetch is currently in flight (use controller as authoritative signal)
    if (activeRefreshControllerRef.current !== null) return;

    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      // Re-check in-flight state after the 120ms debounce window
      if (activeRefreshControllerRef.current !== null) return;
      const requestedMembershipKey = pendingMembershipKeyRef.current;
      const refreshScopeAtStart = refreshScopeKeyRef.current;
      const refreshController = new AbortController();
      activeRefreshControllerRef.current = refreshController;

      lastFetchStartedAtRef.current = Date.now();

      const sessionsUrl = project
        ? `/api/sessions?project=${encodeURIComponent(project)}`
        : "/api/sessions";

      void fetchJsonWithTimeout<{ sessions?: DashboardSession[] } | null>(sessionsUrl, {
        signal: refreshController.signal,
        cache: "no-store",
        timeoutMs: LIVE_REFRESH_TIMEOUT_MS,
        timeoutMessage: `Dashboard refresh timed out after ${LIVE_REFRESH_TIMEOUT_MS}ms`,
      })
        .then((updated) => {
          if (refreshScopeKeyRef.current !== refreshScopeAtStart) return;
          if (refreshController.signal.aborted || !updated?.sessions) {
            // Update timestamp even for non-OK responses to prevent retry storms
            if (!refreshController.signal.aborted) {
              lastRefreshAtRef.current = Date.now();
            }
            return;
          }

          lastRefreshAtRef.current = Date.now();
          const updatedSessions = preserveEnrichedPRs(sessionsRef.current, updated.sessions);
          const attentionLevels = Object.fromEntries(
            updatedSessions.map((s) => [s.id, getAttentionLevel(s, attentionZones)]),
          ) as AttentionMap;
          dispatch({
            type: "reset",
            sessions: updatedSessions,
            attentionLevels,
            liveResolved: true,
          });
        })
        .catch((err: unknown) => {
          if (
            refreshScopeKeyRef.current !== refreshScopeAtStart ||
            pageUnloadingRef.current ||
            refreshController.signal.aborted ||
            isAbortLikeError(err)
          ) {
            return;
          }
          console.warn("[useSessionEvents] refresh failed:", err);
          // Update timestamp on failure to prevent retry loops
          lastRefreshAtRef.current = Date.now();
        })
        .finally(() => {
          if (activeRefreshControllerRef.current === refreshController) {
            activeRefreshControllerRef.current = null;
          }
          if (refreshScopeKeyRef.current !== refreshScopeAtStart) return;
          if (refreshController.signal.aborted) {
            // If there's still a pending membership change, reschedule so it isn't lost
            if (pendingMembershipKeyRef.current !== null) {
              scheduleRefresh();
            }
            return;
          }

          if (
            pendingMembershipKeyRef.current !== null &&
            pendingMembershipKeyRef.current !== requestedMembershipKey
          ) {
            scheduleRefresh();
            return;
          }

          pendingMembershipKeyRef.current = null;
        });
    }, MEMBERSHIP_REFRESH_DELAY_MS);
  }, [project, attentionZones]);

  // Sync mux session-fetch errors into reducer state
  useEffect(() => {
    if (disabled) return;
    dispatch({ type: "setLoadError", error: muxLastError ?? null });
  }, [disabled, muxLastError]);

  // Mux-based session updates (replaces SSE when available)
  useEffect(() => {
    if (disabled || !muxSessions) return;
    // Note: empty array is intentional — it means all sessions were removed and we
    // must still run the membership-key comparison to trigger scheduleRefresh().

    // muxSessions is global (all projects). Filter to only sessions in the
    // current project-scoped state so we don't trigger spurious refreshes
    // when viewing a single-project page.
    const currentIds = new Set(sessionsRef.current.map((s) => s.id));
    const scopedMuxSessions = muxSessions.filter((s) => currentIds.has(s.id));
    // The mux feed is global, but the page is project-scoped. We can't tell from
    // a mux patch whether an unknown ID belongs to this project — only /api/sessions
    // knows. So if we see ANY id we don't have, trigger a refresh to find out.
    const hasUnknownIds = muxSessions.some((s) => !currentIds.has(s.id));

    dispatch({ type: "snapshot", patches: scopedMuxSessions as SessionPatch[] });

    const currentMembershipKey = createMembershipKey(sessionsRef.current);
    const snapshotMembershipKey = createMembershipKey(scopedMuxSessions);

    if (hasUnknownIds || currentMembershipKey !== snapshotMembershipKey) {
      pendingMembershipKeyRef.current = snapshotMembershipKey;
      scheduleRefresh();
    } else if (Date.now() - lastRefreshAtRef.current >= STALE_REFRESH_INTERVAL_MS) {
      scheduleRefresh();
    }

    // Do not abort the active refresh when a newer mux snapshot arrives. The
    // refresh path coalesces in-flight requests and applies the latest pending
    // membership key in finally(); aborting here turned every rapid snapshot
    // sequence into a local request-cancel loop.
  }, [disabled, muxSessions, scheduleRefresh]);

  // Unmount-only cleanup: clear the debounce timer to prevent leaks.
  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      activeRefreshControllerRef.current?.abort();
      activeRefreshControllerRef.current = null;
    };
  }, []);

  return state;
}
