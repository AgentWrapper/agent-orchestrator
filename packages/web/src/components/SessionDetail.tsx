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
import { AgentMemoryPanel } from "./AgentMemoryPanel";
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
      <main className="session-detail-page flex-1 min-h-0 flex flex-col bg-[var(--color-bg-base)]">
        <div className="flex-1 min-h-0 flex flex-col">
          {!showTerminal ? (
            <div className="session-detail-terminal-placeholder h-full" />
          ) : terminalEnded ? (
            <div className="flex flex-col gap-0 overflow-y-auto p-4">
              <SessionEndedSummary
                session={session}
                headline={headline}
                pr={pr}
                dashboardHref={dashboardHref}
                isRestorable={isRestorable}
                onRestore={handleRestore}
              />
              <AgentMemoryPanel session={session} />
            </div>
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
