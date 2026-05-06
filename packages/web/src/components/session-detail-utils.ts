import { isPRRateLimited, isPRUnenriched, type DashboardPR } from "@/lib/types";

export const sessionActivityMeta: Record<string, { label: string; color: string }> = {
  active: { label: "Active", color: "var(--color-status-working)" },
  ready: { label: "Ready", color: "var(--color-status-ready)" },
  idle: { label: "Idle", color: "var(--color-status-idle)" },
  waiting_input: { label: "Waiting for input", color: "var(--color-status-attention)" },
  blocked: { label: "Blocked", color: "var(--color-status-error)" },
  exited: { label: "Exited", color: "var(--color-status-error)" },
};

export function formatTimeCompact(isoDate: string | null): string {
  if (!isoDate) return "just now";
  const ts = new Date(isoDate).getTime();
  if (!Number.isFinite(ts)) return "just now";
  const diffMs = Date.now() - ts;
  if (diffMs <= 0) return "just now";
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

export function getCiShortLabel(pr: DashboardPR): string {
  if (isPRRateLimited(pr) || isPRUnenriched(pr)) return "CI";
  if (pr.ciStatus === "passing") return "CI passing";
  if (pr.ciStatus === "failing") return "CI failed";
  return "CI pending";
}

export function getReviewShortLabel(pr: DashboardPR): string {
  if (isPRRateLimited(pr) || isPRUnenriched(pr)) return "";
  if (pr.reviewDecision === "approved") return "approved";
  if (pr.reviewDecision === "changes_requested") return "changes";
  return "review";
}

export function cleanBugbotComment(body: string): { title: string; description: string } {
  const isBugbot = body.includes("<!-- DESCRIPTION START -->") || body.includes("### ");
  if (isBugbot) {
    const titleMatch = body.match(/###\s+(.+?)(?:\n|$)/);
    const title = titleMatch ? titleMatch[1].replace(/\*\*/g, "").trim() : "Comment";
    const descMatch = body.match(
      /<!-- DESCRIPTION START -->\s*([\s\S]*?)\s*<!-- DESCRIPTION END -->/,
    );
    const description = descMatch ? descMatch[1].trim() : body.split("\n")[0] || "No description";
    return { title, description };
  }
  return { title: "Comment", description: body.trim() };
}

export function buildGitHubBranchUrl(pr: DashboardPR): string {
  let origin = "https://github.com";

  try {
    origin = new URL(pr.url).origin;
  } catch {
    // Fall back to the public GitHub host if the PR URL is missing or invalid.
  }

  return `${origin}/${pr.owner}/${pr.repo}/tree/${pr.branch}`;
}

export function activityStateClass(activityLabel: string): string {
  const normalized = activityLabel.toLowerCase();
  if (normalized === "active") return "session-detail-status-pill--active";
  if (normalized === "ready") return "session-detail-status-pill--ready";
  if (normalized === "idle") return "session-detail-status-pill--idle";
  if (normalized === "waiting for input") return "session-detail-status-pill--waiting";
  if (normalized === "blocked" || normalized === "exited") {
    return "session-detail-status-pill--error";
  }
  return "session-detail-status-pill--neutral";
}

export function activityToneClass(activityColor: string): string {
  switch (activityColor) {
    case "var(--color-status-working)":
      return "session-detail-tone--working";
    case "var(--color-status-ready)":
      return "session-detail-tone--ready";
    case "var(--color-status-idle)":
      return "session-detail-tone--idle";
    case "var(--color-status-attention)":
      return "session-detail-tone--attention";
    case "var(--color-status-error)":
      return "session-detail-tone--error";
    default:
      return "session-detail-tone--muted";
  }
}

export function mobileStatusPillClass(activityLabel: string): string {
  const normalized = activityLabel.toLowerCase();
  if (normalized === "active") return "session-detail__status-pill--active";
  if (normalized === "ready") return "session-detail__status-pill--ready";
  if (normalized === "waiting for input") return "session-detail__status-pill--waiting";
  if (normalized === "blocked" || normalized === "exited") {
    return "session-detail__status-pill--error";
  }
  return "session-detail__status-pill--idle";
}

export function ciToneClass(pr: DashboardPR): string {
  if (isPRRateLimited(pr) || isPRUnenriched(pr)) return "session-detail-ci-tone--neutral";
  if (pr.ciStatus === "passing") return "session-detail-ci-tone--pass";
  if (pr.ciStatus === "failing") return "session-detail-ci-tone--fail";
  return "session-detail-ci-tone--pending";
}
