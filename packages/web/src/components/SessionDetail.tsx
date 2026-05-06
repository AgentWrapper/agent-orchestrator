"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMediaQuery, MOBILE_BREAKPOINT } from "@/hooks/useMediaQuery";
import { type DashboardSession, TERMINAL_STATUSES, NON_RESTORABLE_STATUSES } from "@/lib/types";
import dynamic from "next/dynamic";
import { getSessionTitle } from "@/lib/format";
import type { ProjectInfo } from "@/lib/project-name";
import { SidebarContext } from "./workspace/SidebarContext";
import { projectDashboardPath, projectSessionPath } from "@/lib/routes";

import { ProjectSidebar, type ProjectSidebarOrchestrator } from "./ProjectSidebar";
import { MobileBottomNav } from "./MobileBottomNav";
import { SessionDetailHeader, type OrchestratorZones } from "./SessionDetailHeader";
import { SessionEndedSummary } from "./SessionEndedSummary";
import { sessionActivityMeta } from "./session-detail-utils";

export type { OrchestratorZones } from "./SessionDetailHeader";

const DirectTerminal = dynamic(
  () => import("./DirectTerminal").then((m) => ({ default: m.DirectTerminal })),
  {
    ssr: false,
    // h-full (not a fixed 440px) so the skeleton matches the eventual terminal's
    // flex-1 sizing and the layout stays viewport-driven during lazy load.
    loading: () => (
      <div className="h-full w-full animate-pulse rounded bg-[var(--color-bg-primary)]" />
    ),
  },
);

interface SessionDetailProps {
  session: DashboardSession;
  isOrchestrator?: boolean;
  orchestratorZones?: OrchestratorZones;
  projectOrchestratorId?: string | null;
  projects?: ProjectInfo[];
  sidebarSessions?: DashboardSession[] | null;
  sidebarOrchestrators?: ProjectSidebarOrchestrator[];
  sidebarLoading?: boolean;
  sidebarError?: boolean;
  onRetrySidebar?: () => void;
}

export function SessionDetail({
  session,
  isOrchestrator = false,
  orchestratorZones,
  projectOrchestratorId = null,
  projects = [],
  sidebarSessions = [],
  sidebarOrchestrators,
  sidebarLoading = false,
  sidebarError = false,
  onRetrySidebar,
}: SessionDetailProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isMobile = useMediaQuery(MOBILE_BREAKPOINT);
  const startFullscreen = searchParams.get("fullscreen") === "true";
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  const pr = session.pr;
  const terminalEnded = TERMINAL_STATUSES.has(session.status);
  const isRestorable = terminalEnded && !NON_RESTORABLE_STATUSES.has(session.status);
  const activity = (session.activity && sessionActivityMeta[session.activity]) ?? {
    label: session.activity ?? "unknown",
    color: "var(--color-text-muted)",
  };
  const headline = getSessionTitle(session);

  const terminalVariant = isOrchestrator ? "orchestrator" : "agent";

  const isOpenCodeSession = session.metadata["agent"] === "opencode";
  const opencodeSessionId =
    typeof session.metadata["opencodeSessionId"] === "string" &&
    session.metadata["opencodeSessionId"].length > 0
      ? session.metadata["opencodeSessionId"]
      : undefined;
  const reloadCommand = opencodeSessionId
    ? `/exit\nopencode --session ${opencodeSessionId}\n`
    : undefined;
  const dashboardHref = session.projectId ? projectDashboardPath(session.projectId) : "/";

  const handleKill = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/kill`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (projectOrchestratorId) {
        router.push(projectSessionPath(session.projectId, projectOrchestratorId));
        return;
      }
      router.push(dashboardHref);
    } catch (err) {
      console.error("Failed to kill session:", err);
    }
  }, [dashboardHref, projectOrchestratorId, router, session.id, session.projectId]);

  const handleRestore = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/restore`, {
        method: "POST",
      });
      if (!res.ok) {
        const message = await res.text().catch(() => "");
        throw new Error(message || `HTTP ${res.status}`);
      }
      window.location.reload();
    } catch (err) {
      console.error("Failed to restore session:", err);
    }
  }, [session.id]);

  const orchestratorHref = useMemo(() => {
    if (isOrchestrator) return projectSessionPath(session.projectId, session.id);
    if (projectOrchestratorId) return projectSessionPath(session.projectId, projectOrchestratorId);
    return null;
  }, [isOrchestrator, projectOrchestratorId, session.id, session.projectId]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setShowTerminal(true));
    return () => {
      window.cancelAnimationFrame(frame);
      setShowTerminal(false);
    };
  }, [session.id]);

  const handleToggleSidebar = useCallback(() => {
    if (isMobile) {
      setMobileSidebarOpen((v) => !v);
    } else {
      setSidebarCollapsed((v) => !v);
    }
  }, [isMobile]);

  return (
    <SidebarContext.Provider value={{ onToggleSidebar: handleToggleSidebar, mobileSidebarOpen }}>
      <div className="dashboard-app-shell">
        <SessionDetailHeader
          session={session}
          isOrchestrator={isOrchestrator}
          isMobile={isMobile}
          terminalEnded={terminalEnded}
          isRestorable={isRestorable}
          activity={activity}
          headline={headline}
          projects={projects}
          orchestratorHref={orchestratorHref}
          orchestratorZones={orchestratorZones}
          onToggleSidebar={handleToggleSidebar}
          onRestore={handleRestore}
          onKill={handleKill}
        />

        <div
          className={`dashboard-shell dashboard-shell--desktop${
            sidebarCollapsed ? " dashboard-shell--sidebar-collapsed" : ""
          }`}
        >
          {projects.length > 0 ? (
            <div
              className={`sidebar-wrapper${
                mobileSidebarOpen ? " sidebar-wrapper--mobile-open" : ""
              }`}
            >
              <ProjectSidebar
                projects={projects}
                sessions={sidebarSessions}
                orchestrators={sidebarOrchestrators}
                loading={sidebarLoading}
                error={sidebarError}
                onRetry={onRetrySidebar}
                activeProjectId={session.projectId}
                activeSessionId={session.id}
                collapsed={sidebarCollapsed}
                onToggleCollapsed={() => setSidebarCollapsed((current) => !current)}
                onMobileClose={() => setMobileSidebarOpen(false)}
              />
            </div>
          ) : null}
          {mobileSidebarOpen && (
            <div className="sidebar-mobile-backdrop" onClick={() => setMobileSidebarOpen(false)} />
          )}

          <div className="dashboard-main dashboard-main--desktop">
            <main className="session-detail-page flex-1 min-h-0 flex flex-col bg-[var(--color-bg-base)]">
              <div className="flex-1 min-h-0 flex flex-col">
                {!showTerminal ? (
                  <div className="session-detail-terminal-placeholder h-full" />
                ) : terminalEnded ? (
                  <SessionEndedSummary
                    session={session}
                    headline={headline}
                    pr={pr}
                    dashboardHref={dashboardHref}
                  />
                ) : (
                  <DirectTerminal
                    sessionId={session.id}
                    projectId={session.projectId}
                    tmuxName={session.metadata?.tmuxName}
                    startFullscreen={startFullscreen}
                    variant={terminalVariant}
                    appearance="dark"
                    height="100%"
                    isOpenCodeSession={isOpenCodeSession}
                    reloadCommand={isOpenCodeSession ? reloadCommand : undefined}
                    autoFocus
                  />
                )}
              </div>
            </main>
          </div>
        </div>
        <MobileBottomNav
          ariaLabel="Session navigation"
          activeTab={isOrchestrator ? "orchestrator" : undefined}
          dashboardHref={dashboardHref}
          prsHref={
            session.projectId ? `/?project=${encodeURIComponent(session.projectId)}&tab=prs` : "/"
          }
          showOrchestrator={!!orchestratorHref}
          orchestratorHref={orchestratorHref}
        />
      </div>
    </SidebarContext.Provider>
  );
}
