"use client";

import { useEffect, useRef, useState } from "react";
import { CI_STATUS } from "@aoagents/ao-core/types";
import { cn } from "@/lib/cn";
import { type DashboardSession, type DashboardPR, isPRMergeReady } from "@/lib/types";
import { SessionDetailPRCard } from "./SessionDetailPRCard";
import { askAgentToFix } from "./session-detail-agent-actions";
import type { OrchestratorZones } from "./SessionDetailHeader";

export function GitBranchIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="6" y1="4" x2="6" y2="14" />
      <circle cx="6" cy="17" r="2.3" />
      <circle cx="18" cy="7" r="2.3" />
      <path d="M18 9.3a8 8 0 0 1-8 8" />
    </svg>
  );
}

export function OrchestratorZonePills({ zones }: { zones: OrchestratorZones }) {
  const stats: Array<{ value: number; label: string; toneClass: string }> = [
    { value: zones.merge, label: "merge", toneClass: "topbar-zone-pill--merge" },
    { value: zones.respond, label: "respond", toneClass: "topbar-zone-pill--respond" },
    { value: zones.review, label: "review", toneClass: "topbar-zone-pill--review" },
    { value: zones.working, label: "working", toneClass: "topbar-zone-pill--working" },
    { value: zones.pending, label: "pending", toneClass: "topbar-zone-pill--pending" },
    { value: zones.done, label: "done", toneClass: "topbar-zone-pill--done" },
  ].filter((s) => s.value > 0);

  if (stats.length === 0) return null;

  return (
    <span className="topbar-fleet-pills" aria-label="Fleet session counts">
      <span className="topbar-fleet-pills__label">Fleet</span>
      {stats.map((s) => (
        <span key={s.label} className={cn("topbar-zone-pill", s.toneClass)}>
          <span className="topbar-zone-pill__value">{s.value}</span>
          <span className="topbar-zone-pill__label">{s.label}</span>
        </span>
      ))}
    </span>
  );
}

/**
 * Mobile-only PR affordance. On desktop the PR card lives in the inspector
 * rail; on mobile (no rail) this popover surfaces the same SessionDetailPRCard.
 */
export function MobilePrButton({ session, pr }: { session: DashboardSession; pr: DashboardPR }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const allGreen = isPRMergeReady(pr);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const keyHandler = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", keyHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", keyHandler);
    };
  }, [open]);

  return (
    <div className="topbar-pr-btn-wrap" ref={ref}>
      <a
        href={pr.url}
        target="_blank"
        rel="noopener noreferrer"
        className={cn("dashboard-app-btn topbar-pr-btn", open && "topbar-pr-btn--open")}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1) return;
          event.preventDefault();
          setOpen((value) => !value);
        }}
        aria-expanded={open}
        aria-label={`PR #${pr.number}`}
      >
        <span
          className={cn(
            "topbar-pr-dot",
            allGreen
              ? "topbar-pr-dot--green"
              : pr.ciStatus === CI_STATUS.FAILING || pr.reviewDecision === "changes_requested"
                ? "topbar-pr-dot--red"
                : "topbar-pr-dot--amber",
          )}
        />
        PR #{pr.number}
        <svg
          width="10"
          height="10"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path d={open ? "M18 15l-6-6-6 6" : "M6 9l6 6 6-6"} />
        </svg>
      </a>

      {open && (
        <div className="topbar-pr-popover">
          <SessionDetailPRCard
            pr={pr}
            metadata={session.metadata}
            lifecyclePrReason={session.lifecycle?.prReason ?? undefined}
            onAskAgentToFix={(comment, onSuccess, onError) =>
              askAgentToFix(session.id, comment, onSuccess, onError)
            }
          />
        </div>
      )}
    </div>
  );
}
