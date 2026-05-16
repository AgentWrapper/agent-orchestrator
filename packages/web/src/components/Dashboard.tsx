"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMediaQuery, MOBILE_BREAKPOINT } from "@/hooks/useMediaQuery";
import {
  type DashboardSession,
  type AttentionLevel,
  type DashboardOrchestratorLink,
  type DashboardAttentionZoneMode,
  getAttentionLevel,
  isPRRateLimited,
  isDashboardSessionRestorable,
  isDashboardSessionTerminated,
} from "@/lib/types";
import { AttentionZone } from "./AttentionZone";
import { DynamicFavicon, countNeedingAttention } from "./DynamicFavicon";
import { useSessionEvents } from "@/hooks/useSessionEvents";
import { useMuxOptional } from "@/providers/MuxProvider";
import { ProjectSidebar } from "./ProjectSidebar";
import type { ProjectInfo } from "@/lib/project-name";
import { EmptyState } from "./Skeleton";
import { ToastProvider, useToast } from "./Toast";
import { ConnectionBar } from "./ConnectionBar";
import { UpdateBanner } from "./UpdateBanner";
import { CopyDebugBundleButton } from "./CopyDebugBundleButton";
import { SidebarContext } from "./workspace/SidebarContext";
import { projectDashboardPath, projectSessionPath } from "@/lib/routes";
import { BottomSheet } from "./BottomSheet";

interface DashboardProps {
  initialSessions: DashboardSession[];
  projectId?: string;
  projectName?: string;
  projects?: ProjectInfo[];
  orchestrators?: DashboardOrchestratorLink[];
  /** Dashboard attention zone mode (defaults to "simple" — 4 zones). */
  attentionZones?: DashboardAttentionZoneMode;
  /** SSR/services failure — show an error banner instead of a misleading empty dashboard */
  dashboardLoadError?: string;
}

const SIMPLE_KANBAN_LEVELS = ["working", "pending", "action", "merge"] as const;
const DETAILED_KANBAN_LEVELS = ["working", "pending", "review", "respond", "merge"] as const;
const EMPTY_ORCHESTRATORS: DashboardOrchestratorLink[] = [];

function formatRelativeTimeCompact(isoDate: string | null): string {
  if (!isoDate) return "just now";
  const timestamp = new Date(isoDate).getTime();
  if (!Number.isFinite(timestamp)) return "just now";

  const diffMs = Date.now() - timestamp;
  if (diffMs <= 0) return "just now";

  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return `${diffSecs}s ago`;
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

function mergeOrchestrators(
  current: DashboardOrchestratorLink[],
  incoming: DashboardOrchestratorLink[],
): DashboardOrchestratorLink[] {
  const merged = new Map(current.map((orchestrator) => [orchestrator.projectId, orchestrator]));

  for (const orchestrator of incoming) {
    merged.set(orchestrator.projectId, orchestrator);
  }

  return [...merged.values()];
}

function DoneCard({
  session,
  onRestore,
}: {
  session: DashboardSession;
  onRestore: (id: string) => void;
}) {
  const title =
    (!session.summaryIsFallback && session.summary) ||
    session.issueTitle ||
    session.summary ||
    session.id;
  const isMerged = session.pr?.state === "merged" || session.status === "merged";
  const isTerminated = isDashboardSessionTerminated(session);
  const canRestore = isDashboardSessionRestorable(session);
  const badgeLabel = isMerged ? "merged" : isTerminated ? "terminated" : "done";
  const badgeClass = `done-card__badge ${isTerminated ? "done-card__badge--terminated" : "done-card__badge--merged"}`;

  return (
    <div className="done-card">
      <p className="done-card__title">{title}</p>
      <div className="done-card__meta">
        <span className={badgeClass}>{badgeLabel}</span>
        {session.pr ? (
          <a
            href={session.pr.url}
            target="_blank"
            rel="noopener noreferrer"
            className="done-card__pr"
            onClick={(e) => e.stopPropagation()}
          >
            <svg
              width="9"
              height="9"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              viewBox="0 0 24 24"
            >
              <circle cx="18" cy="18" r="3" />
              <circle cx="6" cy="6" r="3" />
              <path d="M6 9v3a6 6 0 0 0 6 6h3" />
            </svg>
            #{session.pr.number}
          </a>
        ) : null}
        <span className="done-card__age">{formatRelativeTimeCompact(session.lastActivityAt)}</span>
        {canRestore && !isMerged ? (
          <button
            type="button"
            className="done-card__restore"
            onClick={(e) => {
              e.stopPropagation();
              onRestore(session.id);
            }}
          >
            Restore
          </button>
        ) : null}
      </div>
    </div>
  );
}

function DashboardInner({
  initialSessions,
  projectId,
  projectName,
  projects = [],
  orchestrators,
  attentionZones = "simple",
  dashboardLoadError,
}: DashboardProps) {
  const orchestratorLinks = orchestrators ?? EMPTY_ORCHESTRATORS;
  const mux = useMuxOptional();
  const kanbanLevels =
    attentionZones === "detailed" ? DETAILED_KANBAN_LEVELS : SIMPLE_KANBAN_LEVELS;
  const initialAttentionLevels = useMemo(() => {
    const levels: Record<string, AttentionLevel> = {};
    for (const s of initialSessions) {
      levels[s.id] = getAttentionLevel(s, attentionZones);
    }
    return levels;
  }, [initialSessions, attentionZones]);
  const { sessions, attentionLevels, liveSessionsResolved, loadError } = useSessionEvents({
    initialSessions,
    // No project filter — sidebar needs all sessions across all projects.
    // Kanban filtering is applied client-side via projectSessions below.
    muxSessions: mux?.status === "connected" ? mux.sessions : undefined,
    muxLastError: mux?.lastError,
    initialAttentionLevels,
    attentionZones,
  });

  const projectSessions = useMemo(() => {
    if (!projectId) return sessions;
    return sessions.filter((s) => s.projectId === projectId);
  }, [sessions, projectId]);
  const connectionStatus: "connected" | "reconnecting" | "disconnected" =
    mux?.status === "disconnected"
      ? "disconnected"
      : mux?.status === "connected"
        ? "connected"
        : "reconnecting";
  const recoveredFromLoadError = Boolean(dashboardLoadError) && liveSessionsResolved;
  const ssrLoadError = recoveredFromLoadError ? undefined : dashboardLoadError;
  // Live WS error takes precedence; fall back to SSR load error when live data hasn't resolved it.
  const visibleLoadError = loadError ?? ssrLoadError;
  const searchParams = useSearchParams();
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;
  const activeSessionId = searchParams.get("session") ?? undefined;
  const [rateLimitDismissed, setRateLimitDismissed] = useState(false);
  const [activeOrchestrators, setActiveOrchestrators] =
    useState<DashboardOrchestratorLink[]>(orchestratorLinks);
  const [spawningProjectIds, setSpawningProjectIds] = useState<string[]>([]);
  const [spawnErrors, setSpawnErrors] = useState<Record<string, string>>({});
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const isMobile = useMediaQuery(MOBILE_BREAKPOINT);
  const [collapsedZones, setCollapsedZones] = useState<Set<AttentionLevel>>(
    () => new Set<AttentionLevel>(["done", "working"]),
  );
  const [previewSession, setPreviewSession] = useState<DashboardSession | null>(null);
  const [bottomSheetMode, setBottomSheetMode] = useState<"preview" | "confirm-kill">("preview");
  const debugParam = searchParams.get("debug");
  const showDebugBundleButton =
    !isMobile &&
    (process.env.NODE_ENV === "development" || debugParam === "1" || debugParam === "true");
  const { showToast } = useToast();
  const [doneExpanded, setDoneExpanded] = useState(false);
  const sessionsRef = useRef(sessions);

  sessionsRef.current = sessions;
  const allProjectsView = projects.length > 1 && projectId === undefined;
  const currentProjectOrchestrator = useMemo(
    () =>
      projectId
        ? (activeOrchestrators.find((orchestrator) => orchestrator.projectId === projectId) ?? null)
        : null,
    [activeOrchestrators, projectId],
  );
  const orchestratorHref = currentProjectOrchestrator
    ? projectSessionPath(currentProjectOrchestrator.projectId, currentProjectOrchestrator.id)
    : null;
  const canSpawnProjectOrchestrator =
    !allProjectsView &&
    Boolean(projectId) &&
    projects.some((project) => project.id === projectId && !project.resolveError) &&
    !orchestratorHref;
  const activeProject = projectId
    ? (projects.find((project) => project.id === projectId) ?? null)
    : null;
  const isSpawningCurrentProject = projectId ? spawningProjectIds.includes(projectId) : false;
  const currentProjectSpawnError = projectId ? (spawnErrors[projectId] ?? null) : null;

  const displaySessions = useMemo(() => {
    if (allProjectsView || !activeSessionId) return projectSessions;
    return projectSessions.filter((s) => s.id === activeSessionId);
  }, [projectSessions, allProjectsView, activeSessionId]);

  useEffect(() => {
    setActiveOrchestrators((current) => mergeOrchestrators(current, orchestratorLinks));
  }, [orchestratorLinks]);

  // Update document title with live attention counts
  useEffect(() => {
    const needsAttention = countNeedingAttention(attentionLevels);
    const label = projectName ?? "ao";
    document.title = needsAttention > 0 ? `${label} (${needsAttention} need attention)` : label;
  }, [attentionLevels, projectName]);

  useEffect(() => {
    setMobileMenuOpen(false);
  }, [searchParams]);

  const grouped = useMemo(() => {
    const zones: Record<AttentionLevel, DashboardSession[]> = {
      merge: [],
      action: [],
      respond: [],
      review: [],
      pending: [],
      working: [],
      done: [],
    };
    for (const session of displaySessions) {
      zones[getAttentionLevel(session, attentionZones)].push(session);
    }
    return zones;
  }, [displaySessions, attentionZones]);

  const sessionsByProject = useMemo(() => {
    const groupedSessions = new Map<string, DashboardSession[]>();
    for (const session of sessions) {
      const projectSessions = groupedSessions.get(session.projectId);
      if (projectSessions) {
        projectSessions.push(session);
        continue;
      }
      groupedSessions.set(session.projectId, [session]);
    }
    return groupedSessions;
  }, [sessions]);

  const projectOverviews = useMemo(() => {
    if (!allProjectsView) return [];

    return projects.map((project) => {
      const projectSessions = sessionsByProject.get(project.id) ?? [];
      const counts: Record<AttentionLevel, number> = {
        merge: 0,
        action: 0,
        respond: 0,
        review: 0,
        pending: 0,
        working: 0,
        done: 0,
      };

      for (const session of projectSessions) {
        counts[getAttentionLevel(session, attentionZones)]++;
      }

      return {
        project,
        orchestrator:
          activeOrchestrators.find((orchestrator) => orchestrator.projectId === project.id) ?? null,
        sessionCount: projectSessions.length,
        openPRCount: projectSessions.filter((session) => session.pr?.state === "open").length,
        counts,
      };
    });
  }, [activeOrchestrators, allProjectsView, attentionZones, projects, sessionsByProject]);

  const handleSend = useCallback(
    async (sessionId: string, message: string) => {
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message }),
        });
        if (!res.ok) {
          const text = await res.text();
          const messageText = text || "Unknown error";
          console.error(`Failed to send message to ${sessionId}:`, messageText);
          showToast(`Send failed: ${messageText}`, "error");
          const errorWithToast = new Error(messageText);
          (errorWithToast as Error & { toastShown?: boolean }).toastShown = true;
          throw errorWithToast;
        }
      } catch (error) {
        const toastShown =
          error instanceof Error &&
          "toastShown" in error &&
          (error as Error & { toastShown?: boolean }).toastShown;
        if (!toastShown) {
          console.error(`Network error sending message to ${sessionId}:`, error);
          showToast("Network error while sending message", "error");
        }
        throw error;
      }
    },
    [showToast],
  );

  const killSession = useCallback(
    async (sessionId: string) => {
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/kill`, {
          method: "POST",
        });
        if (!res.ok) {
          const text = await res.text();
          console.error(`Failed to kill ${sessionId}:`, text);
          showToast(`Terminate failed: ${text}`, "error");
        } else {
          showToast("Session terminated", "success");
        }
      } catch (error) {
        console.error(`Network error killing ${sessionId}:`, error);
        showToast("Network error while terminating session", "error");
      }
    },
    [showToast],
  );

  const handleKill = useCallback(
    (sessionId: string) => {
      const session = sessionsRef.current.find((s) => s.id === sessionId) ?? null;
      if (!session) return;
      void killSession(session.id);
    },
    [killSession],
  );
  const handlePreview = useCallback((session: DashboardSession) => {
    setPreviewSession(session);
    setBottomSheetMode("preview");
  }, []);

  const handleRequestKill = useCallback(() => {
    setBottomSheetMode("confirm-kill");
  }, []);

  const handleBottomSheetClose = useCallback(() => {
    setPreviewSession(null);
    setBottomSheetMode("preview");
  }, []);

  const handleBottomSheetConfirmKill = useCallback(() => {
    if (previewSession) void killSession(previewSession.id);
    setPreviewSession(null);
    setBottomSheetMode("preview");
  }, [previewSession, killSession]);

  const handleMerge = useCallback(
    async (prNumber: number) => {
      try {
        const res = await fetch(`/api/prs/${prNumber}/merge`, { method: "POST" });
        if (!res.ok) {
          const text = await res.text();
          console.error(`Failed to merge PR #${prNumber}:`, text);
          showToast(`Merge failed: ${text}`, "error");
          return;
        } else {
          showToast(`PR #${prNumber} merged`, "success");
        }
      } catch (error) {
        console.error(`Network error merging PR #${prNumber}:`, error);
        showToast("Network error while merging PR", "error");
      }
    },
    [showToast],
  );

  const handleRestore = useCallback(
    async (sessionId: string) => {
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/restore`, {
          method: "POST",
        });
        if (!res.ok) {
          const text = await res.text();
          console.error(`Failed to restore ${sessionId}:`, text);
          showToast(`Restore failed: ${text}`, "error");
        } else {
          showToast("Session restored", "success");
          routerRef.current.refresh();
        }
      } catch (error) {
        console.error(`Network error restoring ${sessionId}:`, error);
        showToast("Network error while restoring session", "error");
      }
    },
    [showToast],
  );

  const handleSpawnOrchestrator = async (project: ProjectInfo) => {
    setSpawningProjectIds((current) =>
      current.includes(project.id) ? current : [...current, project.id],
    );
    setSpawnErrors(({ [project.id]: _ignored, ...current }) => current);

    try {
      const res = await fetch("/api/orchestrators", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id }),
      });

      const data = (await res.json().catch(() => null)) as {
        orchestrator?: DashboardOrchestratorLink;
        error?: string;
      } | null;

      if (!res.ok || !data?.orchestrator) {
        throw new Error(data?.error ?? `Failed to spawn orchestrator for ${project.name}`);
      }

      const orchestrator = data.orchestrator;

      setActiveOrchestrators((current) => {
        const next = current.filter((orchestrator) => orchestrator.projectId !== project.id);
        next.push(orchestrator);
        return next;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to spawn orchestrator";
      setSpawnErrors((current) => ({ ...current, [project.id]: message }));
      console.error(`Failed to spawn orchestrator for ${project.id}:`, error);
    } finally {
      setSpawningProjectIds((current) => current.filter((id) => id !== project.id));
    }
  };

  const hasAnySessions = kanbanLevels.some((level) => grouped[level].length > 0);
  const showEmptyState = !allProjectsView && !hasAnySessions && !visibleLoadError;

  const loadErrorBanner = visibleLoadError ? (
    <div
      className="dashboard-alert mb-6 flex flex-col gap-1.5 border border-[color-mix(in_srgb,var(--color-status-error)_28%,transparent)] bg-[color-mix(in_srgb,var(--color-status-error)_10%,transparent)] px-3.5 py-2.5 text-[11px] md:mb-4"
      role="alert"
      aria-live="assertive"
    >
      <span className="font-semibold text-[var(--color-status-error)]">
        Orchestrator failed to load
      </span>
      <span className="break-words text-[var(--color-text-secondary)]">{visibleLoadError}</span>
      <span className="text-[var(--color-text-secondary)]">
        Confirm <span className="font-mono text-[10px]">agent-orchestrator.yaml</span> exists and is
        valid, then run <span className="font-mono text-[10px]">ao doctor</span> for diagnostics.
      </span>
    </div>
  ) : null;

  const anyRateLimited = useMemo(
    () => sessions.some((session) => session.pr && isPRRateLimited(session.pr)),
    [sessions],
  );
  const normalizedProjectName = projectName?.trim().toLowerCase();
  const headerProjectLabel =
    normalizedProjectName === "agent orchestrator"
      ? (projectId ?? projectName ?? (allProjectsView ? "All projects" : "Dashboard"))
      : (projectName ?? (allProjectsView ? "All projects" : "Dashboard"));
  const showHeaderProjectLabel = !allProjectsView && headerProjectLabel.trim().length > 0;

  const handleZoneToggle = (level: AttentionLevel) => {
    setCollapsedZones((prev) => {
      const next = new Set(prev);
      if (next.has(level)) {
        next.delete(level);
      } else {
        next.add(level);
      }
      return next;
    });
  };
  const handleToggleSidebar = () => {
    if (typeof window !== "undefined" && window.innerWidth < 768) {
      setMobileMenuOpen((current) => !current);
    } else {
      setSidebarCollapsed((current) => !current);
    }
  };

  return (
    <SidebarContext.Provider
      value={{ onToggleSidebar: handleToggleSidebar, mobileSidebarOpen: mobileMenuOpen }}
    >
      <>
        <UpdateBanner />
        <ConnectionBar status={connectionStatus} />
        <div className="dashboard-app-shell">
          <header className="dashboard-app-header">
            <button
              type="button"
              className="dashboard-app-sidebar-toggle"
              onClick={handleToggleSidebar}
              aria-label="Toggle sidebar"
            >
              {isMobile ? (
                <svg
                  width="16"
                  height="16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              ) : (
                <svg
                  width="14"
                  height="14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <path d="M9 3v18" />
                </svg>
              )}
            </button>
            <div className="dashboard-app-header__brand">
              <span className="dashboard-app-header__brand-dot" aria-hidden="true" />
              <span>Agent Orchestrator</span>
            </div>
            {showHeaderProjectLabel ? (
              <>
                <span className="dashboard-app-header__sep" aria-hidden="true" />
                <span className="dashboard-app-header__project">{headerProjectLabel}</span>
              </>
            ) : null}
            {showDebugBundleButton ? <CopyDebugBundleButton projectId={projectId} /> : null}
            <div className="dashboard-app-header__spacer" />
            <div className="dashboard-app-header__actions">
              {!allProjectsView && orchestratorHref ? (
                <Link
                  href={orchestratorHref}
                  className="dashboard-app-btn dashboard-app-btn--amber"
                  aria-label="Orchestrator"
                >
                  <svg
                    width="12"
                    height="12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <circle cx="12" cy="5" r="2" fill="currentColor" stroke="none" />
                    <path d="M12 7v4M12 11H6M12 11h6M6 11v3M12 11v3M18 11v3" />
                    <circle cx="6" cy="17" r="2" />
                    <circle cx="12" cy="17" r="2" />
                    <circle cx="18" cy="17" r="2" />
                  </svg>
                  Orchestrator
                </Link>
              ) : canSpawnProjectOrchestrator && activeProject ? (
                <button
                  type="button"
                  className="dashboard-app-btn dashboard-app-btn--amber"
                  aria-label="Spawn Orchestrator"
                  onClick={() => void handleSpawnOrchestrator(activeProject)}
                  disabled={isSpawningCurrentProject}
                >
                  <svg
                    width="12"
                    height="12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <circle cx="12" cy="5" r="2" fill="currentColor" stroke="none" />
                    <path d="M12 7v4M12 11H6M12 11h6M6 11v3M12 11v3M18 11v3" />
                    <circle cx="6" cy="17" r="2" />
                    <circle cx="12" cy="17" r="2" />
                    <circle cx="18" cy="17" r="2" />
                  </svg>
                  {isSpawningCurrentProject ? "Spawning..." : "Spawn Orchestrator"}
                </button>
              ) : null}
            </div>
          </header>

          <div
            className={`dashboard-shell dashboard-shell--desktop${sidebarCollapsed ? " dashboard-shell--sidebar-collapsed" : ""}`}
          >
            <div
              className={`sidebar-wrapper${mobileMenuOpen ? " sidebar-wrapper--mobile-open" : ""}`}
            >
              <ProjectSidebar
                projects={projects}
                sessions={sessions}
                orchestrators={activeOrchestrators}
                activeProjectId={projectId}
                activeSessionId={activeSessionId}
                collapsed={sidebarCollapsed}
                onToggleCollapsed={() => setSidebarCollapsed((current) => !current)}
                onMobileClose={() => setMobileMenuOpen(false)}
              />
            </div>
            {mobileMenuOpen && (
              <div className="sidebar-mobile-backdrop" onClick={() => setMobileMenuOpen(false)} />
            )}

            <main className="dashboard-main dashboard-main--desktop">
              <DynamicFavicon attentionLevels={attentionLevels} projectName={projectName} />
              <div className="dashboard-main__subhead">
                <h1 className="dashboard-main__title">Dashboard</h1>
                <p className="dashboard-main__subtitle">
                  Live agent sessions, pull requests, and merge status.
                </p>
              </div>

              <div className="dashboard-main__body">
                {loadErrorBanner}
                {anyRateLimited && !rateLimitDismissed && (
                  <div className="dashboard-alert mb-4 flex items-center gap-2.5 border border-[color-mix(in_srgb,var(--color-status-attention)_25%,transparent)] bg-[var(--color-tint-yellow)] px-3.5 py-2.5 text-[11px] text-[var(--color-status-attention)]">
                    <svg
                      className="h-3.5 w-3.5 shrink-0"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      viewBox="0 0 24 24"
                    >
                      <circle cx="12" cy="12" r="10" />
                      <path d="M12 8v4M12 16h.01" />
                    </svg>
                    <span className="flex-1">
                      GitHub API rate limited — PR data (CI status, review state, sizes) may be
                      stale. Will retry automatically on next refresh.
                    </span>
                    <button
                      onClick={() => setRateLimitDismissed(true)}
                      className="ml-1 shrink-0 opacity-60 hover:opacity-100"
                      aria-label="Dismiss"
                    >
                      <svg
                        className="h-3.5 w-3.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        viewBox="0 0 24 24"
                      >
                        <path d="M18 6 6 18M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                )}

                {allProjectsView && (
                  <ProjectOverviewGrid
                    overviews={projectOverviews}
                    onSpawnOrchestrator={handleSpawnOrchestrator}
                    spawningProjectIds={spawningProjectIds}
                    spawnErrors={spawnErrors}
                    attentionZones={attentionZones}
                  />
                )}

                {!allProjectsView && hasAnySessions && (
                  <div className="kanban-board-wrap">
                    <div
                      className="kanban-board"
                      data-columns={kanbanLevels.length}
                      style={
                        {
                          "--kanban-column-count": kanbanLevels.length,
                        } as React.CSSProperties
                      }
                    >
                      {kanbanLevels.map((level) => (
                        <AttentionZone
                          key={level}
                          level={level}
                          sessions={grouped[level]}
                          onSend={handleSend}
                          onKill={handleKill}
                          onMerge={handleMerge}
                          onRestore={handleRestore}
                          compactMobile={isMobile}
                          collapsed={isMobile && collapsedZones.has(level)}
                          onToggle={isMobile ? handleZoneToggle : undefined}
                          onPreview={isMobile ? handlePreview : undefined}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {showEmptyState ? (
                  <EmptyState
                    orchestratorHref={orchestratorHref}
                    onSpawnOrchestrator={
                      canSpawnProjectOrchestrator && activeProject
                        ? () => {
                            void handleSpawnOrchestrator(activeProject);
                          }
                        : null
                    }
                    spawnLabel={isSpawningCurrentProject ? "Spawning..." : "Spawn Orchestrator"}
                    spawnDisabled={isSpawningCurrentProject}
                  />
                ) : null}

                {!allProjectsView && currentProjectSpawnError ? (
                  <p className="mt-3 text-[11px] text-[var(--color-status-error)]">
                    {currentProjectSpawnError}
                  </p>
                ) : null}

                {!allProjectsView && grouped.done.length > 0 && (
                  <div className="done-bar mt-6">
                    <button
                      type="button"
                      className="done-bar__toggle"
                      onClick={() => setDoneExpanded((v) => !v)}
                      aria-expanded={doneExpanded}
                    >
                      <svg
                        className={`done-bar__chevron${doneExpanded ? " done-bar__chevron--open" : ""}`}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                      >
                        <path d="m9 18 6-6-6-6" />
                      </svg>
                      <span className="done-bar__label">Done / Terminated</span>
                      <span className="done-bar__count">{grouped.done.length}</span>
                    </button>
                    {doneExpanded && (
                      <div className="done-bar__cards">
                        {grouped.done.map((session) => (
                          <DoneCard key={session.id} session={session} onRestore={handleRestore} />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </main>
          </div>
        </div>
        <BottomSheet
          session={previewSession}
          mode={bottomSheetMode}
          onCancel={handleBottomSheetClose}
          onConfirm={handleBottomSheetConfirmKill}
          onRequestKill={handleRequestKill}
          onMerge={handleMerge}
          isMergeReady={previewSession ? attentionLevels[previewSession.id] === "merge" : false}
        />
      </>
    </SidebarContext.Provider>
  );
}

export function Dashboard(props: DashboardProps) {
  return (
    <ToastProvider>
      <DashboardInner {...props} />
    </ToastProvider>
  );
}

function ProjectOverviewGrid({
  overviews,
  onSpawnOrchestrator,
  spawningProjectIds,
  spawnErrors,
  attentionZones,
}: {
  overviews: Array<{
    project: ProjectInfo;
    orchestrator: DashboardOrchestratorLink | null;
    sessionCount: number;
    openPRCount: number;
    counts: Record<AttentionLevel, number>;
  }>;
  onSpawnOrchestrator: (project: ProjectInfo) => Promise<void>;
  spawningProjectIds: string[];
  spawnErrors: Record<string, string>;
  attentionZones: DashboardAttentionZoneMode;
}) {
  return (
    <div className="mb-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {overviews.map(({ project, orchestrator, sessionCount, openPRCount, counts }) =>
        (() => {
          const isDegraded = Boolean(project.resolveError);
          const projectHref = projectDashboardPath(project.id);

          return (
            <section
              key={project.id}
              className="border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-4"
            >
              <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-[14px] font-semibold text-[var(--color-text-primary)]">
                    {project.name}
                  </h2>
                  <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                    {isDegraded ? (
                      "Config needs repair"
                    ) : (
                      <>
                        {sessionCount} active session{sessionCount !== 1 ? "s" : ""}
                        {openPRCount > 0
                          ? ` · ${openPRCount} open PR${openPRCount !== 1 ? "s" : ""}`
                          : ""}
                      </>
                    )}
                  </div>
                </div>
                <Link
                  href={projectHref}
                  className="border border-[var(--color-border-default)] px-3 py-1.5 text-[11px] font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:no-underline"
                >
                  Open project
                </Link>
              </div>

              <div className="mb-4 flex flex-wrap gap-2">
                <ProjectMetric label="Merge" value={counts.merge} tone="ready" />
                {attentionZones === "detailed" ? (
                  <>
                    <ProjectMetric label="Respond" value={counts.respond} tone="error" />
                    <ProjectMetric label="Review" value={counts.review} tone="orange" />
                  </>
                ) : (
                  <ProjectMetric label="Action" value={counts.action} tone="orange" />
                )}
                <ProjectMetric label="Pending" value={counts.pending} tone="attention" />
                <ProjectMetric label="Working" value={counts.working} tone="working" />
              </div>

              <div className="border-t border-[var(--color-border-subtle)] pt-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-[11px] text-[var(--color-text-muted)]">
                    {isDegraded
                      ? "Project config could not be resolved"
                      : orchestrator
                        ? "Per-project orchestrator available"
                        : "No running orchestrator"}
                  </div>
                  {isDegraded ? (
                    <Link
                      href={projectHref}
                      className="border border-[var(--color-border-default)] px-3 py-1.5 text-[11px] font-semibold text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:no-underline"
                    >
                      Repair project
                    </Link>
                  ) : orchestrator ? (
                    <Link
                      href={projectSessionPath(orchestrator.projectId, orchestrator.id)}
                      className="orchestrator-btn flex items-center gap-2 px-3 py-1.5 text-[11px] font-semibold hover:no-underline"
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)] opacity-80" />
                      orchestrator
                    </Link>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void onSpawnOrchestrator(project)}
                      disabled={spawningProjectIds.includes(project.id)}
                      className="orchestrator-btn px-3 py-1.5 text-[11px] font-semibold disabled:cursor-wait disabled:opacity-70"
                    >
                      {spawningProjectIds.includes(project.id)
                        ? "Spawning..."
                        : "Spawn Orchestrator"}
                    </button>
                  )}
                </div>
                {spawnErrors[project.id] ? (
                  <p className="mt-2 text-[11px] text-[var(--color-status-error)]">
                    {spawnErrors[project.id]}
                  </p>
                ) : null}
              </div>
            </section>
          );
        })(),
      )}
    </div>
  );
}

function ProjectMetric({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="min-w-[78px] border border-[var(--color-border-subtle)] px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
        {label}
      </div>
      <div
        className="project-metric__value mt-1 text-[18px] font-semibold tabular-nums"
        data-tone={tone}
      >
        {value}
      </div>
    </div>
  );
}
