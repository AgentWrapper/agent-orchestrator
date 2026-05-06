"use client";

import { memo, useState, useEffect, useRef } from "react";
import {
  type DashboardSession,
  getAttentionLevel,
  isPRRateLimited,
  isPRUnenriched,
  CI_STATUS,
  getSessionTruthLabel,
  getPRTruthLabel,
  getRuntimeTruthLabel,
  isDashboardSessionDone,
  isDashboardSessionTerminal,
  isDashboardSessionRestorable,
} from "@/lib/types";
import { cn } from "@/lib/cn";
import { getSessionTitle } from "@/lib/format";
import { CICheckList } from "./CIBadge";
import { getSizeLabel } from "./PRStatus";
import { projectSessionHashPath, projectSessionPath } from "@/lib/routes";

/**
 * Tracks which session IDs have already played their entrance animation.
 * Prevents the kanban-card-enter animation from replaying when React
 * unmounts and remounts a card due to attention-level column changes.
 */
const enteredSessionIds = new Set<string>();

interface SessionCardProps {
  session: DashboardSession;
  onSend?: (sessionId: string, message: string) => Promise<void> | void;
  onKill?: (sessionId: string) => void;
  onMerge?: (prNumber: number) => void;
  onRestore?: (sessionId: string) => void;
}

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

function SessionCardView({ session, onSend, onKill, onMerge, onRestore }: SessionCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [sendingAction, setSendingAction] = useState<string | null>(null);
  const [failedAction, setFailedAction] = useState<string | null>(null);
  const [sendingQuickReply, setSendingQuickReply] = useState<string | null>(null);
  const [sentQuickReply, setSentQuickReply] = useState<string | null>(null);
  const [killConfirming, setKillConfirming] = useState(false);
  const [replyText, setReplyText] = useState("");
  const actionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const quickReplyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const handleQuickReply = async (message: string): Promise<boolean> => {
    const trimmedMessage = message.trim();
    if (!trimmedMessage || sendingQuickReply !== null) return false;

    setSendingQuickReply(trimmedMessage);
    setSentQuickReply(null);

    try {
      await Promise.resolve(onSend?.(session.id, trimmedMessage));
      setSentQuickReply(trimmedMessage);
      if (quickReplyTimerRef.current) clearTimeout(quickReplyTimerRef.current);
      quickReplyTimerRef.current = setTimeout(() => setSentQuickReply(null), 2000);
      return true;
    } catch {
      return false;
    } finally {
      setSendingQuickReply(null);
    }
  };

  const handleReplyKeyDown = async (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const sent = await handleQuickReply(replyText);
      if (sent) setReplyText("");
    }
  };

  useEffect(() => {
    return () => {
      if (actionTimerRef.current) clearTimeout(actionTimerRef.current);
      if (quickReplyTimerRef.current) clearTimeout(quickReplyTimerRef.current);
    };
  }, []);

  const handleAction = async (action: string, message: string) => {
    if (sendingAction !== null) return;

    setSendingAction(action);
    setFailedAction(null);
    try {
      await Promise.resolve(onSend?.(session.id, message));
      if (actionTimerRef.current) clearTimeout(actionTimerRef.current);
      actionTimerRef.current = setTimeout(() => setSendingAction(null), 2000);
    } catch {
      setSendingAction(null);
      setFailedAction(action);
      if (actionTimerRef.current) clearTimeout(actionTimerRef.current);
      actionTimerRef.current = setTimeout(() => setFailedAction(null), 2000);
    }
  };

  const rateLimited = pr ? isPRRateLimited(pr) : false;
  const prUnenriched = pr ? isPRUnenriched(pr) : false;
  const alerts = getAlerts(session);
  const isReadyToMerge = !rateLimited && pr?.mergeability.mergeable && pr.state === "open";
  const isTerminal = isDashboardSessionTerminal(session);
  const isRestorable = isDashboardSessionRestorable(session);

  const title = getSessionTitle(session);
  const footerStatus = getFooterStatusLabel(session, level, Boolean(isReadyToMerge));
  const visiblePassingChecks =
    !rateLimited && pr && !prUnenriched
      ? pr.ciChecks.filter((check) => check.status === "passed").slice(0, 3)
      : [];
  const isDone = isDashboardSessionDone(session) || level === "done";
  const truthLine = session.lifecycle
    ? [
        `Session ${getSessionTruthLabel(session)}`,
        `PR ${getPRTruthLabel(session)}`,
        `Runtime ${getRuntimeTruthLabel(session)}`,
      ].join(" · ")
    : null;
  const secondaryText = session.issueLabel
    ? `${session.issueLabel}${session.issueTitle ? ` · ${session.issueTitle}` : ""}`
    : (session.issueTitle ??
      (session.summary && session.summary !== title ? session.summary : null));
  const cardFrameClass = isReadyToMerge
    ? "session-card--merge-frame"
    : alerts.length > 0
      ? "session-card--alert-frame"
      : "session-card--fixed";
  const accentClass = isReadyToMerge
    ? "session-card--accent-merge"
    : level === "working"
      ? "session-card--accent-working"
      : level === "respond"
        ? "session-card--accent-respond"
        : level === "review" || level === "pending"
          ? "session-card--accent-attention"
          : "session-card--accent-default";

  const handleKillClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (!killConfirming) {
      setKillConfirming(true);
      return;
    }

    setKillConfirming(false);
    onKill?.(session.id);
  };

  /* ── Done card variant ──────────────────────────────────────────── */
  if (isDone) {
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
              className="done-restore-btn"
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

            {/* Action buttons — restore already shown in header row */}
          </div>
        )}
      </div>
    );
  }

  const cardDotTone = (() => {
    if (isTerminal) return "exited";
    if (isReadyToMerge || level === "merge" || level === "review") return "ready";
    if (level === "respond") return "waiting";
    if (level === "pending") return "idle";
    if (level === "working") return "working";
    return "idle";
  })();

  /* ── Standard card (non-done) ────────────────────────────────────── */
  return (
    <div
      className={cn(
        "session-card border",
        !hasEntered && "kanban-card-enter",
        cardFrameClass,
        accentClass,
        isReadyToMerge && "card-merge-ready",
      )}
    >
      <div className="session-card__header">
        <span
          className={cn(
            "card__adot",
            cardDotTone === "working" && "card__adot--working",
            cardDotTone === "ready" && "card__adot--ready",
            cardDotTone === "idle" && "card__adot--idle",
            cardDotTone === "waiting" && "card__adot--waiting",
            cardDotTone === "exited" && "card__adot--exited",
          )}
        />
        <span className="card__id">{session.id}</span>
        <div className="flex-1" />
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
            className="session-card__control session-card__terminal-link"
          >
            <svg
              className="session-card__control-icon"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="M6 10l4 2-4 2" />
              <path d="M14 14h4" />
            </svg>
            terminal
          </a>
        )}
      </div>

      <div className="session-card__body flex min-h-0 flex-1 flex-col">
        <div className="card__title-wrap">
          <p className="card__title">{title}</p>
        </div>

        <div className="card__meta">
          {session.branch && <span className="card__branch">{session.branch}</span>}
          {session.branch && pr ? (
            <span className="card__meta-sep" aria-hidden="true">
              ·
            </span>
          ) : null}
          {pr && (
            <a
              href={pr.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="card__pr"
            >
              #{pr.number}
            </a>
          )}
          {pr &&
            !rateLimited &&
            (prUnenriched ? (
              <span className="inline-block h-[14px] w-16 animate-pulse rounded-full bg-[var(--color-bg-subtle)]" />
            ) : (
              <span className="card__diff inline-flex items-center">
                <span className="card__diff-add">+{pr.additions}</span>{" "}
                <span className="card__diff-del">-{pr.deletions}</span>{" "}
                <span className="card__diff-size">{getSizeLabel(pr.additions, pr.deletions)}</span>
                <span className="sr-only">
                  {`+${pr.additions} -${pr.deletions} ${getSizeLabel(pr.additions, pr.deletions)}`}
                </span>
              </span>
            ))}
        </div>

        {secondaryText && (
          <div className="px-[10px] pb-[5px]">
            {level === "merge" || isReadyToMerge ? (
              <p className="session-card__secondary session-card__secondary--merge">
                <svg
                  width="9"
                  height="9"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path d="M20 6 9 17l-5-5" />
                </svg>
                <span>{secondaryText}</span>
              </p>
            ) : (
              <p className="session-card__secondary">{secondaryText}</p>
            )}
          </div>
        )}

        {truthLine && (
          <div className="px-[10px] pb-[5px]">
            <p className="text-[10px] leading-relaxed text-[var(--color-text-tertiary)]">
              {truthLine}
            </p>
          </div>
        )}

        {rateLimited && pr?.state === "open" && (
          <div className="px-[10px] pb-[5px]">
            <span className="inline-flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]">
              <svg
                className="h-3 w-3 text-[var(--color-text-tertiary)]"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                viewBox="0 0 24 24"
              >
                <circle cx="12" cy="12" r="10" />
                <path d="M12 8v4M12 16h.01" />
              </svg>
              PR data rate limited
            </span>
          </div>
        )}

        {visiblePassingChecks.length > 0 && (
          <div className="card__ci">
            {visiblePassingChecks.map((check) => {
              const chipContent = (
                <>
                  <svg
                    width="8"
                    height="8"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                  {check.name}
                </>
              );
              return check.url ? (
                <a
                  key={check.name}
                  href={check.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ci-chip ci-chip--pass"
                  onClick={(e) => e.stopPropagation()}
                >
                  {chipContent}
                </a>
              ) : (
                <span key={check.name} className="ci-chip ci-chip--pass">
                  {chipContent}
                </span>
              );
            })}
          </div>
        )}

        {!rateLimited && alerts.length > 0 && (
          <div className="card__alerts flex flex-col">
            {alerts.slice(0, 3).map((alert) => (
              <div key={alert.key} className={cn("alert-row", `alert-row--${alert.type}`)}>
                <span className="alert-row__icon">{alert.icon}</span>
                <span className="alert-row__text">
                  <a
                    href={alert.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {alert.count !== undefined && (
                      <>
                        <span className="font-bold">{alert.count}</span>{" "}
                      </>
                    )}
                    {alert.label}
                  </a>
                  {alert.notified && (
                    <span className="alert-row__notified" title="Agent has been notified">
                      {" "}
                      &middot; notified
                    </span>
                  )}
                </span>
                {alert.actionLabel && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleAction(alert.key, alert.actionMessage ?? "");
                    }}
                    disabled={sendingAction === alert.key}
                    className="alert-row__action"
                  >
                    {sendingAction === alert.key
                      ? "sent!"
                      : failedAction === alert.key
                        ? "failed"
                        : alert.actionLabel}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {level === "respond" && (
          <div className="quick-reply" onClick={(e) => e.stopPropagation()}>
            {session.summary && !session.summaryIsFallback && (
              <div className="card__agent-msg">
                <svg
                  className="card__agent-msg-icon"
                  width="10"
                  height="10"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
                <span>{session.summary}</span>
              </div>
            )}
            <a
              href={projectSessionPath(session.projectId, session.id)}
              onClick={(e) => e.stopPropagation()}
              className="card__view-context"
            >
              View current context →
            </a>
            {!isTerminal && (
              <>
                <div className="card__presets">
                  <button
                    className="card__preset"
                    onClick={() => void handleQuickReply("continue")}
                    disabled={sendingQuickReply !== null}
                  >
                    {sendingQuickReply === "continue"
                      ? "Sending..."
                      : sentQuickReply === "continue"
                        ? "Sent"
                        : "Continue"}
                  </button>
                  <button
                    className="card__preset"
                    onClick={() => void handleQuickReply("abort")}
                    disabled={sendingQuickReply !== null}
                  >
                    {sendingQuickReply === "abort"
                      ? "Sending..."
                      : sentQuickReply === "abort"
                        ? "Sent"
                        : "Abort"}
                  </button>
                  <button
                    className="card__preset"
                    onClick={() => void handleQuickReply("skip")}
                    disabled={sendingQuickReply !== null}
                  >
                    {sendingQuickReply === "skip"
                      ? "Sending..."
                      : sentQuickReply === "skip"
                        ? "Sent"
                        : "Skip"}
                  </button>
                </div>
                <div className="card__reply-wrap">
                  <textarea
                    className="card__reply"
                    placeholder={
                      sendingQuickReply !== null ? "Sending..." : "Type a reply... (Enter to send)"
                    }
                    aria-label="Type a reply to the agent"
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    onKeyDown={(e) => {
                      void handleReplyKeyDown(e);
                    }}
                    rows={1}
                    disabled={sendingQuickReply !== null}
                  />
                </div>
              </>
            )}
          </div>
        )}

        <div className="session-card__footer">
          <span className="card__status min-w-0 truncate" title={session.userPrompt ?? undefined}>
            {!session.issueUrl && session.userPrompt
              ? session.userPrompt.length > 60
                ? session.userPrompt.slice(0, 60) + "…"
                : session.userPrompt
              : footerStatus}
          </span>

          {isReadyToMerge && pr ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onMerge?.(pr.number);
              }}
              className="session-card__control session-card__merge-control"
            >
              <svg
                className="session-card__control-icon"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                viewBox="0 0 24 24"
              >
                <circle cx="6" cy="6" r="2" />
                <circle cx="18" cy="18" r="2" />
                <circle cx="18" cy="6" r="2" />
                <path d="M8 6h5a3 3 0 0 1 3 3v7" />
              </svg>
              Merge PR #{pr.number}
            </button>
          ) : (
            !isTerminal && (
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
            )
          )}
        </div>
      </div>
    </div>
  );
}

function areSessionCardPropsEqual(prev: SessionCardProps, next: SessionCardProps): boolean {
  return (
    prev.session === next.session &&
    prev.onSend === next.onSend &&
    prev.onKill === next.onKill &&
    prev.onMerge === next.onMerge &&
    prev.onRestore === next.onRestore
  );
}

export const SessionCard = memo(SessionCardView, areSessionCardPropsEqual);

function getFooterStatusLabel(
  session: DashboardSession,
  level: ReturnType<typeof getAttentionLevel>,
  isReadyToMerge: boolean,
): string {
  if (isReadyToMerge || level === "merge") return "mergeable";
  if (session.lifecycle?.sessionState === "detecting") return "detecting";
  if (level === "respond") return getSessionTruthLabel(session);
  if (session.lifecycle?.prReason === "ci_failing" || session.status === "ci_failed")
    return "ci failing";
  if (level === "review") return getPRTruthLabel(session);
  if (level === "working") return getSessionTruthLabel(session);
  return getSessionTruthLabel(session);
}

interface Alert {
  key: string;
  type: "ci" | "changes" | "review" | "conflict" | "comment";
  icon: React.ReactNode;
  label: string;
  url: string;
  count?: number;
  notified?: boolean;
  actionLabel?: string;
  actionMessage?: string;
}

function getAlerts(session: DashboardSession): Alert[] {
  const pr = session.pr;
  if (!pr || pr.state !== "open") return [];
  if (isPRRateLimited(pr)) return [];
  if (isPRUnenriched(pr)) return [];

  const meta = session.metadata;
  const alerts: Alert[] = [];

  // The lifecycle manager's status is the most up-to-date source of truth.
  // PR enrichment data can be stale (5-min cache) or unavailable (rate limit/timeout).
  // Use lifecycle status as fallback when PR data hasn't caught up yet.
  const lifecyclePrReason = session.lifecycle?.prReason ?? null;
  const lifecycleStatus = meta["status"];

  const ciIsFailing =
    pr.ciStatus === CI_STATUS.FAILING ||
    lifecyclePrReason === "ci_failing" ||
    lifecycleStatus === "ci_failed";
  const hasChangesRequested =
    pr.reviewDecision === "changes_requested" ||
    lifecyclePrReason === "changes_requested" ||
    lifecycleStatus === "changes_requested";
  const hasConflicts = !pr.mergeability.noConflicts;

  if (ciIsFailing) {
    const failedCheck = pr.ciChecks.find((c) => c.status === "failed");
    const failCount = pr.ciChecks.filter((c) => c.status === "failed").length;
    if (failCount === 0 && pr.ciStatus !== CI_STATUS.FAILING) {
      // Lifecycle says ci_failed but PR enrichment hasn't caught up — show generic alert
      alerts.push({
        key: "ci-fail",
        type: "ci",
        icon: "\u2717",
        label: "CI failing",
        url: pr.url + "/checks",
        notified: Boolean(meta["lastCIFailureDispatchHash"]),
        actionLabel: "Ask to fix",
        actionMessage: `Please fix the failing CI checks on ${pr.url}`,
      });
    } else if (failCount === 0) {
      alerts.push({
        key: "ci-unknown",
        type: "ci",
        icon: "?",
        label: "CI unknown",
        url: pr.url + "/checks",
      });
    } else {
      alerts.push({
        key: "ci-fail",
        type: "ci",
        icon: "\u2717",
        count: failCount,
        label: `check${failCount > 1 ? "s" : ""} failing`,
        url: failedCheck?.url ?? pr.url + "/checks",
        notified: Boolean(meta["lastCIFailureDispatchHash"]),
        actionLabel: "Ask to fix",
        actionMessage: `Please fix the failing CI checks on ${pr.url}`,
      });
    }
  }

  if (hasChangesRequested) {
    alerts.push({
      key: "changes",
      type: "changes",
      icon: "\u21BB",
      label: "changes requested",
      url: pr.url,
      notified: Boolean(meta["lastPendingReviewDispatchHash"]),
      actionLabel: "Ask to address",
      actionMessage: `Please address the requested changes on ${pr.url}`,
    });
  } else if (!pr.isDraft && (pr.reviewDecision === "pending" || pr.reviewDecision === "none")) {
    alerts.push({
      key: "review",
      type: "review",
      icon: (
        <svg
          width="9"
          height="9"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      ),
      label: "needs review",
      url: pr.url,
      actionLabel: "Ask to post",
      actionMessage: `Post ${pr.url} on slack asking for a review.`,
    });
  }

  if (hasConflicts) {
    alerts.push({
      key: "conflict",
      type: "conflict",
      icon: "\u26A0",
      label: "merge conflict",
      url: pr.url,
      notified: meta["lastMergeConflictDispatched"] === "true",
      actionLabel: "Ask to fix",
      actionMessage: `Please resolve the merge conflicts on ${pr.url} by rebasing on the base branch`,
    });
  }

  if (pr.unresolvedThreads > 0) {
    const firstUrl = pr.unresolvedComments[0]?.url ?? pr.url + "/files";
    alerts.push({
      key: "comments",
      type: "comment",
      icon: "\uD83D\uDCAC",
      label: "unresolved comments",
      count: pr.unresolvedThreads,
      url: firstUrl,
      actionLabel: "Ask to resolve",
      actionMessage: `Please address all unresolved review comments on ${pr.url}`,
    });
  }

  return alerts;
}
