"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMediaQuery, MOBILE_BREAKPOINT } from "@/hooks/useMediaQuery";
import {
  type DashboardSession,
  isDashboardSessionRestorable,
  isDashboardSessionTerminal,
} from "@/lib/types";
import dynamic from "next/dynamic";
import { getSessionTitle } from "@/lib/format";
import type { ProjectInfo } from "@/lib/project-name";
import { useSidebarContext } from "./workspace/SidebarContext";
import { projectDashboardPath, projectSessionPath } from "@/lib/routes";

import { MobileBottomNav } from "./MobileBottomNav";
import { SessionDetailHeader, type OrchestratorZones } from "./SessionDetailHeader";
import { SessionEndedSummary } from "./SessionEndedSummary";
import { ArtifactRail } from "./ArtifactRail";
import { ArtifactRailSplitter, useArtifactRailWidth } from "./ArtifactRailSplitter";
import { useArtifactRailCollapsed } from "@/hooks/useArtifactUiState";
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
}

export function SessionDetail({
  session,
  isOrchestrator = false,
  orchestratorZones,
  projectOrchestratorId = null,
  projects = [],
}: SessionDetailProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isMobile = useMediaQuery(MOBILE_BREAKPOINT);
  const sidebarCtx = useSidebarContext();
  const [artifactRailWidth, setArtifactRailWidth] = useArtifactRailWidth();
  const { collapsed: artifactRailCollapsed, setCollapsed: setArtifactRailCollapsed } =
    useArtifactRailCollapsed();
  const startFullscreen = searchParams.get("fullscreen") === "true";
  const [showTerminal, setShowTerminal] = useState(false);
  const pr = session.pr;
  const terminalEnded = isDashboardSessionTerminal(session);
  const isRestorable = isDashboardSessionRestorable(session);
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
    if (isOrchestrator) return null;
    if (projectOrchestratorId) return projectSessionPath(session.projectId, projectOrchestratorId);
    return null;
  }, [isOrchestrator, projectOrchestratorId, session.projectId]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setShowTerminal(true));
    return () => {
      window.cancelAnimationFrame(frame);
      setShowTerminal(false);
    };
  }, [session.id]);

  return (
    <div className="dashboard-main--desktop">
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
        onToggleSidebar={sidebarCtx?.onToggleSidebar ?? (() => {})}
        onRestore={handleRestore}
        onKill={handleKill}
      />
      {/* Inner row wrapper. Holds terminal lockup + splitter + artifact rail
          side-by-side. Sits between header and bottom nav, which are flex
          children of dashboard-main--desktop (flex-direction: column). */}
      <div className="flex min-h-0 flex-1 flex-row">
        <main className="session-detail-page flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--color-bg-base)]">
          <div className="flex min-h-0 flex-1 flex-col">
            {!showTerminal ? (
              <div className="session-detail-terminal-placeholder h-full" />
            ) : terminalEnded ? (
              <SessionEndedSummary
                session={session}
                headline={headline}
                pr={pr}
                dashboardHref={dashboardHref}
                isRestorable={isRestorable}
                onRestore={handleRestore}
              />
            ) : (
              <DirectTerminal
                sessionId={session.id}
                projectId={session.projectId}
                tmuxName={session.metadata?.tmuxName}
                startFullscreen={startFullscreen}
                variant={terminalVariant}
                appearance="theme"
                height="100%"
                isOpenCodeSession={isOpenCodeSession}
                reloadCommand={isOpenCodeSession ? reloadCommand : undefined}
                autoFocus
              />
            )}
          </div>
        </main>
        {!isMobile ? (
          artifactRailCollapsed ? (
            // Collapsed: show a small "expand" handle at the right edge.
            // No splitter — there's nothing to resize.
            <button
              type="button"
              onClick={() => setArtifactRailCollapsed(false)}
              aria-label="Expand artifacts rail"
              title="Show artifacts"
              className="flex h-full w-6 shrink-0 items-center justify-center border-l border-[var(--color-border-subtle)] bg-[var(--color-bg-sidebar)] text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]"
            >
              ‹
            </button>
          ) : (
            <>
              <ArtifactRailSplitter
                width={artifactRailWidth}
                onWidthChange={setArtifactRailWidth}
              />
              {/* Width is dynamic (user-resizable), so an inline style is
                  required — flexBasis pins the rail at the desired width.
                  This is the same exception pattern as ArtifactHtml's iframe height. */}
              <div
                className="flex min-h-0 shrink-0"
                style={{ flexBasis: `${artifactRailWidth}px`, width: `${artifactRailWidth}px` }}
              >
                <ArtifactRail
                  sessionId={session.id}
                  onCollapseRail={() => setArtifactRailCollapsed(true)}
                />
              </div>
            </>
          )
        ) : null}
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
  );
}
