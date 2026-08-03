import { describe, expect, it } from "vitest";
import { currentReviewerTerminal, type ReviewsResponse } from "./reviewer-terminal";

describe("currentReviewerTerminal", () => {
	it("uses the daemon generation when the PR projection omits its run", () => {
		const response: ReviewsResponse = {
			reviewerGeneration: "batch-hidden-from-pr-projection",
			reviewerHandleId: "review-worker-1",
			reviewerHarness: "codex",
			reviews: [],
		};

		expect(currentReviewerTerminal(response)).toEqual({
			generation: "batch-hidden-from-pr-projection",
			handleId: "review-worker-1",
		});
	});
});
