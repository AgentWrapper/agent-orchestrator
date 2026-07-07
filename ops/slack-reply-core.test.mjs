import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";

import {
	buildAoSendArgs,
	extractMessageEvent,
	routeReply,
	ThreadSessionMap,
	urlVerificationResponse,
	verifySlackSignature,
} from "./slack-reply-core.mjs";

const SECRET = "shhh-signing-secret";

function sign(body, ts, secret = SECRET) {
	return `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;
}

describe("verifySlackSignature (acceptance #2 — trusted inbound)", () => {
	const now = 1_700_000_000_000;
	const ts = String(Math.floor(now / 1000));
	const body = '{"type":"event_callback"}';

	it("accepts a correctly signed, fresh request", () => {
		assert.equal(
			verifySlackSignature({ signingSecret: SECRET, timestamp: ts, body, signature: sign(body, ts), now }),
			true,
		);
	});
	it("rejects a tampered body", () => {
		assert.equal(
			verifySlackSignature({ signingSecret: SECRET, timestamp: ts, body: body + "x", signature: sign(body, ts), now }),
			false,
		);
	});
	it("rejects a wrong secret", () => {
		assert.equal(
			verifySlackSignature({ signingSecret: "other", timestamp: ts, body, signature: sign(body, ts), now }),
			false,
		);
	});
	it("rejects a stale timestamp (replay)", () => {
		const oldTs = String(Math.floor(now / 1000) - 600);
		assert.equal(
			verifySlackSignature({ signingSecret: SECRET, timestamp: oldTs, body, signature: sign(body, oldTs), now }),
			false,
		);
	});
	it("rejects missing fields", () => {
		assert.equal(verifySlackSignature({ signingSecret: SECRET, body, now }), false);
	});
});

describe("ThreadSessionMap", () => {
	it("remembers and looks up a thread->session binding", () => {
		const m = new ThreadSessionMap();
		m.remember("t1", { projectId: "ao", sessionId: "agent-9" });
		assert.deepEqual(m.lookup("t1"), { projectId: "ao", sessionId: "agent-9" });
		assert.equal(m.lookup("nope"), null);
	});
	it("survives serialize/deserialize", () => {
		const m = new ThreadSessionMap();
		m.remember("t1", { projectId: "ao", sessionId: "agent-9" });
		const round = ThreadSessionMap.deserialize(m.serialize());
		assert.deepEqual(round.lookup("t1"), { projectId: "ao", sessionId: "agent-9" });
	});
	it("evicts oldest beyond capacity", () => {
		const m = new ThreadSessionMap({ max: 2 });
		m.remember("t1", { sessionId: "a" });
		m.remember("t2", { sessionId: "b" });
		m.remember("t3", { sessionId: "c" });
		assert.equal(m.lookup("t1"), null);
		assert.equal(m.lookup("t3").sessionId, "c");
	});
});

describe("routeReply (acceptance #2 — reply routes to originating session)", () => {
	it("routes a threaded reply to the bound session", () => {
		const threadMap = new ThreadSessionMap();
		threadMap.remember("t1", { projectId: "ao", sessionId: "agent-9" });
		const r = routeReply(
			{ text: "use the second option", threadTs: "t1", user: "UNICK" },
			{
				threadMap,
				allowedUserId: "UNICK",
			},
		);
		assert.deepEqual(r, {
			ok: true,
			via: "thread",
			sessionId: "agent-9",
			projectId: "ao",
			message: "use the second option",
		});
	});

	it("strips a leading bot mention from a threaded reply", () => {
		const threadMap = new ThreadSessionMap();
		threadMap.remember("t1", { sessionId: "agent-9" });
		const r = routeReply(
			{ text: "<@UBOT> go ahead", threadTs: "t1", user: "UNICK" },
			{ threadMap, allowedUserId: "UNICK" },
		);
		assert.equal(r.message, "go ahead");
	});

	it("routes explicit 'send <session> <message>' at top level", () => {
		const r = routeReply({ text: "send agent-42 rebase onto main", user: "UNICK" }, { allowedUserId: "UNICK" });
		assert.deepEqual(r, {
			ok: true,
			via: "explicit",
			sessionId: "agent-42",
			projectId: "",
			message: "rebase onto main",
		});
	});

	it("routes 'session: message' shorthand", () => {
		const r = routeReply({ text: "agent-42: rebase onto main", user: "UNICK" }, { allowedUserId: "UNICK" });
		assert.equal(r.ok, true);
		assert.equal(r.sessionId, "agent-42");
		assert.equal(r.message, "rebase onto main");
	});

	it("ignores the bot's own messages (loop prevention)", () => {
		assert.equal(routeReply({ text: "x", botId: "B1" }, {}).reason, "ignored_bot");
		assert.equal(routeReply({ text: "x", subtype: "bot_message" }, {}).reason, "ignored_bot");
	});

	it("rejects an unauthorized user when allow-list is configured", () => {
		const r = routeReply({ text: "send agent-1 hi", user: "UEVE" }, { allowedUserId: "UNICK" });
		assert.equal(r.reason, "unauthorized_user");
	});

	it("reports an unknown thread reply as a miss", () => {
		const threadMap = new ThreadSessionMap();
		const r = routeReply({ text: "hello", threadTs: "unknown", user: "UNICK" }, { threadMap, allowedUserId: "UNICK" });
		assert.equal(r.reason, "unknown_thread");
	});

	it("reports no route for unstructured top-level chatter", () => {
		assert.equal(routeReply({ text: "hi", user: "UNICK" }, { allowedUserId: "UNICK" }).reason, "no_route");
	});

	it("fails CLOSED when no allow-list is configured (security)", () => {
		const threadMap = new ThreadSessionMap();
		threadMap.remember("t1", { sessionId: "agent-9" });
		assert.equal(routeReply({ text: "go", threadTs: "t1", user: "UANY" }, { threadMap }).reason, "no_allowlist");
		assert.equal(routeReply({ text: "send agent-1 hi", user: "UANY" }, {}).reason, "no_allowlist");
	});

	it("does NOT route ordinary chatter as an explicit send (no bare-token routing)", () => {
		assert.equal(routeReply({ text: "hello world", user: "UNICK" }, { allowedUserId: "UNICK" }).reason, "no_route");
		assert.equal(
			routeReply({ text: "agent-1 do the thing", user: "UNICK" }, { allowedUserId: "UNICK" }).reason,
			"no_route",
		);
	});
});

describe("buildAoSendArgs", () => {
	it("builds argv for a valid route", () => {
		const args = buildAoSendArgs({ ok: true, sessionId: "agent-9", message: "go" });
		assert.deepEqual(args, ["send", "--session", "agent-9", "--message", "go"]);
	});
	it("returns null for a failed route", () => {
		assert.equal(buildAoSendArgs({ ok: false }), null);
		assert.equal(buildAoSendArgs({ ok: true, sessionId: "", message: "x" }), null);
	});
});

describe("Slack envelope helpers", () => {
	it("answers the url_verification handshake", () => {
		assert.deepEqual(urlVerificationResponse({ type: "url_verification", challenge: "abc" }), {
			challenge: "abc",
		});
		assert.equal(urlVerificationResponse({ type: "event_callback" }), null);
	});

	it("extracts a message event from an event_callback envelope", () => {
		const ev = extractMessageEvent({
			type: "event_callback",
			event: { type: "message", text: "hi", thread_ts: "t1", user: "UNICK", ts: "1.2", channel: "C1" },
		});
		assert.deepEqual(ev, {
			text: "hi",
			threadTs: "t1",
			ts: "1.2",
			user: "UNICK",
			botId: "",
			subtype: "",
			channel: "C1",
		});
	});

	it("returns null for non-message envelopes", () => {
		assert.equal(extractMessageEvent({ type: "event_callback", event: { type: "reaction_added" } }), null);
		assert.equal(extractMessageEvent({ type: "other" }), null);
	});
});

describe("ThreadSessionMap.mergeFrom (P1 fix)", () => {
	it("folds in newer bindings without dropping existing ones", () => {
		const a = new ThreadSessionMap();
		a.remember("t1", { sessionId: "x" });
		const b = new ThreadSessionMap();
		b.remember("t2", { sessionId: "y" });
		a.mergeFrom(b);
		assert.equal(a.lookup("t1").sessionId, "x");
		assert.equal(a.lookup("t2").sessionId, "y");
	});
	it("newer binding wins on key collision", () => {
		const a = new ThreadSessionMap();
		a.remember("t1", { sessionId: "old" });
		const b = new ThreadSessionMap();
		b.remember("t1", { sessionId: "new" });
		a.mergeFrom(b);
		assert.equal(a.lookup("t1").sessionId, "new");
	});
});
