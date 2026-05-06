import type { DashboardPR } from "@/lib/types";

/**
 * GitHub compare URL for the PR head branch against its base branch.
 * Used when resolving merge conflicts (GitHub compare view).
 */
export function buildGitHubCompareUrl(
  pr: Pick<DashboardPR, "owner" | "repo" | "baseBranch" | "branch">,
): string {
  const owner = encodeURIComponent(pr.owner);
  const repo = encodeURIComponent(pr.repo);
  const base = encodeURIComponent(pr.baseBranch);
  const head = encodeURIComponent(pr.branch);
  return `https://github.com/${owner}/${repo}/compare/${base}...${head}`;
}
