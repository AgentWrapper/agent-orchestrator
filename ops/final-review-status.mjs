#!/usr/bin/env node
import { execFileSync } from "node:child_process";

import {
	FINAL_REVIEW_CONTEXT,
	assertFullSHA,
	buildHumanMergeRequiredStatusPayload,
	buildStatusPayload,
	evaluateAutonomousMergeStatuses,
	evaluateFinalReviewStatuses,
	normalizeRepoSlug,
} from "./final-review-status-core.mjs";

function usage(exitCode = 1) {
	const out = exitCode === 0 ? process.stdout : process.stderr;
	out.write(`Usage:
  node ops/final-review-status.mjs set --repo owner/repo --sha <full-head-sha> --verdict <clean|parked> --reviewer-family <family> [--target-url <url>] [--human-merge-required]
  node ops/final-review-status.mjs check --repo owner/repo --sha <full-head-sha> [--mode human|autonomous]

The check command exits 0 only for a successful ${FINAL_REVIEW_CONTEXT} status
whose description says verdict=clean and head=<that exact SHA>. Autonomous mode
also exits non-zero when a current-head merge-park status requires a human merge.
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

function checkStatus(opts) {
	const repo = normalizeRepoSlug(requireOpt(opts, "repo"));
	const sha = assertFullSHA(requireOpt(opts, "sha"));
	const mode = String(opts.mode ?? "human").trim();
	if (mode !== "human" && mode !== "autonomous") throw new Error("--mode must be human or autonomous");
	const statuses = ghJSON(["api", "--method", "GET", `repos/${repo}/commits/${sha}/statuses`, "-f", "per_page=100"]);
	const result =
		mode === "autonomous" ? evaluateAutonomousMergeStatuses(statuses, sha) : evaluateFinalReviewStatuses(statuses, sha);
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
