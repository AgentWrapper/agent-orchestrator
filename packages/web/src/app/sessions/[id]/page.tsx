"use client";

import { useEffect, useState, useCallback, useRef, type ReactNode } from "react";
import { useParams, usePathname, useRouter } from "next/navigation";
import { ACTIVITY_STATE, SESSION_STATUS, isOrchestratorSession } from "@aoagents/ao-core/types";
import { SessionDetail } from "@/components/SessionDetail";
import { ErrorDisplay } from "@/components/ErrorDisplay";
import {
  ProjectSidebar,
  type ProjectSidebarOrchestrator,
} from "@/components/ProjectSidebar";
import { useMediaQuery, MOBILE_BREAKPOINT } from "@/hooks/useMediaQuery";
import {
  type DashboardSession,
  type DashboardOrchestratorLink,
  type ActivityState,
  getAttentionLevel,
} from "@/lib/types";
import { activityIcon } from "@/lib/activity-icons";
import type { ProjectInfo } from "@/lib/project-name";
import { getSessionTitle } from "@/lib/format";
import { useMuxSessionActivity } from "@/hooks/useMuxSessionActivity";
import { useMuxOptional } from "@/providers/MuxProvider";
import type { SessionPatch } from "@/lib/mux-protocol";
import { projectSessionPath } from "@/lib/routes";
import { fetchJsonWithTimeout } from "@/lib/client-fetch";

function truncate(s: string, max: number): string {
  // Split on code points so emoji / astral characters aren't cleaved into
  // lone UTF-16 surrogates at the truncation boundary.
  const codePoints = Array.from(s);
  return codePoints.length > max ? codePoints.slice(0, max).join("") + "..." : s;
}

/** Build a descriptive tab title from session data. */
function buildSessionTitle(
  session: DashboardSession,
  prefixByProject: Map<string, string>,
  activityOverride?: ActivityState | null,
): string {
  const id = session.id;
  const activity = activityOverride !== undefined ? activityOverride : session.activity;
  const emoji = activity ? (activityIcon[activity] ?? "") : "";
  const allPrefixes = [...prefixByProject.values()];
  const isOrchestrator = isOrchestratorSession(
    session,
    prefixByProject.get(session.projectId),
    allPrefixes,
  );

  let detail: string;

  if (isOrchestrator) {
    detail = "Orchestrator Terminal";
  } else {
    detail = truncate(getSessionTitle(session), 40);
  }

  return emoji ? `${emoji} ${id} | ${detail}` : `${id} | ${detail}`;
}

// NOTE: No `action` field here by design. This status strip is a detail-page
// summary, and `SessionDetail.OrchestratorZones` (the consumer of these
// counts) only renders the detailed 5-zone breakdown. `getAttentionLevel()`
// below is called without a mode so it defaults to "detailed" and never
// returns "action" — the strip stays in detailed mode independent of the
// dashboard's `attentionZones` config.
interface ZoneCounts {
  merge: number;
  respond: number;
  review: number;
  pending: number;
  working: number;
  done: number;
}

interface ProjectSessionsBody {
  sessions?: DashboardSession[];
  orchestratorId?: string | null;
  orchestrators?: Array<{ id: string; projectId: string; projectName: string }>;
}

let cachedProjects: ProjectInfo[] | null = null;
let cachedSidebarSessions: DashboardSession[] | null = null;
const SESSION_PAGE_REFRESH_INTERVAL_MS = 2000;
const SESSION_FETCH_TIMEOUT_MS = 8000;
const PROJECT_SIDEBAR_FETCH_TIMEOUT_MS = 5000;
const PROJECTS_FETCH_TIMEOUT_MS = 5000;
const validSessionStatuses = new Set<string>(Object.values(SESSION_STATUS));
const validActivityStates = new Set<string>(Object.values(ACTIVITY_STATE));
const warnedMuxPatchValues = new Set<string>();

function isDashboardSessionStatus(value: string): value is DashboardSession["status"] {
  return validSessionStatuses.has(value);
}

function isActivityState(value: string): value is ActivityState {
  return validActivityStates.has(value);
}

function areProjectsEqual(previous: ProjectInfo[] | null, next: ProjectInfo[]): boolean {
  if (!previous || previous.length !== next.length) {
    return false;
  }

  return previous.every((project, index) => {
    const candidate = next[index];
    return JSON.stringify(project) === JSON.stringify(candidate);
  });
}

function areSidebarSessionsEqual(
  previous: DashboardSession[] | null,
  next: DashboardSession[],
): boolean {
  if (!previous || previous.length !== next.length) {
    return false;
  }

  return previous.every((session, index) => {
    const candidate = next[index];
    return JSON.stringify(session) === JSON.stringify(candidate);
  });
}

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

function getSessionLoadErrorMessage(error: Error): string {
  const normalized = error.message.toLowerCase();
  if (normalized.includes("timed out")) {
    return "The session request is taking too long, so the page stopped waiting instead of spinning forever. You can retry, or return to the project and reopen a different session.";
  }
  if (normalized.includes("network")) {
    return "The session request failed before the dashboard got a response. Check the local server connection and try again.";
  }
  if (normalized.includes("404")) {
    return "This session is no longer available. It may have been removed while the page was open.";
  }
  if (normalized.includes("500")) {
    return "The server returned an internal error while loading this session. Try again to re-fetch the latest state.";
  }
  return "The dashboard could not load this session cleanly. Try again to re-fetch the latest state.";
}

function SidebarPlaceholder({ message }: { message: string }) {
  return (
    <div className="project-sidebar h-full">
      <div className="space-y-3 px-3 py-4">
        <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-[var(--color-text-tertiary)]">
          Projects
        </div>
        <div className="space-y-2">
          {Array.from({ length: 3 }, (_, index) => (
            <div
              key={`sidebar-placeholder-${index}`}
              className="h-10 animate-pulse border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)]"
            />
          ))}
        </div>
        <div className="pt-2 text-[12px] text-[var(--color-text-tertiary)]">{message}</div>
      </div>
    </div>
  );
}

function SessionPageShell({
  projects,
  projectsLoading,
  sidebarSessions,
  sidebarOrchestrators,
  sidebarLoading,
  sidebarError,
  onRetrySidebar,
  activeProjectId,
  activeSessionId,
  children,
}: {
  projects: ProjectInfo[];
  projectsLoading: boolean;
  sidebarSessions: DashboardSession[] | null;
  sidebarOrchestrators?: ProjectSidebarOrchestrator[];
  sidebarLoading: boolean;
  sidebarError: boolean;
  onRetrySidebar: () => void;
  activeProjectId?: string;
  activeSessionId?: string;
  children: ReactNode;
}) {
  const isMobile = useMediaQuery(MOBILE_BREAKPOINT);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  const handleToggleSidebar = useCallback(() => {
    if (isMobile) {
      setMobileSidebarOpen((current) => !current);
      return;
    }
    setSidebarCollapsed((current) => !current);
  }, [isMobile]);

  return (
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
          <span>Agent Orchestrator</span>
        </div>
        <div className="dashboard-app-header__spacer" />
      </header>

      <div
        className={`dashboard-shell dashboard-shell--desktop${sidebarCollapsed ? " dashboard-shell--sidebar-collapsed" : ""}`}
      >
        <div
          className={`sidebar-wrapper${mobileSidebarOpen ? " sidebar-wrapper--mobile-open" : ""}`}
        >
          {projects.length > 0 ? (
            <ProjectSidebar
              projects={projects}
              sessions={sidebarSessions}
              orchestrators={sidebarOrchestrators}
              loading={sidebarLoading}
              error={sidebarError}
              onRetry={onRetrySidebar}
              activeProjectId={activeProjectId}
              activeSessionId={activeSessionId}
              collapsed={sidebarCollapsed}
              onToggleCollapsed={() => setSidebarCollapsed((current) => !current)}
              onMobileClose={() => setMobileSidebarOpen(false)}
            />
          ) : (
            <SidebarPlaceholder
              message={projectsLoading ? "Loading projects..." : "Projects unavailable."}
            />
          )}
        </div>
        {mobileSidebarOpen && (
          <div className="sidebar-mobile-backdrop" onClick={() => setMobileSidebarOpen(false)} />
        )}

        <div className="dashboard-main dashboard-main--desktop">
          <main className="session-detail-page flex-1 min-h-0 flex flex-col bg-[var(--color-bg-base)]">
            <div className="flex-1 min-h-0">{children}</div>
          </main>
        </div>
      </div>
    </div>
  );
}

function applyMuxSessionPatches(
  current: DashboardSession[] | null,
  patches: SessionPatch[],
): DashboardSession[] | null {
  if (!current || patches.length === 0) {
    return current;
  }

  const patchById = new Map(patches.map((patch) => [patch.id, patch]));
  let changed = false;

  const next = current.map((session) => {
    const patch = patchById.get(session.id);
    if (!patch) {
      return session;
    }

    if (!isDashboardSessionStatus(patch.status)) {
      const warningKey = `status:${patch.status}`;
      if (!warnedMuxPatchValues.has(warningKey)) {
        warnedMuxPatchValues.add(warningKey);
        console.warn("Ignoring mux session patch with unknown status", {
          sessionId: patch.id,
          status: patch.status,
        });
      }
      return session;
    }

    if (patch.activity !== null && !isActivityState(patch.activity)) {
      const warningKey = `activity:${patch.activity}`;
      if (!warnedMuxPatchValues.has(warningKey)) {
        warnedMuxPatchValues.add(warningKey);
        console.warn("Ignoring mux session patch with unknown activity", {
          sessionId: patch.id,
          activity: patch.activity,
        });
      }
      return session;
    }

    if (
      session.status === patch.status &&
      session.activity === patch.activity &&
      session.lastActivityAt === patch.lastActivityAt
    ) {
      return session;
    }

    changed = true;
    const nextSession: DashboardSession = {
      ...session,
      status: patch.status,
      activity: patch.activity,
      lastActivityAt: patch.lastActivityAt,
    };
    return nextSession;
  });

  return changed ? next : current;
}

export default function SessionPage() {
  const params = useParams();
  const pathname = usePathname();
  const router = useRouter();
  const id = params.id as string;
  const expectedProjectId =
    typeof params.projectId === "string"
      ? params.projectId
      : Array.isArray(params.projectId)
        ? params.projectId[0]
        : null;
  const mux = useMuxOptional();

  // Read optimistic session data written by sidebar navigation (instant render, no white screen)
  const cachedSession = (() => {
    if (typeof sessionStorage === "undefined") return null;
    try {
      const raw = sessionStorage.getItem(`ao-session-nav:${id}`);
      if (raw) {
        sessionStorage.removeItem(`ao-session-nav:${id}`);
        return JSON.parse(raw) as DashboardSession;
      }
    } catch {
      /* ignore */
    }
    return null;
  })();

  const [session, setSession] = useState<DashboardSession | null>(cachedSession);
  const [zoneCounts, setZoneCounts] = useState<ZoneCounts | null>(null);
  const [projectOrchestratorId, setProjectOrchestratorId] = useState<string | null | undefined>(
    undefined,
  );
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(cachedProjects === null);
  const [sidebarSessions, setSidebarSessions] = useState<DashboardSession[] | null>(
    () => cachedSidebarSessions,
  );
  const [sidebarOrchestrators, setSidebarOrchestrators] = useState<
    ProjectSidebarOrchestrator[] | undefined
  >(undefined);
  const [loading, setLoading] = useState(cachedSession === null);
  const [routeError, setRouteError] = useState<Error | null>(null);
  const [sessionMissing, setSessionMissing] = useState(false);
  const [sidebarError, setSidebarError] = useState(false);
  const [prefixByProject, setPrefixByProject] = useState<Map<string, string>>(new Map());
  const sessionProjectId = session?.projectId ?? null;
  const allPrefixes = [...prefixByProject.values()];
  const sessionIsOrchestrator = session
    ? isOrchestratorSession(session, prefixByProject.get(session.projectId), allPrefixes)
    : false;
  const sessionProjectIdRef = useRef<string | null>(null);
  const sessionIsOrchestratorRef = useRef(false);
  const resolvedProjectSessionsKeyRef = useRef<string | null>(null);
  const prefixByProjectRef = useRef<Map<string, string>>(new Map());
  const hasLoadedSessionRef = useRef(cachedSession !== null);
  const pendingMuxSessionsRef = useRef<SessionPatch[] | null>(null);
  // In-flight guards — prevent concurrent duplicate fetches
  const fetchingSessionRef = useRef(false);
  const fetchingProjectSessionsRef = useRef(false);
  const fetchingSidebarRef = useRef(false);
  const sessionFetchControllerRef = useRef<AbortController | null>(null);
  const projectSessionsFetchControllerRef = useRef<AbortController | null>(null);
  const sidebarFetchControllerRef = useRef<AbortController | null>(null);
  const pageUnloadingRef = useRef(false);

  // Keep prefixByProjectRef in sync so fetchProjectSessions (stable [] dep) reads latest map
  useEffect(() => {
    prefixByProjectRef.current = prefixByProject;
  }, [prefixByProject]);

  // Fetch project prefix map once on mount so isOrchestratorSession can use the correct prefix
  const fetchProjects = useCallback(async () => {
    if (cachedProjects) {
      setProjects(cachedProjects);
      setPrefixByProject(new Map(cachedProjects.map((p) => [p.id, p.sessionPrefix ?? p.id])));
      setProjectsLoading(false);
    }

    try {
      const data = await fetchJsonWithTimeout<{ projects?: ProjectInfo[] } | null>(
        "/api/projects",
        {
          timeoutMs: PROJECTS_FETCH_TIMEOUT_MS,
          timeoutMessage: `Projects request timed out after ${PROJECTS_FETCH_TIMEOUT_MS}ms`,
        },
      );
      if (!data?.projects) return;
      if (!areProjectsEqual(cachedProjects, data.projects)) {
        cachedProjects = data.projects;
        setProjects(data.projects);
        setPrefixByProject(new Map(data.projects.map((p) => [p.id, p.sessionPrefix ?? p.id])));
      }
    } catch (err) {
      console.error("Failed to fetch projects:", err);
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  // Get real-time activity updates from WebSocket (title emoji)
  const sseActivity = useMuxSessionActivity(id);

  // Update document title based on session data + SSE activity override
  useEffect(() => {
    if (session) {
      document.title = buildSessionTitle(session, prefixByProject, sseActivity?.activity);
    } else {
      document.title = `${id} | Session Detail`;
    }
  }, [session, id, prefixByProject, sseActivity]);

  useEffect(() => {
    sessionProjectIdRef.current = sessionProjectId;
  }, [sessionProjectId]);

  useEffect(() => {
    if (!session) return;
    if (!projects.some((project) => project.id === session.projectId)) return;

    if (pathname?.startsWith("/sessions/")) {
      router.replace(projectSessionPath(session.projectId, session.id));
      return;
    }

    if (
      pathname?.startsWith("/projects/") &&
      expectedProjectId &&
      session.projectId !== expectedProjectId
    ) {
      router.replace(projectSessionPath(session.projectId, session.id));
    }
  }, [expectedProjectId, pathname, projects, router, session]);

  useEffect(() => {
    sessionIsOrchestratorRef.current = sessionIsOrchestrator;
  }, [sessionIsOrchestrator]);

  // Fetch session data (memoized to avoid recreating on every render)
  const fetchSession = useCallback(async () => {
    if (fetchingSessionRef.current) return;
    fetchingSessionRef.current = true;
    const controller = new AbortController();
    sessionFetchControllerRef.current = controller;
    try {
      const data = await fetchJsonWithTimeout<DashboardSession | { error: string }>(
        `/api/sessions/${encodeURIComponent(id)}`,
        {
          signal: controller.signal,
          timeoutMs: SESSION_FETCH_TIMEOUT_MS,
          timeoutMessage: `Session request timed out after ${SESSION_FETCH_TIMEOUT_MS}ms`,
        },
      );
      setSession(data as DashboardSession);
      setRouteError(null);
      setSessionMissing(false);
      hasLoadedSessionRef.current = true;
    } catch (err) {
      if (pageUnloadingRef.current || controller.signal.aborted || isAbortLikeError(err)) {
        return;
      }
      const message = err instanceof Error ? err.message : "Failed to load session";
      const normalizedMessage = message.toLowerCase();
      if (
        normalizedMessage.includes("session not found") ||
        normalizedMessage.includes("http 404")
      ) {
        if (!hasLoadedSessionRef.current) {
          setSessionMissing(true);
        }
        setLoading(false);
        return;
      }
      console.error("Failed to fetch session:", err);
      if (!hasLoadedSessionRef.current) {
        setRouteError(err instanceof Error ? err : new Error("Failed to load session"));
      }
    } finally {
      setLoading(false);
      fetchingSessionRef.current = false;
      if (sessionFetchControllerRef.current === controller) {
        sessionFetchControllerRef.current = null;
      }
    }
  }, [id]);

  const fetchProjectSessions = useCallback(async () => {
    if (fetchingProjectSessionsRef.current) return;
    const projectId = sessionProjectIdRef.current;
    if (!projectId) return;
    const isOrchestrator = sessionIsOrchestratorRef.current;
    const projectSessionsKey = `${projectId}:${isOrchestrator ? "orchestrator" : "worker"}`;
    if (!isOrchestrator && resolvedProjectSessionsKeyRef.current === projectSessionsKey) return;
    fetchingProjectSessionsRef.current = true;
    const controller = new AbortController();
    projectSessionsFetchControllerRef.current = controller;
    try {
      const query = isOrchestrator
        ? `/api/sessions?project=${encodeURIComponent(projectId)}&fresh=true`
        : `/api/sessions?project=${encodeURIComponent(projectId)}&orchestratorOnly=true&fresh=true`;
      const body = await fetchJsonWithTimeout<ProjectSessionsBody>(query, {
        signal: controller.signal,
        timeoutMs: PROJECT_SIDEBAR_FETCH_TIMEOUT_MS,
        timeoutMessage: `Project sessions request timed out after ${PROJECT_SIDEBAR_FETCH_TIMEOUT_MS}ms`,
      });
      const sessions = body.sessions ?? [];
      const orchestratorId =
        body.orchestratorId ??
        body.orchestrators?.find((orchestrator) => orchestrator.projectId === projectId)?.id ??
        null;
      setProjectOrchestratorId((current) =>
        current === orchestratorId ? current : orchestratorId,
      );

      if (!isOrchestrator) {
        resolvedProjectSessionsKeyRef.current = projectSessionsKey;
        return;
      }

      const counts: ZoneCounts = {
        merge: 0,
        respond: 0,
        review: 0,
        pending: 0,
        working: 0,
        done: 0,
      };
      const allPrefixes = [...prefixByProjectRef.current.values()];
      for (const s of sessions) {
        if (!isOrchestratorSession(s, prefixByProjectRef.current.get(s.projectId), allPrefixes)) {
          // Detailed mode by default — "action" never appears. The guard
          // is a compile-time narrowing hint for the index below.
          const level = getAttentionLevel(s);
          if (level === "action") continue;
          counts[level]++;
        }
      }
      setZoneCounts(counts);
    } catch (err) {
      if (pageUnloadingRef.current || controller.signal.aborted || isAbortLikeError(err)) {
        return;
      }
      console.error("Failed to fetch project sessions:", err);
    } finally {
      fetchingProjectSessionsRef.current = false;
      if (projectSessionsFetchControllerRef.current === controller) {
        projectSessionsFetchControllerRef.current = null;
      }
    }
  }, []);

  const fetchSidebarSessions = useCallback(async () => {
    if (fetchingSidebarRef.current) return;
    fetchingSidebarRef.current = true;
    const controller = new AbortController();
    sidebarFetchControllerRef.current = controller;
    try {
      const body = await fetchJsonWithTimeout<{
        sessions?: DashboardSession[];
        orchestrators?: DashboardOrchestratorLink[];
      } | null>("/api/sessions?fresh=true", {
        signal: controller.signal,
        timeoutMs: PROJECT_SIDEBAR_FETCH_TIMEOUT_MS,
        timeoutMessage: `Sidebar sessions request timed out after ${PROJECT_SIDEBAR_FETCH_TIMEOUT_MS}ms`,
      });
      const restSessions = body?.sessions ?? [];
      const nextSessions =
        applyMuxSessionPatches(restSessions, pendingMuxSessionsRef.current ?? []) ?? restSessions;
      cachedSidebarSessions = nextSessions;
      setSidebarOrchestrators(body?.orchestrators);
      setSidebarError(false);
      setSidebarSessions((current) =>
        areSidebarSessionsEqual(current, nextSessions) ? current : nextSessions,
      );
    } catch (err) {
      if (pageUnloadingRef.current || controller.signal.aborted || isAbortLikeError(err)) {
        return;
      }
      console.error("Failed to fetch sidebar sessions:", err);
      setSidebarError(true);
      setSidebarSessions((current) => (current === null ? [] : current));
    } finally {
      fetchingSidebarRef.current = false;
      if (sidebarFetchControllerRef.current === controller) {
        sidebarFetchControllerRef.current = null;
      }
    }
  }, []);

  useEffect(() => {
    if (!mux?.sessions) return;

    // Only overlay mux snapshots onto REST refreshes while the WebSocket is
    // live. After a disconnect `mux.sessions` retains the last snapshot, which
    // would silently overwrite fresher REST data via `pendingMuxSessionsRef`.
    if (mux.status !== "connected") {
      pendingMuxSessionsRef.current = null;
      return;
    }

    pendingMuxSessionsRef.current = mux.sessions;

    // Read current sessions via the module-level cache so this effect reacts to
    // new mux data only — keeping `sidebarSessions` out of the dep array avoids
    // re-running on every state change that the effect itself produces.
    const next = applyMuxSessionPatches(cachedSidebarSessions, mux.sessions);
    if (next !== cachedSidebarSessions) {
      cachedSidebarSessions = next;
      setSidebarSessions(next);
    }

    if (mux.sessions.length === 0 || !cachedSidebarSessions) {
      return;
    }

    const cachedIds = new Set(cachedSidebarSessions.map((sidebarSession) => sidebarSession.id));
    const muxIds = new Set(mux.sessions.map((muxSession) => muxSession.id));
    if (cachedIds.size !== muxIds.size) {
      void fetchSidebarSessions();
      return;
    }

    for (const muxId of muxIds) {
      if (!cachedIds.has(muxId)) {
        void fetchSidebarSessions();
        return;
      }
    }
  }, [fetchSidebarSessions, mux?.sessions, mux?.status]);

  useEffect(() => {
    if (!sessionIsOrchestrator) {
      setZoneCounts(null);
    }
  }, [sessionIsOrchestrator]);

  // Initial fetch — load independent sidebar/session data in parallel.
  useEffect(() => {
    void Promise.all([fetchProjects(), fetchSession(), fetchSidebarSessions()]);
  }, [fetchProjects, fetchSession, fetchSidebarSessions]);

  useEffect(() => {
    if (!sessionProjectId) return;
    void fetchProjectSessions();
  }, [fetchProjectSessions, sessionIsOrchestrator, sessionProjectId]);

  // Poll frequently enough that sidebar/project session state keeps up with
  // newly spawned workers and terminated sessions without feeling laggy.
  useEffect(() => {
    const interval = setInterval(() => {
      fetchSession();
      fetchProjectSessions();
      fetchSidebarSessions();
    }, SESSION_PAGE_REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchSession, fetchProjectSessions, fetchSidebarSessions]);

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
    return () => {
      sessionFetchControllerRef.current?.abort();
      projectSessionsFetchControllerRef.current?.abort();
      sidebarFetchControllerRef.current?.abort();
    };
  }, []);

  if (loading) {
    return (
      <SessionPageShell
        projects={projects}
        projectsLoading={projectsLoading}
        sidebarSessions={sidebarSessions}
        sidebarOrchestrators={sidebarOrchestrators}
        sidebarLoading={sidebarSessions === null}
        sidebarError={sidebarError}
        onRetrySidebar={fetchSidebarSessions}
        activeProjectId={expectedProjectId ?? undefined}
        activeSessionId={id}
      >
        <div className="flex h-full min-h-screen items-center justify-center bg-[var(--color-bg-base)]">
          <div className="flex flex-col items-center gap-3">
            <svg
              className="h-5 w-5 animate-spin text-[var(--color-text-tertiary)]"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <path d="M12 3a9 9 0 1 0 9 9" />
            </svg>
            <div className="text-[13px] text-[var(--color-text-tertiary)]">Loading session…</div>
          </div>
        </div>
      </SessionPageShell>
    );
  }

  if (sessionMissing) {
    return (
      <SessionPageShell
        projects={projects}
        projectsLoading={projectsLoading}
        sidebarSessions={sidebarSessions}
        sidebarOrchestrators={sidebarOrchestrators}
        sidebarLoading={sidebarSessions === null}
        sidebarError={sidebarError}
        onRetrySidebar={fetchSidebarSessions}
        activeProjectId={expectedProjectId ?? undefined}
        activeSessionId={id}
      >
        <ErrorDisplay
          title="Session not found"
          message="This session is no longer available. It may have been removed, renamed, or already cleaned up."
          tone="not-found"
          primaryAction={{
            label: "Back to dashboard",
            href: expectedProjectId ? `/projects/${expectedProjectId}` : "/",
          }}
          secondaryAction={{ label: "Retry", onClick: () => void fetchSession() }}
          compact
          chrome="card"
        />
      </SessionPageShell>
    );
  }

  if (routeError) {
    return (
      <SessionPageShell
        projects={projects}
        projectsLoading={projectsLoading}
        sidebarSessions={sidebarSessions}
        sidebarOrchestrators={sidebarOrchestrators}
        sidebarLoading={sidebarSessions === null}
        sidebarError={sidebarError}
        onRetrySidebar={fetchSidebarSessions}
        activeProjectId={session?.projectId ?? expectedProjectId ?? undefined}
        activeSessionId={id}
      >
        <ErrorDisplay
          title="Failed to load session"
          message={getSessionLoadErrorMessage(routeError)}
          tone="error"
          primaryAction={{
            label: "Try again",
            onClick: () => {
              setRouteError(null);
              setSessionMissing(false);
              setLoading(true);
              void Promise.all([fetchProjects(), fetchSession(), fetchSidebarSessions()]);
            },
          }}
          secondaryAction={{
            label: "Back to dashboard",
            href: session?.projectId ? `/projects/${session.projectId}` : "/",
          }}
          error={routeError}
          compact
          chrome="card"
        />
      </SessionPageShell>
    );
  }

  if (!session) {
    return (
      <SessionPageShell
        projects={projects}
        projectsLoading={projectsLoading}
        sidebarSessions={sidebarSessions}
        sidebarOrchestrators={sidebarOrchestrators}
        sidebarLoading={sidebarSessions === null}
        sidebarError={sidebarError}
        onRetrySidebar={fetchSidebarSessions}
        activeProjectId={expectedProjectId ?? undefined}
        activeSessionId={id}
      >
        <ErrorDisplay
          title="Session unavailable"
          message="The backend has not returned this session yet. This can happen right after spawning an orchestrator; retry once the terminal registers the session."
          tone="error"
          primaryAction={{ label: "Retry", onClick: () => void fetchSession() }}
          secondaryAction={{
            label: "Back to dashboard",
            href: expectedProjectId ? `/projects/${expectedProjectId}` : "/",
          }}
          compact
          chrome="card"
        />
      </SessionPageShell>
    );
  }

  return (
    <SessionDetail
      session={session}
      isOrchestrator={sessionIsOrchestrator}
      orchestratorZones={zoneCounts ?? undefined}
      projectOrchestratorId={projectOrchestratorId}
      projects={projects}
      sidebarSessions={sidebarSessions}
      sidebarOrchestrators={sidebarOrchestrators}
      sidebarLoading={sidebarSessions === null}
      sidebarError={sidebarError}
      onRetrySidebar={fetchSidebarSessions}
    />
  );
}
