"use client";

import { memo, useState, useEffect } from "react";
import {
  type DashboardSession,
  type DashboardPR,
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
  onMerge?: (prNumber: number, owner?: string, repo?: string) => void;
  onRestore?: (sessionId: string) => void;
}

function getPRDotClass(p: DashboardPR): string {
  if (!p.enriched) return "bg-[var(--color-text-tertiary)] opacity-30";
  if (p.state === "merged") return "bg-[var(--color-status-merge)]";
  if (p.state === "closed") return "bg-[var(--color-text-muted)]";
  if (p.ciStatus === "failing" || p.reviewDecision === "changes_requested")
    return "bg-[var(--color-status-error)]";
  if (p.isDraft) return "bg-[var(--color-text-muted)]";
  if (p.ciStatus === "passing") return "bg-[var(--color-status-merge)]";
  if (p.ciStatus === "pending") return "bg-[var(--color-status-pending)]";
  return "bg-[var(--color-text-tertiary)] opacity-30";
}

function getPRChipColorClass(p: DashboardPR): string {
  if (!p.enriched)
    return "bg-[var(--color-bg-subtle)] text-[var(--color-text-muted)]";
  if (p.state === "merged")
    return "bg-[color-mix(in_srgb,var(--color-status-merge)_15%,transparent)] text-[var(--color-status-merge)]";
  if (p.state === "closed")
    return "bg-[var(--color-bg-subtle)] text-[var(--color-text-muted)]";
  if (p.ciStatus === "failing" || p.reviewDecision === "changes_requested")
    return "bg-[color-mix(in_srgb,var(--color-status-error)_15%,transparent)] text-[var(--color-status-error)]";
  if (p.isDraft)
    return "bg-[var(--color-bg-subtle)] text-[var(--color-text-muted)]";
  if (p.ciStatus === "passing")
    return "bg-[color-mix(in_srgb,var(--color-status-merge)_15%,transparent)] text-[var(--color-status-merge)]";
  if (p.ciStatus === "pending")
    return "bg-[color-mix(in_srgb,var(--color-status-pending)_15%,transparent)] text-[var(--color-status-pending)]";
  return "bg-[var(--color-bg-subtle)] text-[var(--color-text-muted)]";
}

function getPRStatusLabel(p: DashboardPR): string {
  if (!p.enriched) return "";
  if (p.state === "merged") return "merged";
  if (p.state === "closed") return "closed";
  if (p.ciStatus === "failing") return "CI failing";
  if (p.reviewDecision === "changes_requested") return "changes requested";
  if (p.isDraft) return "draft";
  if (p.reviewDecision === "approved") return "approved";
  if (p.ciStatus === "passing") return "needs review";
  if (p.ciStatus === "pending") return "CI running";
  return "";
}

function getRepoInitials(repo: string): string {
  return repo
    .split("-")
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("")
    .slice(0, 3);
}

function SessionCardView({ session, onKill, onMerge, onRestore }: SessionCardProps) {
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
  const prs = session.prs ?? [];
  const isMultiRepo = new Set(prs.map((p) => p.repo)).size > 1;
  // For multi-PR sessions, track which PR's details are shown in the card body.
  const [selectedPRIndex, setSelectedPRIndex] = useState(0);
  useEffect(() => setSelectedPRIndex(0), [session.id]);
  const safeIndex = Math.min(selectedPRIndex, Math.max(0, prs.length - 1));
  const selectedPR = prs.length > 1 ? (prs[safeIndex] ?? pr) : pr;

  const effectivePR = prs.length > 1 ? selectedPR : pr;
  const rateLimited = effectivePR ? isPRRateLimited(effectivePR) : false;
  const prUnenriched = effectivePR ? isPRUnenriched(effectivePR) : false;
  const isReadyToMerge = !rateLimited && effectivePR?.mergeability.mergeable && effectivePR.state === "open";
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

        <div className="card__meta">
          {session.branch && <span className="card__branch">{session.branch}</span>}
          {prs.length === 1 && (
            <>
              {session.branch && (
                <span className="card__meta-sep" aria-hidden="true">·</span>
              )}
              <a
                href={prs[0].url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="card__pr inline-flex items-center gap-1"
              >
                <span className={cn("inline-block h-1.5 w-1.5 shrink-0 rounded-full", getPRDotClass(prs[0]))} />
                #{prs[0].number}
              </a>
            </>
          )}
        </div>

        {/* Per-PR rows: shown only when session has more than one PR.
            Clicking a row selects it — the footer detail below updates to that PR. */}
        {prs.length > 1 && (
          <div className="px-[10px] pb-[5px] flex flex-col gap-[2px]">
            {prs.map((p, i) => {
              const statusLabel = getPRStatusLabel(p);
              const isSelected = i === safeIndex;
              return (
                <div
                  key={p.url}
                  role="button"
                  tabIndex={0}
                  className={cn(
                    "flex items-center gap-1.5 min-w-0 rounded px-1 -mx-1 cursor-pointer transition-colors",
                    isSelected
                      ? "bg-[var(--color-bg-subtle)] border-l-2 border-[var(--color-accent)] pl-[2px]"
                      : "hover:bg-[var(--color-bg-subtle)] border-l-2 border-transparent pl-[2px]",
                  )}
                  onClick={(e) => { e.stopPropagation(); setSelectedPRIndex(i); }}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); setSelectedPRIndex(i); } }}
                >
                  {isMultiRepo && (
                    <span className="shrink-0 font-[var(--font-mono)] text-[9px] text-[var(--color-text-tertiary)] bg-[var(--color-bg-subtle)] px-1 py-0.5 rounded leading-none">
                      {getRepoInitials(p.repo)}
                    </span>
                  )}
                  <a
                    href={p.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => { e.stopPropagation(); setSelectedPRIndex(i); }}
                    className={cn(
                      "shrink-0 inline-flex items-center font-[var(--font-mono)] text-[10px] font-bold px-1.5 py-0.5 rounded leading-none no-underline",
                      getPRChipColorClass(p),
                    )}
                  >
                    #{p.number}
                  </a>
                  {p.title ? (
                    <span
                      className="flex-1 truncate text-[11px] text-[var(--color-text-secondary)]"
                      title={p.title}
                    >
                      {p.title}
                    </span>
                  ) : (
                    <span className="flex-1" />
                  )}
                  {p.enriched && (
                    <span className="shrink-0 font-[var(--font-mono)] text-[10px]">
                      <span className="text-[var(--color-status-merge)]">+{p.additions}</span>{" "}
                      <span className="text-[var(--color-status-error)]">-{p.deletions}</span>
                    </span>
                  )}
                  {statusLabel && statusLabel !== "needs review" && (
                    <span className="shrink-0 text-[10px] text-[var(--color-text-tertiary)]">
                      · {statusLabel}
                    </span>
                  )}
                </div>
              );
            })}
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
            {isReadyToMerge && effectivePR ? (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onMerge?.(effectivePR.number, effectivePR.owner, effectivePR.repo);
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
                Merge PR #{effectivePR.number}
              </button>
            ) : null}
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
    prev.onMerge === next.onMerge &&
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
