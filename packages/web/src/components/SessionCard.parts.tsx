"use client";

import { useState } from "react";
import {
  type DashboardSession,
  isPRRateLimited,
  isPRUnenriched,
  getSessionTruthLabel,
  isDashboardSessionRestorable,
} from "@/lib/types";
import { cn } from "@/lib/cn";
import { getSessionTitle } from "@/lib/format";
import { CICheckList } from "./CIBadge";
import { getSizeLabel } from "./PRStatus";
import { projectSessionPath } from "@/lib/routes";

/**
 * Determine the status display info for done cards.
 */
function getDoneStatusInfo(session: DashboardSession): {
  label: string;
  pillClass: string;
  icon: React.ReactNode;
} {
  const activity = session.activity;
  const status = session.status;
  const prState = session.lifecycle?.prState ?? session.pr?.state;

  if (prState === "merged" || status === "merged") {
    return {
      label: "merged",
      pillClass: "done-status-pill--merged",
      icon: (
        <svg
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          viewBox="0 0 24 24"
          className="h-3 w-3"
        >
          <path d="M20 6 9 17l-5-5" />
        </svg>
      ),
    };
  }

  if (prState === "closed") {
    return {
      label: "closed",
      pillClass: "done-status-pill--exited",
      icon: (
        <svg
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          viewBox="0 0 24 24"
          className="h-3 w-3"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M9 12h6" />
        </svg>
      ),
    };
  }

  if (
    session.lifecycle?.sessionState === "terminated" ||
    status === "killed" ||
    status === "terminated"
  ) {
    return {
      label: getSessionTruthLabel(session),
      pillClass: "done-status-pill--killed",
      icon: (
        <svg
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          viewBox="0 0 24 24"
          className="h-3 w-3"
        >
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      ),
    };
  }

  // Default: exited / done / cleanup / closed PR
  const label = activity === "exited" ? "exited" : getSessionTruthLabel(session);
  return {
    label,
    pillClass: "done-status-pill--exited",
    icon: (
      <svg
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        viewBox="0 0 24 24"
        className="h-3 w-3"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M9 12h6" />
      </svg>
    ),
  };
}

interface DoneSessionCardProps {
  session: DashboardSession;
  onRestore?: (sessionId: string) => void;
}

/**
 * Done / Terminated card variant — kept intact from the original SessionCard.
 * Click to expand a detail panel (summary, issue, CI checks, PR metrics).
 */
export function DoneSessionCard({ session, onRestore }: DoneSessionCardProps) {
  const [expanded, setExpanded] = useState(false);
  const pr = session.pr;
  const rateLimited = pr ? isPRRateLimited(pr) : false;
  const prUnenriched = pr ? isPRUnenriched(pr) : false;
  const isRestorable = isDashboardSessionRestorable(session);
  const title = getSessionTitle(session);
  const statusInfo = getDoneStatusInfo(session);

  return (
    <div
      className={cn("session-card-done", expanded && "done-expanded")}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a, button, textarea")) return;
        setExpanded(!expanded);
      }}
    >
      {/* Row 1: Status pill + session id + restore */}
      <div className="flex items-center gap-2 px-3.5 pt-3 pb-1.5">
        <span className={cn("done-status-pill", statusInfo.pillClass)}>
          {statusInfo.icon}
          {statusInfo.label}
        </span>
        <span className="font-[var(--font-mono)] text-[10px] tracking-wide text-[var(--color-text-muted)]">
          {session.id}
        </span>
        <div className="flex-1" />
        {isRestorable && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRestore?.(session.id);
            }}
            className="done-card__restore"
          >
            <svg
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
              className="h-3 w-3"
            >
              <polyline points="1 4 1 10 7 10" />
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
            </svg>
            restore
          </button>
        )}
      </div>

      {/* Row 2: Title */}
      <div className="px-3.5 pb-2">
        <p className="session-card-done__title text-[13px] font-semibold leading-snug [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden">
          {title}
        </p>
      </div>

      {/* Row 3: Meta chips */}
      <div className="flex flex-wrap items-center gap-1.5 px-3.5 pb-3">
        {session.branch && (
          <span className="done-meta-chip font-[var(--font-mono)]">
            <svg
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
              className="h-2.5 w-2.5 opacity-50"
            >
              <path d="M6 3v12M18 9a3 3 0 0 1-3 3H9a3 3 0 0 0-3 3" />
              <circle cx="18" cy="6" r="3" />
            </svg>
            {session.branch}
          </span>
        )}
        {pr && (
          <a
            href={pr.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="done-meta-chip font-[var(--font-mono)] font-bold text-[var(--color-text-primary)] no-underline underline-offset-2 hover:underline"
          >
            #{pr.number}
          </a>
        )}
        {pr &&
          !rateLimited &&
          (prUnenriched ? (
            <span className="inline-block h-[14px] w-16 animate-pulse rounded-full bg-[var(--color-bg-subtle)]" />
          ) : (
            <span className="done-meta-chip font-[var(--font-mono)]">
              <span className="text-[var(--color-status-ready)]">+{pr.additions}</span>{" "}
              <span className="text-[var(--color-status-error)]">-{pr.deletions}</span>{" "}
              {getSizeLabel(pr.additions, pr.deletions)}
              <span className="sr-only">
                {`+${pr.additions} -${pr.deletions} ${getSizeLabel(pr.additions, pr.deletions)}`}
              </span>
            </span>
          ))}
        <a
          href={projectSessionPath(session.projectId, session.id)}
          onClick={(e) => e.stopPropagation()}
          className="done-meta-chip font-[var(--font-mono)] font-semibold text-[var(--color-accent)] no-underline hover:underline"
        >
          View current context
        </a>
      </div>

      {/* Expandable detail panel */}
      {expanded && (
        <div className="done-expand-section px-3.5 py-3">
          {session.summary && pr?.title && session.summary !== pr.title && (
            <div className="mb-3">
              <div className="done-detail-heading">
                <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path d="M4 6h16M4 12h16M4 18h10" />
                </svg>
                Summary
              </div>
              <p className="text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
                {session.summary}
              </p>
            </div>
          )}

          {session.issueUrl && (
            <div className="mb-3">
              <div className="done-detail-heading">
                <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 8v4M12 16h.01" />
                </svg>
                Issue
              </div>
              <a
                href={session.issueUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="text-[12px] text-[var(--color-accent)] hover:underline"
              >
                {session.issueLabel || session.issueUrl}
                {session.issueTitle && `: ${session.issueTitle}`}
              </a>
            </div>
          )}

          {pr && pr.ciChecks.length > 0 && (
            <div className="mb-3">
              <div className="done-detail-heading">
                <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path d="M9 12l2 2 4-4" />
                  <circle cx="12" cy="12" r="10" />
                </svg>
                CI Checks
              </div>
              <CICheckList checks={pr.ciChecks} />
            </div>
          )}

          {pr && (
            <div className="mb-3">
              <div className="done-detail-heading">
                <svg fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65S8.93 17.38 9 18v4" />
                  <path d="M9 18c-4.51 2-5-2-7-2" />
                </svg>
                PR
              </div>
              <p className="text-[12px] text-[var(--color-text-secondary)]">
                <a
                  href={pr.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="hover:underline"
                >
                  {pr.title}
                </a>
                {prUnenriched ? (
                  <>
                    <br />
                    <span className="mt-1 inline-flex items-center gap-2 text-[10px] text-[var(--color-text-muted)]">
                      <span className="inline-block h-3 w-12 animate-pulse rounded bg-[var(--color-bg-subtle)]" />
                      <span>PR details loading...</span>
                    </span>
                  </>
                ) : (
                  <>
                    <br />
                    <span className="mt-1 inline-flex items-center gap-2">
                      <span className="done-meta-chip font-[var(--font-mono)]">
                        <span className="text-[var(--color-status-ready)]">+{pr.additions}</span>{" "}
                        <span className="text-[var(--color-status-error)]">-{pr.deletions}</span>
                      </span>
                      <span className="text-[var(--color-text-muted)]">·</span>
                      <span className="text-[10px] text-[var(--color-text-muted)]">
                        mergeable: {pr.mergeability.mergeable ? "yes" : "no"}
                      </span>
                      <span className="text-[var(--color-text-muted)]">·</span>
                      <span className="text-[10px] text-[var(--color-text-muted)]">
                        review: {pr.reviewDecision}
                      </span>
                    </span>
                  </>
                )}
              </p>
            </div>
          )}

          {!pr && (
            <p className="text-[12px] text-[var(--color-text-tertiary)]">
              No PR associated with this session.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
