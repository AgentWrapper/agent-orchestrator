"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMediaQuery, MOBILE_BREAKPOINT } from "@/hooks/useMediaQuery";
import {
  type DashboardSession,
  TERMINAL_STATUSES,
  NON_RESTORABLE_STATUSES,
} from "@/lib/types";
import dynamic from "next/dynamic";
import { getSessionTitle } from "@/lib/format";
import type { ProjectInfo } from "@/lib/project-name";
import { SidebarContext } from "./workspace/SidebarContext";
import { projectDashboardPath, projectSessionPath } from "@/lib/routes";

import { ProjectSidebar } from "./ProjectSidebar";
import { MobileBottomNav } from "./MobileBottomNav";
import {
  SessionDetailHeader,
  type OrchestratorZones,
} from "./SessionDetailHeader";
import { SessionEndedSummary } from "./SessionEndedSummary";
import { sessionActivityMeta } from "./session-detail-utils";

export type { OrchestratorZones } from "./SessionDetailHeader";

type SessionDetailTab = "agent" | "tokens-skills";

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
  const [activeTab, setActiveTab] = useState<SessionDetailTab>("agent");
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
            <div
              className="sidebar-mobile-backdrop"
              onClick={() => setMobileSidebarOpen(false)}
            />
          )}

          <div className="dashboard-main dashboard-main--desktop">
            <main className="session-detail-page flex-1 min-h-0 flex flex-col bg-[var(--color-bg-base)]">
              <div className="session-detail-tabs" role="tablist" aria-label="세션 상세 탭">
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === "agent"}
                  className="session-detail-tab"
                  onClick={() => setActiveTab("agent")}
                >
                  에이전트
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === "tokens-skills"}
                  className="session-detail-tab"
                  onClick={() => setActiveTab("tokens-skills")}
                >
                  토큰·스킬
                </button>
              </div>

              <div className="flex-1 min-h-0 flex flex-col">
                {activeTab === "tokens-skills" ? (
                  <TokensSkillsPanel session={session} />
                ) : !showTerminal ? (
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
            session.projectId
              ? `/?project=${encodeURIComponent(session.projectId)}&tab=prs`
              : "/"
          }
          showOrchestrator={!!orchestratorHref}
          orchestratorHref={orchestratorHref}
        />
      </div>
    </SidebarContext.Provider>
  );
}

function formatTokenCount(value: number): string {
  return new Intl.NumberFormat("ko-KR").format(value);
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat("ko-KR", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value < 1 ? 4 : 2,
  }).format(value);
}

function TokensSkillsPanel({ session }: { session: DashboardSession }) {
  const cost = session.agentCost;
  const totalTokens = cost ? cost.inputTokens + cost.outputTokens : null;
  const skillRows = [
    { label: "에이전트", value: session.metadata["agent"] },
    { label: "모델", value: session.metadata["model"] },
    { label: "권한 모드", value: session.metadata["permissions"] },
    { label: "서브에이전트", value: session.metadata["subagent"] },
    { label: "내부 세션", value: session.agentSessionId },
  ].filter((row): row is { label: string; value: string } => Boolean(row.value));

  return (
    <div className="session-detail-info-panel">
      <section className="session-detail-info-section" aria-labelledby="session-token-title">
        <div className="session-detail-info-section__header">
          <h2 id="session-token-title">토큰 사용량</h2>
          {cost ? <span>{formatUsd(cost.estimatedCostUsd)}</span> : null}
        </div>
        {cost && totalTokens !== null ? (
          <div className="session-detail-token-grid">
            <MetricBlock label="입력 토큰" value={formatTokenCount(cost.inputTokens)} />
            <MetricBlock label="출력 토큰" value={formatTokenCount(cost.outputTokens)} />
            <MetricBlock label="전체 토큰" value={formatTokenCount(totalTokens)} />
            <MetricBlock label="예상 비용" value={formatUsd(cost.estimatedCostUsd)} />
          </div>
        ) : (
          <p className="session-detail-info-empty">이 세션에서 수집된 토큰 데이터가 없습니다.</p>
        )}
      </section>

      <section className="session-detail-info-section" aria-labelledby="session-skills-title">
        <div className="session-detail-info-section__header">
          <h2 id="session-skills-title">스킬 구성</h2>
        </div>
        {skillRows.length > 0 ? (
          <dl className="session-detail-skill-list">
            {skillRows.map((row) => (
              <div key={row.label} className="session-detail-skill-list__row">
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="session-detail-info-empty">이 세션에 기록된 스킬 정보가 없습니다.</p>
        )}
      </section>
    </div>
  );
}

function MetricBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="session-detail-metric-block">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
