import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { AttentionNotifier } from "./attention-notifier.mjs";

function fakeSlack() {
	const posts = [];
	const updates = [];
	let seq = 0;
	return {
		posts,
		updates,
		postMessage: async (text) => {
			posts.push(text);
			return { ts: `ts_${++seq}` };
		},
		update: async (ts, text) => {
			updates.push({ ts, text });
			return { ts };
		},
	};
}

const quietLogger = { error: () => {}, info: () => {}, warn: () => {} };

function sessions(list) {
	return { sessions: list };
}

describe("AttentionNotifier.tick — outbound engine (acceptance #1)", () => {
	let slack;
	beforeEach(() => {
		slack = fakeSlack();
	});

	it("alerts once per new attention transition with an @mention", async () => {
		const n = new AttentionNotifier({
			sessionSource: async () => sessions([{ id: "a", projectId: "ao", activity: { state: "waiting_input" } }]),
			slack,
			mentionUserId: "UNICK",
			logger: quietLogger,
		});
		const r = await n.tick();
		assert.equal(r.alerted.length, 1);
		const alert = slack.posts.find((p) => p.includes("needs_input"));
		assert.match(alert, /<@UNICK>/);
	});

	it("does not re-alert the same unchanged state on the next poll (dedup)", async () => {
		const src = async () => sessions([{ id: "a", projectId: "ao", activity: { state: "waiting_input" } }]);
		const n = new AttentionNotifier({ sessionSource: src, slack, mentionUserId: "U", logger: quietLogger });
		await n.tick();
		const before = slack.posts.filter((p) => p.includes("needs_input")).length;
		await n.tick();
		const after = slack.posts.filter((p) => p.includes("needs_input")).length;
		assert.equal(before, after, "should not re-alert an unchanged state");
	});

	it("re-alerts after the state resolves and the session re-enters", async () => {
		let waiting = true;
		const n = new AttentionNotifier({
			sessionSource: async () =>
				sessions([{ id: "a", projectId: "ao", activity: { state: waiting ? "waiting_input" : "active" } }]),
			slack,
			mentionUserId: "U",
			logger: quietLogger,
		});
		await n.tick(); // alert
		waiting = false;
		const r = await n.tick(); // resolves
		assert.equal(r.resolved.length, 1);
		waiting = true;
		const r2 = await n.tick(); // re-enters -> alert again
		assert.equal(r2.alerted.length, 1);
	});

	it("binds each alert's thread to its session for the reply path", async () => {
		const bindings = [];
		const n = new AttentionNotifier({
			sessionSource: async () => sessions([{ id: "agent-9", projectId: "ao", activity: { state: "blocked" } }]),
			slack,
			mentionUserId: "U",
			logger: quietLogger,
			onThreadBind: (ts, target) => bindings.push({ ts, target }),
		});
		await n.tick();
		assert.equal(bindings.length, 1);
		assert.equal(bindings[0].target.sessionId, "agent-9");
		assert.equal(n.threadMap.lookup(bindings[0].ts).sessionId, "agent-9");
	});
});

describe("AttentionNotifier digest — 'what needs me' edited in place (acceptance #3)", () => {
	it("posts the digest once then edits it in place on later ticks", async () => {
		const slack = fakeSlack();
		let list = [{ id: "a", projectId: "ao", activity: { state: "waiting_input" } }];
		const n = new AttentionNotifier({
			sessionSource: async () => sessions(list),
			slack,
			mentionUserId: "U",
			logger: quietLogger,
		});
		await n.tick();
		assert.ok(
			slack.posts.some((p) => /need/.test(p)),
			"digest posted",
		);
		const updatesBefore = slack.updates.length;
		list = [];
		await n.tick();
		assert.ok(slack.updates.length > updatesBefore, "digest edited in place");
		assert.match(slack.updates.at(-1).text, /Nothing needs you/);
	});
});

describe("AttentionNotifier self-health (acceptance — heartbeat/self-health)", () => {
	it("alerts Nick after 3 consecutive poll failures", async () => {
		const slack = fakeSlack();
		const n = new AttentionNotifier({
			sessionSource: async () => {
				throw new Error("connection refused");
			},
			slack,
			mentionUserId: "UNICK",
			logger: quietLogger,
		});
		await n.tick();
		await n.tick();
		assert.equal(slack.posts.length, 0, "no premature health alert");
		await n.tick();
		assert.equal(slack.posts.length, 1);
		assert.match(slack.posts[0], /daemon_unhealthy/);
		assert.match(slack.posts[0], /<@UNICK>/);
	});
});

describe("AttentionNotifier — review fixes (retry + webhook digest)", () => {
	it("retries an alert on the next poll when the Slack post fails (no silent drop)", async () => {
		let fail = true;
		const posts = [];
		const slack = {
			postMessage: async (t) => {
				if (t.includes("needs_input") && fail) throw new Error("slack 503");
				posts.push(t);
				return { ts: `ts_${posts.length}` };
			},
			update: async () => ({ ts: "d" }),
		};
		const src = async () => sessions([{ id: "a", projectId: "ao", activity: { state: "waiting_input" } }]);
		const n = new AttentionNotifier({ sessionSource: src, slack, mentionUserId: "U", logger: quietLogger });
		const r1 = await n.tick();
		assert.equal(r1.alerted.length, 0, "first alert failed to post");
		fail = false;
		const r2 = await n.tick();
		assert.equal(r2.alerted.length, 1, "second poll must retry the failed alert");
	});

	it("does not repost the digest every poll in webhook mode (ts=null)", async () => {
		const posts = [];
		const slack = {
			postMessage: async (t) => {
				posts.push(t);
				return { ts: null }; // webhook mode: no message handle
			},
			update: async () => ({ ts: null }),
		};
		let list = [{ id: "a", projectId: "ao", activity: { state: "waiting_input" } }];
		const n = new AttentionNotifier({
			sessionSource: async () => sessions(list),
			slack,
			mentionUserId: "U",
			logger: quietLogger,
		});
		await n.tick();
		const digestsAfter1 = posts.filter((p) => /need|Nothing/.test(p)).length;
		await n.tick(); // unchanged state
		await n.tick(); // unchanged state
		const digestsAfter3 = posts.filter((p) => /need|Nothing/.test(p)).length;
		assert.equal(digestsAfter1, digestsAfter3, "webhook digest must not repost when unchanged");
	});

	it("reposts the digest in webhook mode only when its content changes", async () => {
		const posts = [];
		const slack = {
			postMessage: async (t) => {
				posts.push(t);
				return { ts: null };
			},
			update: async () => ({ ts: null }),
		};
		let list = [{ id: "a", projectId: "ao", activity: { state: "waiting_input" } }];
		const n = new AttentionNotifier({
			sessionSource: async () => sessions(list),
			slack,
			mentionUserId: "U",
			logger: quietLogger,
		});
		await n.tick();
		const before = posts.filter((p) => /Nothing needs you/.test(p)).length;
		list = []; // resolves -> digest content changes to empty state
		await n.tick();
		const after = posts.filter((p) => /Nothing needs you/.test(p)).length;
		assert.ok(after > before, "digest should repost when content changes");
	});
});

describe("digestContentKey + anti-spam guard survive the changing timestamp (cycle-2 fix)", async () => {
	const { digestContentKey } = await import("./attention-notifier.mjs");

	it("is stable for the same pending set regardless of order", () => {
		const a = [
			{ signature: "", kind: "needs_input", sessionId: "a", projectId: "ao", title: "x", attention: true },
			{ kind: "blocked", sessionId: "b", projectId: "ao", title: "y", attention: true },
		];
		const k1 = digestContentKey([a[0], a[1]]);
		const k2 = digestContentKey([a[1], a[0]]);
		assert.equal(k1, k2);
	});

	it("does not re-post/edit the digest across ticks when the pending set is unchanged", async () => {
		const slack = fakeSlack();
		let tick = 0;
		const list = [{ id: "a", projectId: "ao", activity: { state: "waiting_input" } }];
		const n = new AttentionNotifier({
			sessionSource: async () => sessions(list),
			slack,
			mentionUserId: "U",
			logger: quietLogger,
			// clock advances every call so the digest's 'as of' stamp changes
			clock: () => new Date(1_700_000_000_000 + tick++ * 10_000),
		});
		await n.tick();
		const postsAfter1 = slack.posts.length;
		const updatesAfter1 = slack.updates.length;
		await n.tick();
		await n.tick();
		assert.equal(slack.posts.length, postsAfter1, "no extra digest posts when unchanged");
		assert.equal(slack.updates.length, updatesAfter1, "no extra digest edits when unchanged");
	});
});

describe("webhook post failure is retried (cycle-2 fix via slack-client)", () => {
	it("propagates a non-ok webhook response so the alert retries", async () => {
		let calls = 0;
		const slack = {
			// simulate slack-client webhook behavior: throw on non-ok
			postMessage: async (t) => {
				calls++;
				if (t.includes("needs_input") && calls === 1) throw new Error("slack webhook: HTTP 429");
				return { ts: null };
			},
			update: async () => ({ ts: null }),
		};
		const src = async () => sessions([{ id: "a", projectId: "ao", activity: { state: "waiting_input" } }]);
		const n = new AttentionNotifier({ sessionSource: src, slack, mentionUserId: "U", logger: quietLogger });
		const r1 = await n.tick();
		assert.equal(r1.alerted.length, 0);
		const r2 = await n.tick();
		assert.equal(r2.alerted.length, 1, "alert retried after webhook failure");
	});
});

describe("saveState/loadState round-trip persists tracker (cycle-6 fix)", async () => {
	const { saveState, loadState } = await import("./attention-notifier.mjs");
	const { AttentionTracker } = await import("./attention-core.mjs");
	const { ThreadSessionMap } = await import("./slack-reply-core.mjs");
	const os = await import("node:os");
	const path = await import("node:path");
	const { mkdtempSync, rmSync } = await import("node:fs");

	it("restores open signatures across a simulated restart", () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "ao-attn-state-"));
		const file = path.join(dir, "state.json");
		try {
			const tracker = new AttentionTracker();
			tracker.observe({ kind: "needs_input", sessionId: "a", projectId: "ao", title: "", url: "", attention: true });
			const threadMap = new ThreadSessionMap();
			threadMap.remember("t1", { sessionId: "a" });
			saveState(file, { threadMap, digest: { ts: "d1" }, tracker });

			const restored = loadState(file);
			assert.equal(restored.tracker.isOpen({ kind: "needs_input", sessionId: "a", projectId: "ao" }), true);
			assert.equal(restored.digest.ts, "d1");
			assert.equal(restored.threadMap.lookup("t1").sessionId, "a");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
