#!/usr/bin/env node
import { execFileSync } from "node:child_process";

import {
	FINAL_REVIEW_CONTEXT,
	assertFullSHA,
	buildHumanMergeRequiredStatusPayload,
	buildReviewPassedStatusPayload,
	buildStatusPayload,
	evaluateAutonomousMergeStatuses,
	evaluateBlockingReviews,
	evaluateFinalReviewStatuses,
	flattenReviewPages,
	normalizeRepoSlug,
	selectHeadPullRequest,
} from "./final-review-status-core.mjs";

function usage(exitCode = 1) {
	const out = exitCode === 0 ? process.stdout : process.stderr;
	out.write(`Usage:
  node ops/final-review-status.mjs set --repo owner/repo --sha <full-head-sha> --verdict <clean|parked> --reviewer-family <family> [--target-url <url>] [--human-merge-required]
  node ops/final-review-status.mjs check --repo owner/repo --sha <full-head-sha> [--mode human|autonomous]

The check command exits 0 only for a successful ${FINAL_REVIEW_CONTEXT} status
whose description says verdict=clean and head=<that exact SHA>. Autonomous mode
also exits non-zero when a current-head merge-park status requires a human merge,
or when an independent reviewer has an outstanding CHANGES_REQUESTED review on that
same head (GitHub does not block the merge queue on one; this gate does).
`);
	process.exit(exitCode);
}

const BOOLEAN_FLAGS = new Set(["human_merge_required"]);

function parseArgs(argv) {
	const [command, ...rest] = argv;
	if (!command || command === "-h" || command === "--help") usage(command ? 0 : 1);
	const opts = { command };
	for (let i = 0; i < rest.length; i += 1) {
		const arg = rest[i];
		if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
		const key = arg.slice(2).replaceAll("-", "_");
		if (BOOLEAN_FLAGS.has(key)) {
			opts[key] = true;
			continue;
		}
		const value = rest[i + 1];
		if (!value || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
		opts[key] = value;
		i += 1;
	}
	return opts;
}

function requireOpt(opts, key) {
	const value = String(opts[key] ?? "").trim();
	if (!value) throw new Error(`missing required --${key.replaceAll("_", "-")}`);
	return value;
}

function ghJSON(args, input) {
	const stdout = execFileSync("gh", args, {
		encoding: "utf8",
		input,
		stdio: input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
	});
	return stdout.trim() ? JSON.parse(stdout) : null;
}

function postStatus(opts) {
	const repo = normalizeRepoSlug(requireOpt(opts, "repo"));
	const sha = assertFullSHA(requireOpt(opts, "sha"));
	const verdict = requireOpt(opts, "verdict");
	const reviewerFamily = requireOpt(opts, "reviewer_family");
	const payload = buildStatusPayload({
		sha,
		verdict,
		reviewerFamily,
		targetUrl: opts.target_url ?? "",
	});
	const reviewPassedPayload = buildReviewPassedStatusPayload({
		sha,
		verdict,
		reviewerFamily,
		targetUrl: opts.target_url ?? "",
	});
	if (opts.human_merge_required && verdict !== "clean") {
		throw new Error("--human-merge-required is only valid with --verdict clean");
	}

	const mergePark = opts.human_merge_required
		? buildHumanMergeRequiredStatusPayload({
				sha,
				reviewerFamily,
				targetUrl: opts.target_url ?? "",
			})
		: null;
	if (mergePark) postGitHubStatus(repo, sha, mergePark);
	postGitHubStatus(repo, sha, payload);
	postGitHubStatus(repo, sha, reviewPassedPayload);

	const result = {
		ok: true,
		context: payload.context,
		state: payload.state,
		description: payload.description,
		head: sha.toLowerCase(),
	};
	if (mergePark) {
		result.mergePark = {
			context: mergePark.context,
			state: mergePark.state,
			description: mergePark.description,
		};
	}
	result.reviewPassed = {
		context: reviewPassedPayload.context,
		state: reviewPassedPayload.state,
		description: reviewPassedPayload.description,
	};
	process.stdout.write(`${JSON.stringify(result)}\n`);
}

function postGitHubStatus(repo, sha, payload) {
	ghJSON(
		[
			"api",
			"--method",
			"POST",
			`repos/${repo}/statuses/${sha}`,
			"-f",
			`state=${payload.state}`,
			"-f",
			`context=${payload.context}`,
			"-f",
			`description=${payload.description}`,
			...(payload.target_url ? ["-f", `target_url=${payload.target_url}`] : []),
		],
		undefined,
	);
}

// The PR whose head is this SHA, plus its reviews.
//
// The PR is DERIVED from the SHA rather than taken as a flag on purpose. An
// optional --pr would mean a caller that omits it silently skips the blocking-review
// check — a bypass, and this gate exists precisely because a gate you can route
// around is not a gate. A required --pr would instead break every existing
// autonomous caller. Deriving it needs no caller change and leaves no hole.
//
// Fails CLOSED: if no PR can be resolved for the head, we cannot evaluate reviews
// at all, so we must not certify the PR mergeable.
function fetchHeadPullRequestReviews(repo, sha) {
	const pulls = ghJSON(["api", "--method", "GET", `repos/${repo}/commits/${sha}/pulls`, "-f", "per_page=100"]) ?? [];

	// This endpoint returns EVERY pull associated with the commit — merged and closed
	// ones included. Taking the first exact-head match could select a stale or closed
	// PR and thereby miss a CHANGES_REQUESTED on the PR actually entering the merge
	// queue: a direct bypass. Consider only OPEN PRs whose head is this SHA, and
	// require exactly one — genuine ambiguity fails closed rather than guessing.
	const { pr: prNumber, ambiguous, author } = selectHeadPullRequest(pulls, sha);
	if (!prNumber) return { pr: null, ambiguous, author: "", reviews: null };

	// --slurp: with --paginate, gh emits one JSON document PER PAGE, so a plain parse
	// throws once a PR passes 100 reviews. --slurp wraps the pages in a single array,
	// which we flatten. Without it the gate fails closed on a heavily reviewed PR —
	// safe, but UNCLEARABLE, and an unclearable gate is one workers route around.
	const pages = ghJSON([
		"api",
		"--paginate",
		"--slurp",
		"--method",
		"GET",
		`repos/${repo}/pulls/${prNumber}/reviews`,
		"-f",
		"per_page=100",
	]);

	// Deliberately NOT `?? []`: a null/absent body means "we could not read the
	// reviews", not "there are none". Passing it through as null lets
	// evaluateBlockingReviews fail closed (invalid-reviews-response) instead of
	// certifying a merge on an unread response.
	return { pr: prNumber, ambiguous: false, author, reviews: flattenReviewPages(pages) };
}

function checkStatus(opts) {
	const repo = normalizeRepoSlug(requireOpt(opts, "repo"));
	const sha = assertFullSHA(requireOpt(opts, "sha"));
	const mode = String(opts.mode ?? "human").trim();
	if (mode !== "human" && mode !== "autonomous") throw new Error("--mode must be human or autonomous");
	const statuses = ghJSON(["api", "--method", "GET", `repos/${repo}/commits/${sha}/statuses`, "-f", "per_page=100"]);
	const result =
		mode === "autonomous" ? evaluateAutonomousMergeStatuses(statuses, sha) : evaluateFinalReviewStatuses(statuses, sha);

	// A clean, SHA-current final review is necessary but not sufficient for an
	// autonomous merge: an independent reviewer may have requested changes on this
	// same head. GitHub will not stop the merge queue on that (mainprotect carries
	// no pull_request rule), so this gate must. See evaluateBlockingReviews (#304).
	if (mode === "autonomous" && result.ok) {
		const { pr, ambiguous, author, reviews } = fetchHeadPullRequestReviews(repo, sha);
		if (!pr) {
			const reason = ambiguous ? "ambiguous-pull-request-for-head" : "no-pull-request-for-head";
			process.stdout.write(`${JSON.stringify({ ok: false, reason, head: sha.toLowerCase() })}\n`);
			process.exit(1);
		}
		const blocking = evaluateBlockingReviews(reviews, { head: sha, prAuthor: author });
		if (!blocking.ok) {
			process.stdout.write(`${JSON.stringify({ ...blocking, pr })}\n`);
			process.exit(1);
		}
	}

	process.stdout.write(`${JSON.stringify(result)}\n`);
	if (!result.ok) process.exit(1);
}

try {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.command === "set") postStatus(opts);
	else if (opts.command === "check") checkStatus(opts);
	else throw new Error(`unknown command: ${opts.command}`);
} catch (err) {
	process.stderr.write(`final-review-status: ${err.message}\n`);
	process.exit(1);
}
