"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useMediaQuery, MOBILE_BREAKPOINT } from "@/hooks/useMediaQuery";
import {
  type DashboardSession,
  type DashboardPR,
  type DashboardOrchestratorLink,
  type DashboardAttentionZoneMode,
  getAttentionLevel,
} from "@/lib/types";
import { useSessionEvents } from "@/hooks/useSessionEvents";
import { useMuxOptional } from "@/providers/MuxProvider";
import { ProjectSidebar } from "./ProjectSidebar";
import { ThemeToggle } from "./ThemeToggle";
import { DynamicFavicon } from "./DynamicFavicon";
import { PRCard, PRTableRow } from "./PRStatus";
import { MobileBottomNav } from "./MobileBottomNav";
import type { ProjectInfo } from "@/lib/project-name";
import { getProjectScopedHref } from "@/lib/project-utils";
import { projectDashboardPath, projectSessionPath } from "@/lib/routes";

interface PullRequestsPageProps {
  initialSessions: DashboardSession[];
  projectId?: string;
  projectName?: string;
  projects?: ProjectInfo[];
  orchestrators?: DashboardOrchestratorLink[];
  /** Dashboard attention zone mode (defaults to "simple" — 4 zones). */
  attentionZones?: DashboardAttentionZoneMode;
}

const EMPTY_ORCHESTRATORS: DashboardOrchestratorLink[] = [];

type PRFilterValue = "all" | "open" | "merged" | "closed";

function getSectionLabel(filter: PRFilterValue): string {
  if (filter === "open") return "Open PRs";
  if (filter === "merged") return "Merged PRs";
  if (filter === "closed") return "Closed PRs";
  return "All PRs";
}

export function PullRequestsPage({
  initialSessions,
  projectId,
  projectName,
  projects = [],
  orchestrators,
  attentionZones = "simple",
}: PullRequestsPageProps) {
  const orchestratorLinks = orchestrators ?? EMPTY_ORCHESTRATORS;
  const mux = useMuxOptional();
  // Seed initial attention levels using the same mode used during refresh
  // (read from `config.dashboard.attentionZones` upstream). This prevents
  // the attentionLevels map from oscillating between detailed (seed/refresh)
  // and simple (server snapshot) values.
  const initialAttentionLevels = useMemo(() => {
    const levels: Record<string, ReturnType<typeof getAttentionLevel>> = {};
    for (const s of initialSessions) {
      levels[s.id] = getAttentionLevel(s, attentionZones);
    }
    return levels;
  }, [initialSessions, attentionZones]);
  const { sessions, attentionLevels } = useSessionEvents({
    initialSessions,
    project: projectId,
    muxSessions: mux?.status === "connected" ? mux.sessions : undefined,
    initialAttentionLevels,
    attentionZones,
  });
  const searchParams = useSearchParams();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const isMobile = useMediaQuery(MOBILE_BREAKPOINT);
  const showSidebar = projects.length > 1;
  const allProjectsView = showSidebar && projectId === undefined;
  const currentProjectOrchestrator = useMemo(
    () =>
      projectId
        ? orchestratorLinks.find((orchestrator) => orchestrator.projectId === projectId) ?? null
        : null,
    [orchestratorLinks, projectId],
  );
  const [prFilter, setPrFilter] = useState<PRFilterValue>("all");

  const allPRs = useMemo(() => {
    return sessions
      .filter((session): session is DashboardSession & { pr: DashboardPR } => !!session.pr)
      .map((session) => session.pr)
      .sort((a, b) => b.number - a.number);
  }, [sessions]);

  const openPRs = useMemo(() => allPRs.filter((pr) => pr.state === "open"), [allPRs]);
  const mergedPRs = useMemo(() => allPRs.filter((pr) => pr.state === "merged"), [allPRs]);
  const closedPRs = useMemo(() => allPRs.filter((pr) => pr.state === "closed"), [allPRs]);
  const dashboardHref = projectId ? projectDashboardPath(projectId) : getProjectScopedHref("/", projectId);
  const prsHref = getProjectScopedHref("/prs", projectId);
  const orchestratorHref = currentProjectOrchestrator
    ? projectSessionPath(currentProjectOrchestrator.projectId, currentProjectOrchestrator.id)
    : null;
  const activeMobilePRs = prFilter === "open" ? openPRs : prFilter === "merged" ? mergedPRs : prFilter === "closed" ? closedPRs : allPRs;

  useEffect(() => {
    setMobileMenuOpen(false);
  }, [searchParams]);

  return (
      <div
        className={`dashboard-shell flex h-screen${!isMobile && sidebarCollapsed ? " dashboard-shell--sidebar-collapsed" : ""}`}
      >
      {showSidebar ? (
        <div className={`sidebar-wrapper${mobileMenuOpen ? " sidebar-wrapper--mobile-open" : ""}`}>
          <ProjectSidebar
            projects={projects}
            sessions={sessions}
            orchestrators={orchestratorLinks}
            activeProjectId={projectId}
            activeSessionId={undefined}
            collapsed={sidebarCollapsed}
            onToggleCollapsed={() => setSidebarCollapsed((current) => !current)}
            onMobileClose={() => setMobileMenuOpen(false)}
          />
        </div>
      ) : null}
      {mobileMenuOpen && (
        <div className="sidebar-mobile-backdrop" onClick={() => setMobileMenuOpen(false)} />
      )}
      <div className="dashboard-main flex-1 overflow-y-auto px-4 py-4 md:px-7 md:py-6">
        <DynamicFavicon attentionLevels={attentionLevels} projectName={projectName ? `${projectName} PRs` : "Pull Requests"} />
        {isMobile ? (
          <section className="mobile-pr-page-header">
            <div className="mobile-pr-page-header__top">
              <div className="mobile-pr-page-header__title-row">
                {showSidebar ? (
                  <button
                    type="button"
                    className="mobile-menu-toggle"
                    onClick={() => setMobileMenuOpen(true)}
                    aria-label="Open menu"
                  >
                    <svg
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      viewBox="0 0 24 24"
                      className="h-5 w-5"
                    >
                      <path d="M4 6h16M4 12h16M4 18h16" />
                    </svg>
                  </button>
                ) : null}
                <h1 className="mobile-pr-page-header__title">
                  {projectName ? `${projectName} PRs` : "Pull Requests"}
                </h1>
              </div>
              <div className="mobile-pr-page-header__meta">
                <span className="mobile-pr-page-header__count">{allPRs.length}</span>
                <ThemeToggle />
              </div>
            </div>
            <p className="mobile-pr-page-header__subtitle">
              Open pull requests created by agents{allProjectsView ? " across projects" : " in this project"}.
            </p>
          </section>
        ) : (
          <section className="dashboard-hero mb-5">
            <div className="dashboard-hero__backdrop" />
            <div className="dashboard-hero__content">
              {showSidebar ? (
                <button
                  type="button"
                  className="mobile-menu-toggle"
                  onClick={() => setMobileMenuOpen(true)}
                  aria-label="Open menu"
                >
                  <svg
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    viewBox="0 0 24 24"
                    className="h-5 w-5"
                  >
                    <path d="M4 6h16M4 12h16M4 18h16" />
                  </svg>
                </button>
              ) : null}
              <div className="dashboard-hero__primary">
                <div className="dashboard-hero__heading">
                  <div>
                    <h1 className="dashboard-title">{projectName ? `${projectName} PRs` : "Pull Requests"}</h1>
                    <p className="dashboard-subtitle">
                      Open pull requests created by agents{allProjectsView ? " across all projects" : " in this project"}.
                    </p>
                  </div>
                </div>
                <div className="dashboard-stat-cards dashboard-stat-cards--persist-mobile">
                  <div className="dashboard-stat-card">
                    <span className="dashboard-stat-card__value">{openPRs.length}</span>
                    <span className="dashboard-stat-card__label">Open PRs</span>
                    <span className="dashboard-stat-card__meta">
                      {allProjectsView ? "Across all projects" : "In this project"}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </section>
        )}

        <section className="mx-auto max-w-[900px]">
          {/* Filter tabs */}
          <div className={isMobile ? "mobile-pr-filter-tabs" : "mb-4 flex items-center gap-1.5"}>
            {(
              [
                { value: "all", label: "All", count: allPRs.length },
                { value: "open", label: "Open", count: openPRs.length },
                { value: "merged", label: "Merged", count: mergedPRs.length },
                { value: "closed", label: "Closed", count: closedPRs.length },
              ] as const
            ).map(({ value, label, count }) => (
              <button
                key={value}
                type="button"
                onClick={() => setPrFilter(value)}
                className={
                  isMobile
                    ? "mobile-pr-filter-tab"
                    : [
                        "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-semibold transition-colors",
                        prFilter === value
                          ? "border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] text-[var(--color-text-primary)]"
                          : "border-transparent bg-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]",
                      ].join(" ")
                }
                data-active={isMobile ? String(prFilter === value) : undefined}
              >
                {label}
                <span className={isMobile ? "mobile-pr-filter-tab__count" : "rounded-full bg-[var(--color-chip-bg)] px-1.5 py-px text-[9.5px] font-mono text-[var(--color-text-muted)]"}>
                  {count}
                </span>
              </button>
            ))}
          </div>

          {isMobile ? (
            <div className="mobile-pr-mobile-layout">
              {prFilter === "all" ? (
                <>
                  {openPRs.length > 0 && (
                    <section className="mobile-pr-group" aria-label="Open pull requests">
                      <div className="mobile-pr-section-header">
                        <span>Open</span>
                        <span>{openPRs.length}</span>
                      </div>
                      <div className="mobile-pr-list">
                        {openPRs.map((pr) => (
                          <PRCard key={`${pr.owner}/${pr.repo}-${pr.number}`} pr={pr} />
                        ))}
                      </div>
                    </section>
                  )}
                  {mergedPRs.length > 0 && (
                    <section className="mobile-pr-group" aria-label="Merged pull requests">
                      <div className="mobile-pr-section-header">
                        <span>Merged</span>
                        <span>{mergedPRs.length}</span>
                      </div>
                      <div className="mobile-pr-list">
                        {mergedPRs.map((pr) => (
                          <PRCard key={`${pr.owner}/${pr.repo}-${pr.number}`} pr={pr} muted />
                        ))}
                      </div>
                    </section>
                  )}
                  {closedPRs.length > 0 && (
                    <section className="mobile-pr-group" aria-label="Closed pull requests">
                      <div className="mobile-pr-section-header">
                        <span>Closed</span>
                        <span>{closedPRs.length}</span>
                      </div>
                      <div className="mobile-pr-list">
                        {closedPRs.map((pr) => (
                          <PRCard key={`${pr.owner}/${pr.repo}-${pr.number}`} pr={pr} muted />
                        ))}
                      </div>
                    </section>
                  )}
                  {allPRs.length === 0 && (
                    <div className="mobile-pr-empty">
                      No pull requests yet.
                    </div>
                  )}
                </>
              ) : (
                <section className="mobile-pr-group" aria-label={getSectionLabel(prFilter)}>
                  <div className="mobile-pr-section-header">
                    <span>{getSectionLabel(prFilter).replace(" PRs", "")}</span>
                    <span>{activeMobilePRs.length}</span>
                  </div>
                  <div className="mobile-pr-list">
                    {activeMobilePRs.length > 0 ? (
                      activeMobilePRs.map((pr) => (
                        <PRCard key={`${pr.owner}/${pr.repo}-${pr.number}`} pr={pr} muted={prFilter !== "open"} />
                      ))
                    ) : (
                      <div className="mobile-pr-empty">No pull requests in this view.</div>
                    )}
                  </div>
                </section>
              )}
            </div>
          ) : (
            <div className="overflow-hidden rounded-[7px] border border-[var(--color-border-subtle)]">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-elevated)]">
                    <th className="px-3 py-2 text-left text-[10.5px] font-mono font-500 uppercase tracking-[0.05em] text-[var(--color-text-muted)]">
                      PR
                    </th>
                    <th className="px-3 py-2 text-left text-[10.5px] font-mono font-500 uppercase tracking-[0.05em] text-[var(--color-text-muted)]">
                      Title
                    </th>
                    <th className="px-3 py-2 text-left text-[10.5px] font-mono font-500 uppercase tracking-[0.05em] text-[var(--color-text-muted)]">
                      Size
                    </th>
                    <th className="px-3 py-2 text-left text-[10.5px] font-mono font-500 uppercase tracking-[0.05em] text-[var(--color-text-muted)]">
                      CI
                    </th>
                    <th className="px-3 py-2 text-left text-[10.5px] font-mono font-500 uppercase tracking-[0.05em] text-[var(--color-text-muted)]">
                      Review
                    </th>
                    <th className="px-3 py-2 text-left text-[10.5px] font-mono font-500 uppercase tracking-[0.05em] text-[var(--color-text-muted)]">
                      Threads
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(prFilter === "all" || prFilter === "open") && openPRs.length > 0 && (
                    <>
                      {prFilter === "all" && (
                        <tr>
                          <td colSpan={6} className="border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-3 py-1.5 text-[9.5px] font-mono font-semibold uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
                            Open
                          </td>
                        </tr>
                      )}
                      {openPRs.map((pr) => (
                        <PRTableRow key={`${pr.owner}/${pr.repo}-${pr.number}`} pr={pr} />
                      ))}
                    </>
                  )}
                  {(prFilter === "all" || prFilter === "merged") && mergedPRs.length > 0 && (
                    <>
                      {prFilter === "all" && (
                        <tr>
                          <td colSpan={6} className="border-b border-t border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-3 py-1.5 text-[9.5px] font-mono font-semibold uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
                            Merged
                          </td>
                        </tr>
                      )}
                      {mergedPRs.map((pr) => (
                        <PRTableRow key={`${pr.owner}/${pr.repo}-${pr.number}`} pr={pr} muted />
                      ))}
                    </>
                  )}
                  {(prFilter === "all" || prFilter === "closed") && closedPRs.length > 0 && (
                    <>
                      {prFilter === "all" && (
                        <tr>
                          <td colSpan={6} className="border-b border-t border-[var(--color-border-subtle)] bg-[var(--color-bg-base)] px-3 py-1.5 text-[9.5px] font-mono font-semibold uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
                            Closed
                          </td>
                        </tr>
                      )}
                      {closedPRs.map((pr) => (
                        <PRTableRow key={`${pr.owner}/${pr.repo}-${pr.number}`} pr={pr} muted />
                      ))}
                    </>
                  )}
                  {allPRs.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-4 py-6 text-[12px] text-[var(--color-text-secondary)]">
                        No pull requests yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
      {isMobile ? (
        <MobileBottomNav
          ariaLabel="PR navigation"
          activeTab="prs"
          dashboardHref={dashboardHref}
          prsHref={prsHref}
          showOrchestrator={!allProjectsView}
          orchestratorHref={orchestratorHref}
        />
      ) : null}
    </div>
  );
}
