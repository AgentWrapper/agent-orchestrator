"use client";

import { type DashboardPR, isPRRateLimited, isPRUnenriched } from "@/lib/types";
import { CIBadge } from "./CIBadge";

export function getSizeLabel(additions: number, deletions: number): string {
  const size = additions + deletions;
  return size > 1000 ? "XL" : size > 500 ? "L" : size > 200 ? "M" : size > 50 ? "S" : "XS";
}

interface PRStatusProps {
  pr: DashboardPR;
}

export function PRStatus({ pr }: PRStatusProps) {
  const sizeLabel = getSizeLabel(pr.additions, pr.deletions);
  const rateLimited = isPRRateLimited(pr);
  const unenriched = isPRUnenriched(pr);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {/* PR number */}
      <a
        href={pr.url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[11px] font-medium text-[var(--color-accent)] underline-offset-2 hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        #{pr.number}
      </a>

      {/* Size — shimmer when unenriched, hide when rate limited */}
      {!rateLimited && (unenriched ? (
        <span className="inline-block h-[14px] w-16 animate-pulse rounded-full bg-[var(--color-bg-subtle)]" />
      ) : (
        <span className="inline-flex items-center rounded-full bg-[rgba(125,133,144,0.08)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-text-muted)]">
          +{pr.additions} -{pr.deletions} {sizeLabel}
        </span>
      ))}

      {/* Merged badge */}
      {pr.state === "merged" && (
        <span className="inline-flex items-center rounded-full bg-[var(--color-chip-bg)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-text-secondary)]">
          merged
        </span>
      )}

      {/* Draft badge */}
      {pr.isDraft && pr.state === "open" && (
        <span className="inline-flex items-center rounded-full bg-[rgba(125,133,144,0.08)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-text-muted)]">
          draft
        </span>
      )}

      {/* CI status — shimmer when unenriched */}
      {pr.state === "open" && !pr.isDraft && !rateLimited && (unenriched ? (
        <span className="inline-block h-[14px] w-14 animate-pulse rounded-full bg-[var(--color-bg-subtle)]" />
      ) : (
        <CIBadge status={pr.ciStatus} checks={pr.ciChecks} />
      ))}

      {/* Review decision (only for open PRs with real data) */}
      {pr.state === "open" && pr.reviewDecision === "approved" && !rateLimited && !unenriched && (
        <span className="inline-flex items-center rounded-full bg-[rgba(63,185,80,0.1)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-accent-green)]">
          approved
        </span>
      )}
    </div>
  );
}

interface PRTableRowProps {
  pr: DashboardPR;
  muted?: boolean;
}

export function PRTableRow({ pr, muted = false }: PRTableRowProps) {
  const sizeLabel = getSizeLabel(pr.additions, pr.deletions);
  const rateLimited = isPRRateLimited(pr);
  const unenriched = isPRUnenriched(pr);
  const hideData = rateLimited || unenriched;

  const reviewLabel = hideData
    ? "—"
    : pr.state === "merged"
      ? "merged"
      : pr.state === "closed"
        ? "closed"
    : pr.isDraft
      ? "draft"
      : pr.reviewDecision === "approved"
        ? "approved"
        : pr.reviewDecision === "changes_requested"
          ? "changes requested"
          : "needs review";

  const reviewClass = hideData
    ? "text-[var(--color-text-tertiary)]"
    : pr.isDraft
      ? "text-[var(--color-text-muted)]"
      : pr.reviewDecision === "approved"
        ? "text-[var(--color-accent-green)]"
        : pr.reviewDecision === "changes_requested"
          ? "text-[var(--color-accent-red)]"
          : "text-[var(--color-accent-yellow)]";

  const shimmer = <span className="inline-block h-3 w-12 animate-pulse rounded bg-[var(--color-bg-subtle)]" />;

  return (
    <tr className={`border-b border-[var(--color-border-subtle)] transition-colors hover:bg-[var(--color-bg-subtle)]${muted ? " opacity-60 hover:opacity-100" : ""}`}>
      <td className="px-3 py-2.5 text-sm">
        <a href={pr.url} target="_blank" rel="noopener noreferrer" className="hover:underline">
          #{pr.number}
        </a>
      </td>
      <td className="max-w-[420px] truncate px-3 py-2.5 text-sm font-medium">
        <a href={pr.url} target="_blank" rel="noopener noreferrer" className="hover:underline">
          {pr.title}
        </a>
      </td>
      <td className="px-3 py-2.5 text-sm">
        {unenriched ? shimmer : rateLimited ? (
          <span className="text-[var(--color-text-tertiary)]">—</span>
        ) : (
          <>
            <span className="text-[var(--color-accent-green)]">+{pr.additions}</span>{" "}
            <span className="text-[var(--color-accent-red)]">-{pr.deletions}</span>{" "}
            <span className="text-[var(--color-text-muted)]">{sizeLabel}</span>
          </>
        )}
      </td>
      <td className="px-3 py-2.5">
        {unenriched ? shimmer : rateLimited ? (
          <span className="text-[var(--color-text-tertiary)]">—</span>
        ) : (
          <CIBadge status={pr.ciStatus} checks={pr.ciChecks} compact />
        )}
      </td>
      <td className={`px-3 py-2.5 text-xs font-semibold ${reviewClass}`}>
        {unenriched ? shimmer : reviewLabel}
      </td>
      <td
        className={`px-3 py-2.5 text-center text-sm font-bold ${unenriched ? "" : pr.unresolvedThreads > 0 ? "text-[var(--color-accent-red)]" : "text-[var(--color-border-default)]"}`}
      >
        {unenriched ? shimmer : pr.unresolvedThreads}
      </td>
    </tr>
  );
}

function getCiDotColor(pr: DashboardPR): string {
  if (pr.ciStatus === "passing") return "var(--color-accent-green)";
  if (pr.ciStatus === "failing") return "var(--color-accent-red)";
  return "var(--color-status-attention)";
}

function getCiTextColor(pr: DashboardPR): string {
  if (pr.ciStatus === "passing") return "var(--color-accent-green)";
  if (pr.ciStatus === "failing") return "var(--color-accent-red)";
  return "var(--color-text-secondary)";
}

function getReviewColor(pr: DashboardPR): string {
  if (pr.reviewDecision === "approved") return "var(--color-accent-green)";
  if (pr.reviewDecision === "changes_requested") return "var(--color-accent-red)";
  return "var(--color-text-secondary)";
}

export function PRCard({ pr, muted = false }: PRTableRowProps) {
  const rateLimited = isPRRateLimited(pr);
  const unenriched = isPRUnenriched(pr);
  const hideData = rateLimited || unenriched;

  const ciLabel = hideData
    ? "—"
    : pr.ciStatus === "passing"
      ? "passing"
      : pr.ciStatus === "failing"
        ? "failed"
        : "pending";

  const reviewLabel = hideData
    ? "—"
    : pr.state === "merged"
      ? "merged"
      : pr.state === "closed"
        ? "closed"
        : pr.isDraft
          ? "draft"
          : pr.reviewDecision === "approved"
            ? "approved"
            : pr.reviewDecision === "changes_requested"
              ? "changes"
              : "needs review";

  const shimmer = <span className="inline-block h-3 w-10 animate-pulse rounded bg-[var(--color-bg-subtle)]" />;
  const diffLabel = hideData ? null : `+${pr.additions} -${pr.deletions}`;
  const lineTone =
    pr.state === "merged"
      ? "mobile-pr-card__meta--merged"
      : pr.state === "closed"
        ? "mobile-pr-card__meta--closed"
        : pr.reviewDecision === "changes_requested"
          ? "mobile-pr-card__meta--changes"
          : pr.reviewDecision === "approved"
            ? "mobile-pr-card__meta--approved"
            : "mobile-pr-card__meta--open";

  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noopener noreferrer"
      className={`mobile-pr-card${muted ? " mobile-pr-card--muted" : ""}`}
    >
      <div className="mobile-pr-card__line">
        <span className="mobile-pr-card__number">#{pr.number}</span>
        <span className="mobile-pr-card__title">{pr.title}</span>
      </div>
      <div className={`mobile-pr-card__meta ${lineTone}`}>
        {unenriched ? shimmer : (
          <span className="mobile-pr-card__metric-value">
            <span
              className="mobile-pr-card__ci-dot"
              style={{ background: hideData ? "var(--color-text-tertiary)" : getCiDotColor(pr) }}
            />
            <span style={{ color: hideData ? undefined : getCiTextColor(pr) }}>{ciLabel}</span>
          </span>
        )}
        <span className="mobile-pr-card__review" style={{ color: hideData ? undefined : getReviewColor(pr) }}>
          {unenriched ? shimmer : reviewLabel}
        </span>
        <span className="mobile-pr-card__diff">
          {hideData ? shimmer : diffLabel}
        </span>
      </div>
    </a>
  );
}
