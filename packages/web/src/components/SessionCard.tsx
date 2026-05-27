"use client";

import { memo, useState, useEffect } from "react";
import {
  type DashboardSession,
  getAttentionLevel,
  isPRRateLimited,
  isPRUnenriched,
  CI_STATUS,
  isDashboardSessionDone,
  isDashboardSessionTerminal,
  isDashboardSessionRestorable,
} from "@/lib/types";
import { cn } from "@/lib/cn";
import { getSessionTitle } from "@/lib/format";
import { StatusBadge } from "./StatusBadge";
import { DoneSessionCard } from "./SessionCard.parts";
import { projectSessionHashPath } from "@/lib/routes";

/**
 * Tracks which session IDs have already played their entrance animation.
 * Prevents the kanban-card-enter animation from replaying when React
 * unmounts and remounts a card due to attention-level column changes.
 */
const enteredSessionIds = new Set<string>();

interface SessionCardProps {
  session: DashboardSession;
  onKill?: (sessionId: string) => void;
  onRestore?: (sessionId: string) => void;
}

function SessionCardView({ session, onKill, onRestore }: SessionCardProps) {
  const [killConfirming, setKillConfirming] = useState(false);

  // Only play the entrance animation on the very first mount of this session.
  // Subsequent remounts (e.g. attention-level column change) skip the animation
  // to prevent the card from blinking (opacity 0→1 flash every SSE cycle).
  const [hasEntered] = useState(() => enteredSessionIds.has(session.id));
  useEffect(() => {
    if (hasEntered) return;

    const frameId = window.requestAnimationFrame(() => {
      enteredSessionIds.add(session.id);
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [hasEntered, session.id]);

  const level = getAttentionLevel(session);
  const pr = session.pr;

  const rateLimited = pr ? isPRRateLimited(pr) : false;
  const prUnenriched = pr ? isPRUnenriched(pr) : false;
  const isReadyToMerge = !rateLimited && pr?.mergeability.mergeable && pr.state === "open";
  const isTerminal = isDashboardSessionTerminal(session);
  const isRestorable = isDashboardSessionRestorable(session);

  const title = getSessionTitle(session);
  const footerDetail = getFooterDetail(session, Boolean(isReadyToMerge), rateLimited, prUnenriched);
  const isDone = isDashboardSessionDone(session) || level === "done";

  const handleKillClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (!killConfirming) {
      setKillConfirming(true);
      return;
    }

    setKillConfirming(false);
    onKill?.(session.id);
  };

  /* ── Done card variant (split out into SessionCard.parts) ───────── */
  if (isDone) {
    return <DoneSessionCard session={session} onRestore={onRestore} />;
  }

  /* ── Standard card (non-done) — compact / informational ──────────── */
  return (
    <div className={cn("session-card border", !hasEntered && "kanban-card-enter")}>
      <div className="session-card__header">
        <StatusBadge session={session} />
        <div className="flex-1" />
        <span className="card__id">{session.id}</span>
        {isRestorable && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRestore?.(session.id);
            }}
            className="session-card__control session-card__restore-control"
          >
            <svg
              className="session-card__control-icon"
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
            restore
          </button>
        )}
        {!isTerminal && (
          <a
            href={projectSessionHashPath(
              session.projectId,
              session.id,
              "#session-terminal-section",
            )}
            onClick={(e) => e.stopPropagation()}
            className="session-card__terminal-link"
          >
            <svg
              className="session-card__terminal-link-icon"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <path d="m4 17 6-6-6-6" />
              <path d="M12 19h8" />
            </svg>
            terminal
          </a>
        )}
      </div>

      <div className="session-card__body flex min-h-0 flex-1 flex-col">
        <div className="card__title-wrap">
          <p className="card__title">{title}</p>
        </div>

        {session.branch && (
          <div className="card__meta">
            <span className="card__branch-icon" aria-hidden="true">
              <svg fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
                <line x1="6" y1="4" x2="6" y2="14" />
                <circle cx="6" cy="17" r="2.3" />
                <circle cx="18" cy="7" r="2.3" />
                <path d="M18 9.3a8 8 0 0 1-8 8" />
              </svg>
            </span>
            <span className="card__branch">{session.branch}</span>
          </div>
        )}

        <div className="session-card__footer">
          <div className="session-card__footer-info">
            {pr ? (
              <a
                href={pr.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="card__pr"
              >
                PR #{pr.number}
              </a>
            ) : null}
            {pr && footerDetail ? (
              <span className="card__meta-sep" aria-hidden="true">
                ·
              </span>
            ) : null}
            {footerDetail ? (
              <span className="session-card__footer-detail" data-tone={footerDetail.tone}>
                {footerDetail.text}
              </span>
            ) : null}
          </div>

          <div className="session-card__footer-actions">
            {!isTerminal ? (
              <button
                onClick={handleKillClick}
                onMouseLeave={() => setKillConfirming(false)}
                onBlur={() => setKillConfirming(false)}
                aria-label={killConfirming ? "Confirm terminate session" : "Terminate session"}
                className={cn(
                  "session-card__control session-card__terminate btn--danger",
                  killConfirming && "is-confirming",
                )}
              >
                {killConfirming ? (
                  <span className="font-mono text-[10px] font-semibold tracking-[0.04em]">
                    kill?
                  </span>
                ) : (
                  <svg
                    className="session-card__control-icon"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    viewBox="0 0 24 24"
                  >
                    <path d="M3 6h18" />
                    <path d="M8 6V4h8v2" />
                    <path d="M19 6l-1 14H6L5 6" />
                  </svg>
                )}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function areSessionCardPropsEqual(prev: SessionCardProps, next: SessionCardProps): boolean {
  return (
    prev.session === next.session &&
    prev.onKill === next.onKill &&
    prev.onRestore === next.onRestore
  );
}

export const SessionCard = memo(SessionCardView, areSessionCardPropsEqual);

type FooterTone = "fail" | "amber" | "green" | undefined;

/**
 * Terse PR/CI detail for the card's thin info footer (mockup: `PR #N · CI …`).
 * No cost is shown (the dashboard session carries none).
 */
function getFooterDetail(
  session: DashboardSession,
  isReadyToMerge: boolean,
  rateLimited: boolean,
  prUnenriched: boolean,
): { text: string; tone: FooterTone } | null {
  const pr = session.pr;
  if (!pr) {
    if (session.lifecycle?.sessionState === "detecting") {
      return { text: "detecting…", tone: undefined };
    }
    return { text: "no PR yet", tone: undefined };
  }
  if (rateLimited) return { text: "PR data rate limited", tone: undefined };
  if (prUnenriched) return { text: "loading…", tone: undefined };

  if (
    pr.ciStatus === CI_STATUS.FAILING ||
    session.lifecycle?.prReason === "ci_failing" ||
    session.status === "ci_failed"
  ) {
    const failed = pr.ciChecks.filter((c) => c.status === "failed").length;
    return {
      text: failed > 0 ? `${failed} check${failed === 1 ? "" : "s"} failed` : "CI failed",
      tone: "fail",
    };
  }
  if (pr.reviewDecision === "changes_requested") {
    return { text: "changes requested", tone: "amber" };
  }
  if (pr.unresolvedThreads > 0) {
    return {
      text: `${pr.unresolvedThreads} comment${pr.unresolvedThreads === 1 ? "" : "s"}`,
      tone: "amber",
    };
  }
  if (isReadyToMerge && pr.reviewDecision === "approved") {
    return { text: "approved", tone: "green" };
  }
  if (pr.ciStatus === CI_STATUS.PASSING) return { text: "CI passed", tone: "green" };
  if (pr.ciStatus === CI_STATUS.PENDING) return { text: "CI running", tone: undefined };
  return { text: "review pending", tone: undefined };
}
