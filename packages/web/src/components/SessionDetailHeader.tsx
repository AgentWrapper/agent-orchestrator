"use client";

import type { DashboardSession } from "@/lib/types";
import type { ProjectInfo } from "@/lib/project-name";
import { DashboardNotificationButton } from "./DashboardNotificationButton";
import { StatusBadge } from "./StatusBadge";
import { buildGitHubBranchUrl } from "./session-detail-utils";
import { projectDashboardPath } from "@/lib/routes";
import { GitBranchIcon, MobilePrButton, OrchestratorZonePills } from "./SessionDetailHeader.parts";

export interface OrchestratorZones {
  merge: number;
  respond: number;
  review: number;
  pending: number;
  working: number;
  done: number;
}

interface SessionDetailHeaderProps {
  session: DashboardSession;
  isOrchestrator: boolean;
  isMobile: boolean;
  terminalEnded: boolean;
  isRestorable: boolean;
  headline: string;
  projects: ProjectInfo[];
  orchestratorHref: string | null;
  orchestratorZones?: OrchestratorZones;
  onToggleSidebar: () => void;
  onRestore: () => void;
  onKill: () => void;
}

export function SessionDetailHeader({
  session,
  isOrchestrator,
  isMobile,
  terminalEnded,
  isRestorable,
  headline,
  projects,
  orchestratorHref,
  orchestratorZones,
  onToggleSidebar,
  onRestore,
  onKill,
}: SessionDetailHeaderProps) {
  const pr = session.pr;

  const headerProjectLabel =
    projects.find((project) => project.id === session.projectId)?.name ?? session.projectId;

  return (
    <header className="dashboard-app-header session-topbar">
      {/* Mobile-only drawer toggle. On desktop the sidebar carries its own
          collapse/expand affordance, so the topbar doesn't duplicate it. */}
      {isMobile && projects.length > 0 ? (
        <button
          type="button"
          className="dashboard-app-sidebar-toggle"
          onClick={onToggleSidebar}
          aria-label="Toggle sidebar"
        >
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
        </button>
      ) : null}

      {/* ‹ Kanban back button → the project board. Workers get a plain "Kanban"
          back; orchestrators keep their dedicated "Open Kanban"/fleet button
          further along the row. */}
      {!isOrchestrator ? (
        <a
          className="session-board-btn"
          href={projectDashboardPath(session.projectId)}
          title="Back to Kanban"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
          <span className="topbar-btn-label">Kanban</span>
        </a>
      ) : null}

      {!isOrchestrator ? <span className="session-topbar__vdiv" aria-hidden="true" /> : null}

      {isOrchestrator ? (
        <div className="topbar-project-pills-group">
          <div className="topbar-project-line">
            <span className="dashboard-app-header__project">{headerProjectLabel}</span>
            <span className="topbar-identity-sep" aria-hidden="true">
              ·
            </span>
            <span className="session-detail-mode-badge session-detail-mode-badge--neutral">
              <svg
                width="12"
                height="12"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
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
            </span>
          </div>
          <div className="topbar-session-pills">
            <StatusBadge session={session} variant="pill" />
            {orchestratorZones ? <OrchestratorZonePills zones={orchestratorZones} /> : null}
          </div>
        </div>
      ) : (
        <>
          {/* Session identity — TITLE first, BRANCH to its right (mono + git icon). */}
          <div className="session-topbar__id">
            <span className="session-topbar__title" title={headline}>
              {headline}
            </span>
            {session.branch ? (
              pr ? (
                <a
                  href={buildGitHubBranchUrl(pr)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="session-topbar__branch session-topbar__branch--link"
                  title={session.branch}
                >
                  <span className="session-topbar__branch-icon">
                    <GitBranchIcon />
                  </span>
                  {session.branch}
                </a>
              ) : (
                <span className="session-topbar__branch" title={session.branch}>
                  <span className="session-topbar__branch-icon">
                    <GitBranchIcon />
                  </span>
                  {session.branch}
                </span>
              )
            ) : null}
          </div>
          <StatusBadge session={session} variant="pill" />
          <span className="dashboard-app-header__session-id topbar-mobile-only">{session.id}</span>
        </>
      )}

      <div className="dashboard-app-header__spacer" />
      <div className="dashboard-app-header__actions">
        <DashboardNotificationButton />
        {/* PR lives in the desktop inspector rail; the topbar popover is the
            mobile-only affordance (no inspector there). */}
        {!isOrchestrator && pr && isMobile ? <MobilePrButton session={session} pr={pr} /> : null}

        {!isOrchestrator && isRestorable ? (
          <button
            type="button"
            className="dashboard-app-btn dashboard-app-btn--restore"
            onClick={onRestore}
          >
            <svg
              className="topbar-action-icon"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <path d="M20 11a8 8 0 0 0-14.9-3.98" />
              <path d="M4 5v4h4" />
              <path d="M4 13a8 8 0 0 0 14.9 3.98" />
              <path d="M20 19v-4h-4" />
            </svg>
            <span className="topbar-btn-label">Restore</span>
          </button>
        ) : !isOrchestrator && !terminalEnded ? (
          <button
            type="button"
            className="dashboard-app-btn dashboard-app-btn--danger"
            onClick={onKill}
          >
            <svg
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              viewBox="0 0 24 24"
            >
              <path d="M4 7h16" />
              <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              <path d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" />
              <line x1="10" y1="11.5" x2="10" y2="17.5" />
              <line x1="14" y1="11.5" x2="14" y2="17.5" />
            </svg>
            <span className="topbar-btn-label">Kill</span>
          </button>
        ) : null}

        {orchestratorHref ? (
          <a
            href={orchestratorHref}
            className="dashboard-app-btn dashboard-app-btn--primary topbar-desktop-only"
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
            <span className="topbar-btn-label">Orchestrator</span>
          </a>
        ) : null}
        {isOrchestrator ? (
          <a
            href={projectDashboardPath(session.projectId)}
            className="dashboard-app-btn dashboard-app-btn--amber"
            aria-label="Open Kanban"
          >
            <svg
              className="topbar-action-icon"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <rect x="4" y="4" width="4" height="16" rx="1.2" />
              <rect x="10" y="4" width="4" height="16" rx="1.2" />
              <rect x="16" y="4" width="4" height="16" rx="1.2" />
            </svg>
            <span className="topbar-btn-label">Open Kanban</span>
          </a>
        ) : null}
      </div>
    </header>
  );
}
