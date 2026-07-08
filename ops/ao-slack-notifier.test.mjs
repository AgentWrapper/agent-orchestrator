import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
	SlackNotificationNotifier,
	describeSlackMessage,
	loadState,
	notificationKey,
	parseSSEFrames,
	saveState,
} from "./ao-slack-notifier.mjs";

let cleanup = [];
afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((f) => f()));
});

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

describe("ao Slack notifier replay/dedup", () => {
	it("uses stable notification ids as the dedup cursor", () => {
		assert.equal(notificationKey({ id: "ntf_1", type: "needs_input" }), "ntf_1");
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
