"use client";

import { useEffect, useRef } from "react";
import { getAttentionLevel, isPRRateLimited, isPRUnenriched, type DashboardSession } from "@/lib/types";
import { getSessionTitle } from "@/lib/format";
import { projectSessionPath } from "@/lib/routes";

function getRelativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

function formatTagLabel(value: string): string {
  return value.replaceAll("_", " ");
}

function isTag(
  value:
    | {
        label: string;
        tone: "accent" | "neutral" | "mono";
      }
    | null,
): value is { label: string; tone: "accent" | "neutral" | "mono" } {
  return value !== null;
}

interface BottomSheetProps {
  session: DashboardSession | null;
  mode: "preview" | "confirm-kill";
  onConfirm: () => void;
  onCancel: () => void;
  onRequestKill?: () => void;
  onMerge?: (prNumber: number) => void;
  isMergeReady?: boolean;
}

export function BottomSheet({
  session,
  mode,
  onCancel,
  onConfirm,
  onRequestKill,
  onMerge,
  isMergeReady = false,
}: BottomSheetProps) {
  const touchStartYRef = useRef<number | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const sessionIdRef = useRef<string | null>(null);
  const mergePrNumber = session?.pr?.number ?? null;

  useEffect(() => {
    if (!session) {
      sessionIdRef.current = null;
      return;
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [session, onCancel]);

  useEffect(() => {
    if (!session) return;
    if (!sheetRef.current) return;

    const focusable = sheetRef.current.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    // Only steal focus when the sheet first opens (new session id), not on SSE updates.
    const isNewSession = sessionIdRef.current !== session.id;
    sessionIdRef.current = session.id;
    if (isNewSession) first.focus();

    function handleTabTrap(e: KeyboardEvent) {
      if (e.key === "Tab") {
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    const sheet = sheetRef.current;
    sheet.addEventListener("keydown", handleTabTrap);
    return () => sheet.removeEventListener("keydown", handleTabTrap);
  }, [session, mode]);

  function handleTouchStart(e: React.TouchEvent) {
    touchStartYRef.current = e.touches[0]?.clientY ?? null;
  }

  function handleTouchEnd(e: React.TouchEvent) {
    if (touchStartYRef.current === null) return;
    const deltaY = (e.changedTouches[0]?.clientY ?? 0) - touchStartYRef.current;
    touchStartYRef.current = null;
    if (deltaY > 80) {
      onCancel();
    }
  }

  if (!session) return null;

  const title = getSessionTitle(session);
  const attention = getAttentionLevel(session);
  const summary =
    session.summary && !session.summaryIsFallback ? session.summary : null;
  const hasLiveTerminateAction =
    attention !== "done" && attention !== "merge" && session.status !== "terminated";
  const pr = session.pr;
  const showLivePrData = Boolean(pr && !isPRRateLimited(pr) && !isPRUnenriched(pr));
  const showTerminalStatePills = attention === "done" || session.status === "terminated" || session.activity === "exited";
  const tags = [
    { label: formatTagLabel(attention), tone: "accent" as const },
    { label: formatTagLabel(session.status), tone: "neutral" as const },
    session.activity ? { label: formatTagLabel(session.activity), tone: "neutral" as const } : null,
    session.branch ? { label: session.branch, tone: "mono" as const } : null,
    session.pr ? { label: `PR #${session.pr.number}`, tone: "neutral" as const } : null,
    session.issueLabel ? { label: session.issueLabel, tone: "neutral" as const } : null,
  ].filter(isTag);

  return (
    <>
      {/* Backdrop */}
      <div
        className="bottom-sheet-backdrop"
        onClick={onCancel}
        aria-hidden="true"
      />

      {/* Sheet */}
      <div
        ref={sheetRef}
        className="bottom-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bottom-sheet-title"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        {/* Drag handle */}
        <div className="bottom-sheet__handle" aria-hidden="true" />

        {mode === "confirm-kill" ? (
          <>
            <div className="bottom-sheet__header">
              <h2 id="bottom-sheet-title" className="bottom-sheet__title">
                Terminate session?
              </h2>
              <p className="bottom-sheet__subtitle">This action cannot be undone.</p>
            </div>

            <div className="bottom-sheet__session-info">
              <div className="bottom-sheet__session-name">{title}</div>
              <div className="bottom-sheet__session-meta">
                {tags.map((tag) => (
                  <span
                    key={`${tag.tone}-${tag.label}`}
                    className={`bottom-sheet__tag bottom-sheet__tag--${tag.tone}`}
                  >
                    {tag.label}
                  </span>
                ))}
              </div>
              {summary ? <p className="bottom-sheet__summary">{summary}</p> : null}
            </div>
          </>
        ) : (
          <>
            <div className="bottom-sheet__preview-card">
              <div className="bottom-sheet__preview-strip" data-level={attention} />
              <div className="bottom-sheet__preview-content">
                <div className="bottom-sheet__preview-header">
                  <span className="bottom-sheet__preview-id">{session.id}</span>
                  <span className="bottom-sheet__preview-time">{getRelativeTime(session.lastActivityAt)}</span>
                </div>
                <h2 id="bottom-sheet-title" className="bottom-sheet__title">
                  {title}
                </h2>
                <p className="bottom-sheet__subtitle">
                  {formatTagLabel(attention)} · started {getRelativeTime(session.createdAt)}
                </p>

                <div className="bottom-sheet__preview-meta">
                  {session.branch ? (
                    <span className="bottom-sheet__preview-branch">{session.branch}</span>
                  ) : null}
                  {pr ? <span className="bottom-sheet__preview-pr">#{pr.number}</span> : null}
                  {showLivePrData && pr ? (
                    <span className="bottom-sheet__preview-diff">
                      <span className="bottom-sheet__preview-diff-add">+{pr.additions}</span>
                      {" "}
                      <span className="bottom-sheet__preview-diff-del">-{pr.deletions}</span>
                    </span>
                  ) : null}
                </div>

                {showLivePrData && pr ? (
                  <div className="bottom-sheet__preview-pills">
                    <span className="bottom-sheet__tag bottom-sheet__tag--neutral">
                      {pr.ciStatus === "passing"
                        ? "CI passing"
                        : pr.ciStatus === "failing"
                          ? "CI failed"
                          : "CI pending"}
                    </span>
                    <span className="bottom-sheet__tag bottom-sheet__tag--accent">
                      {pr.reviewDecision === "approved"
                        ? "approved"
                        : pr.reviewDecision === "changes_requested"
                          ? "changes requested"
                        : "needs review"}
                    </span>
                    {showTerminalStatePills ? (
                      <span className="bottom-sheet__tag bottom-sheet__tag--accent">
                        {formatTagLabel(session.status)}
                      </span>
                    ) : null}
                    {showTerminalStatePills && session.activity ? (
                      <span className="bottom-sheet__tag bottom-sheet__tag--neutral">
                        {formatTagLabel(session.activity)}
                      </span>
                    ) : null}
                  </div>
                ) : (
                  <div className="bottom-sheet__preview-pills">
                    <span className="bottom-sheet__tag bottom-sheet__tag--accent">
                      {formatTagLabel(session.status)}
                    </span>
                    {session.activity ? (
                      <span className="bottom-sheet__tag bottom-sheet__tag--neutral">
                        {formatTagLabel(session.activity)}
                      </span>
                    ) : null}
                  </div>
                )}
              </div>
            </div>
            {summary ? <p className="bottom-sheet__summary">{summary}</p> : null}
          </>
        )}

        <div className="bottom-sheet__actions">
          {mode === "confirm-kill" ? (
            <>
              <button
                type="button"
                className="bottom-sheet__btn bottom-sheet__btn--cancel"
                onClick={onCancel}
              >
                Cancel
              </button>
              <button
                type="button"
                className="bottom-sheet__btn bottom-sheet__btn--danger"
                onClick={onConfirm}
              >
                Terminate
              </button>
            </>
          ) : (
            <>
              <a
                href={projectSessionPath(session.projectId, session.id)}
                className="bottom-sheet__btn bottom-sheet__btn--primary"
              >
                Open session
              </a>
              {isMergeReady && session.pr && onMerge ? (
                <button
                  type="button"
                  className="bottom-sheet__btn bottom-sheet__btn--secondary"
                  onClick={() => {
                    if (mergePrNumber !== null) {
                      onMerge(mergePrNumber);
                    }
                  }}
                >
                  Merge
                </button>
              ) : hasLiveTerminateAction && onRequestKill ? (
                <button
                  type="button"
                  className="bottom-sheet__btn bottom-sheet__btn--danger"
                  onClick={onRequestKill}
                >
                  <svg
                    className="bottom-sheet__btn-icon"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path d="M3 6h18" />
                    <path d="M8 6V4h8v2" />
                    <path d="M19 6l-1 14H6L5 6" />
                    <path d="M10 11v6M14 11v6" />
                  </svg>
                  Terminate
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>
    </>
  );
}
