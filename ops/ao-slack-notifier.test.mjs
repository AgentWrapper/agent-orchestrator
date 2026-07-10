import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
	SlackNotificationNotifier,
	describeSlackMessage,
	digestContentKey,
	loadState,
	notificationKey,
	parsePollMs,
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

		assert.equal(posts.filter((p) => /1 thing needs you/.test(p)).length, 1);
		assert.equal(updates.length, 1);
		assert.deepEqual(updates[0], {
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
