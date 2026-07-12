import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
	SlackNotificationNotifier,
	contentSignature,
	describeSlackMessage,
	digestContentKey,
	fetchMainCI,
	loadState,
	normalizeNotification,
	notificationKey,
	parsePollMs,
	parseSSEFrames,
	saveState,
} from "./ao-slack-notifier.mjs";
import {
	childEnv,
	emptyEnvPath,
	listen,
	releaseSymlinkScript,
	repoRootFrom,
	spawnNode,
	waitForOutput,
} from "./main-invocation-test-helpers.mjs";

let cleanup = [];
afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((f) => f()));
});

const REPO_ROOT = repoRootFrom(import.meta.url);

async function tmpState() {
	const dir = await mkdtemp(path.join(os.tmpdir(), "ao-slack-state-"));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	return path.join(dir, "state.json");
}

function response(body, ok = true, status = 200) {
	return { ok, status, json: async () => body };
}

describe("ao Slack notifier notification formatting", () => {
	it("mentions needs_input notifications", () => {
		const msg = describeSlackMessage(
			{
				id: "n1",
				type: "needs_input",
				sessionId: "agent-1",
				projectId: "ao",
				title: "permission prompt",
			},
			"U123",
		);

		assert.equal(msg, "<@U123> 🖐️ *needs_input* [ao] agent-1: permission prompt");
	});

	it("does not mention routine ready_to_merge notifications", () => {
		const msg = describeSlackMessage(
			{
				type: "ready_to_merge",
				sessionId: "agent-2",
				projectId: "ao",
				title: "PR ready",
				prUrl: "https://github.example/pr/1",
			},
			"U123",
		);

		assert.equal(msg, "🟢 *ready_to_merge* [ao] agent-2: PR ready https://github.example/pr/1");
	});

	it("mentions sensitive ready_to_merge notifications distinctly", () => {
		const msg = describeSlackMessage(
			{
				type: "ready_to_merge",
				sessionId: "agent-2",
				projectId: "ao",
				title: "PR ready",
				prUrl: "https://github.example/pr/1",
				sensitive: true,
				changedPaths: ["backend/internal/lifecycle/reactions.go"],
			},
			"U123",
		);

		assert.equal(msg, "<@U123> 🛑 *parked_sensitive_merge* [ao] agent-2: PR ready https://github.example/pr/1");
	});

	it("does not mention pr_merged notifications", () => {
		const msg = describeSlackMessage(
			{
				type: "pr_merged",
				sessionId: "agent-4",
				projectId: "ao",
				title: "Merged after parked review",
			},
			"U123",
		);

		assert.equal(msg, "🚀 *pr_merged* [ao] agent-4: Merged after parked review");
	});

	it("mentions red main CI notifications", () => {
		const msg = describeSlackMessage(
			{
				type: "main_ci_red",
				sessionId: "main",
				projectId: "ao",
				title: "main is red at fee462ed: go, cli-e2e",
			},
			"U123",
		);

		assert.equal(msg, "<@U123> 🚨 *main_ci_red* [ao] main: main is red at fee462ed: go, cli-e2e");
	});

	it("posts orchestrator replacement notifications without mentioning", () => {
		const msg = describeSlackMessage(
			{
				type: "orchestrator_replaced",
				sessionId: "mer-orch-2",
				projectId: "mer",
				title: "mer orchestrator was replaced",
			},
			"U123",
		);

		assert.equal(msg, "🔁 *orchestrator_replaced* [mer] mer-orch-2: mer orchestrator was replaced");
	});

	it("mentions capped orchestrator replacement notifications", () => {
		const msg = describeSlackMessage(
			{
				type: "orchestrator_replacement_capped",
				sessionId: "mer-orch",
				projectId: "mer",
				title: "mer-orch replacement paused",
			},
			"U123",
		);

		assert.equal(msg, "<@U123> 🚨 *orchestrator_replacement_capped* [mer] mer-orch: mer-orch replacement paused");
	});

	it("mentions duplicate_pr notifications loudly", () => {
		const msg = describeSlackMessage(
			{
				type: "duplicate_pr",
				sessionId: "agent-94",
				projectId: "ao",
				title: "Duplicate PR #180 for the same issue",
				prUrl: "https://github.example/pr/180",
			},
			"U123",
		);

		assert.equal(
			msg,
			"<@U123> ♊ *duplicate_pr* [ao] agent-94: Duplicate PR #180 for the same issue https://github.example/pr/180",
		);
	});

	it("posts worker death notifications without mentioning", () => {
		const msg = describeSlackMessage(
			{
				type: "worker_died_unfinished",
				sessionId: "agent-5",
				projectId: "ao",
				title: "worker died with unfinished work: issue #155",
			},
			"U123",
		);

		assert.equal(msg, "🧯 *worker_died_unfinished* [ao] agent-5: worker died with unfinished work: issue #155");
	});

	it("mentions retry cap exhaustion notifications", () => {
		const msg = describeSlackMessage(
			{
				type: "worker_retry_exhausted",
				sessionId: "agent-6",
				projectId: "ao",
				title: "worker retry cap exhausted: issue #155",
			},
			"U123",
		);

		assert.equal(msg, "<@U123> 🚨 *worker_retry_exhausted* [ao] agent-6: worker retry cap exhausted: issue #155");
	});

	it("keeps retry cap notifications session-scoped when a fallback payload has a PR URL", () => {
		const n = normalizeNotification({
			type: "worker_retry_exhausted",
			sessionId: "agent-6",
			projectId: "ao",
			prUrl: "https://github.example/pr/6",
		});
		assert.equal(n.subjectKind, "session");
		assert.equal(n.subjectId, "agent-6");
	});

	it("shows model subjects when sessionId is empty", () => {
		const msg = describeSlackMessage({
			type: "model_unreachable",
			sessionId: "",
			projectId: "ao",
			subject: { kind: "model", id: "ao-workerMix-0-model-codex" },
			title: "gpt-5 model unreachable",
		});

		assert.equal(msg, "🧠 *model_unreachable* [ao] ao-workerMix-0-model-codex: gpt-5 model unreachable");
	});

	it("accepts the SSE envelope shape from older tests", () => {
		const msg = describeSlackMessage(
			{
				type: "notification_created",
				notification: {
					id: "n2",
					type: "needs_input",
					sessionId: "agent-1",
					projectId: "ao",
					title: "waiting",
				},
			},
			"U123",
		);

		assert.equal(msg, "<@U123> 🖐️ *needs_input* [ao] agent-1: waiting");
	});

	it("ignores raw CDC events that are not typed notifications", () => {
		const msg = describeSlackMessage({ type: "session_updated", payload: { sessionId: "a" } }, "U123");
		assert.equal(msg, null);
	});
});

describe("ao Slack notifier main CI poll", () => {
	it("fails visibly when GitHub truncates main CI check runs", async () => {
		await assert.rejects(
			() =>
				fetchMainCI({
					repo: "polymath-ventures/agent-orchestrator",
					fetchImpl: async () =>
						response({ total_count: 101, check_runs: Array.from({ length: 100 }, (_, i) => ({ name: `job-${i}` })) }),
				}),
			/check runs truncated at 100\/101/,
		);
	});

	it("pages and digests red main from the poll source", async () => {
		const posts = [];
		const notifier = new SlackNotificationNotifier({
			stateFile: await tmpState(),
			mentionUserId: "U123",
			postMessage: async (text) => {
				posts.push(text);
				return { ts: `ts_${posts.length}` };
			},
			updateMessage: async () => true,
			fetchImpl: async (url) => {
				if (String(url).includes("/sessions")) return response({ sessions: [] });
				return response({ notifications: [] });
			},
			mainCISource: async () => [
				{
					projectId: "ao",
					status: "failing",
					sha: "fee462ed3aabb",
					failedJobs: ["go", "cli-e2e"],
					url: "https://github.example/actions/runs/1",
				},
			],
		});

		const result = await notifier.pollSessionAttention();

		assert.equal(result.alerted.length, 1);
		assert.match(posts[0], /<@U123> 🚨 \*main_ci_red\*/);
		assert(
			posts.some((p) => /main is red at fee462ed: go, cli-e2e/.test(p) && /thing needs you/.test(p)),
			posts,
		);
	});

	it("caches main CI polling separately from the session attention cadence", async () => {
		let mainPolls = 0;
		let now = 1_000;
		const notifier = new SlackNotificationNotifier({
			stateFile: await tmpState(),
			mentionUserId: "U123",
			postMessage: async () => ({ ts: "ts" }),
			updateMessage: async () => true,
			fetchImpl: async () => response({ sessions: [] }),
			mainCIPollMs: 60_000,
			mainCISource: async () => {
				mainPolls += 1;
				return [
					{
						projectId: "ao",
						status: "failing",
						sha: "fee462ed3aabb",
						failedJobs: ["go"],
						url: "https://github.example/actions/runs/1",
					},
				];
			},
			clock: () => new Date(now),
		});

		await notifier.pollSessionAttention();
		now += 10_000;
		await notifier.pollSessionAttention();
		now += 60_000;
		await notifier.pollSessionAttention();

		assert.equal(mainPolls, 2);
	});
});

describe("ao Slack notifier replay/dedup", () => {
	it("uses stable notification ids as the dedup cursor", () => {
		assert.equal(notificationKey({ id: "ntf_1", type: "needs_input" }), "ntf_1");
	});

	it("migrates legacy subject-less state keys on load", async () => {
		const stateFile = await tmpState();
		await writeFile(
			stateFile,
			JSON.stringify({
				seen: [
					"needs_input|ao|agent-1|2026-07-12T00:00:00Z|waiting|",
					"ready_to_merge|ao|agent-2|2026-07-12T00:01:00Z|ready|https://github.example/pr/2",
				],
				attentionTracker: {
					open: [["ao/agent-1#needs_input", { kind: "needs_input", sessionId: "agent-1", projectId: "ao", attention: true }]],
				},
				postedSignatures: {
					"main_ci_red|ao|main||0|sha-main": 123,
					"ready_to_merge|ao|agent-2|https://github.example/pr/2|0|sha-pr": 456,
				},
				needsResponseMessages: {
					"ao/agent-1#needs_input": {
						ts: "1.2",
						channel: "C",
						text: "waiting",
						record: { kind: "needs_input", sessionId: "agent-1", projectId: "ao", attention: true },
					},
					"ao/agent-2#parked_sensitive_merge": {
						ts: "2.3",
						channel: "C",
						text: "ready",
						record: {
							kind: "parked_sensitive_merge",
							sessionId: "agent-2",
							projectId: "ao",
							url: "https://github.example/pr/2",
							attention: true,
						},
					},
				},
			}),
			"utf8",
		);

		const state = loadState(stateFile);
		assert.ok(state.seen.has("needs_input|ao|session:agent-1|2026-07-12T00:00:00Z|waiting|"));
		assert.ok(
			state.seen.has("ready_to_merge|ao|pr:https://github.example/pr/2|2026-07-12T00:01:00Z|ready|https://github.example/pr/2"),
		);
		assert.ok(
			state.attentionTracker.isOpen({
				kind: "needs_input",
				sessionId: "agent-1",
				subjectKind: "session",
				subjectId: "agent-1",
				projectId: "ao",
				attention: true,
			}),
		);
		assert.equal(state.postedSignatures["main_ci_red|ao|project:ao||0|sha-main"], 123);
		const migratedPrSignature = contentSignature({
			type: "ready_to_merge",
			projectId: "ao",
			sessionId: "agent-2",
			prUrl: "https://github.example/pr/2",
			subject: { kind: "pr", id: "https://github.example/pr/2" },
			headSha: "sha-pr",
		});
		assert.equal(migratedPrSignature, "ready_to_merge|ao|pr:https://github.example/pr/2|https://github.example/pr/2|0|sha-pr");
		assert.equal(state.postedSignatures[migratedPrSignature], 456);
		assert.ok(state.needsResponseMessages["ao/session:agent-1#needs_input"]);
		assert.ok(state.needsResponseMessages["ao/pr:https://github.example/pr/2#parked_sensitive_merge|https://github.example/pr/2"]);
	});

	it("catch-up posts unread notifications once and persists seen ids", async () => {
		const stateFile = await tmpState();
		const posts = [];
		let listed = false;
		const marked = [];
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			postMessage: async (text) => posts.push(text),
			fetchImpl: async (url, init = {}) => {
				if (init.method === "PATCH") {
					marked.push(url.split("/").at(-1));
					return response({});
				}
				assert.match(url, /\/notifications\?status=unread&limit=100$/);
				if (listed) return response({ notifications: [] });
				listed = true;
				return response({
					notifications: [
						{
							id: "ntf_1",
							type: "needs_input",
							sessionId: "a",
							projectId: "ao",
							title: "waiting",
							createdAt: "2026-07-07T00:00:00Z",
						},
					],
				});
			},
			logger: { info() {}, error() {} },
		});

		await notifier.catchUpUnread();
		await notifier.catchUpUnread();

		assert.equal(posts.length, 1);
		assert.match(posts[0], /<@U123>.*needs_input/);
		assert.ok(loadState(stateFile).seen.has("ntf_1"));
		assert.deepEqual(marked, ["ntf_1"]);
	});

	it("drains multiple unread pages by marking delivered notifications read", async () => {
		const stateFile = await tmpState();
		const posts = [];
		const marked = [];
		let page = 0;
		const pages = [
			[
				{ id: "ntf_1", type: "needs_input", sessionId: "a", projectId: "ao", title: "first" },
				{ id: "ntf_2", type: "ready_to_merge", sessionId: "b", projectId: "ao", title: "second" },
			],
			[{ id: "ntf_3", type: "needs_input", sessionId: "c", projectId: "ao", title: "third" }],
		];
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			pageLimit: 2,
			mentionUserId: "U123",
			postMessage: async (text) => posts.push(text),
			fetchImpl: async (url, init = {}) => {
				if (init.method === "PATCH") {
					marked.push(url.split("/").at(-1));
					return response({});
				}
				assert.match(url, /limit=2$/);
				return response({ notifications: pages[page++] ?? [] });
			},
			logger: { info() {}, error() {} },
		});

		await notifier.catchUpUnread();

		assert.equal(posts.length, 2);
		assert.deepEqual(marked, ["ntf_1", "ntf_2", "ntf_3"]);
		const saved = loadState(stateFile);
		assert.ok(saved.seen.has("ntf_1"));
		assert.ok(saved.seen.has("ntf_3"));
	});

	it("first bootstrap seeds old informational notifications without posting them", async () => {
		const stateFile = await tmpState();
		const posts = [];
		const marked = [];
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			postMessage: async (text) => posts.push(text),
			fetchImpl: async (url, init = {}) => {
				if (init.method === "PATCH") {
					marked.push(url.split("/").at(-1));
					return response({});
				}
				return response({
					notifications: [
						{ id: "old_merge", type: "pr_merged", sessionId: "a", projectId: "ao", title: "merged" },
						{ id: "waiting", type: "needs_input", sessionId: "b", projectId: "ao", title: "waiting" },
					],
				});
			},
			logger: { info() {}, error() {} },
		});

		await notifier.catchUpUnread();

		assert.equal(posts.length, 1);
		assert.match(posts[0], /needs_input/);
		const saved = loadState(stateFile);
		assert.ok(saved.seen.has("old_merge"));
		assert.ok(saved.seen.has("waiting"));
		assert.equal(saved.initialized, true);
		assert.deepEqual(marked, ["old_merge", "waiting"]);
	});

	it("loads default state from the configured state file", async () => {
		const stateFile = await tmpState();
		saveState(
			stateFile,
			{
				seen: new Set(["ntf_1"]),
				lastEventId: "ev_1",
				lastHeartbeatAt: 0,
				initialized: true,
				lastDigestKey: "digest",
				digestTs: "123.456",
			},
			100,
		);

		const notifier = new SlackNotificationNotifier({ stateFile });

		assert.ok(notifier.state.seen.has("ntf_1"));
		assert.equal(notifier.state.lastEventId, "ev_1");
		assert.equal(notifier.state.lastDigestKey, "digest");
		assert.equal(notifier.state.digestTs, "123.456");
	});

	it("logs state persistence failures instead of silently swallowing them", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "ao-slack-state-blocked-"));
		cleanup.push(() => rm(dir, { recursive: true, force: true }));
		const blockingFile = path.join(dir, "not-a-dir");
		await writeFile(blockingFile, "blocks mkdir");
		const warnings = [];

		saveState(path.join(blockingFile, "state.json"), { seen: new Set(["n1"]) }, 10, {
			warn: (...args) => warnings.push(args.join(" ")),
		});

		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /failed to persist state/);
	});

	it("does not mark a notification seen until Slack delivery succeeds", async () => {
		const stateFile = await tmpState();
		let fail = true;
		const posts = [];
		const marked = [];
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			postMessage: async (text) => {
				if (fail) throw new Error("slack 503");
				posts.push(text);
			},
			fetchImpl: async (url, init = {}) => {
				if (init.method === "PATCH") {
					marked.push(url.split("/").at(-1));
					return response({});
				}
				return response({ notifications: [] });
			},
			logger: { info() {}, error() {} },
		});
		const raw = { id: "ntf_1", type: "needs_input", sessionId: "a", projectId: "ao", title: "waiting" };

		await assert.rejects(() => notifier.handleNotification(raw), /slack 503/);
		assert.equal(loadState(stateFile).seen.has("ntf_1"), false);
		assert.deepEqual(marked, []);
		fail = false;
		assert.equal(await notifier.handleNotification(raw), true);
		assert.equal(posts.length, 1);
		assert.deepEqual(marked, ["ntf_1"]);
		assert.ok(loadState(stateFile).seen.has("ntf_1"));
	});
});

describe("ao Slack notifier needs-response routing", () => {
	it("routes routine notifications to notify and operator waits to needs-response", async () => {
		const stateFile = await tmpState();
		const posts = [];
		const marked = [];
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			notifyChannel: "C-notify",
			needsResponseChannel: "C-needs",
			postMessage: async (text, opts = {}) => posts.push({ text, channel: opts.channel }),
			fetchImpl: async (url, init = {}) => {
				if (init.method === "PATCH") {
					marked.push(url.split("/").at(-1));
					return response({});
				}
				return response({ notifications: [] });
			},
			logger: { info() {}, error() {}, warn() {} },
			bootstrapMode: "post_all",
		});

		await notifier.handleNotification({
			id: "ready-sensitive",
			type: "ready_to_merge",
			sessionId: "s1",
			projectId: "ao",
			title: "PR #7 ready",
			prUrl: "https://github.example/pr/7",
			sensitive: true,
		});
		await notifier.handleNotification({
			id: "merged",
			type: "pr_merged",
			sessionId: "s2",
			projectId: "ao",
			title: "PR #8 merged",
			prUrl: "https://github.example/pr/8",
		});

		assert.equal(posts.length, 2);
		assert.match(posts[0].text, /parked_sensitive_merge/);
		assert.equal(posts[0].channel, "C-needs");
		assert.match(posts[1].text, /pr_merged/);
		assert.equal(posts[1].channel, "C-notify");
		assert.deepEqual(marked, ["ready-sensitive", "merged"]);
	});

	it("routes worker_retry_exhausted to the needs-response channel (issue #230)", async () => {
		const stateFile = await tmpState();
		const posts = [];
		const marked = [];
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			notifyChannel: "C-notify",
			needsResponseChannel: "C-needs",
			postMessage: async (text, opts = {}) => {
				posts.push({ text, channel: opts.channel });
				return { ts: "m1" };
			},
			updateMessage: async () => {
				throw new Error("worker_retry_exhausted should not be resolved by session polling");
			},
			fetchImpl: async (url, init = {}) => {
				if (init.method === "PATCH") {
					marked.push(url.split("/").at(-1));
					return response({});
				}
				return response({ notifications: [] });
			},
			logger: { info() {}, error() {}, warn() {} },
			bootstrapMode: "post_all",
		});

		await notifier.handleNotification({
			id: "exhausted",
			type: "worker_retry_exhausted",
			sessionId: "worker-dead",
			projectId: "ao",
			title: "worker retry cap exhausted: issue #12",
			prUrl: "https://github.example/pr/99",
		});

		assert.equal(posts.length, 1);
		assert.match(posts[0].text, /worker_retry_exhausted/);
		assert.equal(posts[0].channel, "C-needs");
		assert.deepEqual(marked, ["exhausted"]);
		assert.equal(Object.keys(notifier.state.needsResponseMessages).length, 1);
		assert.equal(notifier.state.attentionTracker.pending().length, 0);

		await notifier.pollSessionAttention();
		await notifier.pollSessionAttention();

		assert.equal(Object.keys(notifier.state.needsResponseMessages).length, 1);
	});

	it("edits the original needs-response message when a session wait clears", async () => {
		const stateFile = await tmpState();
		const posts = [];
		const updates = [];
		let ts = 0;
		const pages = [
			{ sessions: [{ id: "blocked-1", projectId: "ao", activity: { state: "blocked" } }] },
			{ sessions: [] },
			{ sessions: [] },
		];
		let page = 0;
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			notifyChannel: "C-notify",
			needsResponseChannel: "C-needs",
			postMessage: async (text, opts = {}) => {
				posts.push({ text, channel: opts.channel });
				return { ts: `m${++ts}` };
			},
			updateMessage: async (messageTs, text, opts = {}) => {
				updates.push({ ts: messageTs, text, channel: opts.channel });
				return true;
			},
			fetchImpl: async () => response(pages[page++] ?? { sessions: [] }),
			clock: () => new Date("2026-07-11T03:00:00Z"),
			logger: { info() {}, error() {}, warn() {} },
		});

		await notifier.pollSessionAttention();
		await notifier.pollSessionAttention();
		await notifier.pollSessionAttention();

		const needsPost = posts.find((p) => /blocked/.test(p.text) && /<@U123>/.test(p.text));
		assert.equal(needsPost?.channel, "C-needs");
		assert.ok(
			updates.some(
				(u) =>
					u.ts === "m1" && u.channel === "C-needs" && /resolved/.test(u.text) && /2026-07-11T03:00:00Z/.test(u.text),
			),
		);
	});

	it("edits a parked sensitive PR message when the same PR merges", async () => {
		const stateFile = await tmpState();
		const posts = [];
		const updates = [];
		const marked = [];
		let ts = 0;
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			notifyChannel: "C-notify",
			needsResponseChannel: "C-needs",
			postMessage: async (text, opts = {}) => {
				posts.push({ text, channel: opts.channel });
				return { ts: `m${++ts}` };
			},
			updateMessage: async (messageTs, text, opts = {}) => {
				updates.push({ ts: messageTs, text, channel: opts.channel });
				return true;
			},
			fetchImpl: async (url, init = {}) => {
				if (init.method === "PATCH") {
					marked.push(url.split("/").at(-1));
					return response({});
				}
				return response({ notifications: [] });
			},
			clock: () => new Date("2026-07-11T04:00:00Z"),
			logger: { info() {}, error() {}, warn() {} },
			bootstrapMode: "post_all",
		});

		await notifier.handleNotification({
			id: "ready",
			type: "ready_to_merge",
			sessionId: "s1",
			projectId: "ao",
			title: "PR #7 ready",
			prUrl: "https://github.example/pr/7",
			sensitive: true,
		});
		await notifier.handleNotification({
			id: "merged",
			type: "pr_merged",
			sessionId: "s1",
			projectId: "ao",
			title: "PR #7 merged",
			prUrl: "https://github.example/pr/7",
		});

		assert.equal(posts[0].channel, "C-needs");
		assert.equal(posts[1].channel, "C-notify");
		assert.ok(updates.some((u) => u.ts === "m1" && u.channel === "C-needs" && /PR #7 merged/.test(u.text)));
		assert.deepEqual(marked, ["ready", "merged"]);
	});

	it("does not resolve a parked sensitive PR from an empty session poll", async () => {
		const stateFile = await tmpState();
		const posts = [];
		const updates = [];
		let ts = 0;
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			notifyChannel: "C-notify",
			needsResponseChannel: "C-needs",
			postMessage: async (text, opts = {}) => {
				posts.push({ text, channel: opts.channel });
				return { ts: `m${++ts}` };
			},
			updateMessage: async (messageTs, text, opts = {}) => {
				updates.push({ ts: messageTs, text, channel: opts.channel });
				return true;
			},
			fetchImpl: async (url, init = {}) => {
				if (init.method === "PATCH") return response({});
				if (/\/sessions\?active=true$/.test(url)) return response({ sessions: [] });
				return response({ notifications: [] });
			},
			logger: { info() {}, error() {}, warn() {} },
			bootstrapMode: "post_all",
		});

		await notifier.handleNotification({
			id: "ready",
			type: "ready_to_merge",
			sessionId: "s1",
			projectId: "ao",
			title: "PR #7 ready",
			prUrl: "https://github.example/pr/7",
			sensitive: true,
		});
		await notifier.pollSessionAttention();
		await notifier.pollSessionAttention();

		assert.equal(posts.filter((p) => /parked_sensitive_merge/.test(p.text)).length, 1);
		assert.equal(
			updates.some((u) => /resolved/.test(u.text)),
			false,
		);
		assert.equal(Object.keys(notifier.state.needsResponseMessages).length, 1);
	});

	it("posts a fresh parked sensitive PR alert when the head SHA changes", async () => {
		const stateFile = await tmpState();
		const posts = [];
		const marked = [];
		let ts = 0;
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			notifyChannel: "C-notify",
			needsResponseChannel: "C-needs",
			postMessage: async (text, opts = {}) => {
				posts.push({ text, channel: opts.channel });
				return { ts: `m${++ts}` };
			},
			updateMessage: async () => true,
			fetchImpl: async (url, init = {}) => {
				if (init.method === "PATCH") {
					marked.push(url.split("/").at(-1));
					return response({});
				}
				return response({ notifications: [] });
			},
			logger: { info() {}, error() {}, warn() {} },
			bootstrapMode: "post_all",
		});

		for (const [id, headSha] of [
			["ready-a", "aaa111"],
			["ready-b", "bbb222"],
		]) {
			await notifier.handleNotification({
				id,
				type: "ready_to_merge",
				sessionId: "s1",
				projectId: "ao",
				title: "PR #7 ready",
				prUrl: "https://github.example/pr/7",
				sensitive: true,
				headSha,
			});
		}

		assert.equal(posts.filter((p) => p.channel === "C-needs" && /parked_sensitive_merge/.test(p.text)).length, 2);
		assert.equal(Object.keys(notifier.state.needsResponseMessages).length, 2);
		assert.deepEqual(marked, ["ready-a", "ready-b"]);
	});

	it("retries parked sensitive PR resolution before marking terminal notifications read", async () => {
		const stateFile = await tmpState();
		const posts = [];
		const updates = [];
		const marked = [];
		let ts = 0;
		let failUpdate = true;
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			notifyChannel: "C-notify",
			needsResponseChannel: "C-needs",
			postMessage: async (text, opts = {}) => {
				posts.push({ text, channel: opts.channel });
				return { ts: `m${++ts}` };
			},
			updateMessage: async (messageTs, text, opts = {}) => {
				if (failUpdate) {
					failUpdate = false;
					throw new Error("slack 503");
				}
				updates.push({ ts: messageTs, text, channel: opts.channel });
				return true;
			},
			fetchImpl: async (url, init = {}) => {
				if (init.method === "PATCH") {
					marked.push(url.split("/").at(-1));
					return response({});
				}
				return response({ notifications: [] });
			},
			clock: () => new Date("2026-07-11T06:00:00Z"),
			logger: { info() {}, error() {}, warn() {} },
			bootstrapMode: "post_all",
		});
		const merged = {
			id: "merged",
			type: "pr_merged",
			sessionId: "s1",
			projectId: "ao",
			title: "PR #7 merged",
			prUrl: "https://github.example/pr/7",
		};

		await notifier.handleNotification({
			id: "ready",
			type: "ready_to_merge",
			sessionId: "s1",
			projectId: "ao",
			title: "PR #7 ready",
			prUrl: "https://github.example/pr/7",
			sensitive: true,
		});
		await notifier.handleNotification(merged);

		assert.deepEqual(marked, ["ready"], "terminal notification stays unread after failed resolution edit");
		assert.equal(Object.keys(notifier.state.needsResponseMessages).length, 1);
		assert.equal(posts.filter((p) => /pr_merged/.test(p.text)).length, 1);

		await notifier.handleNotification(merged);

		assert.deepEqual(marked, ["ready", "merged"]);
		assert.ok(updates.some((u) => u.ts === "m1" && /resolved/.test(u.text)));
		assert.equal(Object.keys(notifier.state.needsResponseMessages).length, 0);
		assert.equal(posts.filter((p) => /pr_merged/.test(p.text)).length, 1, "retry does not repost terminal notice");
	});

	it("retries a needs-response resolution edit after chat.update fails", async () => {
		const stateFile = await tmpState();
		const posts = [];
		const updates = [];
		let ts = 0;
		let failUpdate = true;
		const pages = [
			{ sessions: [{ id: "blocked-1", projectId: "ao", activity: { state: "blocked" } }] },
			{ sessions: [] },
			{ sessions: [] },
			{ sessions: [] },
		];
		let page = 0;
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			notifyChannel: "C-notify",
			needsResponseChannel: "C-needs",
			postMessage: async (text, opts = {}) => {
				posts.push({ text, channel: opts.channel });
				return { ts: `m${++ts}` };
			},
			updateMessage: async (messageTs, text, opts = {}) => {
				if (failUpdate) {
					failUpdate = false;
					throw new Error("slack 503");
				}
				updates.push({ ts: messageTs, text, channel: opts.channel });
				return true;
			},
			fetchImpl: async () => response(pages[page++] ?? { sessions: [] }),
			clock: () => new Date("2026-07-11T05:00:00Z"),
			logger: { info() {}, error() {}, warn() {} },
		});

		await notifier.pollSessionAttention();
		await notifier.pollSessionAttention();
		await notifier.pollSessionAttention();
		assert.equal(
			updates.some((u) => u.ts === "m1"),
			false,
			"first per-item resolution attempt fails",
		);
		assert.equal(Object.keys(notifier.state.needsResponseMessages).length, 1, "message remains open for retry");

		await notifier.pollSessionAttention();

		assert.ok(updates.some((u) => u.ts === "m1" && /resolved/.test(u.text)));
		assert.equal(Object.keys(notifier.state.needsResponseMessages).length, 0);
	});
});

describe("ao Slack notifier SSE parsing", () => {
	it("parses notification SSE frames and preserves partial trailing frames", () => {
		const parsed = parseSSEFrames(
			'event: notification_created\nid: 42\ndata: {"id":"n1"}\n\nevent: notification_created\ndata:',
		);
		assert.equal(parsed.frames.length, 1);
		assert.equal(parsed.frames[0].id, "42");
		assert.equal(parsed.frames[0].event, "notification_created");
		assert.equal(parsed.frames[0].data, '{"id":"n1"}');
		assert.equal(parsed.rest, "event: notification_created\ndata:");
	});
});

describe("ao Slack notifier session attention polling", () => {
	it("mentions blocked, dead-orchestrator, and worker no-signal states from /sessions", async () => {
		const stateFile = await tmpState();
		const posts = [];
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			postMessage: async (text) => posts.push(text),
			fetchImpl: async (url) => {
				assert.equal(url, "http://ao.test/api/v1/sessions?active=true");
				return response({
					sessions: [
						{ id: "worker-blocked", projectId: "ao", activity: { state: "blocked" } },
						{ id: "orch-dead", projectId: "ao", kind: "orchestrator", status: "no_signal" },
						{ id: "worker-silent", projectId: "ao", kind: "worker", status: "no_signal" },
					],
				});
			},
			logger: { info() {}, error() {}, warn() {} },
		});

		const result = await notifier.pollSessionAttention();

		assert.equal(result.alerted.length, 3);
		assert.ok(posts.some((p) => /<@U123>.*blocked/.test(p)));
		assert.ok(posts.some((p) => /<@U123>.*orchestrator_dead/.test(p)));
		assert.ok(posts.some((p) => /<@U123>.*no_signal/.test(p)));
	});

	it("dedupes unchanged session attention and re-alerts after resolution", async () => {
		const stateFile = await tmpState();
		const posts = [];
		const pages = [
			{ sessions: [{ id: "a", projectId: "ao", activity: { state: "blocked" } }] },
			{ sessions: [{ id: "a", projectId: "ao", activity: { state: "blocked" } }] },
			{ sessions: [] },
			{ sessions: [] },
			{ sessions: [{ id: "a", projectId: "ao", activity: { state: "blocked" } }] },
		];
		let page = 0;
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			postMessage: async (text) => posts.push(text),
			fetchImpl: async () => response(pages[page++] ?? { sessions: [] }),
			logger: { info() {}, error() {}, warn() {} },
		});

		await notifier.pollSessionAttention();
		await notifier.pollSessionAttention();
		await notifier.pollSessionAttention();
		await notifier.pollSessionAttention();
		await notifier.pollSessionAttention();

		assert.equal(posts.filter((p) => /blocked/.test(p) && /<@U123>/.test(p)).length, 2);
	});

	it("posts the what-needs-me digest only when pending content changes", async () => {
		const stateFile = await tmpState();
		const posts = [];
		let payload = { sessions: [{ id: "a", projectId: "ao", activity: { state: "blocked" } }] };
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			postMessage: async (text) => posts.push(text),
			fetchImpl: async () => response(payload),
			clock: () => new Date("2026-07-10T00:00:00Z"),
			logger: { info() {}, error() {}, warn() {} },
		});

		await notifier.pollSessionAttention();
		await notifier.pollSessionAttention();
		payload = { sessions: [] };
		await notifier.pollSessionAttention();
		await notifier.pollSessionAttention();

		assert.equal(posts.filter((p) => /thing needs you|Nothing needs you/.test(p)).length, 2);
		assert.ok(posts.some((p) => /1 thing needs you/.test(p)));
		assert.ok(posts.some((p) => /Nothing needs you/.test(p)));
	});

	it("edits an existing digest in bot-token mode when content changes", async () => {
		const stateFile = await tmpState();
		const posts = [];
		const updates = [];
		let ts = 0;
		let payload = { sessions: [{ id: "a", projectId: "ao", activity: { state: "blocked" } }] };
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			postMessage: async (text) => {
				posts.push(text);
				return { ts: `m${++ts}` };
			},
			updateMessage: async (messageTs, text) => {
				updates.push({ ts: messageTs, text });
				return true;
			},
			fetchImpl: async () => response(payload),
			clock: () => new Date("2026-07-10T00:00:00Z"),
			logger: { info() {}, error() {}, warn() {} },
		});

		await notifier.pollSessionAttention();
		payload = { sessions: [] };
		await notifier.pollSessionAttention();
		await notifier.pollSessionAttention();

		const digestUpdates = updates.filter((u) => /Nothing needs you/.test(u.text));
		assert.equal(posts.filter((p) => /1 thing needs you/.test(p)).length, 1);
		assert.equal(digestUpdates.length, 1);
		assert.deepEqual(digestUpdates[0], {
			ts: "m2",
			text: "✅ *Nothing needs you* — all sessions healthy _(as of 2026-07-10T00:00:00Z)_",
		});
	});

	it("falls back to posting a fresh digest when updating the saved digest ts fails", async () => {
		const stateFile = await tmpState();
		const posts = [];
		let ts = 0;
		let payload = { sessions: [{ id: "a", projectId: "ao", activity: { state: "blocked" } }] };
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			postMessage: async (text) => {
				posts.push(text);
				return { ts: `m${++ts}` };
			},
			updateMessage: async () => {
				throw new Error("message_not_found");
			},
			fetchImpl: async () => response(payload),
			clock: () => new Date("2026-07-10T00:00:00Z"),
			logger: { info() {}, error() {}, warn() {} },
		});

		await notifier.pollSessionAttention();
		payload = { sessions: [] };
		await notifier.pollSessionAttention();
		await notifier.pollSessionAttention();

		assert.equal(posts.filter((p) => /Nothing needs you/.test(p)).length, 1);
		assert.equal(notifier.state.digestTs, "m3");
	});

	it("does not @mention stream-owned needs_input sessions from the poll path", async () => {
		const stateFile = await tmpState();
		const posts = [];
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			postMessage: async (text) => posts.push(text),
			fetchImpl: async () =>
				response({
					sessions: [{ id: "waiting", projectId: "ao", activity: { state: "waiting_input" }, status: "needs_input" }],
				}),
			logger: { info() {}, error() {}, warn() {} },
		});

		const result = await notifier.pollSessionAttention();

		assert.equal(result.alerted.length, 0);
		assert.equal(
			posts.some((p) => /<@U123>.*needs_input/.test(p)),
			false,
		);
		assert.ok(posts.some((p) => /1 thing needs you/.test(p)));
	});

	it("does not clear a needs_input-only digest on one transient empty session poll", async () => {
		const stateFile = await tmpState();
		const posts = [];
		const pages = [
			{
				sessions: [{ id: "waiting", projectId: "ao", activity: { state: "waiting_input" }, status: "needs_input" }],
			},
			{ sessions: [] },
			{
				sessions: [{ id: "waiting", projectId: "ao", activity: { state: "waiting_input" }, status: "needs_input" }],
			},
		];
		let page = 0;
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			postMessage: async (text) => posts.push(text),
			fetchImpl: async () => response(pages[page++] ?? pages.at(-1)),
			logger: { info() {}, error() {}, warn() {} },
		});

		await notifier.pollSessionAttention();
		await notifier.pollSessionAttention();
		await notifier.pollSessionAttention();

		assert.equal(posts.filter((p) => /1 thing needs you/.test(p)).length, 1);
		assert.equal(
			posts.some((p) => /Nothing needs you/.test(p)),
			false,
		);
	});

	it("keeps open attention signatures across save/load restart", async () => {
		const stateFile = await tmpState();
		const posts = [];
		const payload = { sessions: [{ id: "a", projectId: "ao", activity: { state: "blocked" } }] };
		const first = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			postMessage: async (text) => posts.push(text),
			fetchImpl: async () => response(payload),
			logger: { info() {}, error() {}, warn() {} },
		});
		await first.pollSessionAttention();
		const restarted = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			postMessage: async (text) => posts.push(text),
			fetchImpl: async () => response(payload),
			logger: { info() {}, error() {}, warn() {} },
		});

		await restarted.pollSessionAttention();

		assert.equal(posts.filter((p) => /<@U123>.*blocked/.test(p)).length, 1);
	});

	it("does not post an empty digest on cold start", async () => {
		const stateFile = await tmpState();
		const posts = [];
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			postMessage: async (text) => posts.push(text),
			fetchImpl: async () => response({ sessions: [] }),
			logger: { info() {}, error() {}, warn() {} },
		});

		await notifier.pollSessionAttention();

		assert.deepEqual(posts, []);
	});

	it("treats a malformed sessions payload as a poll error instead of an empty all-clear", async () => {
		const stateFile = await tmpState();
		const posts = [];
		let malformed = false;
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			postMessage: async (text) => posts.push(text),
			fetchImpl: async (url) => {
				assert.equal(url, "http://ao.test/api/v1/sessions?active=true");
				if (malformed) return response({ error: "unexpected shape" });
				return response({
					sessions: [
						{
							projectId: "ao",
							sessionId: "blocked-1",
							activity: { state: "blocked" },
							title: "blocked worker",
						},
					],
				});
			},
			logger: { info() {}, error() {}, warn() {} },
		});

		await notifier.pollSessionAttention();
		malformed = true;
		const result = await notifier.pollSessionAttention();

		assert.equal(result.error, true);
		assert.equal(notifier.consecutiveSessionPollErrors, 1);
		assert.equal(posts.filter((p) => /<@U123>.*blocked/.test(p)).length, 1);
		assert.equal(
			posts.some((p) => /Nothing needs you/.test(p)),
			false,
		);
	});

	it("pages daemon_unhealthy after repeated session poll failures", async () => {
		const stateFile = await tmpState();
		const posts = [];
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			postMessage: async (text) => posts.push(text),
			fetchImpl: async () => {
				throw new Error("ECONNREFUSED");
			},
			logger: { info() {}, error() {}, warn() {} },
		});

		await notifier.pollSessionAttention();
		await notifier.pollSessionAttention();
		await notifier.pollSessionAttention();
		await notifier.pollSessionAttention();

		assert.equal(posts.filter((p) => /daemon_unhealthy/.test(p)).length, 1);
		assert.match(posts[0], /<@U123>/);
	});

	it("pages each daemon_unhealthy probe once", async () => {
		const stateFile = await tmpState();
		const posts = [];
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			postMessage: async (text) => posts.push(text),
			fetchImpl: async () => {
				throw new Error("ECONNREFUSED");
			},
			logger: { info() {}, error() {}, warn() {} },
		});

		notifier.consecutiveErrors = 3;
		await notifier.alertUnhealthy("stream down");
		await notifier.pollSessionAttention();
		await notifier.pollSessionAttention();
		await notifier.pollSessionAttention();

		assert.equal(posts.filter((p) => /daemon_unhealthy/.test(p)).length, 2);
		assert.ok(posts[0].includes("cannot reach ao notifications"));
		assert.ok(posts[1].includes("cannot poll ao sessions"));
	});

	it("pages stream daemon_unhealthy when a session poll outage was already latched", async () => {
		const stateFile = await tmpState();
		const posts = [];
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			postMessage: async (text) => posts.push(text),
			fetchImpl: async () => {
				throw new Error("ECONNREFUSED");
			},
			logger: { info() {}, error() {}, warn() {} },
		});

		await notifier.pollSessionAttention();
		await notifier.pollSessionAttention();
		await notifier.pollSessionAttention();
		notifier.consecutiveErrors = 3;
		await notifier.alertUnhealthy("stream down");

		assert.equal(posts.filter((p) => /daemon_unhealthy/.test(p)).length, 2);
		assert.ok(posts[0].includes("cannot poll ao sessions"));
		assert.ok(posts[1].includes("cannot reach ao notifications"));
	});

	it("does not re-arm stream daemon_unhealthy paging after a successful session poll", async () => {
		const stateFile = await tmpState();
		const posts = [];
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			postMessage: async (text) => posts.push(text),
			fetchImpl: async (url) => {
				assert.equal(url, "http://ao.test/api/v1/sessions?active=true");
				return response({ sessions: [] });
			},
			logger: { info() {}, error() {}, warn() {} },
		});

		notifier.consecutiveErrors = 3;
		await notifier.alertUnhealthy("stream down");
		await notifier.pollSessionAttention();
		notifier.consecutiveErrors = 4;
		await notifier.alertUnhealthy("stream still down");

		assert.equal(posts.filter((p) => /daemon_unhealthy/.test(p)).length, 1);
	});

	it("allows a session daemon_unhealthy page after a stream page resolves while sessions stay broken", async () => {
		const stateFile = await tmpState();
		const posts = [];
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			postMessage: async (text) => posts.push(text),
			fetchImpl: async () => {
				throw new Error("ECONNREFUSED");
			},
			logger: { info() {}, error() {}, warn() {} },
		});

		notifier.consecutiveErrors = 3;
		await notifier.alertUnhealthy("stream down");
		await notifier.pollSessionAttention();
		await notifier.pollSessionAttention();
		await notifier.pollSessionAttention();
		notifier.streamUnhealthyPaged = false;
		await notifier.pollSessionAttention();

		assert.equal(posts.filter((p) => /daemon_unhealthy/.test(p)).length, 2);
		assert.ok(posts.at(-1).includes("cannot poll ao sessions"));
	});

	it("retries daemon_unhealthy after Slack delivery fails on the third poll error", async () => {
		const stateFile = await tmpState();
		const posts = [];
		let fail = true;
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			postMessage: async (text) => {
				if (fail) throw new Error("slack 503");
				posts.push(text);
			},
			fetchImpl: async () => {
				throw new Error("ECONNREFUSED");
			},
			logger: { info() {}, error() {}, warn() {} },
		});

		await notifier.pollSessionAttention();
		await notifier.pollSessionAttention();
		await notifier.pollSessionAttention();
		fail = false;
		await notifier.pollSessionAttention();

		assert.equal(posts.filter((p) => /daemon_unhealthy/.test(p)).length, 1);
	});

	it("stops the session attention loop promptly when aborted during poll sleep", async () => {
		const stateFile = await tmpState();
		const controller = new AbortController();
		let polls = 0;
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			sessionPollMs: 10_000,
			postMessage: async () => {},
			fetchImpl: async () => {
				polls += 1;
				controller.abort();
				return response({ sessions: [] });
			},
			logger: { info() {}, error() {}, warn() {} },
		});

		const result = await Promise.race([
			notifier.runSessionAttention({ signal: controller.signal }).then(() => "stopped"),
			new Promise((resolve) => setTimeout(() => resolve("timed out"), 100)),
		]);

		assert.equal(result, "stopped");
		assert.equal(polls, 1);
	});

	it("uses a stable digest key that ignores record order", () => {
		const a = { projectId: "ao", sessionId: "a", kind: "blocked", title: "blocked", attention: true };
		const b = { projectId: "ao", sessionId: "b", kind: "no_signal", title: "silent", attention: true };
		assert.equal(digestContentKey([a, b]), digestContentKey([b, a]));
	});

	it("changes the digest key when a pending record gains a URL", () => {
		const base = { projectId: "ao", sessionId: "a", kind: "blocked", title: "blocked", attention: true };
		assert.notEqual(digestContentKey([base]), digestContentKey([{ ...base, url: "https://github.example/pr/1" }]));
	});

	it("normalizes invalid direct session poll intervals to the default", () => {
		assert.equal(parsePollMs(Number.NaN, 10_000), 10_000);
	});

	it("clamps too-small direct session poll intervals and treats zero as disabled", () => {
		assert.equal(parsePollMs(10, 10_000), 1_000);
		assert.equal(parsePollMs(0, 10_000), 0);
		assert.equal(parsePollMs(-1, 10_000), 10_000);
	});
});

describe("ao Slack notifier content cooldown dedupe (issue #190)", () => {
	function stubFetch(pagesRef, marked) {
		return async (url, init = {}) => {
			if (init.method === "PATCH") {
				marked.push(url.split("/").at(-1));
				return response({});
			}
			return response({ notifications: pagesRef.next.shift() ?? [] });
		};
	}

	it("computes a content signature that ignores id and createdAt", () => {
		const a = contentSignature({
			id: "ntf_1",
			type: "ready_to_merge",
			sessionId: "s",
			projectId: "ao",
			prUrl: "https://gh/pr/1",
			createdAt: "2026-07-10T00:00:00Z",
		});
		const b = contentSignature({
			id: "ntf_2",
			type: "ready_to_merge",
			sessionId: "s",
			projectId: "ao",
			prUrl: "https://gh/pr/1",
			createdAt: "2026-07-10T05:00:00Z",
		});
		assert.equal(a, b);
	});

	it("suppresses a duplicate-content notification within the cooldown but still marks it read", async () => {
		const stateFile = await tmpState();
		const posts = [];
		const marked = [];
		const pagesRef = { next: [] };
		let now = 1_000_000;
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			dedupeCooldownMs: 60 * 60 * 1000,
			clock: () => new Date(now),
			postMessage: async (text) => posts.push(text),
			fetchImpl: stubFetch(pagesRef, marked),
			logger: { info() {}, error() {} },
			bootstrapMode: "post_all",
		});

		const first = {
			id: "ntf_1",
			type: "ready_to_merge",
			sessionId: "s",
			projectId: "ao",
			title: "PR #7 ready",
			prUrl: "https://gh/pr/7",
			createdAt: "2026-07-10T00:00:00Z",
		};
		const dup = { ...first, id: "ntf_2", createdAt: "2026-07-10T00:10:00Z" };

		assert.equal(await notifier.handleNotification(first), true);
		now += 10 * 60 * 1000; // 10 min later, within the 60-min cooldown
		await notifier.handleNotification(dup);

		assert.equal(posts.length, 1, "only the first content post reaches Slack");
		assert.deepEqual(marked, ["ntf_1", "ntf_2"], "both rows are still marked read");
	});

	it("re-posts after the cooldown elapses", async () => {
		const stateFile = await tmpState();
		const posts = [];
		const marked = [];
		const pagesRef = { next: [] };
		let now = 1_000_000;
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			dedupeCooldownMs: 60 * 60 * 1000,
			clock: () => new Date(now),
			postMessage: async (text) => posts.push(text),
			fetchImpl: stubFetch(pagesRef, marked),
			logger: { info() {}, error() {} },
			bootstrapMode: "post_all",
		});

		const base = {
			type: "ready_to_merge",
			sessionId: "s",
			projectId: "ao",
			title: "PR #7 ready",
			prUrl: "https://gh/pr/7",
		};
		await notifier.handleNotification({ ...base, id: "ntf_1" });
		now += 61 * 60 * 1000; // past the cooldown
		await notifier.handleNotification({ ...base, id: "ntf_2" });

		assert.equal(posts.length, 2, "a post after the cooldown fires again");
	});

	it("persists posted signatures across a restart", async () => {
		const stateFile = await tmpState();
		const posts = [];
		const marked = [];
		let now = 1_000_000;
		const first = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			dedupeCooldownMs: 60 * 60 * 1000,
			clock: () => new Date(now),
			postMessage: async (text) => posts.push(text),
			fetchImpl: stubFetch({ next: [] }, marked),
			logger: { info() {}, error() {} },
			bootstrapMode: "post_all",
		});
		const base = { type: "pr_merged", sessionId: "s", projectId: "ao", title: "merged", prUrl: "https://gh/pr/9" };
		await first.handleNotification({ ...base, id: "ntf_1" });
		assert.equal(posts.length, 1);

		// Restart: a fresh notifier loads the persisted signatures and suppresses
		// the re-derived identical notification within the cooldown.
		const restarted = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			dedupeCooldownMs: 60 * 60 * 1000,
			clock: () => new Date(now + 5 * 60 * 1000),
			postMessage: async (text) => posts.push(text),
			fetchImpl: stubFetch({ next: [] }, marked),
			logger: { info() {}, error() {} },
			bootstrapMode: "post_all",
		});
		await restarted.handleNotification({ ...base, id: "ntf_2" });
		assert.equal(posts.length, 1, "restart does not re-post the same content within cooldown");
	});

	it("disables the cooldown when set to 0", async () => {
		const stateFile = await tmpState();
		const posts = [];
		const marked = [];
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			dedupeCooldownMs: 0,
			postMessage: async (text) => posts.push(text),
			fetchImpl: stubFetch({ next: [] }, marked),
			logger: { info() {}, error() {} },
			bootstrapMode: "post_all",
		});
		const base = { type: "ready_to_merge", sessionId: "s", projectId: "ao", title: "ready", prUrl: "https://gh/pr/1" };
		await notifier.handleNotification({ ...base, id: "ntf_1" });
		await notifier.handleNotification({ ...base, id: "ntf_2" });
		assert.equal(posts.length, 2, "cooldown disabled posts every distinct row");
	});
});

describe("ao Slack notifier head-SHA aware cooldown (issue #190)", () => {
	function stubFetch(marked) {
		return async (url, init = {}) => {
			if (init.method === "PATCH") {
				marked.push(url.split("/").at(-1));
				return response({});
			}
			return response({ notifications: [] });
		};
	}

	it("includes the head SHA in the content signature", () => {
		const a = contentSignature({
			type: "ready_to_merge",
			sessionId: "s",
			projectId: "ao",
			prUrl: "https://gh/pr/1",
			headSha: "sha-1",
		});
		const b = contentSignature({
			type: "ready_to_merge",
			sessionId: "s",
			projectId: "ao",
			prUrl: "https://gh/pr/1",
			headSha: "sha-2",
		});
		assert.notEqual(a, b);
	});

	it("uses typed subject identity when sessionId is empty", () => {
		const base = {
			type: "main_ci_red",
			sessionId: "",
			projectId: "ao",
			title: "main is red",
			subject: { kind: "project", id: "ao" },
			headSha: "sha-1",
		};
		assert.equal(contentSignature(base), contentSignature({ ...base, id: "ntf_2" }));
		assert.notEqual(contentSignature(base), contentSignature({ ...base, subject: { kind: "project", id: "other" } }));
	});

	it("re-posts a ready_to_merge for a new head within the cooldown", async () => {
		const stateFile = await tmpState();
		const posts = [];
		const marked = [];
		let now = 1_000_000;
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			dedupeCooldownMs: 60 * 60 * 1000,
			clock: () => new Date(now),
			postMessage: async (text) => posts.push(text),
			fetchImpl: stubFetch(marked),
			logger: { info() {}, error() {} },
			bootstrapMode: "post_all",
		});
		const base = { type: "ready_to_merge", sessionId: "s", projectId: "ao", title: "ready", prUrl: "https://gh/pr/1" };
		await notifier.handleNotification({ ...base, id: "ntf_1", headSha: "sha-1" });
		now += 5 * 60 * 1000; // within cooldown
		await notifier.handleNotification({ ...base, id: "ntf_2", headSha: "sha-2" }); // new head

		assert.equal(posts.length, 2, "a new head re-notifies even inside the cooldown");
	});
});

describe("ao Slack notifier main module invocation", () => {
	it("connects to the notification stream when invoked through the release current symlink", async () => {
		const daemon = await listen(
			http.createServer((request, response) => {
				if (request.url?.startsWith("/api/v1/notifications?")) {
					response.setHeader("Content-Type", "application/json");
					response.end(JSON.stringify({ notifications: [] }));
					return;
				}
				if (request.url === "/api/v1/notifications/stream") {
					response.writeHead(200, {
						"Content-Type": "text/event-stream",
						"Cache-Control": "no-cache",
						Connection: "keep-alive",
					});
					response.write(": connected\n\n");
					return;
				}
				response.writeHead(404);
				response.end("not found");
			}),
			cleanup,
		);
		const script = await releaseSymlinkScript({
			cleanup,
			prefix: "ao-slack-release-",
			repoRoot: REPO_ROOT,
			script: "ops/ao-slack-notifier.mjs",
		});

		for (const nodeArgs of [[], ["--preserve-symlinks-main"]]) {
			const stateFile = await tmpState();
			const { child, output } = spawnNode([...nodeArgs, script], {
				cleanup,
				env: childEnv(
					{
						AO_AGENT_HEALTH_POLL_MS: "0",
						AO_ENV_FILE: await emptyEnvPath(cleanup, "ao-slack-notifier-env-"),
						AO_MAIN_CI_POLL_MS: "0",
						AO_PORT: String(daemon.port),
						AO_SESSION_ATTENTION_POLL_MS: "0",
						AO_SLACK_NOTIFIER_STATE: stateFile,
						SLACK_WEBHOOK_URL: "http://127.0.0.1:9/slack",
					},
					{ stripPrefixes: ["AO_", "POLYPOWERS_", "SLACK_"] },
				),
			});

			await waitForOutput({ child, output, pattern: /connected to ao notification stream/ });
			assert.equal(child.exitCode, null);
		}
	});
});
