"use client";

import { memo } from "react";
import { getStatusSpec, type StatusSpec } from "@/lib/status-spec";
import type { DashboardSession } from "@/lib/types";

type StatusBadgeVariant = "inline" | "pill" | "dot";

interface StatusBadgeProps {
  /** Provide a session to derive the status, or pass an explicit spec. */
  session?: DashboardSession;
  spec?: StatusSpec;
  /** inline = dot + colored label (kanban card); pill = bordered tinted pill
   *  (session topbar); dot = dot only (sidebar). */
  variant?: StatusBadgeVariant;
  className?: string;
}

/**
 * The one status presenter used across the dashboard — kanban card badge,
 * session topbar pill, and sidebar dot all render from the same StatusSpec
 * so the status system stays single-sourced (see lib/status-spec.ts).
 */
function StatusBadgeView({ session, spec, variant = "inline", className }: StatusBadgeProps) {
  const resolved = spec ?? (session ? getStatusSpec(session) : null);
  if (!resolved) return null;

  const classes = ["status-badge", `status-badge--${variant}`, className]
    .filter(Boolean)
    .join(" ");

  return (
    <span
      className={classes}
      data-tone={resolved.tone}
      data-breathing={resolved.breathing ? "" : undefined}
    >
      <span className="status-badge__dot" aria-hidden="true" />
      {variant !== "dot" ? <span className="status-badge__label">{resolved.label}</span> : null}
    </span>
  );
}

export const StatusBadge = memo(StatusBadgeView);
