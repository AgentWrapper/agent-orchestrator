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
import { renderTerminal } from "./what-needs-me.mjs";

const REPO_ROOT = repoRootFrom(import.meta.url);
let cleanup = [];

afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((f) => f()));
});

describe("what-needs-me terminal view (acceptance #3)", () => {
	const now = new Date("2026-07-07T00:00:00Z");

	it("shows an explicit empty state", () => {
		const out = renderTerminal({ sessions: [] }, { now });
		assert.match(out, /Nothing needs you/);
	});

	it("aggregates pending sessions across projects with reasons", () => {
		const out = renderTerminal(
			{
				sessions: [
					{ id: "a", projectId: "ao", activity: { state: "waiting_input" } },
					{ id: "b", projectId: "ao", activity: { state: "active" } },
					{ id: "c", projectId: "cc", activity: { state: "blocked" }, prs: [{ url: "http://pr/1" }] },
				],
			},
			{ now },
		);
		assert.match(out, /2 things need your attention/);
		assert.match(out, /ao:/);
		assert.match(out, /cc:/);
		assert.match(out, /a — needs_input/);
		assert.match(out, /c — blocked/);
		assert.match(out, /http:\/\/pr\/1/);
		assert.doesNotMatch(out, /\bb\b —/);
	});

	it("puts red main CI first in the inventory", () => {
		const out = renderTerminal(
			{
				mainCI: [
					{
						projectId: "ao",
						status: "failing",
						sha: "fee462ed3aabb",
						failedJobs: ["go", "cli-e2e"],
						url: "https://github.example/actions/runs/1",
					},
				],
				sessions: [{ id: "a", projectId: "ao", activity: { state: "waiting_input" } }],
			},
			{ now },
		);
		assert.match(out, /2 things need your attention/);
		assert.match(out, /main_ci_red/);
		assert(out.indexOf("main_ci_red") < out.indexOf("a — needs_input"), out);
	});

	it("uses singular phrasing for one item", () => {
		const out = renderTerminal(
			{ sessions: [{ id: "a", projectId: "ao", activity: { state: "waiting_input" } }] },
			{ now },
		);
		assert.match(out, /1 thing needs your attention/);
	});
});

describe("what-needs-me main module invocation", () => {
	it("prints the attention view when invoked through the release current symlink", async () => {
		const daemon = await listen(
			http.createServer((request, response) => {
				if (request.url === "/api/v1/sessions") {
					response.setHeader("Content-Type", "application/json");
					response.end(JSON.stringify({ sessions: [] }));
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
