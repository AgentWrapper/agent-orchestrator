import "server-only";

/**
 * Core Session → DashboardSession serialization.
 *
 * Converts core types (Date objects, PRInfo) into dashboard types
 * (string dates, flattened DashboardPR) suitable for JSON serialization.
 */

import {
  isOrchestratorSession,
  isTerminalSession,
  type Session,
  type Agent,
  type PRInfo,
  type Tracker,
  type ProjectConfig,
  type OrchestratorConfig,
  type PluginRegistry,
} from "@aoagents/ao-core";
import {
  type DashboardSession,
  type DashboardPR,
  type DashboardStats,
  type DashboardOrchestratorLink,
  getAttentionLevel,
} from "./types";
import { TTLCache, type PREnrichmentData } from "./cache";
import { matchesSessionPrefix } from "./session-utils";

/** Cache for issue titles (5 min TTL — issue titles rarely change) */
const issueTitleCache = new TTLCache<string>(300_000);
/** Cache failed issue-title lookups to avoid repeated tracker API calls. */
const issueTitleMissCache = new TTLCache<boolean>(120_000);

function isAbsoluteUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Resolve which project a session belongs to. */
export function resolveProject(
  core: Session,
  projects: Record<string, ProjectConfig>,
): ProjectConfig | undefined {
  // Try explicit projectId first
  const direct = projects[core.projectId];
  if (direct) return direct;

  // Match by session prefix
  const entry = Object.entries(projects).find(([, p]) =>
    matchesSessionPrefix(core.id, p.sessionPrefix),
  );
  if (entry) return entry[1];

  // Fall back to first project
  const firstKey = Object.keys(projects)[0];
  return firstKey ? projects[firstKey] : undefined;
}

function humanizeLifecycleToken(token: string): string {
  return token.replace(/_/g, " ");
}

function buildLifecycleLabel(state: string, reason: string): string {
  if (state === "idle" && reason === "merged_waiting_decision") {
    return "merged, waiting decision";
  }
  if (state === "none") {
    return "not created";
  }
  if (state === "alive") {
    return "alive";
  }
  if (state === "missing") {
    return "missing";
  }
  return humanizeLifecycleToken(state);
}

function buildLifecycleSummary(session: Session): string {
  const { lifecycle } = session;
  if (lifecycle.session.state === "detecting") {
    return `Detecting runtime truth (${humanizeLifecycleToken(lifecycle.session.reason)})`;
  }
  if (lifecycle.pr.state === "merged") {
    return session.metadata["mergedPendingCleanupSince"]
      ? "PR merged; worker session will be cleaned up automatically"
      : "PR merged";
  }
  if (lifecycle.pr.state === "closed") {
    return "PR closed without merge";
  }
  if (lifecycle.pr.reason === "ci_failing") {
    return "PR is open and CI is failing";
  }
  if (lifecycle.pr.reason === "changes_requested") {
    return "PR is open with requested changes";
  }
  if (lifecycle.pr.reason === "review_pending") {
    return "PR is open and waiting on review";
  }
  return `Session ${humanizeLifecycleToken(lifecycle.session.state)} (${humanizeLifecycleToken(lifecycle.session.reason)})`;
}

function buildDashboardLifecycle(session: Session): NonNullable<DashboardSession["lifecycle"]> {
  const lifecycle = session.lifecycle;
  return {
    sessionState: lifecycle.session.state,
    sessionReason: lifecycle.session.reason,
    prState: lifecycle.pr.state,
    prReason: lifecycle.pr.reason,
    runtimeState: lifecycle.runtime.state,
    runtimeReason: lifecycle.runtime.reason,
    session: {
      state: lifecycle.session.state,
      reason: lifecycle.session.reason,
      label: buildLifecycleLabel(lifecycle.session.state, lifecycle.session.reason),
      reasonLabel: humanizeLifecycleToken(lifecycle.session.reason),
      startedAt: lifecycle.session.startedAt,
      completedAt: lifecycle.session.completedAt,
      terminatedAt: lifecycle.session.terminatedAt,
      lastTransitionAt: lifecycle.session.lastTransitionAt,
    },
    pr: {
      state: lifecycle.pr.state,
      reason: lifecycle.pr.reason,
      label: buildLifecycleLabel(lifecycle.pr.state, lifecycle.pr.reason),
      reasonLabel: humanizeLifecycleToken(lifecycle.pr.reason),
      number: lifecycle.pr.number,
      url: lifecycle.pr.url,
      lastObservedAt: lifecycle.pr.lastObservedAt,
    },
    runtime: {
      state: lifecycle.runtime.state,
      reason: lifecycle.runtime.reason,
      label: buildLifecycleLabel(lifecycle.runtime.state, lifecycle.runtime.reason),
      reasonLabel: humanizeLifecycleToken(lifecycle.runtime.reason),
      lastObservedAt: lifecycle.runtime.lastObservedAt,
    },
    legacyStatus: session.status,
    evidence: session.metadata["lifecycleEvidence"] ?? null,
    detectingAttempts: Number.parseInt(session.metadata["detectingAttempts"] ?? "0", 10) || 0,
    detectingEscalatedAt: session.metadata["detectingEscalatedAt"] ?? null,
    summary: buildLifecycleSummary(session),
    guidance: null,
  };
}

export function refreshDashboardSessionDerivedFields(session: DashboardSession): DashboardSession {
  session.attentionLevel = getAttentionLevel(session);
  return session;
}

/** Convert a core Session to a DashboardSession (without PR/issue enrichment). */
export function sessionToDashboard(session: Session): DashboardSession {
  const agentSummary = session.agentInfo?.summary;
  const summary = agentSummary ?? session.metadata["summary"] ?? null;

  return refreshDashboardSessionDerivedFields({
    id: session.id,
    projectId: session.projectId,
    status: session.status,
    activity: session.activity,
    activitySignal: {
      state: session.activitySignal.state,
      activity: session.activitySignal.activity,
      timestamp: session.activitySignal.timestamp?.toISOString() ?? null,
      source: session.activitySignal.source,
      detail: session.activitySignal.detail,
    },
    lifecycle: buildDashboardLifecycle(session),
    branch: session.branch,
    issueId: session.issueId, // Deprecated: kept for backwards compatibility
    issueUrl: session.issueId && isAbsoluteUrl(session.issueId) ? session.issueId : null,
    issueLabel: null, // Will be enriched by enrichSessionIssue()
    issueTitle: null, // Will be enriched by enrichSessionIssueTitle()
    userPrompt: session.metadata["userPrompt"] ?? null,
    displayName: session.metadata["displayName"] ?? null,
    summary,
    summaryIsFallback: agentSummary ? (session.agentInfo?.summaryIsFallback ?? false) : false,
    createdAt: session.createdAt.toISOString(),
    lastActivityAt: session.lastActivityAt.toISOString(),
    pr: session.pr
      ? {
          ...basicPRToDashboard(session.pr),
          state: normalizeDashboardPRState(session.lifecycle.pr.state),
        }
      : null,
    metadata: session.metadata,
    agentReportAudit: [],
  });
}

export function listDashboardOrchestrators(
  sessions: Session[],
  projects: Record<string, ProjectConfig>,
): DashboardOrchestratorLink[] {
  const allSessionPrefixes = Object.entries(projects).map(
    ([projectId, p]) => p.sessionPrefix ?? projectId,
  );
  const bestByProject = new Map<string, Session>();

  for (const session of sessions) {
    if (
      !isOrchestratorSession(
        session,
        projects[session.projectId]?.sessionPrefix ?? session.projectId,
        allSessionPrefixes,
      )
    ) {
      continue;
    }

    const current = bestByProject.get(session.projectId);
    if (!current) {
      bestByProject.set(session.projectId, session);
      continue;
    }

    const currentIsTerminal = isTerminalSession(current);
    const candidateIsTerminal = isTerminalSession(session);
    if (currentIsTerminal !== candidateIsTerminal) {
      if (!candidateIsTerminal) {
        bestByProject.set(session.projectId, session);
      }
      continue;
    }

    const currentActivity = current.lastActivityAt?.getTime() ?? current.createdAt?.getTime() ?? 0;
    const candidateActivity =
      session.lastActivityAt?.getTime() ?? session.createdAt?.getTime() ?? 0;
    if (candidateActivity > currentActivity) {
      bestByProject.set(session.projectId, session);
      continue;
    }

    if (candidateActivity === currentActivity && session.id.localeCompare(current.id) > 0) {
      bestByProject.set(session.projectId, session);
    }
  }

  return [...bestByProject.values()]
    .map((session) => ({
      id: session.id,
      projectId: session.projectId,
      projectName: projects[session.projectId]?.name ?? session.projectId,
    }))
    .sort((a, b) => a.projectName.localeCompare(b.projectName) || a.id.localeCompare(b.id));
}

/**
 * Convert minimal PRInfo to a DashboardPR with default values for enriched fields.
 * These defaults indicate "data not yet loaded" rather than "failing".
 * Use enrichSessionPR() to populate with live data from SCM.
 */
function basicPRToDashboard(pr: PRInfo): DashboardPR {
  return {
    number: pr.number,
    url: pr.url,
    title: pr.title,
    owner: pr.owner,
    repo: pr.repo,
    branch: pr.branch,
    baseBranch: pr.baseBranch,
    isDraft: pr.isDraft,
    state: "open",
    additions: 0,
    deletions: 0,
    ciStatus: "none", // "none" is neutral (no checks configured)
    ciChecks: [],
    reviewDecision: "none", // "none" is neutral (no review required)
    mergeability: {
      mergeable: false,
      ciPassing: false, // Conservative default
      approved: false,
      noConflicts: true, // Optimistic default (conflicts are rare)
      blockers: [],
    },
    unresolvedThreads: 0,
    unresolvedComments: [],
    enriched: false,
  };
}

function normalizeDashboardPRState(
  state: Session["lifecycle"]["pr"]["state"],
): DashboardPR["state"] {
  switch (state) {
    case "merged":
      return "merged";
    case "closed":
      return "closed";
    default:
      return "open";
  }
}

/**
 * Enrich a DashboardSession's PR with live data from the SCM plugin.
 * Uses cache to reduce API calls and handles rate limit errors gracefully.
 */
/**
 * Read PR enrichment data from session metadata.
 * The CLI lifecycle manager writes this data every 30s (batch enrichment)
 * and every 2min (review comments). Returns null if not available.
 */
export function readPREnrichmentFromMetadata(
  metadata: Record<string, string>,
): PREnrichmentData | null {
  const enrichmentRaw = metadata["prEnrichment"];
  if (!enrichmentRaw) return null;

  try {
    const e = JSON.parse(enrichmentRaw);

    let reviewData = {
      unresolvedThreads: 0,
      unresolvedComments: [] as Array<{ url: string; path: string; author: string; body: string }>,
    };
    const reviewRaw = metadata["prReviewComments"];
    if (reviewRaw) {
      try {
        reviewData = JSON.parse(reviewRaw);
      } catch {
        /* use defaults */
      }
    }

    return {
      state: e.state ?? "open",
      title: e.title ?? "",
      additions: e.additions ?? 0,
      deletions: e.deletions ?? 0,
      ciStatus: e.ciStatus ?? "none",
      ciChecks: (e.ciChecks ?? []).map(
        (c: { name: string; status: string; url?: string }) => ({
          name: c.name,
          status: c.status,
          url: c.url,
        }),
      ),
      reviewDecision: e.reviewDecision ?? "none",
      mergeability: {
        mergeable: e.mergeable ?? false,
        ciPassing: e.ciStatus === "passing" || e.ciStatus === "none",
        approved: e.reviewDecision === "approved",
        noConflicts: !(e.hasConflicts ?? false),
        blockers: e.blockers ?? [],
      },
      unresolvedThreads: reviewData.unresolvedThreads ?? 0,
      unresolvedComments: reviewData.unresolvedComments ?? [],
    };
  } catch {
    return null;
  }
}

/**
 * Enrich a DashboardSession's PR data from session metadata.
 * The CLI lifecycle manager persists batch enrichment data to metadata files.
 * No GitHub API calls — reads from disk via the metadata already loaded.
 */
export function enrichSessionPR(
  dashboard: DashboardSession,
): boolean {
  if (!dashboard.pr) return false;

  const data = readPREnrichmentFromMetadata(dashboard.metadata);
  if (!data) return false;

  dashboard.pr.state = data.state;
  if (data.title) dashboard.pr.title = data.title;
  dashboard.pr.additions = data.additions;
  dashboard.pr.deletions = data.deletions;
  dashboard.pr.ciStatus = data.ciStatus;
  dashboard.pr.ciChecks = data.ciChecks;
  dashboard.pr.reviewDecision = data.reviewDecision;
  dashboard.pr.mergeability = data.mergeability;
  dashboard.pr.unresolvedThreads = data.unresolvedThreads;
  dashboard.pr.unresolvedComments = data.unresolvedComments;
  dashboard.pr.enriched = true;
  refreshDashboardSessionDerivedFields(dashboard);
  return true;
}

/** Enrich a DashboardSession's issue URL and label using the tracker plugin. */
export function enrichSessionIssue(
  dashboard: DashboardSession,
  tracker: Tracker,
  project: ProjectConfig,
): void {
  const issueReference = dashboard.issueId ?? dashboard.issueUrl;
  if (!issueReference) return;

  if (isAbsoluteUrl(issueReference)) {
    dashboard.issueUrl = issueReference;
  } else if (/\s/.test(issueReference)) {
    // Free-text issue IDs are user notes, not tracker identifiers.
    dashboard.issueUrl = null;
  } else if (tracker.issueUrl) {
    try {
      const candidateUrl = tracker.issueUrl(issueReference, project);
      if (candidateUrl && isAbsoluteUrl(candidateUrl)) {
        dashboard.issueUrl = candidateUrl;
      } else {
        console.warn("[enrichSessionIssue] tracker.issueUrl() returned a non-absolute URL", {
          tracker: tracker.name,
          issueReference,
          candidateUrl,
        });
      }
    } catch (error) {
      console.warn("[enrichSessionIssue] tracker.issueUrl() failed", {
        tracker: tracker.name,
        issueReference,
        error: String(error),
      });
    }
  }

  if (!dashboard.issueUrl) return;

  // Use tracker plugin to extract human-readable label from URL
  if (tracker.issueLabel) {
    try {
      dashboard.issueLabel = tracker.issueLabel(dashboard.issueUrl, project);
    } catch {
      // If extraction fails, fall back to extracting from URL manually
      const parts = dashboard.issueUrl.split("/");
      dashboard.issueLabel = parts[parts.length - 1] || dashboard.issueUrl;
    }
  } else {
    // Fallback if tracker doesn't implement issueLabel method
    const parts = dashboard.issueUrl.split("/");
    dashboard.issueLabel = parts[parts.length - 1] || dashboard.issueUrl;
  }
}

/**
 * Enrich a DashboardSession's summary by calling agent.getSessionInfo().
 * Only fetches when the session doesn't already have a summary.
 * Reads the agent's JSONL file on disk — fast local I/O, not an API call.
 */
export async function enrichSessionAgentSummary(
  dashboard: DashboardSession,
  coreSession: Session,
  agent: Agent,
): Promise<void> {
  if (dashboard.summary) return;
  try {
    const info = await agent.getSessionInfo(coreSession);
    if (info?.summary) {
      dashboard.summary = info.summary;
      dashboard.summaryIsFallback = info.summaryIsFallback ?? false;
    }
  } catch {
    // Can't read agent session info — keep summary null
  }
}

/**
 * Enrich a DashboardSession's issue title by calling tracker.getIssue().
 * Extracts the identifier from the issue URL using issueLabel(),
 * then fetches full issue details for the title.
 */
export async function enrichSessionIssueTitle(
  dashboard: DashboardSession,
  tracker: Tracker,
  project: ProjectConfig,
): Promise<void> {
  if (!dashboard.issueUrl || !dashboard.issueLabel) return;

  // Check cache first
  const cached = issueTitleCache.get(dashboard.issueUrl);
  if (cached) {
    dashboard.issueTitle = cached;
    return;
  }
  if (issueTitleMissCache.get(dashboard.issueUrl)) {
    return;
  }

  try {
    // Strip "#" prefix from GitHub-style labels to get the identifier
    const identifier = dashboard.issueLabel.replace(/^#/, "");
    const issue = await tracker.getIssue(identifier, project);
    if (issue.title) {
      dashboard.issueTitle = issue.title;
      issueTitleCache.set(dashboard.issueUrl, issue.title);
    }
  } catch {
    issueTitleMissCache.set(dashboard.issueUrl, true);
    // Can't fetch issue — keep issueTitle null
  }
}

/**
 * Fast-path metadata enrichment: issue labels (sync) + agent summaries (local I/O).
 * Does NOT call tracker API for issue titles — use enrichSessionsMetadata() for full enrichment.
 */
export async function enrichSessionsMetadataFast(
  coreSessions: Session[],
  dashboardSessions: DashboardSession[],
  config: OrchestratorConfig,
  registry: PluginRegistry,
): Promise<void> {
  const { summaryPromises } = prepareSessionMetadataEnrichment(
    coreSessions,
    dashboardSessions,
    config,
    registry,
  );

  await Promise.allSettled(summaryPromises);
}

function prepareSessionMetadataEnrichment(
  coreSessions: Session[],
  dashboardSessions: DashboardSession[],
  config: OrchestratorConfig,
  registry: PluginRegistry,
): {
  projects: Array<ProjectConfig | undefined>;
  summaryPromises: Promise<void>[];
} {
  const projects = coreSessions.map((core) => resolveProject(core, config.projects));

  // Issue labels (synchronous string parsing, no API calls)
  projects.forEach((project, i) => {
    if (
      (!dashboardSessions[i].issueUrl && !dashboardSessions[i].issueId) ||
      !project?.tracker?.plugin
    ) {
      return;
    }
    const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
    if (!tracker) return;
    enrichSessionIssue(dashboardSessions[i], tracker, project);
  });

  // Agent summaries (local disk I/O — reads agent JSONL)
  const summaryPromises = coreSessions.map((core, i) => {
    if (dashboardSessions[i].summary) return Promise.resolve();
    const agentName = projects[i]?.agent ?? config.defaults.agent;
    if (!agentName) return Promise.resolve();
    const agent = registry.get<Agent>("agent", agentName);
    if (!agent) return Promise.resolve();
    return enrichSessionAgentSummary(dashboardSessions[i], core, agent);
  });

  return { projects, summaryPromises };
}

/**
 * Full metadata enrichment: issue labels, agent summaries, AND issue titles (tracker API).
 * Used by /api/sessions for complete data. For SSR fast path, use enrichSessionsMetadataFast().
 */
export async function enrichSessionsMetadata(
  coreSessions: Session[],
  dashboardSessions: DashboardSession[],
  config: OrchestratorConfig,
  registry: PluginRegistry,
): Promise<void> {
  const { projects, summaryPromises } = prepareSessionMetadataEnrichment(
    coreSessions,
    dashboardSessions,
    config,
    registry,
  );

  // Issue-title fetches depend on labels being set, but can run in parallel with summary I/O.
  const issueTitlePromises = projects.map((project, i) => {
    if (!dashboardSessions[i].issueUrl || !dashboardSessions[i].issueLabel) {
      return Promise.resolve();
    }
    if (!project?.tracker?.plugin) return Promise.resolve();
    const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
    if (!tracker) return Promise.resolve();
    return enrichSessionIssueTitle(dashboardSessions[i], tracker, project);
  });

  await Promise.allSettled([...summaryPromises, ...issueTitlePromises]);
}

/** Compute dashboard stats from a list of sessions. */
export function computeStats(sessions: DashboardSession[]): DashboardStats {
  return {
    totalSessions: sessions.length,
    workingSessions: sessions.filter((s) => s.activity !== null && s.activity !== "exited").length,
    openPRs: sessions.filter((s) => s.pr?.state === "open").length,
    needsReview: sessions.filter((s) => s.pr && !s.pr.isDraft && s.pr.reviewDecision === "pending")
      .length,
  };
}
