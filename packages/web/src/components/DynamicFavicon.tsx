"use client";

import { useEffect } from "react";
import type { AttentionMap } from "@/hooks/useSessionEvents";

/**
 * Determine overall health from attention levels.
 * - "green"  — all sessions working/done/pending, nothing needs attention
 * - "yellow" — some sessions need review or response
 * - "red"    — critical: sessions stuck, errored, or needing immediate action
 */
function computeHealthFromLevels(levels: AttentionMap): "green" | "yellow" | "red" {
  const entries = Object.values(levels);
  if (entries.length === 0) return "green";

  let hasYellow = false;

  for (const level of entries) {
    // Only "respond" (detailed mode) escalates the favicon to red. "action"
    // (simple mode) collapses respond + review into one bucket, so it
    // necessarily includes routine review work (ci_failed, changes_requested)
    // that used to be yellow. Treating it as red would make every typical
    // review PR scream critical. Keep it at yellow severity.
    if (level === "respond") return "red";
    if (level === "review" || level === "action" || level === "merge") {
      hasYellow = true;
    }
  }

  return hasYellow ? "yellow" : "green";
}

const HEALTH_COLORS: Record<"green" | "yellow" | "red", string> = {
  green: "#22c55e",
  yellow: "#eab308",
  red: "#ef4444",
};

/** Generate an SVG favicon as a data URL with the given initial and color. */
function generateFaviconSvg(initial: string, color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
    <rect width="32" height="32" rx="6" fill="${color}"/>
    <text x="16" y="23" text-anchor="middle" fill="white" font-family="sans-serif" font-weight="700" font-size="20">${initial}</text>
  </svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Count sessions that need human attention (respond, review, action, merge). */
export function countNeedingAttention(levels: AttentionMap): number {
  let count = 0;
  for (const level of Object.values(levels)) {
    if (
      level === "respond" ||
      level === "review" ||
      level === "action" ||
      level === "merge"
    ) {
      count++;
    }
  }
  return count;
}

interface DynamicFaviconProps {
  /** Server-computed attention levels from session snapshots. */
  attentionLevels: AttentionMap;
  projectName?: string;
}

/**
 * Client component that dynamically updates the browser favicon
 * based on system health (session attention levels).
 *
 * Uses server-computed attention levels for real-time updates,
 * rather than recomputing from the full sessions array.
 */
export function DynamicFavicon({ attentionLevels, projectName = "A" }: DynamicFaviconProps) {
  const initial = projectName.charAt(0).toUpperCase();

  useEffect(() => {
    const health = computeHealthFromLevels(attentionLevels);
    const color = HEALTH_COLORS[health];
    const href = generateFaviconSvg(initial, color);

    // Find or create the favicon link element
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.type = "image/svg+xml";
    link.href = href;
  }, [attentionLevels, initial]);

  return null;
}
