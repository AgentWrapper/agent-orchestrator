import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	buildStatusPayload,
	evaluateFinalReviewStatuses,
	normalizeRepoSlug,
	parseStatusDescription,
} from "./final-review-status-core.mjs";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "fedcba9876543210fedcba9876543210fedcba98";

describe("final-review status payload", () => {
	it("emits a success commit status for a clean verdict on the reviewed head", () => {
		assert.deepEqual(
			buildStatusPayload({
				sha: HEAD,
				verdict: "clean",
				reviewerFamily: "codex",
				targetUrl: "https://github.example/pr/1",
			}),
			{
				context: "final-review",
				description: `verdict=clean reviewer_family=codex head=${HEAD}`,
				state: "success",
				target_url: "https://github.example/pr/1",
			},
		);
	});

	it("emits a failure commit status for a parked verdict", () => {
		assert.equal(buildStatusPayload({ sha: HEAD, verdict: "parked", reviewerFamily: "claude" }).state, "failure");
	});

	it("rejects non-full SHA values so the gate cannot bless an ambiguous ref", () => {
		assert.throws(
			() => buildStatusPayload({ sha: "main", verdict: "clean", reviewerFamily: "codex" }),
			/full 40-character head SHA/,
		);
	});
});

describe("final-review status evaluation", () => {
	it("accepts only the latest clean success status for the exact head", () => {
		const result = evaluateFinalReviewStatuses(
			[
				{
					context: "final-review",
					state: "failure",
					description: `verdict=parked reviewer_family=codex head=${HEAD}`,
					created_at: "2026-07-08T00:00:00Z",
				},
				{
					context: "final-review",
					state: "success",
					description: `verdict=clean reviewer_family=codex head=${HEAD}`,
					created_at: "2026-07-08T00:01:00Z",
				},
			],
			HEAD,
		);

		assert.deepEqual(result, {
			ok: true,
			reason: "clean",
			verdict: "clean",
			reviewerFamily: "codex",
			head: HEAD,
			state: "success",
		});
	});

	it("rejects stale status descriptions that refer to a prior pushed head", () => {
		const result = evaluateFinalReviewStatuses(
			[
				{
					context: "final-review",
					state: "success",
					description: `verdict=clean reviewer_family=codex head=${OTHER}`,
				},
			],
			HEAD,
		);

		assert.equal(result.ok, false);
		assert.equal(result.reason, "stale-head");
	});

	it("rejects a newer parked status even when an older clean status exists on the same head", () => {
		const result = evaluateFinalReviewStatuses(
			[
				{
					context: "final-review",
					state: "failure",
					description: `verdict=parked reviewer_family=codex head=${HEAD}`,
					created_at: "2026-07-08T00:02:00Z",
				},
				{
					context: "final-review",
					state: "success",
					description: `verdict=clean reviewer_family=codex head=${HEAD}`,
					created_at: "2026-07-08T00:01:00Z",
				},
			],
			HEAD,
		);

		assert.equal(result.ok, false);
		assert.equal(result.reason, "unclean-final-review");
	});

	it("fails closed when same-timestamp final-review statuses disagree", () => {
		const result = evaluateFinalReviewStatuses(
			[
				{
					context: "final-review",
					state: "success",
					description: `verdict=clean reviewer_family=codex head=${HEAD}`,
					created_at: "2026-07-08T00:01:00Z",
				},
				{
					context: "final-review",
					state: "failure",
					description: `verdict=parked reviewer_family=codex head=${HEAD}`,
					created_at: "2026-07-08T00:01:00Z",
				},
			],
			HEAD,
		);

		assert.equal(result.ok, false);
		assert.equal(result.reason, "unclean-final-review");
	});

	it("rejects malformed, clean-worded, and reviewer-less statuses", () => {
		assert.equal(
			evaluateFinalReviewStatuses(
				[{ context: "final-review", state: "success", description: "status=needs_review" }],
				HEAD,
			).reason,
			"invalid-final-review-status",
		);
		assert.equal(
			evaluateFinalReviewStatuses(
				[
					{
						context: "final-review",
						state: "failure",
						description: `verdict=clean reviewer_family=codex head=${HEAD}`,
					},
				],
				HEAD,
			).reason,
			"unclean-final-review",
		);
		assert.equal(
			evaluateFinalReviewStatuses(
				[{ context: "final-review", state: "success", description: `verdict=clean head=${HEAD}` }],
				HEAD,
			).reason,
			"missing-reviewer-family",
		);
	});

	it("rejects ao native review state values because they are not final-review verdicts", () => {
		const parsed = parseStatusDescription("status=needs_review reviewer_family=codex");

		assert.deepEqual(parsed, {});
		assert.equal(evaluateFinalReviewStatuses([], HEAD).reason, "missing-final-review-status");
	});
});

describe("repo slug validation", () => {
	it("accepts owner/name and rejects path traversal", () => {
		assert.equal(normalizeRepoSlug("polymath-ventures/agent-orchestrator"), "polymath-ventures/agent-orchestrator");
		assert.throws(() => normalizeRepoSlug("polymath-ventures/../agent-orchestrator"), /owner\/name/);
	});
});
