import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient, apiErrorMessage } from "./api-client";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import type { SessionPRSummary } from "../hooks/useSessionScmSummary";

/**
 * Encodes a PR URL as a base64url string for the `{id}` path param on
 * POST /api/v1/prs/{id}/merge. A bare PR number isn't globally unique across
 * repos, and the URL contains slashes that can't be used as a raw path
 * segment, so the backend expects this encoding (see #3064).
 */
export function encodePRId(url: string): string {
	return btoa(url).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** True when a PR's current mergeability allows a real merge attempt. */
export function isPRMergeable(pr: SessionPRSummary): boolean {
	return pr.state === "open" && pr.mergeability.state === "mergeable";
}

/** Human-readable reason the merge button is disabled for this PR. */
export function mergeDisabledReason(pr: SessionPRSummary): string {
	if (pr.state !== "open") {
		return pr.state === "draft" ? "Draft PRs can't be merged yet" : `PR is already ${pr.state}`;
	}
	switch (pr.mergeability.state) {
		case "conflicting":
			return "Has merge conflicts with the base branch";
		case "blocked":
			return "Blocked by required checks or reviews";
		case "unstable":
			return "Checks are unstable — not safe to merge yet";
		case "unknown":
			return "Mergeability not yet determined";
		default:
			return "Not mergeable";
	}
}

/**
 * Merges a PR via the daemon's GitHub-backed merge action. Invalidates the
 * workspace query on success so the board picks up the session's new status
 * (e.g. "merged") without a manual refresh.
 */
export function useMergePR() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (pr: SessionPRSummary) => {
			const id = encodePRId(pr.htmlUrl || pr.url);
			const { error, response } = await apiClient.POST("/api/v1/prs/{id}/merge", {
				params: { path: { id } },
			});
			if (error) {
				throw new Error(apiErrorMessage(error, `Failed to merge PR (${response?.status ?? "unknown"})`));
			}
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
		},
	});
}