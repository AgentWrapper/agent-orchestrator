"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import type { DashboardPR } from "@/lib/types";
import {
  activityStateClass,
  activityToneClass,
  buildGitHubBranchUrl,
} from "./session-detail-utils";

interface SessionTopStripProps {
  headline: string;
  crumbId: string;
  activityLabel: string;
  activityColor: string;
  branch: string | null;
  pr: DashboardPR | null;
  isOrchestrator?: boolean;
  crumbHref: string;
  crumbLabel: string;
  rightSlot?: ReactNode;
  onKill?: () => void;
  onRestore?: () => void;
}

export function SessionTopStrip({
  headline,
  crumbId,
  activityLabel,
  activityColor,
  branch,
  pr,
  isOrchestrator = false,
  crumbHref,
  crumbLabel,
  rightSlot,
  onKill,
  onRestore,
}: SessionTopStripProps) {
  return (
    <div className="session-detail-top-strip">
      <div className="session-detail-crumbs">
        <a href={crumbHref} className="session-detail-crumb-back">
          <svg
            className="h-3 w-3 opacity-60"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            viewBox="0 0 24 24"
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
          {crumbLabel}
        </a>
        <span className="session-detail-crumb-sep">/</span>
        <span className="session-detail-crumb-id">{crumbId}</span>
        {isOrchestrator ? <span className="session-detail-mode-badge">orchestrator</span> : null}
      </div>

      <div className="session-detail-identity">
        <div className="session-detail-identity__info">
          <h1 className="session-detail-identity__title">{headline}</h1>
          <div className="session-detail-identity__pills">
            <div className={cn("session-detail-status-pill", activityStateClass(activityLabel))}>
              <span
                className={cn(
                  "session-detail-status-pill__dot",
                  activityToneClass(activityColor),
                )}
              />
              <span className="session-detail-status-pill__label">{activityLabel}</span>
            </div>
            {branch ? (
              pr ? (
                <a
                  href={buildGitHubBranchUrl(pr)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="session-detail-link-pill session-detail-link-pill--branch session-detail-link-pill--branch-link hover:no-underline"
                >
                  {branch}
                </a>
              ) : (
                <span className="session-detail-link-pill session-detail-link-pill--branch">
                  {branch}
                </span>
              )
            ) : null}
            {pr ? (
              <a
                href={pr.url}
                target="_blank"
                rel="noopener noreferrer"
                className="session-detail-link-pill session-detail-link-pill--pr hover:no-underline"
              >
                PR #{pr.number}
              </a>
            ) : null}
            {pr && (pr.additions > 0 || pr.deletions > 0) ? (
              <span className="session-detail-link-pill session-detail-link-pill--diff">
                <span className="session-detail-diff--add">+{pr.additions}</span>{" "}
                <span className="session-detail-diff--del">-{pr.deletions}</span>
              </span>
            ) : null}
          </div>
        </div>

        {rightSlot ? (
          <div className="session-detail-identity__actions session-detail-identity__actions--custom">
            {rightSlot}
          </div>
        ) : (
          <div className="session-detail-identity__actions">
            {onRestore ? (
              <button type="button" className="done-restore-btn" onClick={onRestore}>
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
                Restore
              </button>
            ) : onKill ? (
              <button
                type="button"
                className="session-detail-action-btn session-detail-action-btn--danger"
                onClick={onKill}
              >
                <svg
                  className="h-3.5 w-3.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                >
                  <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
                Kill
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
