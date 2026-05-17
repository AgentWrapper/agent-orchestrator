"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, usePathname, useRouter } from "next/navigation";
import { isOrchestratorSession } from "@aoagents/ao-core/types";
import { SessionDetail } from "@/components/SessionDetail";
import { ErrorDisplay } from "@/components/ErrorDisplay";
import {
  type DashboardSession,
  type ActivityState,
  getAttentionLevel,
} from "@/lib/types";
import { activityIcon } from "@/lib/activity-icons";
import type { ProjectInfo } from "@/lib/project-name";
import { getSessionTitle } from "@/lib/format";
import { useMuxSessionActivity } from "@/hooks/useMuxSessionActivity";
import { projectSessionPath } from "@/lib/routes";
import { fetchJsonWithTimeout } from "@/lib/client-fetch";

function truncate(s: string, max: number): string {
  const codePoints = Array.from(s);
  return codePoints.length > max ? codePoints.slice(0, max).join("") + "..." : s;
}

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
  const detail = isOrchestrator ? "Orchestrator Terminal" : truncate(getSessionTitle(session), 40);
  return emoji ? `${emoji} ${id} | ${detail}` : `${id} | ${detail}`;
}

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

const SESSION_PAGE_REFRESH_INTERVAL_MS = 2000;
const SESSION_FETCH_TIMEOUT_MS = 8000;
const PROJECT_SESSIONS_FETCH_TIMEOUT_MS = 5000;
const PROJECTS_FETCH_TIMEOUT_MS = 5000;
function areProjectsEqual(previous: ProjectInfo[] | null, next: ProjectInfo[]): boolean {
  if (!previous || previous.length !== next.length) return false;
  return previous.every((p, i) => JSON.stringify(p) === JSON.stringify(next[i]));
}

function isAbortLikeError(error: unknown): boolean {
  if (error instanceof DOMException) return error.name === "AbortError";
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return msg.includes("aborted") || msg.includes("aborterror");
  }
  return false;
}

function getSessionLoadErrorMessage(error: Error): string {
  const normalized = error.message.toLowerCase();
  if (normalized.includes("timed out"))
    return "The session request is taking too long. You can retry, or return to the project and reopen a different session.";
  if (normalized.includes("network"))
    return "The session request failed before the dashboard got a response. Check the local server connection and try again.";
  if (normalized.includes("404"))
    return "This session is no longer available. It may have been removed while the page was open.";
  if (normalized.includes("500"))
    return "The server returned an internal error while loading this session. Try again to re-fetch the latest state.";
  return "The dashboard could not load this session cleanly. Try again to re-fetch the latest state.";
}

function LoadingContent() {
  return (
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
  );
}

export default function ProjectSessionPage() {
  const params = useParams();
  const pathname = usePathname();
  const router = useRouter();
  const id = params.id as string;
  const expectedProjectId = typeof params.projectId === "string" ? params.projectId : undefined;

  // Read optimistic session data written by sidebar navigation
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
  const [loading, setLoading] = useState(cachedSession === null);
  const [routeError, setRouteError] = useState<Error | null>(null);
  const [sessionMissing, setSessionMissing] = useState(false);
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
  const fetchingSessionRef = useRef(false);
  const fetchingProjectSessionsRef = useRef(false);
  const sessionFetchControllerRef = useRef<AbortController | null>(null);
  const projectSessionsFetchControllerRef = useRef<AbortController | null>(null);
  const pageUnloadingRef = useRef(false);
  const mountedRef = useRef(true);

  const sseActivity = useMuxSessionActivity(id);

  useEffect(() => {
    prefixByProjectRef.current = prefixByProject;
  }, [prefixByProject]);

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
    sessionIsOrchestratorRef.current = sessionIsOrchestrator;
  }, [sessionIsOrchestrator]);

  useEffect(() => {
    if (!session || !projects.some((p) => p.id === session.projectId)) return;
    if (
      pathname?.startsWith("/projects/") &&
      expectedProjectId &&
      session.projectId !== expectedProjectId
    ) {
      router.replace(projectSessionPath(session.projectId, session.id));
    }
  }, [expectedProjectId, pathname, projects, router, session]);

  useEffect(() => {
    if (!sessionIsOrchestrator) setZoneCounts(null);
  }, [sessionIsOrchestrator]);

  const fetchProjects = useCallback(async () => {
    if (cachedProjects) {
      setProjects(cachedProjects);
      setPrefixByProject(new Map(cachedProjects.map((p) => [p.id, p.sessionPrefix ?? p.id])));
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
    }
  }, []);

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
      if (pageUnloadingRef.current || controller.signal.aborted || isAbortLikeError(err)) return;
      const message = err instanceof Error ? err.message : "Failed to load session";
      const normalized = message.toLowerCase();
      if (normalized.includes("session not found") || normalized.includes("http 404")) {
        if (!hasLoadedSessionRef.current) setSessionMissing(true);
        setLoading(false);
        return;
      }
      console.error("Failed to fetch session:", err);
      if (!hasLoadedSessionRef.current) {
        setRouteError(err instanceof Error ? err : new Error("Failed to load session"));
      }
    } finally {
      fetchingSessionRef.current = false;
      if (sessionFetchControllerRef.current === controller)
        sessionFetchControllerRef.current = null;
      if (!controller.signal.aborted || hasLoadedSessionRef.current) {
        setLoading(false);
      } else if (mountedRef.current) {
        // Aborted before any session was loaded and the component is still
        // mounted — React Strict Mode fired the cleanup between mount 1 and
        // mount 2, aborting the first fetch. Mount 2's fetchSession() was
        // blocked by fetchingSessionRef (not yet reset). Retry immediately
        // now that the ref is clear. mountedRef guards against the navigation-
        // away case where the component is genuinely unmounted and we should
        // not start a new request.
        void fetchSession();
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
        timeoutMs: PROJECT_SESSIONS_FETCH_TIMEOUT_MS,
        timeoutMessage: `Project sessions request timed out after ${PROJECT_SESSIONS_FETCH_TIMEOUT_MS}ms`,
      });
      const sessions = body.sessions ?? [];
      const orchestratorId =
        body.orchestratorId ??
        body.orchestrators?.find((o) => o.projectId === projectId)?.id ??
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
      const allPfxs = [...prefixByProjectRef.current.values()];
      for (const s of sessions) {
        if (!isOrchestratorSession(s, prefixByProjectRef.current.get(s.projectId), allPfxs)) {
          const level = getAttentionLevel(s);
          if (level === "action") continue;
          counts[level]++;
        }
      }
      setZoneCounts(counts);
    } catch (err) {
      if (pageUnloadingRef.current || controller.signal.aborted || isAbortLikeError(err)) return;
      console.error("Failed to fetch project sessions:", err);
    } finally {
      fetchingProjectSessionsRef.current = false;
      if (projectSessionsFetchControllerRef.current === controller)
        projectSessionsFetchControllerRef.current = null;
    }
  }, []);

  useEffect(() => {
    void Promise.all([fetchProjects(), fetchSession()]);
  }, [fetchProjects, fetchSession]);

  useEffect(() => {
    if (!sessionProjectId) return;
    void fetchProjectSessions();
  }, [fetchProjectSessions, sessionIsOrchestrator, sessionProjectId]);

  useEffect(() => {
    const interval = setInterval(() => {
      void fetchSession();
      void fetchProjectSessions();
    }, SESSION_PAGE_REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchSession, fetchProjectSessions]);

  useEffect(() => {
    pageUnloadingRef.current = false;
    const mark = () => {
      pageUnloadingRef.current = true;
    };
    window.addEventListener("pagehide", mark);
    window.addEventListener("beforeunload", mark);
    return () => {
      window.removeEventListener("pagehide", mark);
      window.removeEventListener("beforeunload", mark);
    };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    return () => {
      sessionFetchControllerRef.current?.abort();
      projectSessionsFetchControllerRef.current?.abort();
    };
  }, []);

  if (loading) return <div className="dashboard-main--desktop"><LoadingContent /></div>;

  if (sessionMissing) {
    return (
      <div className="dashboard-main--desktop">
        <div className="flex h-full items-center justify-center">
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
        </div>
      </div>
    );
  }

  if (routeError) {
    return (
      <div className="dashboard-main--desktop">
        <div className="flex h-full items-center justify-center">
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
                void Promise.all([fetchProjects(), fetchSession()]);
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
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="dashboard-main--desktop">
        <div className="flex h-full items-center justify-center">
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
        </div>
      </div>
    );
  }

  return (
    <SessionDetail
      session={session}
      isOrchestrator={sessionIsOrchestrator}
      orchestratorZones={zoneCounts ?? undefined}
      projectOrchestratorId={projectOrchestratorId}
      projects={projects}
    />
  );
}
