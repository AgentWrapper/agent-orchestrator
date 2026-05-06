"use client";

import { useEffect, useRef, useState } from "react";
import { CI_STATUS } from "@aoagents/ao-core/types";
import { cn } from "@/lib/cn";
import {
  isPRMergeReady,
  isPRRateLimited,
  isPRUnenriched,
  type DashboardPR,
} from "@/lib/types";
import { buildGitHubCompareUrl } from "@/lib/github-links";
import { PRCommentThread } from "./PRCommentThread";

interface SessionDetailPRCardProps {
  pr: DashboardPR;
  metadata: Record<string, string>;
  lifecyclePrReason?: string;
  onAskAgentToFix: (
    comment: { url: string; path: string; body: string },
    onSuccess: () => void,
    onError: () => void,
  ) => Promise<void>;
}

export interface BlockerChip {
  icon: string;
  text: string;
  variant: "fail" | "warn" | "muted";
  notified?: boolean;
}

export function hasMergeConflicts(pr: DashboardPR): boolean {
  const mergeabilityReliable = !isPRUnenriched(pr) && !isPRRateLimited(pr);
  return mergeabilityReliable && pr.state !== "merged" && !pr.mergeability.noConflicts;
}

export function buildBlockerChips(
  pr: DashboardPR,
  metadata: Record<string, string>,
  lifecyclePrReason?: string,
): BlockerChip[] {
  const chips: BlockerChip[] = [];

  const ciNotified = Boolean(metadata["lastCIFailureDispatchHash"]);
  const conflictNotified = metadata["lastMergeConflictDispatched"] === "true";
  const reviewNotified = Boolean(metadata["lastPendingReviewDispatchHash"]);
  const lifecycleStatus = metadata["status"];

  const ciIsFailing =
    pr.ciStatus === CI_STATUS.FAILING ||
    lifecyclePrReason === "ci_failing" ||
    lifecycleStatus === "ci_failed";
  const hasChangesRequested =
    pr.reviewDecision === "changes_requested" ||
    lifecyclePrReason === "changes_requested" ||
    lifecycleStatus === "changes_requested";
  const hasConflicts = hasMergeConflicts(pr);

  if (ciIsFailing) {
    const failCount = pr.ciChecks.filter((check) => check.status === "failed").length;
    chips.push({
      icon: "✗",
      variant: "fail",
      text: failCount > 0 ? `${failCount} check${failCount !== 1 ? "s" : ""} failing` : "CI failing",
      notified: ciNotified,
    });
  } else if (pr.ciStatus === CI_STATUS.PENDING) {
    chips.push({ icon: "●", variant: "warn", text: "CI pending" });
  }

  if (hasChangesRequested) {
    chips.push({
      icon: "✗",
      variant: "fail",
      text: "Changes requested",
      notified: reviewNotified,
    });
  } else if (!pr.mergeability.approved) {
    chips.push({ icon: "○", variant: "muted", text: "Awaiting reviewer" });
  }

  if (hasConflicts) {
    chips.push({
      icon: "✗",
      variant: "fail",
      text: "Merge conflicts",
      notified: conflictNotified,
    });
  }

  if (pr.isDraft) {
    chips.push({ icon: "○", variant: "muted", text: "Draft" });
  }

  return chips;
}

export function SessionDetailPRCard({
  pr,
  metadata,
  lifecyclePrReason,
  onAskAgentToFix,
}: SessionDetailPRCardProps) {
  const [sendingComments, setSendingComments] = useState<Set<string>>(new Set());
  const [sentComments, setSentComments] = useState<Set<string>>(new Set());
  const [errorComments, setErrorComments] = useState<Set<string>>(new Set());
  const [branchCopied, setBranchCopied] = useState(false);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    return () => {
      timersRef.current.forEach((timer) => clearTimeout(timer));
      timersRef.current.clear();
    };
  }, []);

  const handleAskAgentToFix = async (comment: {
    url: string;
    path: string;
    body: string;
  }) => {
    setSentComments((prev) => {
      const next = new Set(prev);
      next.delete(comment.url);
      return next;
    });
    setErrorComments((prev) => {
      const next = new Set(prev);
      next.delete(comment.url);
      return next;
    });
    setSendingComments((prev) => new Set(prev).add(comment.url));

    await onAskAgentToFix(
      comment,
      () => {
        setSendingComments((prev) => {
          const next = new Set(prev);
          next.delete(comment.url);
          return next;
        });
        setSentComments((prev) => new Set(prev).add(comment.url));
        const existing = timersRef.current.get(comment.url);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
          setSentComments((prev) => {
            const next = new Set(prev);
            next.delete(comment.url);
            return next;
          });
          timersRef.current.delete(comment.url);
        }, 3000);
        timersRef.current.set(comment.url, timer);
      },
      () => {
        setSendingComments((prev) => {
          const next = new Set(prev);
          next.delete(comment.url);
          return next;
        });
        setErrorComments((prev) => new Set(prev).add(comment.url));
        const existing = timersRef.current.get(comment.url);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
          setErrorComments((prev) => {
            const next = new Set(prev);
            next.delete(comment.url);
            return next;
          });
          timersRef.current.delete(comment.url);
        }, 3000);
        timersRef.current.set(comment.url, timer);
      },
    );
  };

  const allGreen = isPRMergeReady(pr);
  const blockerIssues = buildBlockerChips(pr, metadata, lifecyclePrReason);
  const fileCount = pr.changedFiles ?? 0;
  const showConflictActions = hasMergeConflicts(pr) && pr.state === "open";
  const compareUrl = showConflictActions ? buildGitHubCompareUrl(pr) : "";

  const handleCopyBranch = () => {
    const clipboardWrite = navigator.clipboard?.writeText(pr.branch);
    if (!clipboardWrite) return;

    void clipboardWrite
      .then(() => {
        setBranchCopied(true);
        const timerKey = "__copy-branch";
        const existing = timersRef.current.get(timerKey);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
          setBranchCopied(false);
          timersRef.current.delete(timerKey);
        }, 2000);
        timersRef.current.set(timerKey, timer);
      })
      .catch(() => {
        /* clipboard unavailable */
      });
  };

  return (
    <div className={cn("session-detail-pr-card", allGreen && "session-detail-pr-card--green")}>
      <div className="session-detail-pr-card__row">
        <a
          href={pr.url}
          target="_blank"
          rel="noopener noreferrer"
          className="session-detail-pr-card__title-link"
        >
          PR #{pr.number}: {pr.title}
        </a>
        <span className="session-detail-pr-card__diff-stats">
          <span className="session-detail-diff--add">+{pr.additions}</span>{" "}
          <span className="session-detail-diff--del">-{pr.deletions}</span>
        </span>
        {fileCount > 0 ? (
          <span className="session-detail-pr-card__diff-label">
            {fileCount} file{fileCount !== 1 ? "s" : ""}
          </span>
        ) : null}
        {pr.isDraft ? <span className="session-detail-pr-card__diff-label">Draft</span> : null}
        {pr.state === "merged" ? (
          <span className="session-detail-pr-card__diff-label">Merged</span>
        ) : null}
      </div>

      {showConflictActions ? (
        <div
          className="session-detail-pr-card__merge-actions"
          role="group"
          aria-label="Resolve merge conflicts"
        >
          <a
            href={compareUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="session-detail-pr-merge-action"
          >
            Compare with base branch
          </a>
          <button
            type="button"
            onClick={handleCopyBranch}
            aria-label={branchCopied ? "Head branch name copied" : "Copy head branch name"}
            className="session-detail-pr-merge-action session-detail-pr-merge-action--btn"
          >
            {branchCopied ? "Copied branch name" : "Copy head branch name"}
          </button>
        </div>
      ) : null}

      <div className="session-detail-pr-card__details">
        {allGreen ? (
          <div className="session-detail-merge-banner">
            <svg
              width="11"
              height="11"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              viewBox="0 0 24 24"
            >
              <path d="M20 6L9 17l-5-5" />
            </svg>
            Ready to merge
          </div>
        ) : (
          blockerIssues.map((issue) => (
            <span
              key={issue.text}
              className={cn(
                "session-detail-blocker-chip",
                issue.variant === "fail" && "session-detail-blocker-chip--fail",
                issue.variant === "warn" && "session-detail-blocker-chip--warn",
                issue.variant === "muted" && "session-detail-blocker-chip--muted",
              )}
            >
              {issue.icon} {issue.text}
              {issue.notified ? (
                <span className="session-detail-blocker-chip__note">· notified</span>
              ) : null}
            </span>
          ))
        )}

        {pr.ciChecks.length > 0 ? (
          <>
            <div className="session-detail-pr-sep" />
            {pr.ciChecks.map((check, index) => {
              const key = check.url ?? `${check.name}-${index}`;
              const chip = (
                <span
                  className={cn(
                    "session-detail-ci-chip",
                    check.status === "passed" && "session-detail-ci-chip--pass",
                    check.status === "failed" && "session-detail-ci-chip--fail",
                    check.status === "pending" && "session-detail-ci-chip--pending",
                    check.status !== "passed" &&
                      check.status !== "failed" &&
                      check.status !== "pending" &&
                      "session-detail-ci-chip--queued",
                  )}
                >
                  {check.status === "passed"
                    ? "✓"
                    : check.status === "failed"
                      ? "✗"
                      : check.status === "pending"
                        ? "●"
                        : "○"}{" "}
                  {check.name}
                </span>
              );
              return check.url ? (
                <a
                  key={key}
                  href={check.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:no-underline"
                  onClick={(event) => event.stopPropagation()}
                >
                  {chip}
                </a>
              ) : (
                <span key={key}>{chip}</span>
              );
            })}
          </>
        ) : null}
      </div>

      <PRCommentThread
        comments={pr.unresolvedComments}
        unresolvedThreads={pr.unresolvedThreads}
        sendingUrls={sendingComments}
        sentUrls={sentComments}
        errorUrls={errorComments}
        onAskAgentToFix={handleAskAgentToFix}
      />
    </div>
  );
}
