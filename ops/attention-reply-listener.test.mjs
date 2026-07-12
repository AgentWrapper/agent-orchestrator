import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterEach, describe, it } from "node:test";

import { handleSlackRequest } from "./attention-reply-listener.mjs";
import {
	childEnv,
	emptyEnvPath,
	freePort,
	releaseSymlinkScript,
	repoRootFrom,
	spawnNode,
	waitForHttp,
} from "./main-invocation-test-helpers.mjs";
import { ThreadSessionMap } from "./slack-reply-core.mjs";

const SECRET = "sign";
const NOW = 1_700_000_000_000;
const REPO_ROOT = repoRootFrom(import.meta.url);
let cleanup = [];

afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((f) => f()));
});

function signed(bodyObj) {
	const rawBody = JSON.stringify(bodyObj);
	const ts = String(Math.floor(NOW / 1000));
	const sig = `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${rawBody}`).digest("hex")}`;
	return {
		rawBody,
		headers: { "x-slack-request-timestamp": ts, "x-slack-signature": sig },
	};
}

const quiet = { info: () => {}, error: () => {} };

describe("handleSlackRequest — inbound reply → ao send (acceptance #2)", () => {
	it("rejects an unsigned/forged request with 401", async () => {
		const { rawBody } = signed({ type: "event_callback" });
		const sent = [];
		const out = await handleSlackRequest({
			rawBody,
			headers: { "x-slack-request-timestamp": "1", "x-slack-signature": "v0=deadbeef" },
			signingSecret: SECRET,
			threadMap: new ThreadSessionMap(),
			aoSend: async (a) => sent.push(a),
			now: NOW,
			logger: quiet,
		});
		assert.equal(out.status, 401);
		assert.equal(sent.length, 0);
	});

	it("answers the Slack url_verification handshake", async () => {
		const { rawBody, headers } = signed({ type: "url_verification", challenge: "chal" });
		const out = await handleSlackRequest({
			rawBody,
			headers,
			signingSecret: SECRET,
			threadMap: new ThreadSessionMap(),
			aoSend: async () => {},
			now: NOW,
			logger: quiet,
		});
		assert.equal(out.status, 200);
		assert.deepEqual(JSON.parse(out.body), { challenge: "chal" });
	});

	it("routes a threaded reply to the bound session via ao send", async () => {
		const threadMap = new ThreadSessionMap();
		threadMap.remember("t1", { projectId: "ao", sessionId: "agent-9" });
		const { rawBody, headers } = signed({
			type: "event_callback",
			event: { type: "message", text: "use option 2", thread_ts: "t1", user: "UNICK", ts: "9.9" },
		});
		const sent = [];
		const out = await handleSlackRequest({
			rawBody,
			headers,
			signingSecret: SECRET,
			threadMap,
			aoSend: async (a) => sent.push(a),
			allowedUserId: "UNICK",
			now: NOW,
			logger: quiet,
		});
		assert.equal(out.status, 200);
		assert.deepEqual(sent[0], ["send", "--session", "agent-9", "--message", "use option 2"]);
		assert.deepEqual(out.sent, { sessionId: "agent-9", message: "use option 2" });
	});

	it("routes a numeric threaded reply via ao session decide", async () => {
		const threadMap = new ThreadSessionMap();
		threadMap.remember("t1", { projectId: "ao", sessionId: "agent-9" });
		const { rawBody, headers } = signed({
			type: "event_callback",
			event: { type: "message", text: "2", thread_ts: "t1", user: "UNICK", ts: "9.9" },
		});
		const sent = [];
		const out = await handleSlackRequest({
			rawBody,
			headers,
			signingSecret: SECRET,
			threadMap,
			aoSend: async (a) => sent.push(a),
			allowedUserId: "UNICK",
			now: NOW,
			logger: quiet,
		});
		assert.equal(out.status, 200);
		assert.deepEqual(sent[0], ["session", "decide", "agent-9", "--option", "2"]);
		assert.deepEqual(out.sent, { sessionId: "agent-9", option: 2 });
	});

	it("falls back to ao send when a numeric reply is not an answerable decision", async () => {
		const threadMap = new ThreadSessionMap();
		threadMap.remember("t1", { projectId: "ao", sessionId: "agent-9" });
		const { rawBody, headers } = signed({
			type: "event_callback",
			event: { type: "message", text: "3", thread_ts: "t1", user: "UNICK", ts: "9.9" },
		});
		const sent = [];
		const out = await handleSlackRequest({
			rawBody,
			headers,
			signingSecret: SECRET,
			threadMap,
			aoSend: async (a) => {
				sent.push(a);
				if (a[0] === "session") throw new Error("SESSION_DECISION_NOT_FOUND");
			},
			allowedUserId: "UNICK",
			now: NOW,
			logger: quiet,
		});
		assert.equal(out.status, 200);
		assert.deepEqual(sent, [
			["session", "decide", "agent-9", "--option", "3"],
			["send", "--session", "agent-9", "--message", "3"],
		]);
		assert.deepEqual(out.sent, { sessionId: "agent-9", message: "3" });
	});

	it("falls back when a numeric reply is invalid for an option-less text question", async () => {
		const threadMap = new ThreadSessionMap();
		threadMap.remember("t1", { projectId: "ao", sessionId: "agent-9" });
		const { rawBody, headers } = signed({
			type: "event_callback",
			event: { type: "message", text: "4", thread_ts: "t1", user: "UNICK", ts: "9.9" },
		});
		const sent = [];
		const out = await handleSlackRequest({
			rawBody,
			headers,
			signingSecret: SECRET,
			threadMap,
			aoSend: async (a) => {
				sent.push(a);
				if (a[0] === "session") throw new Error("INVALID_DECISION_ANSWER");
			},
			allowedUserId: "UNICK",
			now: NOW,
			logger: quiet,
		});
		assert.equal(out.status, 200);
		assert.deepEqual(sent, [
			["session", "decide", "agent-9", "--option", "4"],
			["send", "--session", "agent-9", "--message", "4"],
		]);
		assert.deepEqual(out.sent, { sessionId: "agent-9", message: "4" });
	});

	it("does not route an unauthorized user's reply", async () => {
		const threadMap = new ThreadSessionMap();
		threadMap.remember("t1", { sessionId: "agent-9" });
		const { rawBody, headers } = signed({
			type: "event_callback",
			event: { type: "message", text: "hi", thread_ts: "t1", user: "UEVE", ts: "9.9" },
		});
		const sent = [];
		const out = await handleSlackRequest({
			rawBody,
			headers,
			signingSecret: SECRET,
			threadMap,
			aoSend: async (a) => sent.push(a),
			allowedUserId: "UNICK",
			now: NOW,
			logger: quiet,
		});
		assert.equal(out.status, 200);
		assert.equal(sent.length, 0);
	});

	it("acks (200) but does not route non-message events", async () => {
		const { rawBody, headers } = signed({
			type: "event_callback",
			event: { type: "reaction_added", user: "UNICK" },
		});
		const sent = [];
		const out = await handleSlackRequest({
			rawBody,
			headers,
			signingSecret: SECRET,
			threadMap: new ThreadSessionMap(),
			aoSend: async (a) => sent.push(a),
			now: NOW,
			logger: quiet,
		});
		assert.equal(out.status, 200);
		assert.equal(sent.length, 0);
	});

	it("returns 200 (no retry-storm) when ao send fails", async () => {
		const threadMap = new ThreadSessionMap();
		threadMap.remember("t1", { sessionId: "agent-9" });
		const { rawBody, headers } = signed({
			type: "event_callback",
			event: { type: "message", text: "go", thread_ts: "t1", user: "UNICK", ts: "9.9" },
		});
		const out = await handleSlackRequest({
			rawBody,
			headers,
			signingSecret: SECRET,
			threadMap,
			aoSend: async () => {
				throw new Error("session gone");
			},
			allowedUserId: "UNICK",
			now: NOW,
			logger: quiet,
		});
		assert.equal(out.status, 200);
		assert.equal(out.sent, undefined);
	});
});

describe("handleSlackRequest — refreshes thread map before routing (P1 fix)", () => {
	it("picks up a binding persisted after listener startup", async () => {
		const threadMap = new ThreadSessionMap(); // starts empty (listener started before the alert)
		const { rawBody, headers } = signed({
			type: "event_callback",
			event: { type: "message", text: "go", thread_ts: "t-late", user: "UNICK", ts: "9.9" },
		});
		const sent = [];
		const out = await handleSlackRequest({
			rawBody,
			headers,
			signingSecret: SECRET,
			threadMap,
			aoSend: async (a) => sent.push(a),
			allowedUserId: "UNICK",
			now: NOW,
			logger: quiet,
			// simulate the notifier having persisted a new binding since startup
			refreshThreadMap: (tm) => {
				const fresh = new ThreadSessionMap();
				fresh.remember("t-late", { projectId: "ao", sessionId: "agent-late" });
				tm.mergeFrom(fresh);
			},
		});
		assert.equal(out.status, 200);
		assert.deepEqual(sent[0], ["send", "--session", "agent-late", "--message", "go"]);
	});
});

describe("attention reply listener main module invocation", () => {
	it("listens for Slack events when invoked through the release current symlink", async () => {
		const script = await releaseSymlinkScript({
			cleanup,
			prefix: "ao-reply-release-",
			repoRoot: REPO_ROOT,
			script: "ops/attention-reply-listener.mjs",
		});

		for (const nodeArgs of [[], ["--preserve-symlinks-main"]]) {
			const port = await freePort();
			const envFile = await emptyEnvPath(cleanup, "ao-attention-reply-env-");
			const { child, output } = spawnNode([...nodeArgs, script], {
				cleanup,
				env: childEnv(
					{
						AO_ATTENTION_REPLY_PORT: String(port),
						AO_ENV_FILE: envFile,
						SLACK_MEMBER_ID: "UNICK",
						SLACK_SIGNING_SECRET: SECRET,
					},
					{ stripPrefixes: ["AO_", "POLYPOWERS_", "SLACK_"] },
				),
			});

			const response = await waitForHttp(`http://127.0.0.1:${port}/`, { child, output });
			assert.equal(response.status, 404);
			assert.equal(child.exitCode, null);
		}
	});
});
