"use client";

import { memo, useState, useEffect, useRef } from "react";
import {
  type DashboardSession,
  getAttentionLevel,
  isPRRateLimited,
  isPRUnenriched,
  TERMINAL_STATUSES,
  TERMINAL_ACTIVITIES,
  CI_STATUS,
  type SessionStatus,
} from "@/lib/types";
import { cn } from "@/lib/cn";
import { getSessionTitle } from "@/lib/format";
import { CICheckList } from "./CIBadge";
import { ActivityDot } from "./ActivityDot";
import { getSizeLabel } from "./PRStatus";

interface SessionCardProps {
  session: DashboardSession;
  onSend?: (sessionId: string, message: string) => Promise<void> | void;
  onKill?: (sessionId: string) => void;
  onMerge?: (prNumber: number) => void;
  onRestore?: (sessionId: string) => void;
}

function getStatusBadgeInfo(status: SessionStatus): {
  label: string;
  colorClass: string;
  bgColorClass: string;
  icon: React.ReactNode;
} {
  const iconProps = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    viewBox: "0 0 24 24",
    className: "h-3 w-3",
  };

  const iconPropsSmall = { ...iconProps, className: "h-2.5 w-2.5" };

  switch (status) {
    case "spawning":
      return {
        label: "spawning",
        colorClass: "text-[var(--color-accent)]",
        bgColorClass: "bg-[var(--color-tint-blue)]",
        icon: (
          <svg {...iconProps}>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
        ),
      };

    case "working":
      return {
        label: "working",
        colorClass: "text-[var(--color-status-working)]",
        bgColorClass: "bg-[var(--color-tint-green)]",
        icon: (
          <svg {...iconProps}>
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
          </svg>
        ),
      };

    case "pr_open":
      return {
        label: "pr open",
        colorClass: "text-[var(--color-accent)]",
        bgColorClass: "bg-[var(--color-tint-blue)]",
        icon: (
          <svg {...iconProps}>
            <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65S8.93 17.38 9 18v4" />
            <path d="M9 18c-4.51 2-5-2-7-2" />
          </svg>
        ),
      };

    case "ci_failed":
      return {
        label: "ci failed",
        colorClass: "text-[var(--color-status-error)]",
        bgColorClass: "bg-[var(--color-tint-red)]",
        icon: (
          <svg {...iconProps}>
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        ),
      };

    case "review_pending":
      return {
        label: "review pending",
        colorClass: "text-[var(--color-status-respond)]",
        bgColorClass: "bg-[var(--color-tint-yellow)]",
        icon: (
          <svg {...iconProps}>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v4M12 16h.01" />
          </svg>
        ),
      };

    case "changes_requested":
      return {
        label: "changes requested",
        colorClass: "text-[var(--color-status-error)]",
        bgColorClass: "bg-[var(--color-tint-red)]",
        icon: (
          <svg {...iconProps}>
            <path d="M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18Z" />
            <path d="M12 8v4M12 16h.01" />
          </svg>
        ),
      };

    case "approved":
      return {
        label: "approved",
        colorClass: "text-[var(--color-status-working)]",
        bgColorClass: "bg-[var(--color-tint-green)]",
        icon: (
          <svg {...iconProps}>
            <circle cx="12" cy="12" r="9" />
            <path d="M9 12l2 2 4-4" />
          </svg>
        ),
      };

    case "mergeable":
      return {
        label: "mergeable",
        colorClass: "text-[var(--color-status-working)]",
        bgColorClass: "bg-[var(--color-tint-green)]",
        icon: (
          <svg {...iconProps}>
            <circle cx="6" cy="6" r="2" />
            <circle cx="18" cy="18" r="2" />
            <circle cx="18" cy="6" r="2" />
            <path d="M8 6h5a3 3 0 0 1 3 3v7" />
            <path d="M8 6h5a3 3 0 0 0 3-3V8" />
          </svg>
        ),
      };

    case "merged":
      return {
        label: "merged",
        colorClass: "text-[var(--color-status-working)]",
        bgColorClass: "bg-[var(--color-tint-green)]",
        icon: (
          <svg {...iconProps}>
            <path d="M20 6 9 17l-5-5" />
          </svg>
        ),
      };

    case "cleanup":
      return {
        label: "cleanup",
        colorClass: "text-[var(--color-text-muted)]",
        bgColorClass: "bg-[var(--color-tint-neutral)]",
        icon: (
          <svg {...iconProps}>
            <polyline points="3 6 5 4 21 4 23 6" />
            <line x1="19" y1="6" x2="5" y2="6" />
            <polyline points="10 11 10 17" />
            <polyline points="14 11 14 17" />
            <path d="M4.5 6L6 19c0 .55.45 1 1 1h10c.55 0 1-.45 1-1L19.5 6" />
          </svg>
        ),
      };

    case "done":
      return {
        label: "done",
        colorClass: "text-[var(--color-text-muted)]",
        bgColorClass: "bg-[var(--color-tint-neutral)]",
        icon: (
          <svg {...iconProps}>
            <circle cx="12" cy="12" r="9" />
            <path d="M9 12h6" />
          </svg>
        ),
      };

    case "idle":
      return {
        label: "idle",
        colorClass: "text-[var(--color-text-muted)]",
        bgColorClass: "bg-[var(--color-tint-neutral)]",
        icon: (
          <svg {...iconProps}>
            <circle cx="12" cy="12" r="9" />
            <path d="M9 12h6" />
          </svg>
        ),
      };

    case "needs_input":
      return {
        label: "needs input",
        colorClass: "text-[var(--color-status-respond)]",
        bgColorClass: "bg-[var(--color-tint-yellow)]",
        icon: (
          <svg {...iconProps}>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v4M12 16h.01" />
          </svg>
        ),
      };

    case "stuck":
      return {
        label: "stuck",
        colorClass: "text-[var(--color-status-error)]",
        bgColorClass: "bg-[var(--color-tint-red)]",
        icon: (
          <svg {...iconProps}>
            <circle cx="12" cy="12" r="9" />
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        ),
      };

    case "errored":
      return {
        label: "errored",
        colorClass: "text-[var(--color-status-error)]",
        bgColorClass: "bg-[var(--color-tint-red)]",
        icon: (
          <svg {...iconProps}>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v4M12 16h.01" />
          </svg>
        ),
      };

    case "killed":
      return {
        label: "killed",
        colorClass: "text-[var(--color-status-error)]",
        bgColorClass: "bg-[var(--color-tint-red)]",
        icon: (
          <svg {...iconProps}>
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        ),
      };

    case "terminated":
      return {
        label: "terminated",
        colorClass: "text-[var(--color-text-muted)]",
        bgColorClass: "bg-[var(--color-tint-neutral)]",
        icon: (
          <svg {...iconProps}>
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        ),
      };

    default:
      return {
        label: status,
        colorClass: "text-[var(--color-text-muted)]",
        bgColorClass: "bg-[var(--color-tint-neutral)]",
        icon: (
          <svg {...iconProps}>
            <circle cx="12" cy="12" r="9" />
          </svg>
        ),
      };
  }
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
  const prState = session.pr?.state;

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

  if (status === "killed" || status === "terminated") {
    return {
      label: status,
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
  const label = activity === "exited" ? "exited" : status;
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

function StatusBadge({ status }: { status: SessionStatus }) {
  const badgeInfo = getStatusBadgeInfo(status);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-2 py-1 rounded-[var(--radius-sm)] text-[10px] font-medium whitespace-nowrap",
        badgeInfo.colorClass,
        badgeInfo.bgColorClass,
      )}
    >
      {badgeInfo.icon}
      <span>{badgeInfo.label}</span>
    </span>
  );
}

function SessionCardView({ session, onSend, onKill, onMerge, onRestore }: SessionCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [sendingAction, setSendingAction] = useState<string | null>(null);
  const [failedAction, setFailedAction] = useState<string | null>(null);
  const [sendingQuickReply, setSendingQuickReply] = useState<string | null>(null);
  const [sentQuickReply, setSentQuickReply] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const actionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const quickReplyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  const isTerminal =
    TERMINAL_STATUSES.has(session.status) ||
    (session.activity !== null && TERMINAL_ACTIVITIES.has(session.activity));
  const isRestorable = isTerminal && session.status !== "merged";

  const title = getSessionTitle(session);
  const isDone = level === "done";
  const secondaryText = session.issueLabel
    ? `${session.issueLabel}${session.issueTitle ? ` · ${session.issueTitle}` : ""}`
    : session.issueTitle ?? (session.summary && session.summary !== title ? session.summary : null);
  const cardFrameClass = isReadyToMerge
    ? "session-card--merge-frame"
    : alerts.length > 0
      ? "session-card--alert-frame"
      : "session-card--fixed";
  const dynamicCardStyle =
    alerts.length > 0
      ? {
          minHeight: `${242 + Math.max(0, alerts.length - 2) * 44}px`,
        }
      : isReadyToMerge
        ? { minHeight: "264px" }
        : undefined;

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
        {/* Row 1: Status pill + session id + status badge + restore */}
        <div className="flex items-center gap-2 px-3.5 pt-3 pb-1.5">
          <span className={cn("done-status-pill", statusInfo.pillClass)}>
            {statusInfo.icon}
            {statusInfo.label}
          </span>
          <span className="font-[var(--font-mono)] text-[10px] tracking-wide text-[var(--color-text-muted)]">
            {session.id}
          </span>
          <div className="flex-1" />
          <StatusBadge status={session.status} />
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
          <p
            className="text-[13px] font-semibold leading-snug [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden"
            style={{ color: "var(--done-title-color)" }}
          >
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
          {pr && !rateLimited && (prUnenriched ? (
            <span className="inline-block h-[14px] w-16 animate-pulse rounded-full bg-[var(--color-bg-subtle)]" />
          ) : (
            <span className="done-meta-chip font-[var(--font-mono)]">
              <span className="text-[var(--color-status-ready)]">+{pr.additions}</span>{" "}
              <span className="text-[var(--color-status-error)]">-{pr.deletions}</span>{" "}
              {getSizeLabel(pr.additions, pr.deletions)}
            </span>
          ))}
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

  /* ── Standard card (non-done) ────────────────────────────────────── */
  return (
    <div
      className={cn(
        "session-card border",
        cardFrameClass,
        "hover:border-[var(--color-border-strong)]",
        `card-glow-${level}`,
        isReadyToMerge
          ? "card-merge-ready border-[color-mix(in_srgb,var(--color-status-ready)_30%,transparent)]"
          : "border-[var(--color-border-default)]",
      )}
      style={dynamicCardStyle}
    >
      {/* Header row: dot + session ID + status badge + terminal link */}
      <div className="session-card__header flex items-center gap-2 px-4 pt-4 pb-2">
        {isReadyToMerge ? <ActivityDot activity="ready" /> : <ActivityDot activity={session.activity} />}
        <span className="font-[var(--font-mono)] text-[11px] tracking-wide text-[var(--color-text-muted)]">
          {session.id}
        </span>
        <div className="flex-1" />
        <StatusBadge status={session.status} />
        {isRestorable && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRestore?.(session.id);
            }}
            className="inline-flex items-center gap-1 border border-[color-mix(in_srgb,var(--color-accent)_35%,transparent)] px-2 py-0.5 text-[11px] text-[var(--color-accent)] transition-colors hover:bg-[var(--color-tint-blue)]"
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
        {!isTerminal && (
          <a
            href={`/sessions/${encodeURIComponent(session.id)}`}
            onClick={(e) => e.stopPropagation()}
            className="session-card__control inline-flex items-center justify-center gap-1.5 border border-[var(--color-border-default)] bg-[var(--color-bg-subtle)] px-2.5 py-1 text-[11px] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] hover:no-underline"
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
        {/* Title — its own row, bigger, can wrap */}
        <div className="session-card__title-wrap px-4 pb-2">
          <p
            className={cn(
              "session-card__title leading-snug [display:-webkit-box] [-webkit-box-orient:vertical] overflow-hidden",
              level === "working"
                ? "text-[13px] font-medium text-[var(--color-text-secondary)]"
                : "text-[14px] font-semibold text-[var(--color-text-primary)]",
            )}
          >
            {title}
          </p>
        </div>

        {/* Meta row: branch + PR# + diff size (simplified for merge-ready) */}
        <div className="session-card__meta flex flex-wrap items-center gap-1.5 px-4 pb-2">
          {session.branch && (
            <span className="font-[var(--font-mono)] text-[10px] text-[var(--color-text-muted)]">
              {session.branch}
            </span>
          )}
          {pr && (
            <a
              href={pr.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="font-[var(--font-mono)] text-[11px] font-bold text-[var(--color-text-primary)] underline-offset-2 hover:underline"
            >
              #{pr.number}
            </a>
          )}
          {pr && !rateLimited && (prUnenriched ? (
            <span className="inline-block h-[14px] w-16 animate-pulse rounded-full bg-[var(--color-bg-subtle)]" />
          ) : (
            <span className="inline-flex items-center rounded-full bg-[var(--color-chip-bg)] px-2 py-0.5 font-[var(--font-mono)] text-[10px] font-semibold text-[var(--color-text-muted)]">
              +{pr.additions} -{pr.deletions} {getSizeLabel(pr.additions, pr.deletions)}
            </span>
          ))}
        </div>

        {secondaryText && (
          <div className="px-4 pb-2">
            <p className="session-card__secondary text-[11px] text-[var(--color-text-muted)]">
              {secondaryText}
            </p>
          </div>
        )}

        {/* Rate limited indicator */}
        {rateLimited && pr?.state === "open" && (
          <div className="px-4 pb-2">
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

        {!rateLimited && alerts.length > 0 && (
          <div className="session-card__actions px-4 pb-2 pt-0.5">
            <div className="session-card__alert-grid">
              {alerts.slice(0, 3).map((alert) => (
                <span
                  key={alert.key}
                  className="session-card__alert-pill inline-flex items-stretch overflow-hidden border"
                  style={{
                    borderColor:
                      alert.borderColor ?? alert.color ?? "var(--color-border-default)",
                  }}
                >
                  <a
                    href={alert.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className={cn(
                      "min-w-0 flex-1 truncate whitespace-nowrap px-2 py-0.5 font-[var(--font-mono)] text-[11px] font-medium !underline [text-decoration-skip-ink:none] [text-underline-offset:2px] hover:brightness-125",
                      alert.className,
                    )}
                    style={alert.color ? { color: alert.color } : undefined}
                  >
                    {alert.count !== undefined && (
                      <>
                        <span className="font-bold">{alert.count}</span>{" "}
                      </>
                    )}
                    {alert.label}
                    {alert.notified && (
                      <span className="ml-1 opacity-60" title="Agent has been notified"> · notified</span>
                    )}
                  </a>
                  {alert.actionLabel && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleAction(alert.key, alert.actionMessage ?? "");
                      }}
                      disabled={sendingAction === alert.key}
                      className={cn(
                        "border-l px-2 py-0.5 font-[var(--font-mono)] text-[11px] font-medium transition-colors disabled:opacity-50",
                        failedAction === alert.key &&
                          "bg-[var(--color-tint-red)] text-[var(--color-status-error)]",
                        alert.actionClassName,
                      )}
                      style={{
                        borderColor:
                          alert.borderColor ?? alert.color ?? "var(--color-border-default)",
                      }}
                    >
                      {sendingAction === alert.key
                        ? "sent!"
                        : failedAction === alert.key
                          ? "failed"
                          : alert.actionLabel}
                    </button>
                  )}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="session-card__footer mt-auto flex items-center justify-between gap-2 border-t border-[var(--color-border-subtle)] px-4 py-2.5">
          {session.issueUrl ? (
            <a
              href={session.issueUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="min-w-0 truncate text-[11px] text-[var(--color-accent)] hover:underline"
            >
              {session.issueLabel || session.issueUrl}
            </a>
          ) : (
            <span className="min-w-0 truncate text-[11px] text-[var(--color-text-tertiary)]">
              {session.activity ?? session.status}
            </span>
          )}

          {isReadyToMerge && pr ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onMerge?.(pr.number);
              }}
              className="session-card__control session-card__merge-control inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 border px-2.5 py-1 text-[11px] transition-colors"
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
                <path d="M8 6h5a3 3 0 0 0 3-3V8" />
              </svg>
              merge
            </button>
          ) : !isTerminal && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onKill?.(session.id);
              }}
              aria-label="Terminate session"
              className="session-card__control session-card__terminate inline-flex shrink-0 cursor-pointer items-center justify-center border border-[color-mix(in_srgb,var(--color-status-error)_35%,transparent)] px-2.5 py-1 text-[11px] text-[var(--color-status-error)] transition-colors hover:border-[var(--color-status-error)] hover:bg-[var(--color-tint-red)]"
            >
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
                <path d="M10 11v6M14 11v6" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {level === "respond" && (
        <div className="quick-reply" onClick={(e) => e.stopPropagation()}>
          {session.summary && !session.summaryIsFallback && (
            <p className="quick-reply__summary">{session.summary}</p>
          )}
          <div className="quick-reply__presets">
            <button
              className="quick-reply__preset-btn"
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
              className="quick-reply__preset-btn"
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
              className="quick-reply__preset-btn"
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
          <textarea
            className="quick-reply__input"
            placeholder={sendingQuickReply !== null ? "Sending..." : "Type a reply..."}
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
      )}
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

interface Alert {
  key: string;
  label: string;
  className: string;
  color?: string;
  borderColor?: string;
  url: string;
  count?: number;
  notified?: boolean;
  actionLabel?: string;
  actionMessage?: string;
  actionClassName?: string;
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
  const lifecycleStatus = meta["status"];

  const ciIsFailing = pr.ciStatus === CI_STATUS.FAILING || lifecycleStatus === "ci_failed";
  const hasChangesRequested =
    pr.reviewDecision === "changes_requested" || lifecycleStatus === "changes_requested";
  const hasConflicts = !pr.mergeability.noConflicts;

  if (ciIsFailing) {
    const failedCheck = pr.ciChecks.find((c) => c.status === "failed");
    const failCount = pr.ciChecks.filter((c) => c.status === "failed").length;
    if (failCount === 0 && pr.ciStatus !== CI_STATUS.FAILING) {
      // Lifecycle says ci_failed but PR enrichment hasn't caught up — show generic alert
      alerts.push({
        key: "ci-fail",
        label: "CI failing",
        className: "",
        color: "var(--color-alert-ci)",
        borderColor: "var(--color-alert-ci)",
        url: pr.url + "/checks",
        notified: Boolean(meta["lastCIFailureDispatchHash"]),
        actionLabel: "ask to fix",
        actionMessage: `Please fix the failing CI checks on ${pr.url}`,
        actionClassName: "bg-[var(--color-alert-ci-bg)] text-white hover:brightness-110",
      });
    } else if (failCount === 0) {
      alerts.push({
        key: "ci-unknown",
        label: "CI unknown",
        className: "",
        color: "var(--color-alert-ci-unknown)",
        url: pr.url + "/checks",
      });
    } else {
      alerts.push({
        key: "ci-fail",
        label: `${failCount} CI check${failCount > 1 ? "s" : ""} failing`,
        className: "",
        color: "var(--color-alert-ci)",
        borderColor: "var(--color-alert-ci)",
        url: failedCheck?.url ?? pr.url + "/checks",
        notified: Boolean(meta["lastCIFailureDispatchHash"]),
        actionLabel: "ask to fix",
        actionMessage: `Please fix the failing CI checks on ${pr.url}`,
        actionClassName: "bg-[var(--color-alert-ci-bg)] text-white hover:brightness-110",
      });
    }
  }

  if (hasChangesRequested) {
    alerts.push({
      key: "changes",
      label: "changes requested",
      className: "",
      color: "var(--color-alert-changes)",
      url: pr.url,
      notified: Boolean(meta["lastPendingReviewDispatchHash"]),
      actionLabel: "ask to address",
      actionMessage: `Please address the requested changes on ${pr.url}`,
      actionClassName: "bg-[var(--color-alert-changes-bg)] text-white hover:brightness-110",
    });
  } else if (!pr.isDraft && (pr.reviewDecision === "pending" || pr.reviewDecision === "none")) {
    alerts.push({
      key: "review",
      label: "needs review",
      className: "",
      color: "var(--color-alert-review)",
      url: pr.url,
      actionLabel: "ask to post",
      actionMessage: `Post ${pr.url} on slack asking for a review.`,
      actionClassName: "bg-[var(--color-alert-review-bg)] text-white hover:brightness-110",
    });
  }

  if (hasConflicts) {
    alerts.push({
      key: "conflict",
      label: "merge conflict",
      className: "",
      color: "var(--color-alert-conflict)",
      url: pr.url,
      notified: meta["lastMergeConflictDispatched"] === "true",
      actionLabel: "ask to fix",
      actionMessage: `Please resolve the merge conflicts on ${pr.url} by rebasing on the base branch`,
      actionClassName: "bg-[var(--color-alert-conflict-bg)] text-white hover:brightness-110",
    });
  }

  if (pr.unresolvedThreads > 0) {
    const firstUrl = pr.unresolvedComments[0]?.url ?? pr.url + "/files";
    alerts.push({
      key: "comments",
      label: "unresolved comments",
      count: pr.unresolvedThreads,
      className: "",
      color: "var(--color-alert-comment)",
      borderColor: "var(--color-alert-comment)",
      url: firstUrl,
      actionLabel: "ask to resolve",
      actionMessage: `Please address all unresolved review comments on ${pr.url}`,
      actionClassName: "bg-[var(--color-alert-comment-bg)] text-white hover:brightness-110",
    });
  }

  return alerts;
}
