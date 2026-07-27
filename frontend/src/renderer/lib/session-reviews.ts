import { queryOptions } from "@tanstack/react-query";
import type { components } from "../../api/schema";
import { sortedPRs, type WorkspaceSession } from "../types/workspace";
import { apiClient, apiErrorMessage } from "./api-client";

export type PRReviewState = components["schemas"]["PRReviewState"];
export type ReviewsResponse = components["schemas"]["ListReviewsResponse"];

const usePreviewData = import.meta.env.VITE_NO_ELECTRON === "1";

/**
 * Shared query options for a session's AO review states. The query key is the
 * single source of truth for review data — the SessionInspector Reviews tab
 * and the command palette both subscribe through this, so React Query shares
 * one cache entry per session and one fetch path (including the preview mock).
 */
export function sessionReviewsQueryOptions(session: WorkspaceSession, enabled: boolean) {
	return queryOptions({
		queryKey: ["session-reviews", session.id] as const,
		enabled,
		refetchInterval: (query) => {
			const data = query.state.data as ReviewsResponse | undefined;
			const reviews = data?.reviews ?? [];
			return reviews.some((review) => review.status === "running") ? 2500 : false;
		},
		queryFn: async () => {
			if (usePreviewData) return mockReviewsResponse(session);
			const { data, error } = await apiClient.GET("/api/v1/sessions/{sessionId}/reviews", {
				params: { path: { sessionId: session.id } },
			});
			if (error) throw new Error(apiErrorMessage(error, "Unable to load reviews"));
			return data ?? ({ reviewerHandleId: "", reviews: [] } satisfies ReviewsResponse);
		},
	});
}

/** Review states for a session's open (non-draft) PRs, matching ReviewPanel semantics. */
export function openReviewStatesFor(session: WorkspaceSession, reviewStates: PRReviewState[]): PRReviewState[] {
	const openPRURLs = new Set(
		sortedPRs(session)
			.filter((pr) => pr.state === "open")
			.map((pr) => pr.url),
	);
	return reviewStates.filter((reviewState) => openPRURLs.has(reviewState.prUrl));
}

export function reviewIsRunning(openReviewStates: PRReviewState[]): boolean {
	return openReviewStates.some((reviewState) => reviewState.status === "running");
}

export function reviewRunDisabled(openReviewStates: PRReviewState[], isTriggering: boolean): boolean {
	return (
		isTriggering ||
		openReviewStates.length === 0 ||
		openReviewStates.every((reviewState) => reviewState.status === "ineligible")
	);
}

export function reviewSessionRunAction(reviewStates: PRReviewState[], isTriggering: boolean): string {
	if (isTriggering || reviewStates.some((reviewState) => reviewState.status === "running")) {
		return "Reviewing...";
	}
	if (reviewStates.some((reviewState) => reviewState.status === "changes_requested" || reviewState.latestRun)) {
		return "Re-run review";
	}
	return "Run review";
}

function mockReviewsResponse(session: WorkspaceSession): ReviewsResponse {
	return {
		reviewerHandleId: `${session.id}-reviewer`,
		reviews: sortedPRs(session).map((pr, index) => {
			const targetSha = `demo${pr.number}${index}`;
			const reviewedAt = new Date(Date.now() - (index + 1) * 11 * 60 * 1000).toISOString();
			const latestRun =
				pr.review === "approved" || pr.review === "changes_requested"
					? {
							batchId: `demo-batch-${session.id}`,
							body:
								pr.review === "approved"
									? "Demo review approved. The implementation is ready for the README screenshot flow."
									: "Demo review found polish feedback for the terminal presentation.",
							createdAt: reviewedAt,
							githubReviewId: `${pr.number}01`,
							harness: "codex",
							id: `demo-review-run-${pr.number}`,
							prUrl: pr.url,
							reviewId: `demo-review-${pr.number}`,
							sessionId: session.id,
							status: "delivered",
							targetSha,
							verdict: pr.review === "approved" ? "approved" : "changes_requested",
						}
					: undefined;
			return {
				latestRun,
				prNumber: pr.number,
				prUrl: pr.url,
				status:
					pr.review === "approved"
						? "up_to_date"
						: pr.review === "changes_requested"
							? "changes_requested"
							: pr.state === "draft"
								? "ineligible"
								: "needs_review",
				targetSha,
				title: mockReviewTitle(pr.number),
			};
		}),
	};
}

function mockReviewTitle(prNumber: number): string {
	switch (prNumber) {
		case 319:
			return "Browser preview rail renders inside AO";
		case 320:
			return "Review tab keeps stacked PR rows visible";
		case 321:
			return "Draft child PR waits for parent review";
		case 318:
			return "Terminal polish feedback";
		case 323:
			return "README screenshot assets ready";
		default:
			return `Demo pull request ${prNumber}`;
	}
}
