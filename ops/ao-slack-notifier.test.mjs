import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import http from "node:http";
import { readdirSync, readFileSync, statSync } from "node:fs";
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
import { handleSlackRequest } from "./attention-reply-listener.mjs";
import { loadNotifierThreadMap } from "./notifier-thread-state.mjs";

// Slack signs every inbound request; the listener verifies it before routing, so
// the post->reply integration tests have to sign like Slack does.
const SIGNING_SECRET = "test-signing-secret";

function signedSlackRequest(payload) {
	const rawBody = JSON.stringify(payload);
	const timestamp = String(Math.floor(Date.now() / 1000));
	const signature = `v0=${createHmac("sha256", SIGNING_SECRET).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
	return {
		rawBody,
		headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": signature },
	};
}

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

// operatorResponse builds a GET /attention/operator response body: the single
// canonical projection the daemon owns (issue #268/#313). `items` is a list of
// ItemDTOs (id, kind, projectId, sessionId, sessionTitle, reason, deepLink,
// prUrl, ...); the notifier no longer classifies /sessions or notification rows.
function operatorResponse(items = []) {
	return response({ items });
}

describe("ao Slack notifier informational message rendering", () => {
	// describeSlackMessage now renders ONLY the informational notification set
	// (pr_merged, pr_closed_unmerged, orchestrator_replaced, model_unreachable,
	// model_recovered) as PLAIN posts. It takes ONE arg and NEVER @mentions —
	// every attention condition is delivered by the projection poll.
	it("renders pr_merged as a plain post", () => {
		const msg = describeSlackMessage({
			type: "pr_merged",
			sessionId: "agent-4",
			projectId: "ao",
			title: "Merged after parked review",
		});
		assert.equal(msg, "🚀 *pr_merged* [ao] agent-4: Merged after parked review");
	});

	it("renders pr_closed_unmerged as a plain post", () => {
		const msg = describeSlackMessage({
			type: "pr_closed_unmerged",
			sessionId: "agent-9",
			projectId: "ao",
			title: "PR #3 closed unmerged",
			prUrl: "https://github.example/pr/3",
		});
		assert.equal(msg, "🗑️ *pr_closed_unmerged* [ao] agent-9: PR #3 closed unmerged https://github.example/pr/3");
	});

	it("renders orchestrator_replaced as a plain post", () => {
		const msg = describeSlackMessage({
			type: "orchestrator_replaced",
			sessionId: "mer-orch-2",
			projectId: "mer",
			title: "mer orchestrator was replaced",
		});
		assert.equal(msg, "🔁 *orchestrator_replaced* [mer] mer-orch-2: mer orchestrator was replaced");
	});

	it("renders model subjects when sessionId is empty", () => {
		const msg = describeSlackMessage({
			type: "model_unreachable",
			sessionId: "",
			projectId: "ao",
			subject: { kind: "model", id: "ao-workerMix-0-model-codex" },
			title: "gpt-5 model unreachable",
		});
		assert.equal(msg, "🧠 *model_unreachable* [ao] ao-workerMix-0-model-codex: gpt-5 model unreachable");
	});

	it("never @mentions even when a legacy member id is passed as a second arg", () => {
		const msg = describeSlackMessage({ type: "pr_merged", sessionId: "a", projectId: "ao", title: "merged" }, "U123");
		assert.ok(!msg.includes("<@"), `informational posts must never @mention, got: ${msg}`);
		assert.equal(msg, "🚀 *pr_merged* [ao] a: merged");
	});

	it("returns null for every non-informational (projection-owned) notification type", () => {
		// These conditions now surface through the daemon projection, never this
		// notification path, so describeSlackMessage refuses to render them and they
		// can never be double-posted or (wrongly) @mentioned from the stream.
		for (const type of [
			"needs_input",
			"ready_to_merge",
			"main_ci_red",
			"duplicate_pr",
			"worker_died_unfinished",
			"orchestrator_replacement_capped",
			"blocked",
			"no_signal",
		]) {
			assert.equal(
				describeSlackMessage({ type, sessionId: "a", projectId: "ao", title: "x" }),
				null,
				`${type} must not render through describeSlackMessage`,
			);
		}
	});

	it("accepts the SSE envelope shape for informational notifications", () => {
		const msg = describeSlackMessage({
			type: "notification_created",
			notification: {
				id: "n2",
				type: "pr_merged",
				sessionId: "agent-1",
				projectId: "ao",
				title: "merged",
			},
		});
		assert.equal(msg, "🚀 *pr_merged* [ao] agent-1: merged");
	});

	it("ignores raw CDC events that are not typed notifications", () => {
		const msg = describeSlackMessage({ type: "session_updated", payload: { sessionId: "a" } });
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
		// Main-branch CI health is the ONE operator-attention condition the daemon
		// does not compute into a notification, so pollOperatorAttention folds the
		// local mainCISource probe in. main_ci_red is in MENTION_KINDS, so it earns a
		// resolvable @mention plus a digest line even though the projection is empty.
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
				assert.match(String(url), /\/attention\/operator$/);
				return operatorResponse([]);
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

		const result = await notifier.pollOperatorAttention();

		assert.equal(result.alerted.length, 1);
		assert.match(posts[0], /<@U123> 🚨 \*main_ci_red\*/);
		assert(
			posts.some((p) => /main is red at fee462ed: go, cli-e2e/.test(p) && /thing needs you/.test(p)),
			posts,
		);
	});

	it("caches main CI polling separately from the operator-attention cadence", async () => {
		let mainPolls = 0;
		let now = 1_000;
		const notifier = new SlackNotificationNotifier({
			stateFile: await tmpState(),
			mentionUserId: "U123",
			postMessage: async () => ({ ts: "ts" }),
			updateMessage: async () => true,
			fetchImpl: async () => operatorResponse([]),
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

		await notifier.pollOperatorAttention();
		now += 10_000;
		await notifier.pollOperatorAttention();
		now += 60_000;
		await notifier.pollOperatorAttention();

		assert.equal(mainPolls, 2);
	});
});

describe("ao Slack notifier replay/dedup", () => {
	it("uses stable notification ids as the dedup cursor", () => {
		assert.equal(notificationKey({ id: "ntf_1", type: "pr_merged" }), "ntf_1");
	});

	it("catch-up posts unread informational notifications once and never PATCHes them read", async () => {
		const stateFile = await tmpState();
		const posts = [];
		const patched = [];
		let listed = false;
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			bootstrapMode: "post_all",
			postMessage: async (text) => posts.push(text),
			fetchImpl: async (url, init = {}) => {
				if (init.method === "PATCH") {
					patched.push(url.split("/").at(-1));
					return response({});
				}
				assert.match(url, /\/notifications\?status=unread&limit=100$/);
				if (listed) return response({ notifications: [] });
				listed = true;
				return response({
					notifications: [
						{
							id: "ntf_1",
							type: "pr_merged",
							sessionId: "a",
							projectId: "ao",
							title: "merged",
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
		assert.equal(posts[0], "🚀 *pr_merged* [ao] a: merged");
		assert.ok(!posts[0].includes("<@"), "informational catch-up posts never @mention");
		assert.ok(loadState(stateFile).seen.has("ntf_1"));
		assert.deepEqual(patched, [], "delivery must not PATCH the notification read (read != delivery)");
	});

	it("drains multiple unread pages via the (createdAt, id) cursor, delivering each informational notification", async () => {
		const stateFile = await tmpState();
		const posts = [];
		const patched = [];
		const listURLs = [];
		// Newest-first, as the daemon returns them. Delivery never marks rows
		// read, so page 2 MUST be requested with the cursor of page 1's last row —
		// a plain re-fetch would return the same newest rows forever.
		const rows = [
			{
				id: "ntf_3",
				type: "orchestrator_replaced",
				sessionId: "c",
				projectId: "ao",
				title: "third",
				createdAt: "2026-07-07T00:03:00Z",
			},
			{
				id: "ntf_2",
				type: "pr_closed_unmerged",
				sessionId: "b",
				projectId: "ao",
				title: "second",
				prUrl: "https://gh/pr/2",
				createdAt: "2026-07-07T00:02:00Z",
			},
			{
				id: "ntf_1",
				type: "pr_merged",
				sessionId: "a",
				projectId: "ao",
				title: "first",
				prUrl: "https://gh/pr/1",
				createdAt: "2026-07-07T00:01:00Z",
			},
		];
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			pageLimit: 2,
			mentionUserId: "U123",
			bootstrapMode: "post_all",
			postMessage: async (text) => posts.push(text),
			fetchImpl: async (url, init = {}) => {
				if (init.method === "PATCH") {
					patched.push(url.split("/").at(-1));
					return response({});
				}
				listURLs.push(String(url));
				const u = new URL(String(url));
				const before = u.searchParams.get("before");
				const beforeId = u.searchParams.get("beforeId");
				const remaining = rows.filter((r) => {
					if (!before) return true;
					if (r.createdAt !== before) return r.createdAt < before;
					return beforeId ? r.id < beforeId : false;
				});
				return response({ notifications: remaining.slice(0, 2) });
			},
			logger: { info() {}, error() {}, warn() {} },
		});

		await notifier.catchUpUnread();

		assert.equal(posts.length, 3);
		// Chronological delivery: oldest first.
		assert.match(posts[0], /first/);
		assert.match(posts[2], /third/);
		assert.equal(listURLs.length, 2);
		assert.doesNotMatch(listURLs[0], /before=/);
		assert.match(listURLs[1], /before=2026-07-07T00%3A02%3A00Z/);
		assert.match(listURLs[1], /beforeId=ntf_2/);
		assert.deepEqual(patched, [], "delivery never PATCHes notifications read");
		const saved = loadState(stateFile);
		assert.ok(saved.seen.has("ntf_1"));
		assert.ok(saved.seen.has("ntf_2"));
		assert.ok(saved.seen.has("ntf_3"));
		// The durable high-water mark is the newest processed row.
		assert.deepEqual(saved.catchUpCursor, { createdAt: "2026-07-07T00:03:00.000Z", id: "ntf_3" });
	});

	it("a later catch-up stops at the persisted high-water mark instead of re-walking (or re-posting) old rows", async () => {
		const stateFile = await tmpState();
		const posts = [];
		const oldRow = {
			id: "ntf_old",
			type: "pr_merged",
			sessionId: "a",
			projectId: "ao",
			title: "old",
			createdAt: "2026-07-07T00:01:00Z",
		};
		const newRow = {
			id: "ntf_new",
			type: "pr_merged",
			sessionId: "b",
			projectId: "ao",
			title: "new",
			createdAt: "2026-07-07T00:05:00Z",
		};
		const state = loadState(stateFile);
		state.initialized = true;
		// The old row was processed by a previous run whose seen-set has since been
		// pruned — only the durable cursor remembers it.
		state.catchUpCursor = { createdAt: oldRow.createdAt, id: oldRow.id };
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state,
			mentionUserId: "U123",
			postMessage: async (text) => posts.push(text),
			fetchImpl: async () => response({ notifications: [newRow, oldRow] }),
			logger: { info() {}, error() {}, warn() {} },
		});

		await notifier.catchUpUnread();

		assert.equal(posts.length, 1, posts);
		assert.match(posts[0], /new/);
		assert.deepEqual(loadState(stateFile).catchUpCursor, { createdAt: "2026-07-07T00:05:00.000Z", id: newRow.id });
	});

	it("seeds a missing cursor at the newest row without replaying history", async () => {
		// An initialized state whose cursor is missing/corrupt (v1 migration, bad
		// state file) must NEVER replay full history — rows evicted from the
		// bounded seen-set would re-post. It seeds the high-water mark instead.
		const stateFile = await tmpState();
		const posts = [];
		let calls = 0;
		const state = loadState(stateFile);
		state.initialized = true;
		assert.equal(state.catchUpCursor, null);
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state,
			mentionUserId: "U123",
			postMessage: async (text) => posts.push(text),
			fetchImpl: async () => {
				calls += 1;
				return response({
					notifications: [
						{
							id: "ntf_new",
							type: "pr_merged",
							sessionId: "a",
							projectId: "ao",
							title: "evicted-from-seen history",
							createdAt: "2026-07-07T00:09:00Z",
						},
						{
							id: "ntf_old",
							type: "pr_merged",
							sessionId: "b",
							projectId: "ao",
							title: "older history",
							createdAt: "2026-07-07T00:01:00Z",
						},
					],
				});
			},
			logger: { info() {}, error() {}, warn() {} },
		});

		const sent = await notifier.catchUpUnread();

		assert.deepEqual(sent, []);
		assert.deepEqual(posts, [], "seeding must not post historical rows");
		assert.equal(calls, 1, "seeding fetches a single page");
		assert.deepEqual(loadState(stateFile).catchUpCursor, { createdAt: "2026-07-07T00:09:00.000Z", id: "ntf_new" });
	});

	it("treats an offset-equivalent persisted cursor as the same instant (no replay, no suppression)", async () => {
		// The persisted high-water mark is parsed as RFC 3339 and compared as an
		// INSTANT: a legacy/foreign cursor written at +02:00 must behave exactly
		// like its UTC equivalent. Lexical comparison would read every Z-form row
		// below "2026-07-07T02:00:00+02:00" as history and suppress it.
		const stateFile = await tmpState();
		const posts = [];
		await writeFile(
			stateFile,
			JSON.stringify({
				version: 2,
				initialized: true,
				// Same instant as 2026-07-07T00:00:00Z.
				catchUpCursor: { createdAt: "2026-07-07T02:00:00+02:00", id: "ntf_0" },
			}),
			"utf8",
		);
		const state = loadState(stateFile);
		assert.equal(state.catchUpCursor.createdAt, "2026-07-07T00:00:00.000Z", "cursor normalized to UTC on load");
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state,
			mentionUserId: "U123",
			postMessage: async (text) => {
				posts.push(text);
				return { ts: `t${posts.length}` };
			},
			fetchImpl: async () =>
				response({
					notifications: [
						{
							id: "ntf_after",
							type: "pr_merged",
							sessionId: "a",
							projectId: "ao",
							title: "after cursor",
							createdAt: "2026-07-07T00:30:00Z",
						},
						{
							id: "ntf_before",
							type: "pr_merged",
							sessionId: "b",
							projectId: "ao",
							title: "before cursor",
							createdAt: "2026-07-06T23:00:00Z",
						},
					],
				}),
			logger: { info() {}, error() {}, warn() {} },
		});

		await notifier.catchUpUnread();

		assert.equal(
			posts.filter((p) => /after cursor/.test(p)).length,
			1,
			`newer row must post: ${JSON.stringify(posts)}`,
		);
		assert.equal(posts.filter((p) => /before cursor/.test(p)).length, 0, "older row is history");
	});

	it("drops a malformed persisted cursor instead of trusting garbage", async () => {
		const stateFile = await tmpState();
		await writeFile(
			stateFile,
			JSON.stringify({ version: 2, initialized: true, catchUpCursor: { createdAt: "not-a-time", id: "x" } }),
			"utf8",
		);
		assert.equal(loadState(stateFile).catchUpCursor, null);
	});

	it("drops a lenient-but-not-RFC3339 cursor (date-only) to the seeding path — no replay", async () => {
		// Date.parse would happily "repair" a date-only or timezone-less string
		// into some instant; the contract is strict RFC 3339 (full date-time with
		// Z or offset) or DROP — a dropped cursor seeds, it never replays.
		const stateFile = await tmpState();
		await writeFile(
			stateFile,
			JSON.stringify({ version: 2, initialized: true, catchUpCursor: { createdAt: "2026-07-07", id: "ntf_0" } }),
			"utf8",
		);
		const state = loadState(stateFile);
		assert.equal(state.catchUpCursor, null, "date-only cursor must be dropped, not normalized");

		// The next catch-up therefore SEEDS at the newest row without posting the
		// historical backlog.
		const posts = [];
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state,
			mentionUserId: "U123",
			postMessage: async (text) => {
				posts.push(text);
				return { ts: `t${posts.length}` };
			},
			fetchImpl: async () =>
				response({
					notifications: [
						{
							id: "ntf_hist",
							type: "pr_merged",
							sessionId: "a",
							projectId: "ao",
							title: "history",
							createdAt: "2026-07-07T00:05:00Z",
						},
					],
				}),
			logger: { info() {}, error() {}, warn() {} },
		});

		await notifier.catchUpUnread();

		assert.deepEqual(posts, [], "seeding must not replay history");
		assert.deepEqual(loadState(stateFile).catchUpCursor, { createdAt: "2026-07-07T00:05:00.000Z", id: "ntf_hist" });
	});

	it("seeding on an EMPTY unread snapshot persists an epoch marker so the first future row still posts", async () => {
		// Persisting nothing would make the next catch-up seed AGAIN and silently
		// swallow whatever row arrived in between.
		const stateFile = await tmpState();
		const posts = [];
		let rows = [];
		const state = loadState(stateFile);
		state.initialized = true;
		assert.equal(state.catchUpCursor, null);
		const make = (st) =>
			new SlackNotificationNotifier({
				baseUrl: "http://ao.test/api/v1",
				stateFile,
				state: st,
				mentionUserId: "U123",
				postMessage: async (text) => {
					posts.push(text);
					return { ts: `t${posts.length}` };
				},
				fetchImpl: async () => response({ notifications: rows }),
				logger: { info() {}, error() {}, warn() {} },
			});

		await make(state).catchUpUnread();
		const seeded = loadState(stateFile).catchUpCursor;
		assert.ok(seeded, "empty snapshot must still persist a high-water marker");
		assert.equal(seeded.createdAt, new Date(0).toISOString());

		// A row that arrives later is genuinely new — it must POST, not seed away.
		rows = [
			{
				id: "ntf_first",
				type: "pr_merged",
				sessionId: "a",
				projectId: "ao",
				title: "first ever",
				createdAt: "2026-07-07T00:01:00Z",
			},
		];
		await make(loadState(stateFile)).catchUpUnread();
		assert.equal(posts.filter((p) => /first ever/.test(p)).length, 1, JSON.stringify(posts));
	});

	it("persists cursor progress incrementally so a crash mid-drain does not replay early rows", async () => {
		// The cursor advances as each row completes and is persisted by the next
		// row's delivery-ledger write, so an interrupted drain resumes near the
		// failure point; the one-row persistence lag is absorbed by the seen-set.
		const stateFile = await tmpState();
		const posts = [];
		const rows = [
			{
				id: "ntf_1",
				type: "pr_merged",
				sessionId: "a",
				projectId: "ao",
				title: "one",
				createdAt: "2026-07-07T00:01:00Z",
			},
			{
				id: "ntf_2",
				type: "pr_merged",
				sessionId: "b",
				projectId: "ao",
				title: "two",
				createdAt: "2026-07-07T00:02:00Z",
			},
			{
				id: "ntf_3",
				type: "pr_merged",
				sessionId: "c",
				projectId: "ao",
				title: "three",
				createdAt: "2026-07-07T00:03:00Z",
			},
		];
		const state = loadState(stateFile);
		state.initialized = true;
		state.catchUpCursor = { createdAt: "2026-07-07T00:00:00Z", id: "ntf_0" };
		let failOnThird = true;
		const make = (st) =>
			new SlackNotificationNotifier({
				baseUrl: "http://ao.test/api/v1",
				stateFile,
				state: st,
				mentionUserId: "U123",
				postMessage: async (text) => {
					if (failOnThird && /three/.test(text)) throw new Error("slack down");
					posts.push(text);
					return { ts: `t${posts.length}` };
				},
				fetchImpl: async () => response({ notifications: [...rows].reverse() }),
				logger: { info() {}, error() {}, warn() {} },
			});

		await assert.rejects(() => make(state).catchUpUnread(), /slack down/);

		// Progress persisted before the drain completed: cursor is past row 1.
		const persisted = loadState(stateFile);
		assert.ok(persisted.catchUpCursor, "cursor persisted mid-drain");
		assert.ok(
			Date.parse(persisted.catchUpCursor.createdAt) >= Date.parse("2026-07-07T00:01:00Z"),
			JSON.stringify(persisted.catchUpCursor),
		);
		assert.ok(persisted.seen.has("ntf_1"));
		assert.ok(persisted.seen.has("ntf_2"));

		// The retry delivers only the failed row — rows 1-2 do not repost.
		failOnThird = false;
		await make(loadState(stateFile)).catchUpUnread();
		assert.deepEqual(
			posts.filter((p) => /one|two/.test(p)).length,
			2,
			`rows 1-2 posted exactly once: ${JSON.stringify(posts)}`,
		);
		assert.equal(posts.filter((p) => /three/.test(p)).length, 1);
	});

	it("stops after one page when the daemon ignores the cursor params instead of looping forever", async () => {
		const stateFile = await tmpState();
		const warns = [];
		let calls = 0;
		const fullPage = [
			{
				id: "ntf_b",
				type: "pr_merged",
				sessionId: "b",
				projectId: "ao",
				title: "b",
				createdAt: "2026-07-07T00:02:00Z",
			},
			{
				id: "ntf_a",
				type: "pr_merged",
				sessionId: "a",
				projectId: "ao",
				title: "a",
				createdAt: "2026-07-07T00:01:00Z",
			},
		];
		const state = loadState(stateFile);
		state.initialized = true;
		// A real cursor older than every row, so the walk paginates (a MISSING
		// cursor would seed instead — see the null-cursor seeding test).
		state.catchUpCursor = { createdAt: "2026-07-06T00:00:00Z", id: "ntf_0" };
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state,
			pageLimit: 2,
			postMessage: async () => ({ ts: "1" }),
			fetchImpl: async () => {
				calls += 1;
				return response({ notifications: fullPage });
			},
			logger: { info() {}, error() {}, warn: (m) => warns.push(m) },
		});

		await notifier.catchUpUnread();

		assert.equal(calls, 2, "one page plus one detected-repeat page");
		assert.ok(
			warns.some((w) => /ignored the notifications cursor/.test(w)),
			warns,
		);
	});

	it("first bootstrap seeds old informational notifications without posting them", async () => {
		const stateFile = await tmpState();
		const posts = [];
		const patched = [];
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			postMessage: async (text) => posts.push(text),
			fetchImpl: async (url, init = {}) => {
				if (init.method === "PATCH") {
					patched.push(url.split("/").at(-1));
					return response({});
				}
				return response({
					notifications: [
						{ id: "old_merge", type: "pr_merged", sessionId: "a", projectId: "ao", title: "merged" },
						{ id: "old_closed", type: "pr_closed_unmerged", sessionId: "b", projectId: "ao", title: "closed" },
					],
				});
			},
			logger: { info() {}, error() {} },
		});

		await notifier.catchUpUnread();

		assert.equal(posts.length, 0, "a first-boot backlog of informational rows is seeded, not re-posted");
		const saved = loadState(stateFile);
		assert.ok(saved.seen.has("old_merge"));
		assert.ok(saved.seen.has("old_closed"));
		assert.equal(saved.initialized, true);
		assert.deepEqual(patched, [], "seeding never PATCHes notifications read");
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

	// --- 1g (#293, codex review of #309): saveState used writeFileSync straight
	// onto the live state file. That truncates in place, so a crash mid-write
	// discards EVERY thread binding, seen id and needs-response record at once —
	// the notifier then re-pages history and can never route a threaded reply
	// again. The write must be atomic: temp file + rename.
	it("persists state atomically so a crash mid-write cannot truncate the state file", async () => {
		const stateFile = await tmpState();
		saveState(stateFile, { seen: new Set(["n1"]), threadBindings: { 1.1: { sessionId: "s1", projectId: "p" } } }, 10);
		const before = statSync(stateFile);

		saveState(stateFile, { seen: new Set(["n2"]), threadBindings: { 2.2: { sessionId: "s2", projectId: "p" } } }, 10);
		const after = statSync(stateFile);

		// rename() swaps a fully-written file in; an in-place truncating write keeps
		// the same inode and exposes a half-written file to every reader in between.
		assert.notEqual(
			after.ino,
			before.ino,
			"state must be written to a temp file and renamed into place, never truncated in place",
		);
		assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).threadBindings["2.2"].sessionId, "s2");
		assert.deepEqual(
			readdirSync(path.dirname(stateFile)).filter((name) => name !== path.basename(stateFile)),
			[],
			"the temp file must not be left behind",
		);
	});

	it("leaves the previous state intact when a state write fails", async () => {
		const stateFile = await tmpState();
		saveState(stateFile, { seen: new Set(["keep"]), threadBindings: { 1.1: { sessionId: "s1", projectId: "p" } } }, 10);
		const warnings = [];

		const exploding = {
			seen: new Set(["lost"]),
			attentionTracker: {
				serialize() {
					throw new Error("state serialization blew up mid-save");
				},
			},
		};
		saveState(stateFile, exploding, 10, { warn: (...args) => warnings.push(args.join(" ")) });

		assert.equal(warnings.length, 1);
		assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")).seen, ["keep"], "the last good state must survive");
		assert.deepEqual(
			readdirSync(path.dirname(stateFile)).filter((name) => name !== path.basename(stateFile)),
			[],
			"a failed write must not strand a temp file",
		);
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
		const patched = [];
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
					patched.push(url.split("/").at(-1));
					return response({});
				}
				return response({ notifications: [] });
			},
			logger: { info() {}, error() {} },
		});
		const raw = { id: "ntf_1", type: "pr_merged", sessionId: "a", projectId: "ao", title: "merged" };

		await assert.rejects(() => notifier.handleNotification(raw), /slack 503/);
		assert.equal(loadState(stateFile).seen.has("ntf_1"), false);
		assert.deepEqual(patched, []);
		fail = false;
		assert.equal(await notifier.handleNotification(raw), true);
		assert.equal(posts.length, 1);
		assert.deepEqual(patched, [], "a successful delivery still never PATCHes the notification read");
		assert.ok(loadState(stateFile).seen.has("ntf_1"));
	});
});

describe("ao Slack notifier needs-response routing", () => {
	it("routes informational notifications to the notify channel and never PATCHes them", async () => {
		const stateFile = await tmpState();
		const posts = [];
		const patched = [];
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
					patched.push(url.split("/").at(-1));
					return response({});
				}
				return response({ notifications: [] });
			},
			logger: { info() {}, error() {}, warn() {} },
			bootstrapMode: "post_all",
		});

		await notifier.handleNotification({
			id: "merged",
			type: "pr_merged",
			sessionId: "s2",
			projectId: "ao",
			title: "PR #8 merged",
			prUrl: "https://github.example/pr/8",
		});
		await notifier.handleNotification({
			id: "replaced",
			type: "orchestrator_replaced",
			sessionId: "orch-2",
			projectId: "ao",
			title: "orchestrator replaced",
		});

		assert.equal(posts.length, 2);
		assert.match(posts[0].text, /pr_merged/);
		assert.equal(posts[0].channel, "C-notify");
		assert.match(posts[1].text, /orchestrator_replaced/);
		assert.equal(posts[1].channel, "C-notify");
		for (const p of posts) assert.ok(!p.text.includes("<@"), "informational posts never @mention");
		assert.deepEqual(patched, [], "read != delivery: informational delivery never PATCHes");
	});

	it("edits the original needs-response message when a projection attention item clears", async () => {
		const stateFile = await tmpState();
		const posts = [];
		const updates = [];
		let ts = 0;
		const pages = [
			[{ id: "blocked-1", kind: "blocked", sessionId: "worker-a", projectId: "ao", reason: "blocked on a decision" }],
			[],
			[],
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
			fetchImpl: async () => operatorResponse(pages[page++] ?? []),
			clock: () => new Date("2026-07-11T03:00:00Z"),
			logger: { info() {}, error() {}, warn() {} },
		});

		await notifier.pollOperatorAttention();
		await notifier.pollOperatorAttention();
		await notifier.pollOperatorAttention();

		const needsPost = posts.find((p) => /blocked/.test(p.text) && /<@U123>/.test(p.text));
		assert.equal(needsPost?.channel, "C-needs");
		assert.ok(
			updates.some(
				(u) =>
					u.ts === "m1" && u.channel === "C-needs" && /resolved/.test(u.text) && /2026-07-11T03:00:00Z/.test(u.text),
			),
		);
	});

	it("edits a parked sensitive PR needs-response when the same PR merges", async () => {
		// The parked_sensitive_merge alert now arrives as a projection item; the
		// terminal pr_merged informational notification still resolves it by editing
		// the original needs-response Slack message to a ✅.
		const stateFile = await tmpState();
		const posts = [];
		const updates = [];
		const patched = [];
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
					patched.push(url.split("/").at(-1));
					return response({});
				}
				return operatorResponse([
					{
						id: "parked-7",
						kind: "parked_sensitive_merge",
						sessionId: "s1",
						projectId: "ao",
						reason: "PR #7 parked (sensitive)",
						deepLink: "https://github.example/pr/7",
						prUrl: "https://github.example/pr/7",
					},
				]);
			},
			clock: () => new Date("2026-07-11T04:00:00Z"),
			logger: { info() {}, error() {}, warn() {} },
			bootstrapMode: "post_all",
		});

		await notifier.pollOperatorAttention();
		await notifier.handleNotification({
			id: "merged",
			type: "pr_merged",
			sessionId: "s1",
			projectId: "ao",
			title: "PR #7 merged",
			prUrl: "https://github.example/pr/7",
		});

		const parkedPost = posts.find((p) => /parked_sensitive_merge/.test(p.text));
		assert.equal(parkedPost?.channel, "C-needs");
		const mergedPost = posts.find((p) => /pr_merged/.test(p.text));
		assert.equal(mergedPost?.channel, "C-notify");
		assert.ok(updates.some((u) => u.ts === "m1" && u.channel === "C-needs" && /PR #7 merged/.test(u.text)));
		assert.deepEqual(patched, [], "resolving a parked merge never PATCHes a notification read");
	});

	it("resolves a parked merge by PR identity even when its display deepLink differs from the PR URL", async () => {
		// The record keeps prUrl separate from the display url (which prefers
		// deepLink); the terminal pr_merged event matches on the PR identity.
		const stateFile = await tmpState();
		const updates = [];
		let ts = 0;
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			notifyChannel: "C-notify",
			needsResponseChannel: "C-needs",
			postMessage: async () => ({ ts: `m${++ts}` }),
			updateMessage: async (messageTs, text, opts = {}) => {
				updates.push({ ts: messageTs, text, channel: opts.channel });
				return true;
			},
			fetchImpl: async () =>
				operatorResponse([
					{
						id: "parked-9",
						kind: "parked_sensitive_merge",
						sessionId: "s1",
						projectId: "ao",
						reason: "PR #9 parked (sensitive)",
						deepLink: "/projects/ao/sessions/s1",
						prUrl: "https://github.example/pr/9",
					},
				]),
			clock: () => new Date("2026-07-11T04:00:00Z"),
			logger: { info() {}, error() {}, warn() {} },
			bootstrapMode: "post_all",
		});

		await notifier.pollOperatorAttention();
		await notifier.handleNotification({
			id: "merged-9",
			type: "pr_merged",
			sessionId: "s1",
			projectId: "ao",
			title: "PR #9 merged",
			prUrl: "https://github.example/pr/9",
		});

		assert.ok(
			updates.some((u) => u.ts === "m1" && /PR #9 merged/.test(u.text)),
			`updates = ${JSON.stringify(updates)}`,
		);
	});

	it("migrates v1 (pre-projection) state onto projection item ids: no resolve, no re-page on deploy", async () => {
		// An unversioned state file keys open records by the deleted classifier's
		// signatures. On load they are re-keyed to the projection ids the daemon
		// now emits, so the first projection poll neither resolves the existing
		// Slack messages nor posts duplicates for still-open conditions.
		const stateFile = await tmpState();
		await writeFile(
			stateFile,
			JSON.stringify({
				seen: ["ntf_1"],
				initialized: true,
				attentionTracker: {
					open: [
						[
							"ao/session:agent-1#needs_input",
							{ kind: "needs_input", sessionId: "agent-1", projectId: "ao", attention: true },
						],
						[
							"ao/pr:https://github.example/o/r/pull/2#parked_sensitive_merge|https://github.example/o/r/pull/2",
							{
								kind: "parked_sensitive_merge",
								sessionId: "agent-2",
								projectId: "ao",
								url: "https://github.example/o/r/pull/2",
								attention: true,
							},
						],
					],
				},
				needsResponseMessages: {
					"ao/session:agent-1#needs_input": {
						ts: "1.2",
						channel: "C",
						text: "waiting",
						record: { kind: "needs_input", sessionId: "agent-1", projectId: "ao", attention: true },
					},
					"ao/pr:https://github.example/o/r/pull/2#parked_sensitive_merge|https://github.example/o/r/pull/2": {
						ts: "2.3",
						channel: "C",
						text: "parked",
						record: {
							kind: "parked_sensitive_merge",
							sessionId: "agent-2",
							projectId: "ao",
							url: "https://github.example/o/r/pull/2",
							attention: true,
						},
					},
				},
			}),
			"utf8",
		);

		const state = loadState(stateFile);
		// Records are re-keyed to projection ids.
		assert.equal(state.attentionTracker.isOpen({ id: "session:agent-1:decision" }), true);
		assert.equal(state.attentionTracker.isOpen({ id: "pr:github.example/o/r#2:parked_sensitive_merge" }), true);
		assert.ok(state.needsResponseMessages["session:agent-1:decision"]);
		assert.ok(state.needsResponseMessages["pr:github.example/o/r#2:parked_sensitive_merge"]);
		// The migrated parked record keeps its PR identity for terminal resolves.
		assert.equal(
			state.needsResponseMessages["pr:github.example/o/r#2:parked_sensitive_merge"].record.prUrl,
			"https://github.example/o/r/pull/2",
		);

		const posts = [];
		const updates = [];
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state,
			mentionUserId: "U123",
			postMessage: async (text) => {
				posts.push(text);
				return { ts: `t${posts.length}` };
			},
			updateMessage: async (messageTs, text) => {
				updates.push({ ts: messageTs, text });
				return true;
			},
			fetchImpl: async () =>
				operatorResponse([
					{
						id: "session:agent-1:decision",
						kind: "decision",
						sessionId: "agent-1",
						projectId: "ao",
						reason: "waiting",
					},
					{
						id: "pr:github.example/o/r#2:parked_sensitive_merge",
						kind: "parked_sensitive_merge",
						sessionId: "agent-2",
						projectId: "ao",
						reason: "parked",
						deepLink: "https://github.example/o/r/pull/2",
						prUrl: "https://github.example/o/r/pull/2",
					},
				]),
			logger: { info() {}, error() {}, warn() {} },
		});

		await notifier.pollOperatorAttention();

		assert.equal(
			posts.filter((p) => /<@U123>/.test(p)).length,
			0,
			`still-open conditions must not re-page after migration: ${JSON.stringify(posts)}`,
		);
		assert.deepEqual(updates, [], "still-open conditions must not be resolved by migration");
		// The state file is upgraded in place on the next save.
		saveState(stateFile, notifier.state);
		assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).version, 2);
	});

	it("migrates every formerly tracked legacy kind onto its projection id", async () => {
		// worker_retry_exhausted and orchestrator_replacement_capped were
		// needs-response tracked pre-projection; their projection ids are keyed by
		// subject identity (notification:<project>:<session>:<type>), so they are
		// reconstructible — a deploy must not duplicate-page or orphan them.
		const stateFile = await tmpState();
		await writeFile(
			stateFile,
			JSON.stringify({
				initialized: true,
				attentionTracker: {
					open: [
						[
							"ao/session:w1#worker_retry_exhausted",
							{ kind: "worker_retry_exhausted", sessionId: "w1", projectId: "ao", attention: true },
						],
						[
							"ao/session:orch-1#orchestrator_replacement_capped",
							{ kind: "orchestrator_replacement_capped", sessionId: "orch-1", projectId: "ao", attention: true },
						],
					],
				},
				needsResponseMessages: {
					"ao/session:w1#worker_retry_exhausted": {
						ts: "1.1",
						channel: "C",
						text: "retry cap",
						record: { kind: "worker_retry_exhausted", sessionId: "w1", projectId: "ao", attention: true },
					},
				},
			}),
			"utf8",
		);

		const state = loadState(stateFile);
		assert.equal(state.attentionTracker.isOpen({ id: "notification:ao:w1:worker_retry_exhausted" }), true);
		assert.equal(state.attentionTracker.isOpen({ id: "notification:ao:orch-1:orchestrator_replacement_capped" }), true);
		assert.ok(state.needsResponseMessages["notification:ao:w1:worker_retry_exhausted"]);

		// A projection poll carrying the same conditions neither re-pages nor resolves.
		const posts = [];
		const updates = [];
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state,
			mentionUserId: "U123",
			postMessage: async (text) => {
				posts.push(text);
				return { ts: `t${posts.length}` };
			},
			updateMessage: async (messageTs, text) => {
				updates.push({ ts: messageTs, text });
				return true;
			},
			fetchImpl: async () =>
				operatorResponse([
					{
						id: "notification:ao:w1:worker_retry_exhausted",
						kind: "worker_retry_exhausted",
						sessionId: "w1",
						projectId: "ao",
						reason: "retry cap",
					},
					{
						id: "notification:ao:orch-1:orchestrator_replacement_capped",
						kind: "orchestrator_replacement_capped",
						sessionId: "orch-1",
						projectId: "ao",
						reason: "capped",
					},
				]),
			logger: { info() {}, error() {}, warn() {} },
		});

		await notifier.pollOperatorAttention();

		assert.equal(posts.filter((p) => /<@U123>/.test(p)).length, 0, `no duplicate pages: ${JSON.stringify(posts)}`);
		assert.deepEqual(updates, [], "no premature resolves");
	});

	it("migrates legacy no_signal records so a prime session matches its projection item", async () => {
		// The old poll classified prime sessions' silence as plain no_signal
		// (only kind === "orchestrator" got orchestrator_dead). The projection
		// emits session:<id>:no_signal for prime (kind prime_dead), so the legacy
		// record must re-key onto that id — otherwise a deploy resolves the open
		// Slack message and re-pages the still-dead prime.
		const stateFile = await tmpState();
		await writeFile(
			stateFile,
			JSON.stringify({
				initialized: true,
				attentionTracker: {
					open: [
						[
							"ao/session:prime-1#no_signal",
							{ kind: "no_signal", sessionId: "prime-1", projectId: "ao", attention: true },
						],
					],
				},
				needsResponseMessages: {
					"ao/session:prime-1#no_signal": {
						ts: "3.1",
						channel: "C",
						text: "prime silent",
						record: { kind: "no_signal", sessionId: "prime-1", projectId: "ao", attention: true },
					},
				},
			}),
			"utf8",
		);

		const state = loadState(stateFile);
		assert.equal(state.attentionTracker.isOpen({ id: "session:prime-1:no_signal" }), true);
		assert.ok(state.needsResponseMessages["session:prime-1:no_signal"]);

		const posts = [];
		const updates = [];
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state,
			mentionUserId: "U123",
			postMessage: async (text) => {
				posts.push(text);
				return { ts: `t${posts.length}` };
			},
			updateMessage: async (messageTs, text) => {
				updates.push({ ts: messageTs, text });
				return true;
			},
			fetchImpl: async () =>
				operatorResponse([
					{
						id: "session:prime-1:no_signal",
						kind: "prime_dead",
						sessionId: "prime-1",
						projectId: "ao",
						reason: "Prime orchestrator has no live process signal.",
					},
				]),
			logger: { info() {}, error() {}, warn() {} },
		});

		await notifier.pollOperatorAttention();

		assert.equal(posts.filter((p) => /<@U123>/.test(p)).length, 0, `no re-page: ${JSON.stringify(posts)}`);
		assert.deepEqual(updates, [], "no premature resolve");
	});

	it("v1 records with no projection counterpart (worker no_signal) resolve on the first poll", async () => {
		// The daemon deliberately excludes worker no_signal from the projection;
		// after migration those records reconcile away, which is the correct
		// daemon-truth outcome (their Slack messages get the resolved edit).
		const stateFile = await tmpState();
		await writeFile(
			stateFile,
			JSON.stringify({
				initialized: true,
				attentionTracker: {
					open: [["ao/session:w1#no_signal", { kind: "no_signal", sessionId: "w1", projectId: "ao", attention: true }]],
				},
				needsResponseMessages: {},
			}),
			"utf8",
		);
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			postMessage: async () => ({ ts: "t1" }),
			updateMessage: async () => true,
			fetchImpl: async () => operatorResponse([]),
			logger: { info() {}, error() {}, warn() {} },
		});

		// Two polls: the empty-poll debounce requires confirmation.
		const r1 = await notifier.pollOperatorAttention();
		const r2 = await notifier.pollOperatorAttention();

		assert.equal(r1.pendingEmptyConfirmation ?? false, true);
		assert.deepEqual(
			r2.resolved.map((r) => r.kind),
			["no_signal"],
		);
	});

	it("posts a fresh parked sensitive PR alert when a new projection item id appears", async () => {
		// A new head SHA yields a new daemon notification row and therefore a new
		// projection item id, which the tracker treats as a distinct alert. The
		// notifier dedups by that stable item id, so a new id re-alerts.
		const stateFile = await tmpState();
		const posts = [];
		const patched = [];
		let ts = 0;
		const pages = [
			[
				{
					id: "ready-a",
					kind: "parked_sensitive_merge",
					sessionId: "s1",
					projectId: "ao",
					reason: "PR #7 parked",
					deepLink: "https://github.example/pr/7",
				},
			],
			[
				{
					id: "ready-b",
					kind: "parked_sensitive_merge",
					sessionId: "s1",
					projectId: "ao",
					reason: "PR #7 parked (new head)",
					deepLink: "https://github.example/pr/7",
				},
			],
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
			updateMessage: async () => true,
			fetchImpl: async (url, init = {}) => {
				if (init.method === "PATCH") {
					patched.push(url.split("/").at(-1));
					return response({});
				}
				return operatorResponse(pages[page++] ?? []);
			},
			logger: { info() {}, error() {}, warn() {} },
		});

		await notifier.pollOperatorAttention();
		await notifier.pollOperatorAttention();

		// The resolvable @mention alert (renderAlert with the member id) is distinct
		// from the mention-less digest line, which also names the kind.
		assert.equal(
			posts.filter((p) => p.channel === "C-needs" && /<@U123>.*parked_sensitive_merge/.test(p.text)).length,
			2,
		);
		assert.equal(Object.keys(notifier.state.needsResponseMessages).length, 1);
		assert.deepEqual(patched, []);
	});

	it("retries a parked sensitive PR resolution when the resolve edit fails, then succeeds on re-delivery", async () => {
		const stateFile = await tmpState();
		const posts = [];
		const updates = [];
		const patched = [];
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
					patched.push(url.split("/").at(-1));
					return response({});
				}
				return operatorResponse([
					{
						id: "parked-7",
						kind: "parked_sensitive_merge",
						sessionId: "s1",
						projectId: "ao",
						reason: "PR #7 parked (sensitive)",
						deepLink: "https://github.example/pr/7",
					},
				]);
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

		await notifier.pollOperatorAttention();
		await notifier.handleNotification(merged);

		assert.equal(Object.keys(notifier.state.needsResponseMessages).length, 1, "message stays open after a failed edit");
		assert.equal(updates.length, 0);
		assert.equal(posts.filter((p) => /pr_merged/.test(p.text)).length, 1);

		await notifier.handleNotification(merged);

		assert.ok(updates.some((u) => u.ts === "m1" && /resolved/.test(u.text)));
		assert.equal(Object.keys(notifier.state.needsResponseMessages).length, 0);
		assert.equal(
			posts.filter((p) => /pr_merged/.test(p.text)).length,
			1,
			"re-delivery does not repost the terminal notice",
		);
		assert.deepEqual(patched, []);
	});

	it("retries a needs-response resolution edit after chat.update fails", async () => {
		const stateFile = await tmpState();
		const posts = [];
		const updates = [];
		let ts = 0;
		let failUpdate = true;
		const pages = [
			[{ id: "blocked-1", kind: "blocked", sessionId: "worker-a", projectId: "ao", reason: "blocked" }],
			[],
			[],
			[],
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
			fetchImpl: async () => operatorResponse(pages[page++] ?? []),
			clock: () => new Date("2026-07-11T05:00:00Z"),
			logger: { info() {}, error() {}, warn() {} },
		});

		await notifier.pollOperatorAttention();
		await notifier.pollOperatorAttention();
		await notifier.pollOperatorAttention();
		assert.equal(
			updates.some((u) => u.ts === "m1"),
			false,
			"first per-item resolution attempt fails",
		);
		assert.equal(Object.keys(notifier.state.needsResponseMessages).length, 1, "message remains open for retry");

		await notifier.pollOperatorAttention();

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

describe("ao Slack notifier operator attention polling", () => {
	it("mentions blocked, dead-orchestrator, and worker no-signal projection items", async () => {
		const stateFile = await tmpState();
		const posts = [];
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			postMessage: async (text) => posts.push(text),
			fetchImpl: async (url) => {
				assert.equal(url, "http://ao.test/api/v1/attention/operator");
				return operatorResponse([
					{ id: "b1", kind: "blocked", sessionId: "worker-blocked", projectId: "ao", reason: "blocked" },
					{ id: "o1", kind: "orchestrator_dead", sessionId: "orch-dead", projectId: "ao", reason: "no signal" },
					{ id: "n1", kind: "no_signal", sessionId: "worker-silent", projectId: "ao", reason: "silent" },
				]);
			},
			logger: { info() {}, error() {}, warn() {} },
		});

		const result = await notifier.pollOperatorAttention();

		assert.equal(result.alerted.length, 3);
		assert.ok(posts.some((p) => /<@U123>.*blocked/.test(p)));
		assert.ok(posts.some((p) => /<@U123>.*orchestrator_dead/.test(p)));
		assert.ok(posts.some((p) => /<@U123>.*no_signal/.test(p)));
	});

	it("dedupes unchanged attention items and re-alerts after resolution", async () => {
		const stateFile = await tmpState();
		const posts = [];
		const blocked = { id: "b1", kind: "blocked", sessionId: "a", projectId: "ao", reason: "blocked" };
		const pages = [[blocked], [blocked], [], [], [blocked]];
		let page = 0;
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			postMessage: async (text) => posts.push(text),
			updateMessage: async () => true,
			fetchImpl: async () => operatorResponse(pages[page++] ?? []),
			logger: { info() {}, error() {}, warn() {} },
		});

		await notifier.pollOperatorAttention();
		await notifier.pollOperatorAttention();
		await notifier.pollOperatorAttention();
		await notifier.pollOperatorAttention();
		await notifier.pollOperatorAttention();

		assert.equal(posts.filter((p) => /blocked/.test(p) && /<@U123>/.test(p)).length, 2);
	});

	it("posts the what-needs-me digest only when pending content changes", async () => {
		const stateFile = await tmpState();
		const posts = [];
		let items = [{ id: "b1", kind: "blocked", sessionId: "a", projectId: "ao", reason: "blocked" }];
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			postMessage: async (text) => posts.push(text),
			updateMessage: async () => true,
			fetchImpl: async () => operatorResponse(items),
			clock: () => new Date("2026-07-10T00:00:00Z"),
			logger: { info() {}, error() {}, warn() {} },
		});

		await notifier.pollOperatorAttention();
		await notifier.pollOperatorAttention();
		items = [];
		await notifier.pollOperatorAttention();
		await notifier.pollOperatorAttention();

		assert.equal(posts.filter((p) => /thing needs you|Nothing needs you/.test(p)).length, 2);
		assert.ok(posts.some((p) => /1 thing needs you/.test(p)));
		assert.ok(posts.some((p) => /Nothing needs you/.test(p)));
	});

	it("edits an existing digest in bot-token mode when content changes", async () => {
		const stateFile = await tmpState();
		const posts = [];
		const updates = [];
		let ts = 0;
		let items = [{ id: "b1", kind: "blocked", sessionId: "a", projectId: "ao", reason: "blocked" }];
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
			fetchImpl: async () => operatorResponse(items),
			clock: () => new Date("2026-07-10T00:00:00Z"),
			logger: { info() {}, error() {}, warn() {} },
		});

		await notifier.pollOperatorAttention();
		items = [];
		await notifier.pollOperatorAttention();
		await notifier.pollOperatorAttention();

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
		let items = [{ id: "b1", kind: "blocked", sessionId: "a", projectId: "ao", reason: "blocked" }];
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
			fetchImpl: async () => operatorResponse(items),
			clock: () => new Date("2026-07-10T00:00:00Z"),
			logger: { info() {}, error() {}, warn() {} },
		});

		await notifier.pollOperatorAttention();
		items = [];
		await notifier.pollOperatorAttention();
		await notifier.pollOperatorAttention();

		assert.equal(posts.filter((p) => /Nothing needs you/.test(p)).length, 1);
		assert.equal(notifier.state.digestTs, "m3");
	});

	it("posts a 'pr' item once as a plain thread-bound post plus the digest, never an @mention", async () => {
		// The projection kind `pr` (a routine locally-mergeable PR) is NOT in
		// MENTION_KINDS: it gets one plain (no-mention) post in the notify channel —
		// the pre-projection ready_to_merge behavior, thread-bound so a reply routes
		// to the session — plus the rolling digest line. Repeat polls do not re-post.
		const stateFile = await tmpState();
		const posts = [];
		let ts = 0;
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			notifyChannel: "C_NOTIFY",
			needsResponseChannel: "C_NEEDS",
			postMessage: async (text, { channel } = {}) => {
				posts.push({ text, channel });
				ts += 1;
				return { ts: `t${ts}` };
			},
			updateMessage: async () => true,
			fetchImpl: async () =>
				operatorResponse([
					{
						id: "pr-1",
						kind: "pr",
						sessionId: "agent",
						projectId: "ao",
						reason: "PR ready",
						deepLink: "https://gh/pr/1",
					},
				]),
			logger: { info() {}, error() {}, warn() {} },
		});

		const result = await notifier.pollOperatorAttention();
		await notifier.pollOperatorAttention();

		assert.equal(result.alerted.length, 1);
		assert.equal(
			posts.some((p) => /<@U123>/.test(p.text)),
			false,
			"a pr-kind item must never @mention",
		);
		const plain = posts.filter((p) => /\*pr\*.*PR ready/.test(p.text) && !/needs you/.test(p.text));
		assert.equal(plain.length, 1, "exactly one plain post across repeat polls");
		assert.equal(plain[0].channel, "C_NOTIFY");
		assert.ok(posts.some((p) => /1 thing needs you/.test(p.text)));
		// The plain post is thread-bound so a reply routes back to the session.
		const bindings = Object.values(notifier.state.threadBindings ?? {});
		assert.ok(
			bindings.some((b) => b.sessionId === "agent"),
			`thread bindings = ${JSON.stringify(notifier.state.threadBindings)}`,
		);
	});

	it("includes projection kinds outside the allowlists in the digest (tracked, no individual post)", async () => {
		// The renderer contract: EVERY daemon-declared attention item appears in
		// the digest and is tracked/reconciled. The kind allowlists only decide
		// loud vs plain vs no individual post — a kind newer than this notifier
		// must not silently vanish.
		const stateFile = await tmpState();
		const posts = [];
		const pages = [
			[{ id: "future-1", kind: "future_kind", sessionId: "f1", projectId: "ao", reason: "novel condition" }],
			[],
			[],
		];
		let page = 0;
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			postMessage: async (text) => {
				posts.push(text);
				return { ts: `t${posts.length}` };
			},
			updateMessage: async () => true,
			fetchImpl: async () => operatorResponse(pages[Math.min(page++, pages.length - 1)]),
			logger: { info() {}, error() {}, warn() {} },
		});

		await notifier.pollOperatorAttention();

		assert.equal(posts.filter((p) => /<@U123>/.test(p)).length, 0, "no individual @mention for unknown kinds");
		const digest = posts.find((p) => /1 thing needs you/.test(p));
		assert.ok(digest, `digest missing: ${JSON.stringify(posts)}`);
		assert.match(digest, /future_kind/);
		assert.match(digest, /novel condition/);
		assert.equal(notifier.state.attentionTracker.isOpen({ id: "future-1" }), true, "unknown kinds are tracked");

		// And it reconciles away when the projection drops it (debounce = 2 polls).
		await notifier.pollOperatorAttention();
		const final = await notifier.pollOperatorAttention();
		assert.deepEqual(
			final.resolved.map((r) => r.id),
			["future-1"],
		);
	});

	it("does not clear the digest on one transient empty poll", async () => {
		const stateFile = await tmpState();
		const posts = [];
		const prItem = { id: "pr-1", kind: "pr", sessionId: "agent", projectId: "ao", reason: "PR ready" };
		const pages = [[prItem], [], [prItem]];
		let page = 0;
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			postMessage: async (text) => posts.push(text),
			updateMessage: async () => true,
			fetchImpl: async () => operatorResponse(pages[page++] ?? pages.at(-1)),
			logger: { info() {}, error() {}, warn() {} },
		});

		await notifier.pollOperatorAttention();
		await notifier.pollOperatorAttention();
		await notifier.pollOperatorAttention();

		assert.equal(posts.filter((p) => /1 thing needs you/.test(p)).length, 1);
		assert.equal(
			posts.some((p) => /Nothing needs you/.test(p)),
			false,
		);
	});

	it("keeps open attention signatures across save/load restart", async () => {
		const stateFile = await tmpState();
		const posts = [];
		const items = [{ id: "b1", kind: "blocked", sessionId: "a", projectId: "ao", reason: "blocked" }];
		const first = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			postMessage: async (text) => posts.push(text),
			updateMessage: async () => true,
			fetchImpl: async () => operatorResponse(items),
			logger: { info() {}, error() {}, warn() {} },
		});
		await first.pollOperatorAttention();
		const restarted = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			postMessage: async (text) => posts.push(text),
			updateMessage: async () => true,
			fetchImpl: async () => operatorResponse(items),
			logger: { info() {}, error() {}, warn() {} },
		});

		await restarted.pollOperatorAttention();

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
			fetchImpl: async () => operatorResponse([]),
			logger: { info() {}, error() {}, warn() {} },
		});

		await notifier.pollOperatorAttention();

		assert.deepEqual(posts, []);
	});

	it("treats an attention endpoint HTTP error as a poll error instead of an empty all-clear", async () => {
		const stateFile = await tmpState();
		const posts = [];
		let down = false;
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			postMessage: async (text) => posts.push(text),
			updateMessage: async () => true,
			fetchImpl: async (url) => {
				assert.equal(url, "http://ao.test/api/v1/attention/operator");
				if (down) return response({ error: "boom" }, false, 500);
				return operatorResponse([
					{ id: "b1", kind: "blocked", sessionId: "blocked-1", projectId: "ao", reason: "blocked" },
				]);
			},
			logger: { info() {}, error() {}, warn() {} },
		});

		await notifier.pollOperatorAttention();
		down = true;
		const result = await notifier.pollOperatorAttention();

		assert.equal(result.error, true);
		assert.equal(notifier.consecutiveAttentionPollErrors, 1);
		assert.equal(posts.filter((p) => /<@U123>.*blocked/.test(p)).length, 1);
		assert.equal(
			posts.some((p) => /Nothing needs you/.test(p)),
			false,
		);
	});

	it("treats a malformed 200 payload as an unreachable-class failure, not an all-clear", async () => {
		// A 200 whose body has no `items` array must not silently resolve every
		// open attention item, and it must count toward daemon_unhealthy paging
		// (validated INSIDE the try, before the success latches reset).
		const stateFile = await tmpState();
		const posts = [];
		let malformed = false;
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			postMessage: async (text) => {
				posts.push(text);
				return { ts: `t${posts.length}` };
			},
			updateMessage: async () => true,
			fetchImpl: async () => {
				if (malformed) return response({ sessions: [] }); // wrong shape, HTTP 200
				return operatorResponse([
					{ id: "b1", kind: "blocked", sessionId: "blocked-1", projectId: "ao", reason: "blocked" },
				]);
			},
			logger: { info() {}, error() {}, warn() {} },
		});

		await notifier.pollOperatorAttention();
		malformed = true;
		const r1 = await notifier.pollOperatorAttention();
		const r2 = await notifier.pollOperatorAttention();
		const r3 = await notifier.pollOperatorAttention();

		assert.equal(r1.error, true);
		assert.equal(r2.error, true);
		assert.equal(r3.error, true);
		assert.equal(notifier.consecutiveAttentionPollErrors, 3);
		assert.ok(
			posts.some((p) => /daemon_unhealthy/.test(p)),
			posts,
		);
		// The open blocked alert was never resolved by the malformed payloads.
		assert.equal(notifier.state.attentionTracker.isOpen({ id: "b1" }), true);
	});

	it("pages daemon_unhealthy after repeated attention poll failures", async () => {
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

		await notifier.pollOperatorAttention();
		await notifier.pollOperatorAttention();
		await notifier.pollOperatorAttention();
		await notifier.pollOperatorAttention();

		assert.equal(posts.filter((p) => /daemon_unhealthy/.test(p)).length, 1);
		assert.match(posts[0], /<@U123>/);
		assert.ok(posts[0].includes("cannot reach the ao attention projection"));
	});

	it("pages the stream and attention daemon_unhealthy probes independently", async () => {
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
		await notifier.pollOperatorAttention();
		await notifier.pollOperatorAttention();
		await notifier.pollOperatorAttention();

		assert.equal(posts.filter((p) => /daemon_unhealthy/.test(p)).length, 2);
		assert.ok(posts[0].includes("cannot reach ao notifications"));
		assert.ok(posts[1].includes("cannot reach the ao attention projection"));
	});

	// --- M9 (#293): the daemon-unhealthy alert must survive Slack being down at
	// the exact moment it first fires.
	it("retries the daemon_unhealthy alert until it is actually delivered, then suppresses", async () => {
		const stateFile = await tmpState();
		const posts = [];
		let slackDown = true;
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			postMessage: async (text) => {
				if (slackDown) throw new Error("slack 503");
				posts.push(text);
			},
			fetchImpl: async () => {
				throw new Error("ECONNREFUSED");
			},
			logger: { info() {}, error() {}, warn() {} },
		});

		// Slack is down exactly when the threshold is first crossed.
		notifier.consecutiveErrors = 3;
		await notifier.alertUnhealthy("stream down");
		assert.equal(posts.length, 0, "the post failed, so nothing was delivered");

		// The old code gave up here forever: 4+ never re-attempted.
		notifier.consecutiveErrors = 4;
		await notifier.alertUnhealthy("stream down");
		assert.equal(posts.length, 0);

		slackDown = false;
		notifier.consecutiveErrors = 5;
		await notifier.alertUnhealthy("stream down");
		assert.equal(
			posts.filter((p) => /daemon_unhealthy/.test(p)).length,
			1,
			"once Slack recovers the pending health alert must actually be delivered",
		);

		// Delivered — now, and only now, it may be suppressed.
		notifier.consecutiveErrors = 6;
		await notifier.alertUnhealthy("stream down");
		assert.equal(posts.filter((p) => /daemon_unhealthy/.test(p)).length, 1, "a delivered alert must not re-page");
	});

	it("re-arms the daemon_unhealthy alert after the daemon recovers", async () => {
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
		assert.equal(posts.filter((p) => /daemon_unhealthy/.test(p)).length, 1);

		// Recovery clears the latch, so a LATER outage pages again rather than
		// being suppressed forever by the first one.
		notifier.consecutiveErrors = 0;
		notifier.streamUnhealthyPaged = false;

		notifier.consecutiveErrors = 3;
		await notifier.alertUnhealthy("stream down again");
		assert.equal(posts.filter((p) => /daemon_unhealthy/.test(p)).length, 2, "a new outage after recovery must page");
	});

	it("pages stream daemon_unhealthy when an attention poll outage was already latched", async () => {
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

		await notifier.pollOperatorAttention();
		await notifier.pollOperatorAttention();
		await notifier.pollOperatorAttention();
		notifier.consecutiveErrors = 3;
		await notifier.alertUnhealthy("stream down");

		assert.equal(posts.filter((p) => /daemon_unhealthy/.test(p)).length, 2);
		assert.ok(posts[0].includes("cannot reach the ao attention projection"));
		assert.ok(posts[1].includes("cannot reach ao notifications"));
	});

	it("does not re-arm stream daemon_unhealthy paging after a successful attention poll", async () => {
		const stateFile = await tmpState();
		const posts = [];
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			postMessage: async (text) => posts.push(text),
			fetchImpl: async (url) => {
				assert.equal(url, "http://ao.test/api/v1/attention/operator");
				return operatorResponse([]);
			},
			logger: { info() {}, error() {}, warn() {} },
		});

		notifier.consecutiveErrors = 3;
		await notifier.alertUnhealthy("stream down");
		await notifier.pollOperatorAttention();
		notifier.consecutiveErrors = 4;
		await notifier.alertUnhealthy("stream still down");

		assert.equal(posts.filter((p) => /daemon_unhealthy/.test(p)).length, 1);
	});

	it("allows an attention daemon_unhealthy page independent of the stream latch", async () => {
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
		await notifier.pollOperatorAttention();
		await notifier.pollOperatorAttention();
		await notifier.pollOperatorAttention();

		assert.equal(posts.filter((p) => /daemon_unhealthy/.test(p)).length, 2);
		assert.ok(posts.at(-1).includes("cannot reach the ao attention projection"));
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

		await notifier.pollOperatorAttention();
		await notifier.pollOperatorAttention();
		await notifier.pollOperatorAttention();
		fail = false;
		await notifier.pollOperatorAttention();

		assert.equal(posts.filter((p) => /daemon_unhealthy/.test(p)).length, 1);
	});

	it("stops the operator attention loop promptly when aborted during poll sleep", async () => {
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
				return operatorResponse([]);
			},
			logger: { info() {}, error() {}, warn() {} },
		});

		const result = await Promise.race([
			notifier.runOperatorAttention({ signal: controller.signal }).then(() => "stopped"),
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

	it("normalizes invalid direct poll intervals to the default", () => {
		assert.equal(parsePollMs(Number.NaN, 10_000), 10_000);
	});

	it("clamps too-small direct poll intervals and treats zero as disabled", () => {
		assert.equal(parsePollMs(10, 10_000), 1_000);
		assert.equal(parsePollMs(0, 10_000), 0);
		assert.equal(parsePollMs(-1, 10_000), 10_000);
	});
});

describe("ao Slack notifier content cooldown dedupe (issue #190)", () => {
	function stubFetch(pagesRef, patched) {
		return async (url, init = {}) => {
			if (init.method === "PATCH") {
				patched.push(url.split("/").at(-1));
				return response({});
			}
			return response({ notifications: pagesRef.next.shift() ?? [] });
		};
	}

	it("computes a content signature that ignores id and createdAt", () => {
		const a = contentSignature({
			id: "ntf_1",
			type: "pr_merged",
			sessionId: "s",
			projectId: "ao",
			prUrl: "https://gh/pr/1",
			createdAt: "2026-07-10T00:00:00Z",
		});
		const b = contentSignature({
			id: "ntf_2",
			type: "pr_merged",
			sessionId: "s",
			projectId: "ao",
			prUrl: "https://gh/pr/1",
			createdAt: "2026-07-10T05:00:00Z",
		});
		assert.equal(a, b);
	});

	it("suppresses a duplicate-content notification within the cooldown but never PATCHes it read", async () => {
		const stateFile = await tmpState();
		const posts = [];
		const patched = [];
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
			fetchImpl: stubFetch(pagesRef, patched),
			logger: { info() {}, error() {} },
			bootstrapMode: "post_all",
		});

		const first = {
			id: "ntf_1",
			type: "pr_merged",
			sessionId: "s",
			projectId: "ao",
			title: "PR #7 merged",
			prUrl: "https://gh/pr/7",
			createdAt: "2026-07-10T00:00:00Z",
		};
		const dup = { ...first, id: "ntf_2", createdAt: "2026-07-10T00:10:00Z" };

		assert.equal(await notifier.handleNotification(first), true);
		now += 10 * 60 * 1000; // 10 min later, within the 60-min cooldown
		await notifier.handleNotification(dup);

		assert.equal(posts.length, 1, "only the first content post reaches Slack");
		assert.deepEqual(patched, [], "read != delivery: neither row is PATCHed");
	});

	it("re-posts after the cooldown elapses", async () => {
		const stateFile = await tmpState();
		const posts = [];
		const patched = [];
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
			fetchImpl: stubFetch(pagesRef, patched),
			logger: { info() {}, error() {} },
			bootstrapMode: "post_all",
		});

		const base = {
			type: "pr_merged",
			sessionId: "s",
			projectId: "ao",
			title: "PR #7 merged",
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
		const patched = [];
		let now = 1_000_000;
		const first = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			dedupeCooldownMs: 60 * 60 * 1000,
			clock: () => new Date(now),
			postMessage: async (text) => posts.push(text),
			fetchImpl: stubFetch({ next: [] }, patched),
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
			fetchImpl: stubFetch({ next: [] }, patched),
			logger: { info() {}, error() {} },
			bootstrapMode: "post_all",
		});
		await restarted.handleNotification({ ...base, id: "ntf_2" });
		assert.equal(posts.length, 1, "restart does not re-post the same content within cooldown");
	});

	it("disables the cooldown when set to 0", async () => {
		const stateFile = await tmpState();
		const posts = [];
		const patched = [];
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			dedupeCooldownMs: 0,
			postMessage: async (text) => posts.push(text),
			fetchImpl: stubFetch({ next: [] }, patched),
			logger: { info() {}, error() {} },
			bootstrapMode: "post_all",
		});
		const base = { type: "pr_merged", sessionId: "s", projectId: "ao", title: "merged", prUrl: "https://gh/pr/1" };
		await notifier.handleNotification({ ...base, id: "ntf_1" });
		await notifier.handleNotification({ ...base, id: "ntf_2" });
		assert.equal(posts.length, 2, "cooldown disabled posts every distinct row");
	});
});

describe("ao Slack notifier head-SHA aware cooldown (issue #190)", () => {
	function stubFetch(patched) {
		return async (url, init = {}) => {
			if (init.method === "PATCH") {
				patched.push(url.split("/").at(-1));
				return response({});
			}
			return response({ notifications: [] });
		};
	}

	it("includes the head SHA in the content signature", () => {
		const a = contentSignature({
			type: "pr_merged",
			sessionId: "s",
			projectId: "ao",
			prUrl: "https://gh/pr/1",
			headSha: "sha-1",
		});
		const b = contentSignature({
			type: "pr_merged",
			sessionId: "s",
			projectId: "ao",
			prUrl: "https://gh/pr/1",
			headSha: "sha-2",
		});
		assert.notEqual(a, b);
	});

	it("uses typed subject identity when sessionId is empty", () => {
		const base = {
			type: "model_unreachable",
			sessionId: "",
			projectId: "ao",
			title: "model unreachable",
			subject: { kind: "model", id: "m1" },
			headSha: "sha-1",
		};
		assert.equal(contentSignature(base), contentSignature({ ...base, id: "ntf_2" }));
		assert.notEqual(contentSignature(base), contentSignature({ ...base, subject: { kind: "model", id: "m2" } }));
	});

	it("re-posts an informational notification for a new head within the cooldown", async () => {
		const stateFile = await tmpState();
		const posts = [];
		const patched = [];
		let now = 1_000_000;
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			dedupeCooldownMs: 60 * 60 * 1000,
			clock: () => new Date(now),
			postMessage: async (text) => posts.push(text),
			fetchImpl: stubFetch(patched),
			logger: { info() {}, error() {} },
			bootstrapMode: "post_all",
		});
		const base = { type: "pr_merged", sessionId: "s", projectId: "ao", title: "merged", prUrl: "https://gh/pr/1" };
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

// --- M6 (#293): the outbound notifier must create thread->session bindings.
//
// The RETIRED notifier wrote ThreadSessionMap bindings to ~/.ao/attention-state.json.
// The CURRENT one discarded `chat.postMessage.ts` entirely and persisted only seen
// ids — and deploy actively DELETES the retired notifier's state file. So the reply
// listener had zero bindings and every threaded Slack reply to a live alert routed
// to `unknown_thread`: two-way replies were dead in production.
describe("thread -> session bindings (post -> reply routing)", () => {
	it("persists the posted message ts against the session it came from", async () => {
		const stateFile = await tmpState();
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			postMessage: async () => ({ ts: "1712345678.000100" }),
			fetchImpl: async () => response({}),
			logger: { info() {}, error() {}, warn() {} },
		});

		await notifier.recordDelivered({
			id: "n1",
			type: "pr_merged",
			sessionId: "agent-orchestrator-208",
			projectId: "agent-orchestrator",
			title: "PR merged",
		});

		const map = loadNotifierThreadMap(stateFile);
		assert.deepEqual(map.lookup("1712345678.000100"), {
			projectId: "agent-orchestrator",
			sessionId: "agent-orchestrator-208",
		});
	});

	it("routes a threaded Slack reply back to the session that raised the alert", async () => {
		// The full production path, end to end: notifier posts -> binding is
		// persisted to the shared state file -> reply listener loads it -> a threaded
		// reply resolves to `ao send --session <that session>`.
		const stateFile = await tmpState();
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			postMessage: async () => ({ ts: "1712345678.000200" }),
			fetchImpl: async () => response({}),
			logger: { info() {}, error() {}, warn() {} },
		});
		await notifier.recordDelivered({
			id: "n2",
			type: "orchestrator_replaced",
			sessionId: "agent-orchestrator-99",
			projectId: "agent-orchestrator",
			title: "orchestrator was replaced",
		});

		const threadMap = loadNotifierThreadMap(stateFile);
		const sent = [];
		const out = await handleSlackRequest({
			...signedSlackRequest({
				type: "event_callback",
				event: { type: "message", text: "go with 2", thread_ts: "1712345678.000200", user: "U123", ts: "1712345999.1" },
			}),
			signingSecret: SIGNING_SECRET,
			threadMap,
			allowedUserId: "U123",
			aoSend: async (args) => sent.push(args),
			logger: { info() {}, error() {}, warn() {} },
		});

		assert.equal(out.status, 200);
		assert.deepEqual(out.sent, { sessionId: "agent-orchestrator-99", message: "go with 2" });
		assert.deepEqual(sent, [["send", "--session", "agent-orchestrator-99", "--message", "go with 2"]]);
	});

	it("degrades honestly on a webhook sink, which returns no message ts", async () => {
		// An incoming webhook post has no `ts` in its response, so there is nothing
		// to bind a thread to. That must be reported, not faked: threaded replies
		// genuinely cannot work without SLACK_BOT_TOKEN.
		const stateFile = await tmpState();
		const warnings = [];
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			mentionUserId: "U123",
			// chat.postMessage returns {ts}; an incoming webhook returns nothing.
			postMessage: async () => undefined,
			fetchImpl: async () => response({}),
			logger: { info() {}, error() {}, warn: (...a) => warnings.push(a.join(" ")) },
		});

		await notifier.recordDelivered({
			id: "n3",
			type: "pr_merged",
			sessionId: "agent-orchestrator-7",
			projectId: "agent-orchestrator",
			title: "PR merged",
		});

		const map = loadNotifierThreadMap(stateFile);
		assert.equal(map.lookup(undefined), null, "no ts means no binding — never fabricate one");
		assert.ok(
			warnings.some((w) => /webhook/i.test(w) && /thread/i.test(w)),
			`the webhook sink's inability to thread must be surfaced, got: ${JSON.stringify(warnings)}`,
		);

		// And the reply path degrades to unknown_thread rather than misrouting.
		const route = await handleSlackRequest({
			...signedSlackRequest({
				type: "event_callback",
				event: { type: "message", text: "hi", thread_ts: "9999.0001", user: "U123", ts: "9999.1" },
			}),
			signingSecret: SIGNING_SECRET,
			threadMap: map,
			allowedUserId: "U123",
			aoSend: async () => assert.fail("must not route an unbound thread"),
			logger: { info() {}, error() {}, warn() {} },
		});
		assert.equal(route.status, 200);
		assert.equal(route.sent, undefined);
	});

	it("bounds the binding map so a long-lived notifier cannot grow it without limit", async () => {
		const stateFile = await tmpState();
		const notifier = new SlackNotificationNotifier({
			baseUrl: "http://ao.test/api/v1",
			stateFile,
			state: loadState(stateFile),
			threadBindingLimit: 3,
			postMessage: async () => ({ ts: `ts-${n}` }),
			fetchImpl: async () => response({}),
			logger: { info() {}, error() {}, warn() {} },
		});
		let n = 0;
		for (n = 0; n < 5; n++) {
			await notifier.recordDelivered({
				id: `k${n}`,
				type: "pr_merged",
				sessionId: `s${n}`,
				projectId: "p",
				title: "merged",
			});
		}

		const map = loadNotifierThreadMap(stateFile);
		assert.equal(map.map.size, 3, "oldest bindings must be evicted");
		assert.equal(map.lookup("ts-4").sessionId, "s4", "the newest binding survives");
		assert.equal(map.lookup("ts-0"), null, "the oldest is gone");
	});
});
