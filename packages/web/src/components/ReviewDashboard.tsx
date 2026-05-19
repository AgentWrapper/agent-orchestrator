"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CodeReviewFinding } from "@aoagents/ao-core";
import { MOBILE_BREAKPOINT, useMediaQuery } from "@/hooks/useMediaQuery";
import type { ProjectInfo } from "@/lib/project-name";
import {
  getReviewBoardColumn,
  REVIEW_BOARD_COLUMNS,
  REVIEW_COLUMN_LABELS,
  type DashboardReviewRun,
  type ReviewWorkerOption,
  type ReviewBoardColumn,
} from "@/lib/review-types";
import {
  projectDashboardSessionPath,
  projectDashboardPath,
  projectReviewPath,
  projectSessionHashPath,
  projectSessionPath,
} from "@/lib/routes";
import type { DashboardOrchestratorLink, DashboardSession } from "@/lib/types";
import { ProjectSidebar } from "./ProjectSidebar";
import { ToastProvider, useToast } from "./Toast";
import { SidebarContext } from "./workspace/SidebarContext";

interface ReviewDashboardProps {
  runs: DashboardReviewRun[];
  sidebarSessions?: DashboardSession[];
  orchestrators?: DashboardOrchestratorLink[];
  workerOptions?: ReviewWorkerOption[];
  projectId?: string;
  projectName: string;
  projects: ProjectInfo[];
  dashboardLoadError?: string;
}

const EMPTY_RUNS: DashboardReviewRun[] = [];
const EMPTY_SESSIONS: DashboardSession[] = [];
const EMPTY_ORCHESTRATORS: DashboardOrchestratorLink[] = [];
const EMPTY_WORKERS: ReviewWorkerOption[] = [];

interface ReviewDetailsState {
  run: DashboardReviewRun;
  findings: CodeReviewFinding[];
  loading: boolean;
  error: string | null;
}

const COLUMN_HINTS: Record<ReviewBoardColumn, string> = {
  queued: "Review work requested but not executing yet.",
  reviewing: "A reviewer is reading a snapshot.",
  triage: "Findings need a human decision.",
  waiting: "Feedback is with the coding worker.",
  clean: "No open AO findings remain.",
  failed: "Reviewer runs that need retry or inspection.",
  outdated: "Runs superseded by newer worker commits.",
};

const SUPERSEDABLE_REVIEW_STATUSES = new Set([
  "queued",
  "needs_triage",
  "sent_to_agent",
  "waiting_update",
  "clean",
]);

function formatRelativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  const diffMs = Date.now() - timestamp;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

function formatStatus(value: string): string {
  return value.replaceAll("_", " ");
}

function formatFindingLocation(finding: CodeReviewFinding): string | null {
  if (!finding.filePath) return null;
  if (finding.startLine === undefined) return finding.filePath;
  if (finding.endLine !== undefined && finding.endLine !== finding.startLine) {
    return `${finding.filePath}:${finding.startLine}-${finding.endLine}`;
  }
  return `${finding.filePath}:${finding.startLine}`;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function canSendFeedbackToWorker(run: DashboardReviewRun): boolean {
  if (!run.workerHasRuntime) return false;
  if (run.workerActivity === "exited") return false;
  return run.workerRuntimeState !== "missing" && run.workerRuntimeState !== "exited";
}

function getWorkerAvailabilityLabel(run: DashboardReviewRun): string {
  if (!run.workerHasRuntime) return "no runtime";
  if (run.workerActivity === "exited") return "exited";
  if (run.workerRuntimeState === "missing") return "runtime missing";
  if (run.workerRuntimeState === "exited") return "runtime exited";
  return run.workerActivity ?? run.workerStatus ?? "worker";
}

function mergeOrchestrators(
  current: DashboardOrchestratorLink[],
  incoming: DashboardOrchestratorLink[],
): DashboardOrchestratorLink[] {
  const merged = new Map(current.map((orchestrator) => [orchestrator.projectId, orchestrator]));
  for (const orchestrator of incoming) {
    merged.set(orchestrator.projectId, orchestrator);
  }
  return Array.from(merged.values());
}

function markSupersededReviewRuns(
  current: DashboardReviewRun[],
  nextRun: DashboardReviewRun,
): DashboardReviewRun[] {
  if (!nextRun.targetSha) return current;

  return current.map((run) => {
    if (run.linkedSessionId !== nextRun.linkedSessionId) return run;
    if (run.id === nextRun.id) return run;
    if (!run.targetSha || run.targetSha === nextRun.targetSha) return run;
    if (!SUPERSEDABLE_REVIEW_STATUSES.has(run.status)) return run;
    return { ...run, status: "outdated" };
  });
}

function ReviewDashboardInner({
  runs = EMPTY_RUNS,
  sidebarSessions = EMPTY_SESSIONS,
  orchestrators = EMPTY_ORCHESTRATORS,
  workerOptions = EMPTY_WORKERS,
  projectId,
  projectName,
  projects,
  dashboardLoadError,
}: ReviewDashboardProps) {
  const { showToast } = useToast();
  const router = useRouter();
  const menuRef = useRef<HTMLDivElement>(null);
  const [reviewRuns, setReviewRuns] = useState(runs);
  const [activeOrchestrators, setActiveOrchestrators] =
    useState<DashboardOrchestratorLink[]>(orchestrators);
  const [requestingSessionId, setRequestingSessionId] = useState<string | null>(null);
  const [executingRunIds, setExecutingRunIds] = useState<Set<string>>(() => new Set());
  const [sendingRunIds, setSendingRunIds] = useState<Set<string>>(() => new Set());
  const [restoringOrchestratorId, setRestoringOrchestratorId] = useState<string | null>(null);
  const [newReviewMenuOpen, setNewReviewMenuOpen] = useState(false);
  const [reviewDetails, setReviewDetails] = useState<ReviewDetailsState | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const isMobile = useMediaQuery(MOBILE_BREAKPOINT);

  useEffect(() => {
    setReviewRuns(runs);
  }, [runs]);

  useEffect(() => {
    setActiveOrchestrators((current) => mergeOrchestrators(current, orchestrators));
  }, [orchestrators]);

  useEffect(() => {
    if (!newReviewMenuOpen) return;
    const handlePointer = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setNewReviewMenuOpen(false);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setNewReviewMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [newReviewMenuOpen]);

  useEffect(() => {
    if (!reviewDetails) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setReviewDetails(null);
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [reviewDetails]);

  const grouped = useMemo(() => {
    const columns: Record<ReviewBoardColumn, DashboardReviewRun[]> = {
      queued: [],
      reviewing: [],
      triage: [],
      waiting: [],
      clean: [],
      failed: [],
      outdated: [],
    };
    for (const run of reviewRuns) {
      columns[getReviewBoardColumn(run)].push(run);
    }
    return columns;
  }, [reviewRuns]);

  const allProjectsView = !projectId;
  const openFindingCount = reviewRuns.reduce((sum, run) => sum + run.openFindingCount, 0);
  const activeRunCount = reviewRuns.filter((run) =>
    ["queued", "preparing", "running", "needs_triage", "sent_to_agent", "waiting_update"].includes(
      run.status,
    ),
  ).length;
  const currentProjectOrchestrator = projectId
    ? (activeOrchestrators.find((orchestrator) => orchestrator.projectId === projectId) ?? null)
    : null;
  const orchestratorHref = currentProjectOrchestrator
    ? projectSessionPath(currentProjectOrchestrator.projectId, currentProjectOrchestrator.id)
    : null;
  const visibleWorkerOptions = projectId
    ? workerOptions.filter((worker) => worker.projectId === projectId)
    : workerOptions;
  const codingHref = projectId ? projectDashboardPath(projectId) : "/?project=all";
  const reviewHref = projectReviewPath(projectId);
  const headerProjectLabel = projectName ?? (allProjectsView ? "All projects" : "Reviews");

  const handleToggleSidebar = () => {
    if (isMobile) {
      setMobileMenuOpen((current) => !current);
    } else {
      setSidebarCollapsed((current) => !current);
    }
  };

  const handleRequestReview = async (worker: ReviewWorkerOption) => {
    if (requestingSessionId) return;
    setRequestingSessionId(worker.id);
    try {
      const response = await fetch("/api/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: worker.id }),
      });
      const data = (await response.json().catch(() => null)) as {
        run?: DashboardReviewRun;
        error?: string;
      } | null;
      if (!response.ok || !data?.run) {
        throw new Error(data?.error ?? "Failed to request review");
      }

      const nextRun: DashboardReviewRun = {
        ...data.run,
        projectName: worker.projectName,
        workerTitle: worker.title,
        workerBranch: worker.branch,
        workerPrUrl: worker.prUrl ?? data.run.prUrl ?? null,
        workerStatus: worker.status,
        workerActivity: worker.activity,
        workerRuntimeState: worker.runtimeState,
        workerHasRuntime: worker.hasRuntime,
      };
      setReviewRuns((current) => [
        nextRun,
        ...markSupersededReviewRuns(
          current.filter((run) => run.id !== nextRun.id),
          nextRun,
        ),
      ]);
      setNewReviewMenuOpen(false);
      showToast("Review run requested", "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to request review";
      showToast(`Review failed: ${message}`, "error");
    } finally {
      setRequestingSessionId(null);
    }
  };

  const handleExecuteRun = async (run: DashboardReviewRun) => {
    if (executingRunIds.has(run.id)) return;
    setExecutingRunIds((current) => {
      const next = new Set(current);
      next.add(run.id);
      return next;
    });
    setReviewRuns((current) =>
      current.map((entry) => (entry.id === run.id ? { ...entry, status: "running" } : entry)),
    );
    try {
      const response = await fetch("/api/reviews/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: run.projectId,
          runId: run.id,
          force: run.status === "failed",
        }),
      });
      const data = (await response.json().catch(() => null)) as {
        run?: DashboardReviewRun;
        error?: string;
      } | null;
      if (!response.ok || !data?.run) {
        throw new Error(data?.error ?? "Failed to execute review");
      }

      setReviewRuns((current) =>
        current.map((entry) =>
          entry.id === run.id
            ? {
                ...entry,
                ...data.run,
                projectName: entry.projectName,
                workerTitle: entry.workerTitle,
                workerBranch: entry.workerBranch,
                workerPrUrl: entry.workerPrUrl,
                workerStatus: entry.workerStatus,
                workerActivity: entry.workerActivity,
                workerRuntimeState: entry.workerRuntimeState,
                workerHasRuntime: entry.workerHasRuntime,
              }
            : entry,
        ),
      );
      if (data.run.status === "failed") {
        showToast(
          `Review failed: ${data.run.terminationReason ?? "Reviewer execution failed"}`,
          "error",
        );
        return;
      }
      showToast(
        data.run.openFindingCount > 0 ? "Review findings ready" : "Review completed clean",
        "success",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to execute review";
      setReviewRuns((current) =>
        current.map((entry) => (entry.id === run.id ? { ...entry, status: "failed" } : entry)),
      );
      showToast(`Review failed: ${message}`, "error");
    } finally {
      setExecutingRunIds((current) => {
        const next = new Set(current);
        next.delete(run.id);
        return next;
      });
    }
  };

  const mergeRunUpdate = (run: DashboardReviewRun, nextRun: DashboardReviewRun) => ({
    ...run,
    ...nextRun,
    projectName: run.projectName,
    workerTitle: run.workerTitle,
    workerBranch: run.workerBranch,
    workerPrUrl: run.workerPrUrl,
    workerStatus: run.workerStatus,
    workerActivity: run.workerActivity,
    workerRuntimeState: run.workerRuntimeState,
    workerHasRuntime: run.workerHasRuntime,
  });

  const handleSendFeedback = async (run: DashboardReviewRun) => {
    if (sendingRunIds.has(run.id) || run.openFindingCount === 0) return;
    setSendingRunIds((current) => {
      const next = new Set(current);
      next.add(run.id);
      return next;
    });
    try {
      const response = await fetch("/api/reviews/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: run.projectId, runId: run.id }),
      });
      const data = (await response.json().catch(() => null)) as {
        run?: DashboardReviewRun;
        sentFindingCount?: number;
        error?: string;
      } | null;
      if (!response.ok || !data?.run) {
        throw new Error(data?.error ?? "Failed to send review findings");
      }

      setReviewRuns((current) =>
        current.map((entry) =>
          entry.id === run.id ? mergeRunUpdate(entry, data.run as DashboardReviewRun) : entry,
        ),
      );
      setReviewDetails((current) => {
        if (!current || current.run.id !== run.id) return current;
        const sentAt = new Date().toISOString();
        return {
          ...current,
          run: mergeRunUpdate(current.run, data.run as DashboardReviewRun),
          findings: current.findings.map((finding) =>
            finding.status === "open"
              ? { ...finding, status: "sent_to_agent", sentToAgentAt: sentAt }
              : finding,
          ),
        };
      });
      showToast(
        `Sent ${pluralize(data.sentFindingCount ?? 0, "finding")} to ${run.linkedSessionId}`,
        "success",
      );
      router.push(
        projectSessionHashPath(run.projectId, run.linkedSessionId, "#session-terminal-section"),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to send review findings";
      showToast(`Feedback failed: ${message}`, "error");
    } finally {
      setSendingRunIds((current) => {
        const next = new Set(current);
        next.delete(run.id);
        return next;
      });
    }
  };

  const handleRestoreOrchestrator = async (orchestrator: DashboardOrchestratorLink) => {
    if (restoringOrchestratorId) return;
    setRestoringOrchestratorId(orchestrator.id);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(orchestrator.id)}/restore`, {
        method: "POST",
      });
      const data = (await response.json().catch(() => null)) as {
        error?: string;
        session?: DashboardSession;
      } | null;
      if (!response.ok) {
        throw new Error(data?.error ?? "Failed to restore orchestrator");
      }

      setActiveOrchestrators((current) =>
        current.map((entry) =>
          entry.id === orchestrator.id
            ? {
                ...entry,
                status: data?.session?.status ?? entry.status,
                activity: data?.session?.activity ?? entry.activity,
                runtimeState: data?.session?.lifecycle?.runtimeState ?? "alive",
                hasRuntime: true,
                isTerminal: false,
                isRestorable: false,
              }
            : entry,
        ),
      );
      showToast("Orchestrator restored", "success");
      router.push(projectSessionPath(orchestrator.projectId, orchestrator.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to restore orchestrator";
      showToast(`Restore failed: ${message}`, "error");
    } finally {
      setRestoringOrchestratorId(null);
    }
  };

  const handleOpenReviewDetails = async (run: DashboardReviewRun) => {
    setReviewDetails({ run, findings: [], loading: true, error: null });
    try {
      const params = new URLSearchParams({ projectId: run.projectId, runId: run.id });
      const response = await fetch(`/api/reviews/findings?${params.toString()}`);
      const data = (await response.json().catch(() => null)) as {
        findings?: CodeReviewFinding[];
        error?: string;
      } | null;
      if (!response.ok || !data?.findings) {
        throw new Error(data?.error ?? "Failed to load review findings");
      }

      setReviewDetails((current) =>
        current?.run.id === run.id
          ? { ...current, findings: data.findings ?? [], loading: false, error: null }
          : current,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load review findings";
      setReviewDetails((current) =>
        current?.run.id === run.id
          ? { ...current, findings: [], loading: false, error: message }
          : current,
      );
    }
  };

  return (
    <SidebarContext.Provider
      value={{ onToggleSidebar: handleToggleSidebar, mobileSidebarOpen: mobileMenuOpen }}
    >
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
          <span className="dashboard-app-header__sep" aria-hidden="true" />
          <span className="dashboard-app-header__project">{headerProjectLabel}</span>
          <nav className="workspace-mode-switch" aria-label="Workspace mode">
            <Link href={codingHref} className="workspace-mode-switch__item">
              Coding
            </Link>
            <Link
              href={reviewHref}
              className="workspace-mode-switch__item workspace-mode-switch__item--active"
              aria-current="page"
            >
              Reviews
            </Link>
          </nav>
          <div className="dashboard-app-header__spacer" />
          <div className="dashboard-app-header__actions">
            {!allProjectsView && currentProjectOrchestrator && orchestratorHref ? (
              currentProjectOrchestrator.isRestorable ? (
                <button
                  type="button"
                  className="dashboard-app-btn dashboard-app-btn--amber"
                  disabled={restoringOrchestratorId === currentProjectOrchestrator.id}
                  onClick={() => void handleRestoreOrchestrator(currentProjectOrchestrator)}
                >
                  <svg
                    width="12"
                    height="12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path d="M20 11a8 8 0 0 0-14.9-3.98" />
                    <path d="M4 5v4h4" />
                    <path d="M4 13a8 8 0 0 0 14.9 3.98" />
                    <path d="M20 19v-4h-4" />
                  </svg>
                  {restoringOrchestratorId === currentProjectOrchestrator.id
                    ? "Restoring"
                    : "Restore orchestrator"}
                </button>
              ) : (
                <Link
                  href={orchestratorHref}
                  className="dashboard-app-btn dashboard-app-btn--amber"
                  aria-label="Open project orchestrator"
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
              )
            ) : null}
            <div className="review-new-menu" ref={menuRef}>
              <button
                type="button"
                className="dashboard-app-btn"
                aria-haspopup="menu"
                aria-expanded={newReviewMenuOpen}
                disabled={visibleWorkerOptions.length === 0}
                onClick={() => setNewReviewMenuOpen((open) => !open)}
              >
                <svg
                  width="12"
                  height="12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path d="M12 5v14M5 12h14" />
                </svg>
                New Review
              </button>
              {newReviewMenuOpen ? (
                <div className="review-new-menu__popover" role="menu">
                  {visibleWorkerOptions.map((worker) => (
                    <button
                      key={worker.id}
                      type="button"
                      role="menuitem"
                      className="review-new-menu__item"
                      disabled={requestingSessionId !== null}
                      onClick={() => void handleRequestReview(worker)}
                    >
                      <span className="review-new-menu__item-title">{worker.title}</span>
                      <span className="review-new-menu__item-meta">
                        {allProjectsView ? `${worker.projectName} · ` : ""}
                        {worker.id}
                        {worker.branch ? ` · ${worker.branch}` : ""}
                        {worker.prNumber ? ` · PR #${worker.prNumber}` : ""}
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </header>

        <div
          className={`dashboard-shell dashboard-shell--desktop${
            sidebarCollapsed ? " dashboard-shell--sidebar-collapsed" : ""
          }`}
        >
          <div
            className={`sidebar-wrapper${mobileMenuOpen ? " sidebar-wrapper--mobile-open" : ""}`}
          >
            <ProjectSidebar
              projects={projects}
              sessions={sidebarSessions}
              orchestrators={activeOrchestrators}
              activeProjectId={projectId}
              activeSessionId={undefined}
              collapsed={sidebarCollapsed}
              onToggleCollapsed={() => setSidebarCollapsed((current) => !current)}
              onMobileClose={() => setMobileMenuOpen(false)}
            />
          </div>
          {mobileMenuOpen ? (
            <div className="sidebar-mobile-backdrop" onClick={() => setMobileMenuOpen(false)} />
          ) : null}

          <main className="dashboard-main dashboard-main--desktop review-dashboard-main">
            <div className="review-main-header">
              <div>
                <h1 className="dashboard-main__title">
                  {projectName ? `${projectName} Reviews` : "Reviews"}
                </h1>
                <p className="dashboard-main__subtitle">
                  AO-local reviewer runs, findings, and worker handoffs
                  {allProjectsView ? " across all projects" : " for this project"}.
                </p>
              </div>
              <div className="dashboard-stat-cards dashboard-stat-cards--persist-mobile">
                <ReviewMetric label="Runs" value={reviewRuns.length} meta="Total review runs" />
                <ReviewMetric label="Active" value={activeRunCount} meta="Open review loops" />
                <ReviewMetric label="Findings" value={openFindingCount} meta="Open AO findings" />
              </div>
            </div>

            {dashboardLoadError ? (
              <div className="dashboard-alert mb-4 border border-[color-mix(in_srgb,var(--color-status-error)_28%,transparent)] bg-[color-mix(in_srgb,var(--color-status-error)_10%,transparent)] px-3.5 py-2.5 text-[11px] text-[var(--color-status-error)]">
                {dashboardLoadError}
              </div>
            ) : null}

            {reviewRuns.length === 0 ? (
              <section className="review-empty-state">
                <div className="review-empty-state__title">No review runs yet</div>
                <p className="review-empty-state__body">
                  Reviewer runs will appear here after a worker is ready for review or after a
                  manual review is requested.
                </p>
                <Link
                  href={projectId ? projectDashboardPath(projectId) : "/?project=all"}
                  className="review-empty-state__link"
                >
                  Back to coding dashboard
                </Link>
              </section>
            ) : (
              <div className="kanban-board-wrap">
                <div
                  className="kanban-board review-kanban-board"
                  data-columns={REVIEW_BOARD_COLUMNS.length}
                  style={
                    {
                      "--kanban-column-count": REVIEW_BOARD_COLUMNS.length,
                    } as React.CSSProperties
                  }
                >
                  {REVIEW_BOARD_COLUMNS.map((column) => (
                    <ReviewColumn
                      key={column}
                      column={column}
                      runs={grouped[column]}
                      allProjectsView={allProjectsView}
                      executingRunIds={executingRunIds}
                      sendingRunIds={sendingRunIds}
                      onOpenDetails={handleOpenReviewDetails}
                      onExecute={handleExecuteRun}
                      onSendFeedback={handleSendFeedback}
                    />
                  ))}
                </div>
              </div>
            )}
          </main>
        </div>
        {reviewDetails ? (
          <ReviewDetailsDrawer
            state={reviewDetails}
            onClose={() => setReviewDetails(null)}
            onOpenWorker={() => setReviewDetails(null)}
            isSending={sendingRunIds.has(reviewDetails.run.id)}
            onSendFeedback={handleSendFeedback}
          />
        ) : null}
      </div>
    </SidebarContext.Provider>
  );
}

export function ReviewDashboard(props: ReviewDashboardProps) {
  return (
    <ToastProvider>
      <ReviewDashboardInner {...props} />
    </ToastProvider>
  );
}

function ReviewMetric({ label, value, meta }: { label: string; value: number; meta: string }) {
  return (
    <div className="dashboard-stat-card">
      <span className="dashboard-stat-card__value">{value}</span>
      <span className="dashboard-stat-card__label">{label}</span>
      <span className="dashboard-stat-card__meta">{meta}</span>
    </div>
  );
}

function ReviewColumn({
  column,
  runs,
  allProjectsView,
  executingRunIds,
  sendingRunIds,
  onOpenDetails,
  onExecute,
  onSendFeedback,
}: {
  column: ReviewBoardColumn;
  runs: DashboardReviewRun[];
  allProjectsView: boolean;
  executingRunIds: Set<string>;
  sendingRunIds: Set<string>;
  onOpenDetails: (run: DashboardReviewRun) => void;
  onExecute: (run: DashboardReviewRun) => void;
  onSendFeedback: (run: DashboardReviewRun) => void;
}) {
  return (
    <div className="kanban-column review-kanban-column" data-review-column={column}>
      <div className="kanban-column__header">
        <div className="kanban-column__title-row">
          <div className="kanban-column__dot review-column-dot" data-review-column={column} />
          <span className="kanban-column__title">{REVIEW_COLUMN_LABELS[column]}</span>
          <span className="kanban-column__count">{runs.length}</span>
        </div>
        <p className="review-column-hint">{COLUMN_HINTS[column]}</p>
      </div>

      <div className="kanban-column-body">
        {runs.length > 0 ? (
          <div className="kanban-column__stack">
            {runs.map((run) => (
              <ReviewCard
                key={run.id}
                run={run}
                allProjectsView={allProjectsView}
                isExecuting={executingRunIds.has(run.id)}
                isSending={sendingRunIds.has(run.id)}
                onOpenDetails={onOpenDetails}
                onExecute={onExecute}
                onSendFeedback={onSendFeedback}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ReviewCard({
  run,
  allProjectsView,
  isExecuting,
  isSending,
  onOpenDetails,
  onExecute,
  onSendFeedback,
}: {
  run: DashboardReviewRun;
  allProjectsView: boolean;
  isExecuting: boolean;
  isSending: boolean;
  onOpenDetails: (run: DashboardReviewRun) => void;
  onExecute: (run: DashboardReviewRun) => void;
  onSendFeedback: (run: DashboardReviewRun) => void;
}) {
  const workerHref = projectDashboardSessionPath(run.projectId, run.linkedSessionId);
  const title = run.workerTitle ?? run.linkedSessionId;
  const status = formatStatus(run.status);
  const totalFindingLabel = pluralize(run.findingCount, "finding");
  const secondaryText =
    run.summary ??
    (run.status === "clean"
      ? "Reviewer completed without open AO findings."
      : `Review requested for ${run.linkedSessionId}.`);
  const truthLine = `${status} · ${totalFindingLabel}${
    run.dismissedFindingCount > 0 ? ` · ${pluralize(run.dismissedFindingCount, "dismissed")}` : ""
  }${run.sentFindingCount > 0 ? ` · ${pluralize(run.sentFindingCount, "sent")}` : ""} · worker ${getWorkerAvailabilityLabel(run)}`;
  const canExecute = isExecuting || run.status === "queued" || run.status === "failed";
  const feedbackAvailable = canSendFeedbackToWorker(run);
  const dotClass =
    run.status === "running" || run.status === "preparing"
      ? "card__adot--working"
      : run.status === "clean"
        ? "card__adot--ready"
        : run.status === "needs_triage" || run.status === "failed" || run.status === "cancelled"
          ? "card__adot--waiting"
          : run.status === "sent_to_agent" || run.status === "waiting_update"
            ? "card__adot--ready"
            : "card__adot--idle";

  return (
    <article
      className="session-card session-card--fixed review-card"
      data-review-status={run.status}
      data-reviewer-session-id={run.reviewerSessionId}
      data-linked-session-id={run.linkedSessionId}
    >
      <div className="session-card__header">
        <span className={`card__adot ${dotClass}`} />
        <span className="card__id">
          {allProjectsView ? `${run.projectName} · ` : ""}
          {run.reviewerSessionId}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          className="session-card__control session-card__terminal-link"
          onClick={() => onOpenDetails(run)}
        >
          <svg
            className="session-card__control-icon"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path d="M4 19.5V5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-1.5Z" />
            <path d="M8 7h6M8 11h6M8 15h4" />
          </svg>
          details
        </button>
      </div>

      <div className="session-card__body flex min-h-0 flex-1 flex-col">
        <div className="card__title-wrap">
          <p className="card__title">{title}</p>
        </div>

        <div className="card__meta">
          {run.workerBranch ? <span className="card__branch">{run.workerBranch}</span> : null}
          {run.workerBranch && run.prNumber ? (
            <span className="card__meta-sep" aria-hidden="true">
              ·
            </span>
          ) : null}
          {run.prNumber && run.workerPrUrl ? (
            <a href={run.workerPrUrl} target="_blank" rel="noreferrer" className="card__pr">
              #{run.prNumber}
            </a>
          ) : run.prNumber ? (
            <span className="card__pr">#{run.prNumber}</span>
          ) : null}
        </div>

        <div className="px-[10px] pb-[5px]">
          <p className="session-card__secondary">{secondaryText}</p>
        </div>

        <div className="px-[10px] pb-[5px]">
          <p className="text-[10px] leading-relaxed text-[var(--color-text-tertiary)]">
            {truthLine}
          </p>
        </div>

        {run.openFindingCount > 0 ? (
          <div className="card__alerts">
            <div className="alert-row alert-row--review review-card__finding-alert">
              <span className="alert-row__icon" aria-hidden="true">
                !
              </span>
              <span className="alert-row__text">
                <button type="button" onClick={() => onOpenDetails(run)}>
                  <span className="font-bold">{run.openFindingCount}</span>{" "}
                  {run.openFindingCount === 1 ? "open finding" : "open findings"}
                </button>
              </span>
              <button
                type="button"
                className="alert-row__action"
                onClick={() => onOpenDetails(run)}
              >
                view
              </button>
            </div>
          </div>
        ) : null}

        <div className="session-card__footer">
          <span className="card__status min-w-0 truncate">
            {status} · updated {formatRelativeTime(run.updatedAt)}
          </span>
          <div className="session-card__footer-actions">
            {canExecute ? (
              <button
                type="button"
                className="session-card__control session-card__review-control"
                disabled={isExecuting}
                onClick={() => onExecute(run)}
              >
                <svg
                  className="session-card__control-icon"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path d="M5 3v18l15-9-15-9Z" />
                </svg>
                {isExecuting ? "Running" : run.status === "failed" ? "Retry" : "Run"}
              </button>
            ) : null}
            <Link href={workerHref} className="session-card__control session-card__review-control">
              Worker
            </Link>
            {feedbackAvailable ? (
              <button
                type="button"
                className="session-card__control session-card__terminal-link"
                disabled={isSending || run.openFindingCount === 0}
                title={
                  run.openFindingCount === 0
                    ? "No open review findings to send."
                    : "Send review findings to the worker."
                }
                onClick={() => onSendFeedback(run)}
              >
                {isSending ? "Sending" : "Feedback"}
              </button>
            ) : (
              <span
                className="session-card__control session-card__terminal-link review-card__disabled-control"
                title="This worker has no live runtime to receive terminal feedback."
              >
                {getWorkerAvailabilityLabel(run)}
              </span>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

function ReviewDetailsDrawer({
  state,
  onClose,
  onOpenWorker,
  isSending,
  onSendFeedback,
}: {
  state: ReviewDetailsState;
  onClose: () => void;
  onOpenWorker: () => void;
  isSending: boolean;
  onSendFeedback: (run: DashboardReviewRun) => void;
}) {
  const { run, findings, loading, error } = state;
  const workerHref = projectDashboardSessionPath(run.projectId, run.linkedSessionId);
  const feedbackHref = projectSessionHashPath(
    run.projectId,
    run.linkedSessionId,
    "#session-terminal-section",
  );
  const openFindings = findings.filter((finding) => finding.status === "open");
  const feedbackAvailable = canSendFeedbackToWorker(run);

  return (
    <>
      <div className="review-detail-backdrop" onClick={onClose} />
      <aside
        className="review-detail-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="review-detail-title"
      >
        <div className="review-detail-panel__header">
          <div>
            <div className="review-detail-panel__eyebrow">{run.reviewerSessionId}</div>
            <h2 id="review-detail-title" className="review-detail-panel__title">
              {run.workerTitle ?? run.linkedSessionId}
            </h2>
          </div>
          <button
            type="button"
            className="review-detail-panel__close"
            onClick={onClose}
            aria-label="Close review details"
          >
            x
          </button>
        </div>

        <div className="review-detail-panel__meta">
          <span>{formatStatus(run.status)}</span>
          <span>{run.linkedSessionId}</span>
          {run.workerBranch ? <span>{run.workerBranch}</span> : null}
          {run.prNumber ? <span>PR #{run.prNumber}</span> : null}
        </div>

        <div className="review-detail-panel__actions">
          <Link href={workerHref} onClick={onOpenWorker}>
            Open worker
          </Link>
          {run.workerPrUrl ? (
            <a href={run.workerPrUrl} target="_blank" rel="noreferrer">
              Open PR
            </a>
          ) : null}
          {feedbackAvailable ? <Link href={feedbackHref}>Open terminal</Link> : null}
          {feedbackAvailable && openFindings.length > 0 ? (
            <button type="button" disabled={isSending} onClick={() => onSendFeedback(run)}>
              {isSending ? "Sending feedback" : "Send feedback"}
            </button>
          ) : null}
        </div>

        {!feedbackAvailable ? (
          <div className="review-detail-panel__notice">
            Worker feedback is unavailable because the linked worker is{" "}
            {getWorkerAvailabilityLabel(run)}. Open the worker card to inspect or restore it before
            sending review findings back.
          </div>
        ) : null}

        <div className="review-detail-panel__summary">
          <div className="review-detail-panel__summary-item">
            <span>Open</span>
            <strong>{openFindings.length || run.openFindingCount}</strong>
          </div>
          <div className="review-detail-panel__summary-item">
            <span>Total</span>
            <strong>{run.findingCount}</strong>
          </div>
          <div className="review-detail-panel__summary-item">
            <span>Updated</span>
            <strong>{formatRelativeTime(run.updatedAt)}</strong>
          </div>
        </div>

        <div className="review-detail-panel__content">
          {loading ? <div className="review-detail-panel__empty">Loading findings...</div> : null}
          {error ? <div className="review-detail-panel__error">{error}</div> : null}
          {!loading && !error && findings.length === 0 ? (
            <div className="review-detail-panel__empty">No findings captured for this run.</div>
          ) : null}
          {!loading && !error
            ? findings.map((finding) => {
                const location = formatFindingLocation(finding);
                return (
                  <article
                    key={finding.id}
                    className="review-detail-finding"
                    data-severity={finding.severity}
                  >
                    <div className="review-detail-finding__header">
                      <span>{finding.severity}</span>
                      <span>{formatStatus(finding.status)}</span>
                    </div>
                    <h3>{finding.title}</h3>
                    {location ? <code>{location}</code> : null}
                    <p>{finding.body}</p>
                  </article>
                );
              })
            : null}
        </div>
      </aside>
    </>
  );
}
