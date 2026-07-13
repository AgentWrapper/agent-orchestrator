import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	buildHumanMergeRequiredStatusPayload,
	buildReviewPassedStatusPayload,
	buildStatusPayload,
	evaluateAutonomousMergeStatuses,
	evaluateBlockingReviews,
	evaluateFinalReviewStatuses,
	flattenReviewPages,
	normalizeRepoSlug,
	selectHeadPullRequest,
	parseStatusDescription,
} from "./final-review-status-core.mjs";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "fedcba9876543210fedcba9876543210fedcba98";
const CLI = new URL("./final-review-status.mjs", import.meta.url);

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

	it("emits a failure commit status for an unclean parked verdict", () => {
		assert.equal(buildStatusPayload({ sha: HEAD, verdict: "parked", reviewerFamily: "claude" }).state, "failure");
	});

	it("emits a review-passed status for branch protection", () => {
		assert.deepEqual(
			buildReviewPassedStatusPayload({
				sha: HEAD,
				verdict: "clean",
				reviewerFamily: "codex",
			}),
			{
				context: "review-passed",
				description: `verdict=clean reviewer_family=codex head=${HEAD}`,
				state: "success",
			},
		);
	});

	it("emits a failing review-passed status for parked verdicts", () => {
		assert.equal(
			buildReviewPassedStatusPayload({ sha: HEAD, verdict: "parked", reviewerFamily: "claude" }).state,
			"failure",
		);
	});

	it("emits a green review status and a separate merge park marker for clean human-gated reviews", () => {
		assert.deepEqual(
			buildStatusPayload({
				sha: HEAD,
				verdict: "clean",
				reviewerFamily: "codex",
			}),
			{
				context: "final-review",
				description: `verdict=clean reviewer_family=codex head=${HEAD}`,
				state: "success",
			},
		);
		assert.deepEqual(
			buildHumanMergeRequiredStatusPayload({
				sha: HEAD,
				reviewerFamily: "codex",
				targetUrl: "https://github.example/pr/180",
			}),
			{
				context: "merge-park",
				description: `reason=human-required reviewer_family=codex head=${HEAD}`,
				state: "success",
				target_url: "https://github.example/pr/180",
			},
		);
	});

	it("rejects a misleading humanMergeRequired core payload option", () => {
		assert.throws(
			() =>
				buildStatusPayload({
					sha: HEAD,
					verdict: "clean",
					reviewerFamily: "codex",
					humanMergeRequired: true,
				}),
			/buildHumanMergeRequiredStatusPayload/,
		);
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

describe("autonomous merge evaluation", () => {
	it("passes the human review gate but rejects autonomous merge when a current-head human park marker exists", () => {
		const statuses = [
			{
				context: "final-review",
				state: "success",
				description: `verdict=clean reviewer_family=codex head=${HEAD}`,
				created_at: "2026-07-08T00:01:00Z",
			},
			{
				context: "merge-park",
				state: "success",
				description: `reason=human-required reviewer_family=codex head=${HEAD}`,
				created_at: "2026-07-08T00:02:00Z",
			},
		];

		assert.equal(evaluateFinalReviewStatuses(statuses, HEAD).ok, true);
		assert.deepEqual(evaluateAutonomousMergeStatuses(statuses, HEAD), {
			ok: false,
			reason: "human-merge-required",
			reviewerFamily: "codex",
			head: HEAD,
			state: "success",
		});
	});

	it("rejects merge park markers that declare a different head", () => {
		assert.deepEqual(
			evaluateAutonomousMergeStatuses(
				[
					{
						context: "final-review",
						state: "success",
						description: `verdict=clean reviewer_family=codex head=${HEAD}`,
					},
					{
						context: "merge-park",
						state: "success",
						description: `reason=human-required reviewer_family=codex head=${OTHER}`,
					},
				],
				HEAD,
			),
			{
				ok: false,
				reason: "invalid-merge-park-status",
				head: HEAD,
				state: "success",
			},
		);
	});

	it("rejects malformed merge park markers on the current head", () => {
		assert.deepEqual(
			evaluateAutonomousMergeStatuses(
				[
					{
						context: "final-review",
						state: "success",
						description: `verdict=clean reviewer_family=codex head=${HEAD}`,
					},
					{
						context: "merge-park",
						state: "success",
						description: `reason=manual reviewer_family=codex head=${HEAD}`,
					},
				],
				HEAD,
			),
			{
				ok: false,
				reason: "invalid-merge-park-status",
				head: HEAD,
				state: "success",
			},
		);
	});

	it("rejects human park markers without a reviewer family", () => {
		assert.deepEqual(
			evaluateAutonomousMergeStatuses(
				[
					{
						context: "final-review",
						state: "success",
						description: `verdict=clean reviewer_family=codex head=${HEAD}`,
					},
					{
						context: "merge-park",
						state: "success",
						description: `reason=human-required head=${HEAD}`,
					},
				],
				HEAD,
			),
			{
				ok: false,
				reason: "missing-merge-park-reviewer-family",
				head: HEAD,
				state: "success",
			},
		);
	});
});

describe("final-review status CLI validation", () => {
	it("posts final-review and review-passed statuses for a clean review", () => {
		const dir = mkdtempSync(join(tmpdir(), "final-review-gh-"));
		const log = join(dir, "gh.log");
		const gh = join(dir, "gh");
		writeFileSync(
			gh,
			`#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.GH_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write("{}\\n");
`,
		);
		chmodSync(gh, 0o755);

		const result = spawnSync(
			process.execPath,
			[CLI.pathname, "set", "--repo", "owner/repo", "--sha", HEAD, "--verdict", "clean", "--reviewer-family", "codex"],
			{
				encoding: "utf8",
				env: {
					...process.env,
					GH_LOG: log,
					PATH: `${dir}:${process.env.PATH}`,
				},
			},
		);

		assert.equal(result.status, 0, result.stderr);
		const contexts = readFileSync(log, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line).find((arg) => arg.startsWith("context=")));
		assert.deepEqual(contexts, ["context=final-review", "context=review-passed"]);
	});

	it("posts the human merge park guard before the green final-review status", () => {
		const dir = mkdtempSync(join(tmpdir(), "final-review-gh-"));
		const log = join(dir, "gh.log");
		const gh = join(dir, "gh");
		writeFileSync(
			gh,
			`#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.GH_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write("{}\\n");
`,
		);
		chmodSync(gh, 0o755);

		const result = spawnSync(
			process.execPath,
			[
				CLI.pathname,
				"set",
				"--repo",
				"owner/repo",
				"--sha",
				HEAD,
				"--verdict",
				"clean",
				"--reviewer-family",
				"codex",
				"--human-merge-required",
			],
			{
				encoding: "utf8",
				env: {
					...process.env,
					GH_LOG: log,
					PATH: `${dir}:${process.env.PATH}`,
				},
			},
		);

		assert.equal(result.status, 0, result.stderr);
		const calls = readFileSync(log, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const contexts = calls.map((args) => args.find((arg) => arg.startsWith("context=")));
		assert.deepEqual(contexts, ["context=merge-park", "context=final-review", "context=review-passed"]);
	});

	it("rejects human merge required with an unclean review verdict before posting statuses", () => {
		const result = spawnSync(
			process.execPath,
			[
				CLI.pathname,
				"set",
				"--repo",
				"owner/repo",
				"--sha",
				HEAD,
				"--verdict",
				"parked",
				"--reviewer-family",
				"codex",
				"--human-merge-required",
			],
			{ encoding: "utf8" },
		);

		assert.equal(result.status, 1);
		assert.match(result.stderr, /only valid with --verdict clean/);
	});

	it("validates check mode before shelling out to gh", () => {
		const result = spawnSync(
			process.execPath,
			[CLI.pathname, "check", "--repo", "owner/repo", "--sha", HEAD, "--mode", "robot"],
			{ encoding: "utf8", env: { ...process.env, PATH: "" } },
		);

		assert.equal(result.status, 1);
		assert.match(result.stderr, /--mode must be human or autonomous/);
	});
});

describe("repo slug validation", () => {
	it("accepts owner/name and rejects path traversal", () => {
		assert.equal(normalizeRepoSlug("polymath-ventures/agent-orchestrator"), "polymath-ventures/agent-orchestrator");
		assert.throws(() => normalizeRepoSlug("polymath-ventures/../agent-orchestrator"), /owner\/name/);
	});
});

// GH #304. A blocking review has to actually block. GitHub only enforces
// CHANGES_REQUESTED as a merge blocker when a branch-protection `pull_request`
// rule exists, and `mainprotect` has none — so a requested-change is visible and
// the merge queue merges straight over it. Our PRs land through the autonomous
// merge gate rather than the GitHub UI, so the teeth belong here.
describe("evaluateBlockingReviews (a requested change must block autonomous merge)", () => {
	const AUTHOR = "nhod-codex";
	const REVIEWER = "polymath-orchestrator";
	const OLD = "1111111111111111111111111111111111111111";

	const review = (over = {}) => ({
		user: { login: REVIEWER },
		state: "CHANGES_REQUESTED",
		commit_id: HEAD,
		submitted_at: "2026-07-12T00:00:00Z",
		...over,
	});

	it("BLOCKS on a current-head CHANGES_REQUESTED from a non-author", () => {
		const got = evaluateBlockingReviews([review()], { head: HEAD, prAuthor: AUTHOR });
		assert.equal(got.ok, false);
		assert.equal(got.reason, "changes-requested");
		assert.deepEqual(got.reviewers, [REVIEWER]);
	});

	// The whole ballgame. A CHANGES_REQUESTED against an OLDER commit must not
	// block a PR that has since been fixed and re-reviewed — otherwise the gate is
	// unclearable, and an unclearable gate is one workers learn to route around.
	it("does NOT block on a stale-SHA CHANGES_REQUESTED", () => {
		const got = evaluateBlockingReviews([review({ commit_id: OLD })], { head: HEAD, prAuthor: AUTHOR });
		assert.equal(got.ok, true, `stale review must not block: ${JSON.stringify(got)}`);
	});

	it("does NOT block on the PR author's own CHANGES_REQUESTED", () => {
		const got = evaluateBlockingReviews([review({ user: { login: AUTHOR } })], { head: HEAD, prAuthor: AUTHOR });
		assert.equal(got.ok, true);
	});

	// Latest review per reviewer wins: a reviewer who requests changes and then
	// approves the SAME head has cleared it. Without this the gate never clears.
	it("does NOT block when the same reviewer later APPROVED the same head", () => {
		const got = evaluateBlockingReviews(
			[
				review({ submitted_at: "2026-07-12T00:00:00Z" }),
				review({ state: "APPROVED", submitted_at: "2026-07-12T01:00:00Z" }),
			],
			{ head: HEAD, prAuthor: AUTHOR },
		);
		assert.equal(got.ok, true);
	});

	it("BLOCKS when an APPROVAL is followed by a later CHANGES_REQUESTED on the same head", () => {
		const got = evaluateBlockingReviews(
			[
				review({ state: "APPROVED", submitted_at: "2026-07-12T00:00:00Z" }),
				review({ submitted_at: "2026-07-12T01:00:00Z" }),
			],
			{ head: HEAD, prAuthor: AUTHOR },
		);
		assert.equal(got.ok, false);
		assert.equal(got.reason, "changes-requested");
	});

	it("ignores DISMISSED and COMMENTED reviews (neither is a blocking verdict)", () => {
		assert.equal(evaluateBlockingReviews([review({ state: "DISMISSED" })], { head: HEAD, prAuthor: AUTHOR }).ok, true);
		assert.equal(evaluateBlockingReviews([review({ state: "COMMENTED" })], { head: HEAD, prAuthor: AUTHOR }).ok, true);
		// A COMMENTED review must not CLEAR an earlier blocking one either.
		const got = evaluateBlockingReviews(
			[
				review({ submitted_at: "2026-07-12T00:00:00Z" }),
				review({ state: "COMMENTED", submitted_at: "2026-07-12T01:00:00Z" }),
			],
			{ head: HEAD, prAuthor: AUTHOR },
		);
		assert.equal(got.ok, false);
	});

	it("reports every blocking reviewer, not just the first", () => {
		const got = evaluateBlockingReviews([review(), review({ user: { login: "nhod" } })], {
			head: HEAD,
			prAuthor: AUTHOR,
		});
		assert.equal(got.ok, false);
		assert.deepEqual(got.reviewers.sort(), ["nhod", REVIEWER].sort());
	});

	// Fail closed: if we cannot identify the PR author we cannot tell a
	// self-review from an independent one, so we must not certify the PR mergeable.
	it("fails CLOSED when the PR author is unknown", () => {
		const got = evaluateBlockingReviews([review()], { head: HEAD, prAuthor: "" });
		assert.equal(got.ok, false);
		assert.equal(got.reason, "unknown-pr-author");
	});

	it("is clean when there are genuinely no reviews (a real empty array)", () => {
		assert.equal(evaluateBlockingReviews([], { head: HEAD, prAuthor: AUTHOR }).ok, true);
	});

	// Every ambiguity fails CLOSED. Each "unknown" this waved through would be a
	// bypass — the same shape as the bug the gate exists to fix.
	it("fails CLOSED on a non-array reviews response (null is 'unknown', not 'none')", () => {
		for (const bad of [null, undefined, {}, "oops"]) {
			const got = evaluateBlockingReviews(bad, { head: HEAD, prAuthor: AUTHOR });
			assert.equal(got.ok, false, `${JSON.stringify(bad)} must not certify a merge`);
			assert.equal(got.reason, "invalid-reviews-response");
		}
	});

	it("fails CLOSED on an unknown PR author even with zero reviews", () => {
		const got = evaluateBlockingReviews([], { head: HEAD, prAuthor: "" });
		assert.equal(got.ok, false);
		assert.equal(got.reason, "unknown-pr-author");
	});

	it("fails CLOSED when a current-head verdict has no readable author", () => {
		const got = evaluateBlockingReviews([review({ user: null })], { head: HEAD, prAuthor: AUTHOR });
		assert.equal(got.ok, false);
		assert.equal(got.reason, "unknown-review-author");
	});

	// Ordering must not depend on submitted_at: a missing or malformed timestamp
	// parsed to 0 would let a LATER requested change lose to an EARLIER approval and
	// silently unblock the merge. Response order + review id decide instead.
	it("orders by response order/id, so a malformed timestamp cannot unblock a merge", () => {
		const got = evaluateBlockingReviews(
			[
				review({ id: 1, state: "APPROVED", submitted_at: "2026-07-12T05:00:00Z" }),
				review({ id: 2, state: "CHANGES_REQUESTED", submitted_at: "not-a-date" }),
			],
			{ head: HEAD, prAuthor: AUTHOR },
		);
		assert.equal(got.ok, false, "the later requested change must still win");
		assert.equal(got.reason, "changes-requested");
	});
});

// These cover the CALLER, which is where the real bug hid: the evaluator's own
// tests were green while the CLI selected the wrong PR and coerced an unread
// response into "no reviews". A pure seam is the only way to test it.
describe("selectHeadPullRequest (the gate must resolve the RIGHT pull request)", () => {
	const OTHER = "1111111111111111111111111111111111111111";
	const open = (n, over = {}) => ({
		number: n,
		state: "open",
		head: { sha: HEAD },
		user: { login: "nhod-codex" },
		...over,
	});

	it("selects the single open PR whose head is this SHA", () => {
		assert.deepEqual(selectHeadPullRequest([open(7)], HEAD), { pr: 7, ambiguous: false, author: "nhod-codex" });
	});

	// `commits/{sha}/pulls` returns merged and closed pulls too. Picking one of those
	// would mask a CHANGES_REQUESTED on the PR actually entering the merge queue.
	it("ignores closed and merged pulls that share the SHA", () => {
		const got = selectHeadPullRequest([open(5, { state: "closed" }), open(7)], HEAD);
		assert.deepEqual(got, { pr: 7, ambiguous: false, author: "nhod-codex" });
	});

	it("ignores pulls whose head is a DIFFERENT SHA", () => {
		assert.equal(selectHeadPullRequest([open(5, { head: { sha: OTHER } })], HEAD).pr, null);
	});

	it("fails CLOSED when two open pulls share the head (ambiguous, do not guess)", () => {
		const got = selectHeadPullRequest([open(7), open(9)], HEAD);
		assert.equal(got.pr, null);
		assert.equal(got.ambiguous, true);
	});

	it("fails CLOSED on no match and on a non-array response", () => {
		assert.equal(selectHeadPullRequest([], HEAD).pr, null);
		assert.equal(selectHeadPullRequest(null, HEAD).pr, null);
		assert.equal(selectHeadPullRequest(null, HEAD).ambiguous, false);
	});
});

describe("flattenReviewPages (--paginate --slurp yields an array of pages)", () => {
	it("flattens paged review arrays, so a >100-review PR is still evaluable", () => {
		const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i }));
		const page2 = [{ id: 100 }];
		assert.equal(flattenReviewPages([page1, page2]).length, 101);
	});

	// A non-array body means "we could not read the reviews", not "there are none",
	// and must reach evaluateBlockingReviews intact so IT can fail closed. Coercing
	// to [] here is exactly the caller-level bypass this suite exists to prevent.
	it("passes a non-array response through UNCHANGED so the evaluator fails closed", () => {
		for (const bad of [null, undefined, {}]) {
			assert.equal(Array.isArray(flattenReviewPages(bad)), false);
			assert.equal(evaluateBlockingReviews(flattenReviewPages(bad), { head: HEAD, prAuthor: "a" }).ok, false);
		}
	});
});
