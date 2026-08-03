import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage } from "./api-client";

export type PRReviewState = components["schemas"]["PRReviewState"];
export type ReviewsResponse = components["schemas"]["ListReviewsResponse"];

export function sessionReviewsQueryKey(sessionId: string) {
	return ["session-reviews", sessionId] as const;
}

export async function fetchSessionReviews(sessionId: string): Promise<ReviewsResponse> {
	const { data, error } = await apiClient.GET("/api/v1/sessions/{sessionId}/reviews", {
		params: { path: { sessionId } },
	});
	if (error) throw new Error(apiErrorMessage(error, "Unable to load reviews"));
	return data ?? { reviewerHandleId: "", reviewerHarness: "", reviews: [] };
}

export function newestReviewRun(
	reviewStates: PRReviewState[],
	include: (review: PRReviewState) => boolean = () => true,
): NonNullable<PRReviewState["latestRun"]> | undefined {
	let newest: NonNullable<PRReviewState["latestRun"]> | undefined;
	let newestCreatedAt = Number.NEGATIVE_INFINITY;
	for (const review of reviewStates) {
		const run = review.latestRun;
		if (!run || !include(review)) continue;
		const parsedCreatedAt = Date.parse(run.createdAt);
		const createdAt = Number.isFinite(parsedCreatedAt)
			? parsedCreatedAt
			: Number.NEGATIVE_INFINITY;
		if (!newest || createdAt > newestCreatedAt) {
			newest = run;
			newestCreatedAt = createdAt;
		}
	}
	return newest;
}
