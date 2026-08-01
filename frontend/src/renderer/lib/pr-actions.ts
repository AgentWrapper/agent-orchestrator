import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient, apiErrorMessage } from "./api-client";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { sessionScmSummaryQueryKey, type SessionPRSummary } from "../hooks/useSessionScmSummary";

/**
 * True when this PR's pipeline is genuinely ready to merge — mirrors
 * domain.PRMergeReady's readiness rule server-side (the server re-checks this
 * too; this only drives the button's enabled/disabled state).
 */
export function isPRMergeable(pr: SessionPRSummary): boolean {
	if (pr.state !== "open") return false;
	if (pr.ci.state === "failing" || pr.ci.state === "pending") return false;
	// Unknown CI is only safe to treat as ready when no checks were ever
	// observed for this PR. If checks exist but the rollup hasn't resolved
	// (incomplete/paginated fetch), checkCount > 0 and we must fail closed —
	// otherwise the button would enable for PRs the server will reject.
	if (pr.ci.state === "unknown" && pr.ci.checkCount > 0) return false;
	if (pr.review.decision === "changes_requested" || pr.review.hasUnresolvedHumanComments) return false;
	return pr.mergeability.state === "mergeable";
}

export function mergeDisabledReason(pr: SessionPRSummary): string {
	if (pr.state !== "open") {
		return pr.state === "draft" ? "Draft PRs can't be merged yet" : `PR is already ${pr.state}`;
	}
	if (pr.ci.state === "failing") return "CI is failing";
	if (pr.ci.state === "pending") return "CI checks are still running";
	if (pr.ci.state === "unknown") {
		return pr.ci.checkCount > 0
			? "CI checks haven't finished reporting for this PR"
			: "No CI status reported for this PR yet";
	}
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

/**
 * Input to a merge mutation: the PR plus the session it belongs to, so
 * onSuccess can invalidate that session's cached PR summary directly instead
 * of leaving a stale board until the next SCM poll (#3064 review).
 */
export type MergePRInput = { pr: SessionPRSummary; sessionId: string };

export function useMergePR() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async ({ pr }: MergePRInput) => {
			const { error, response } = await apiClient.POST("/api/v1/prs/{id}/merge", {
				params: { path: { id: String(pr.number) }, query: { repo: pr.repo } },
			});
			if (error) {
				throw new Error(apiErrorMessage(error, `Failed to merge PR (${response?.status ?? "unknown"})`));
			}
		},
		onSuccess: (_data, { sessionId }) => {
			void queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
			void queryClient.invalidateQueries({ queryKey: sessionScmSummaryQueryKey(sessionId) });
		},
	});
}