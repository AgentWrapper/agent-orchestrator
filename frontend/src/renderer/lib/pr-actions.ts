import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient, apiErrorMessage } from "./api-client";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import type { SessionPRSummary } from "../hooks/useSessionScmSummary";

/**
 * True when this PR's pipeline is genuinely ready to merge — mirrors
 * domain.PRPipelineStatus's StatusMergeable branch server-side (the server
 * re-checks this too; this only drives the button's enabled/disabled state).
 */
export function isPRMergeable(pr: SessionPRSummary): boolean {
	if (pr.state !== "open") return false;
	if (pr.ci.state === "failing") return false;
	if (pr.review.decision === "changes_requested" || pr.review.hasUnresolvedHumanComments) return false;
	return pr.mergeability.state === "mergeable";
}

export function mergeDisabledReason(pr: SessionPRSummary): string {
	if (pr.state !== "open") {
		return pr.state === "draft" ? "Draft PRs can't be merged yet" : `PR is already ${pr.state}`;
	}
	if (pr.ci.state === "failing") return "CI is failing";
	if (pr.ci.state === "pending") return "CI checks are still running";
	if (pr.review.decision === "changes_requested" || pr.review.hasUnresolvedHumanComments) {
		return "Has unresolved review feedback";
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

export function useMergePR() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (pr: SessionPRSummary) => {
			const { error, response } = await apiClient.POST("/api/v1/prs/{id}/merge", {
				params: { path: { id: String(pr.number) } },
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