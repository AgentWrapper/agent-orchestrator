"use client";

import type { DashboardPR, DashboardSession } from "@/lib/types";
import { formatRelativeTime } from "@/lib/format";

interface SessionEndedSummaryProps {
  session: DashboardSession;
  headline: string;
  pr: DashboardPR | null;
  dashboardHref: string;
}

function formatEndedTime(isoDate: string | null | undefined): string {
  if (!isoDate) return "Unknown";
  const timestamp = new Date(isoDate).getTime();
  if (!Number.isFinite(timestamp)) return "Unknown";
  return formatRelativeTime(timestamp);
}

function getEndedSessionReason(session: DashboardSession): string {
  if (session.lifecycle?.runtime.reasonLabel) {
    return session.lifecycle.runtime.reasonLabel;
  }
  if (session.status === "killed") return "Manually stopped";
  if (session.status === "terminated") return "Runtime unavailable";
  if (session.status === "done" || session.status === "merged") return "Work completed";
  return "Terminal ended";
}

function getEndedSessionSummary(session: DashboardSession, headline: string): string {
  const pinnedSummary = session.metadata["pinnedSummary"];
  if (pinnedSummary) return pinnedSummary;
  if (session.summary && !session.summaryIsFallback) return session.summary;
  if (session.lifecycle?.summary) return session.lifecycle.summary;
  if (session.userPrompt) return session.userPrompt;
  if (session.summary) return session.summary;
  return headline;
}

export function SessionEndedSummary({
  session,
  headline,
  pr,
  dashboardHref,
}: SessionEndedSummaryProps) {
  const reason = getEndedSessionReason(session);
  const summary = getEndedSessionSummary(session, headline);
  const endedAt =
    session.lifecycle?.session.terminatedAt ??
    session.lifecycle?.session.completedAt ??
    session.lifecycle?.session.lastTransitionAt ??
    session.lastActivityAt;
  const runtimeLabel = session.lifecycle?.runtime.label ?? "Unavailable";
  const prLabel = pr
    ? pr.state === "merged"
      ? "Merged"
      : pr.state === "closed"
        ? "Closed"
        : pr.mergeability.mergeable
          ? "Open, merge-ready"
          : "Open"
    : "No PR";

  return (
    <section className="session-ended-summary" aria-label="Session ended summary">
      <div className="session-ended-summary__panel">
        <div className="session-ended-summary__eyebrow">Terminal ended</div>
        <div className="session-ended-summary__header">
          <div className="session-ended-summary__icon" aria-hidden="true">
            <svg fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
              <rect x="3" y="5" width="18" height="14" rx="3" />
              <path d="M7 10l3 2-3 2" />
              <path d="M13 15h4" />
            </svg>
          </div>
          <div className="session-ended-summary__title-group">
            <h2 className="session-ended-summary__title">{headline}</h2>
            <p className="session-ended-summary__subtitle">
              {reason}. The live terminal is gone, but the session context is still available.
            </p>
          </div>
        </div>

        <div className="session-ended-summary__body">
          <div className="session-ended-summary__section">
            <div className="session-ended-summary__label">What happened</div>
            <p className="session-ended-summary__copy">{summary}</p>
          </div>

          <div className="session-ended-summary__facts" aria-label="Session facts">
            <div className="session-ended-summary__fact">
              <span>Session</span>
              <strong>{session.id}</strong>
            </div>
            <div className="session-ended-summary__fact">
              <span>Ended</span>
              <strong>{formatEndedTime(endedAt)}</strong>
            </div>
            <div className="session-ended-summary__fact">
              <span>Runtime</span>
              <strong>{runtimeLabel}</strong>
            </div>
            <div className="session-ended-summary__fact">
              <span>PR</span>
              <strong>{prLabel}</strong>
            </div>
          </div>

          <div className="session-ended-summary__links">
            {pr ? (
              <a
                href={pr.url}
                target="_blank"
                rel="noopener noreferrer"
                className="session-ended-summary__primary"
              >
                Open PR #{pr.number}
              </a>
            ) : null}
            <a href={dashboardHref} className="session-ended-summary__secondary">
              Back to dashboard
            </a>
          </div>

          {session.lifecycle?.evidence ? (
            <div className="session-ended-summary__evidence">
              <span>Evidence</span>
              <code>{session.lifecycle.evidence}</code>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
