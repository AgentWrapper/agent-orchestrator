import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, describe, it } from "node:test";

import {
	childEnv,
	emptyEnvPath,
	listen,
	releaseSymlinkScript,
	repoRootFrom,
	spawnNode,
	waitForExit,
} from "./main-invocation-test-helpers.mjs";
import { mainCIItems, projectionItems, renderTerminal } from "./what-needs-me.mjs";

const REPO_ROOT = repoRootFrom(import.meta.url);
let cleanup = [];

afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((f) => f()));
});

describe("what-needs-me terminal view", () => {
	const now = new Date("2026-07-07T00:00:00Z");

	it("shows an explicit empty state", () => {
		const out = renderTerminal({ items: [] }, { now });
		assert.match(out, /Nothing needs you/);
	});

	it("renders the projection items grouped by project with reasons and links", () => {
		const out = renderTerminal(
			{
				items: [
					{
						id: "s:a:decision",
						kind: "decision",
						projectId: "ao",
						sessionId: "a",
						reason: "waiting on a decision",
						deepLink: "/projects/ao/sessions/a",
					},
					{
						id: "pr:1:merge",
						kind: "blocked",
						projectId: "cc",
						sessionId: "c",
						reason: "blocked / stuck",
						deepLink: "http://pr/1",
					},
				],
			},
			{ now },
		);
		assert.match(out, /2 things need your attention/);
		assert.match(out, /ao:/);
		assert.match(out, /cc:/);
		assert.match(out, /a — decision/);
		assert.match(out, /c — blocked/);
		assert.match(out, /http:\/\/pr\/1/);
	});

	it("preserves the daemon's newest-first ordering (e.g. main CI first)", () => {
		// The projection is ordered by the daemon; the renderer must not re-sort.
		const out = renderTerminal(
			{
				items: [
					{ id: "n:mainci", kind: "main_ci_red", projectId: "ao", reason: "main is red", deepLink: "" },
					{ id: "s:a:decision", kind: "decision", projectId: "ao", sessionId: "a", reason: "waiting", deepLink: "" },
				],
			},
			{ now },
		);
		assert.match(out, /2 things need your attention/);
		assert.match(out, /main_ci_red/);
		assert(out.indexOf("main_ci_red") < out.indexOf("a — decision"), out);
	});

	it("renders a PR item by its PR number", () => {
		const out = renderTerminal(
			{
				items: [
					{
						id: "pr:900:merge",
						kind: "pr",
						projectId: "ao",
						sessionId: "s1",
						prNumber: 900,
						reason: "mergeable",
						deepLink: "http://pr/900",
					},
				],
			},
			{ now },
		);
		assert.match(out, /#900 — pr/);
	});

	it("uses singular phrasing for one item", () => {
		const out = renderTerminal(
			{
				items: [
					{ id: "s:a:decision", kind: "decision", projectId: "ao", sessionId: "a", reason: "waiting", deepLink: "" },
				],
			},
			{ now },
		);
		assert.match(out, /1 thing needs your attention/);
	});

	it("keeps the exceptional main-CI probe: failing records become items ahead of the projection", () => {
		// The daemon does not model main-branch CI in the projection, so this
		// renderer keeps its own GitHub probe — same carve-out as the notifier.
		const ci = mainCIItems([
			{
				projectId: "ao",
				status: "failing",
				sha: "fee462ed3aabb",
				failedJobs: ["go", "cli-e2e"],
				url: "https://github.example/actions/runs/1",
			},
			{ projectId: "ao", status: "passing", sha: "aaa" },
		]);
		assert.equal(ci.length, 1);
		assert.equal(ci[0].kind, "main_ci_red");
		const out = renderTerminal(
			{
				items: [
					...ci,
					{ id: "s:a:decision", kind: "decision", projectId: "ao", sessionId: "a", reason: "waiting", deepLink: "" },
				],
			},
			{ now },
		);
		assert.match(out, /2 things need your attention/);
		assert.match(out, /main_ci_red/);
		assert.match(out, /main is red at fee462ed: go, cli-e2e/);
		assert(out.indexOf("main_ci_red") < out.indexOf("a — decision"), out);
	});
});

describe("projectionItems — payload validation", () => {
	it("accepts a bare array and {items:[]}", () => {
		assert.deepEqual(projectionItems([]), []);
		assert.deepEqual(projectionItems({ items: [{ id: "x" }] }), [{ id: "x" }]);
	});

	it("throws on a malformed payload instead of rendering a false all-clear", () => {
		// A daemon error body or wrong shape must exit non-zero in main(), never
		// print "Nothing needs you".
		assert.throws(() => projectionItems({}), /invalid payload shape/);
		assert.throws(() => projectionItems({ error: "boom" }), /invalid payload shape/);
		assert.throws(() => projectionItems({ items: "nope" }), /invalid payload shape/);
		assert.throws(() => projectionItems(null), /invalid payload shape/);
	});
});

describe("what-needs-me main module invocation", () => {
	it("prints the attention view when invoked through the release current symlink", async () => {
		const daemon = await listen(
			http.createServer((request, response) => {
				if (request.url === "/api/v1/attention/operator") {
					response.setHeader("Content-Type", "application/json");
					response.end(JSON.stringify({ items: [] }));
					return;
				}
				response.writeHead(404);
				response.end("not found");
			}),
			cleanup,
		);
		const script = await releaseSymlinkScript({
			cleanup,
			prefix: "ao-what-needs-me-release-",
			repoRoot: REPO_ROOT,
			script: "ops/what-needs-me.mjs",
		});
		const envFile = await emptyEnvPath(cleanup, "ao-what-needs-me-env-");

		for (const nodeArgs of [[], ["--preserve-symlinks-main"]]) {
			const { child, output } = spawnNode([...nodeArgs, script], {
				cleanup,
				env: childEnv(
					{
						AO_ENV_FILE: envFile,
						AO_MAIN_CI_REPO: "",
						AO_PORT: String(daemon.port),
						AO_PROJECT_REPO: "",
						GITHUB_TOKEN: "",
						POLYPOWERS_REPO: "",
					},
					{ stripPrefixes: ["AO_", "GITHUB_", "POLYPOWERS_"] },
				),
			});

			const result = await waitForExit({ child, output });
			assert.equal(result.code, 0, output.stderr);
			assert.match(output.stdout, /Nothing needs you/);
		}
	});
});
