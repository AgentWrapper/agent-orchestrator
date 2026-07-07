// slack-reply-core — pure logic for the inbound (two-way) half of the
// attention system (issue #82, acceptance #2). Nick replies in Slack and the
// message is routed back to the waiting worker via `ao send`.
//
// This module holds ONLY pure functions: request-signature verification,
// thread<->session mapping, and turning a Slack event into an `ao send`
// intent. The HTTP listener and the actual `ao send` exec live in the runner.
//
// Vanilla rule: routing shells out to the public `ao send` CLI. No ao core.

import { createHmac, timingSafeEqual } from "node:crypto";

// Slack signs every request: v0=HMAC-SHA256(signing_secret, "v0:ts:body").
// https://api.slack.com/authentication/verifying-requests-from-slack
export function verifySlackSignature({ signingSecret, timestamp, body, signature, now = Date.now() }) {
	if (!signingSecret || !timestamp || !signature) return false;
	// Reject stale timestamps (replay protection): 5 minute window.
	const ts = Number(timestamp);
	if (!Number.isFinite(ts)) return false;
	if (Math.abs(now / 1000 - ts) > 60 * 5) return false;
	const base = `v0:${timestamp}:${body}`;
	const expected = `v0=${createHmac("sha256", signingSecret).update(base).digest("hex")}`;
	const a = Buffer.from(expected);
	const b = Buffer.from(signature);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

// ThreadSessionMap remembers which Slack message thread corresponds to which
// ao session, so a threaded reply routes back to the originating worker. The
// outbound alerter records the mapping when it posts an alert (thread_ts ->
// {projectId, sessionId}); the inbound router looks it up on a reply.
export class ThreadSessionMap {
	constructor({ max = 5000 } = {}) {
		this.map = new Map();
		this.max = max;
	}

	remember(threadTs, target) {
		if (!threadTs || !target || !target.sessionId) return;
		// bounded LRU-ish: drop oldest on overflow
		if (this.map.size >= this.max) {
			const oldest = this.map.keys().next().value;
			this.map.delete(oldest);
		}
		this.map.delete(threadTs);
		this.map.set(threadTs, { projectId: target.projectId ?? "", sessionId: target.sessionId });
	}

	lookup(threadTs) {
		return this.map.get(threadTs) ?? null;
	}

	// mergeFrom folds another map's bindings into this one (newer wins). Used by
	// the reply listener to pick up bindings the notifier persisted after the
	// listener started, without dropping any it already holds.
	mergeFrom(other) {
		if (!other || !other.map) return this;
		for (const [k, v] of other.map) {
			this.map.delete(k);
			this.map.set(k, v);
		}
		while (this.map.size > this.max) {
			const oldest = this.map.keys().next().value;
			this.map.delete(oldest);
		}
		return this;
	}

	serialize() {
		return JSON.stringify([...this.map.entries()]);
	}

	static deserialize(json) {
		const m = new ThreadSessionMap();
		try {
			for (const [k, v] of JSON.parse(json)) m.map.set(k, v);
		} catch {}
		return m;
	}
}

// Explicit-session syntax lets Nick target a session without a threaded reply.
// It requires an UNAMBIGUOUS separator so ordinary chatter is never misrouted:
//   - a "send" verb:      "send <session> <message>" / "@ao send <session> <msg>"
//   - or a colon marker:  "<session>: <message>"
// Plain "hello world" must NOT parse as session "hello".
const EXPLICIT_SEND_RE = /^\s*(?:@ao\s+)?send\s+([A-Za-z0-9][A-Za-z0-9_-]{2,})\s+([\s\S]+)$/;
const EXPLICIT_COLON_RE = /^\s*([A-Za-z0-9][A-Za-z0-9_-]{2,}):\s+([\s\S]+)$/;

// routeReply turns a normalized Slack message into an `ao send` intent, or a
// reason it was ignored. It never executes anything.
//
// message: { text, threadTs, user, botId, subtype }
// opts: { threadMap, selfBotId, allowedUserId }
export function routeReply(message, { threadMap, selfBotId, allowedUserId } = {}) {
	if (!message || typeof message.text !== "string") {
		return { ok: false, reason: "no_text" };
	}
	// Ignore the notifier's own messages and any bot echo to prevent loops.
	if (message.botId || message.subtype === "bot_message") {
		return { ok: false, reason: "ignored_bot" };
	}
	if (selfBotId && message.user === selfBotId) {
		return { ok: false, reason: "ignored_self" };
	}
	// Fail CLOSED: worker control is only routed when an allow-list is
	// configured AND the author matches it. A missing allow-list must never
	// mean "allow everyone" — that would expose `ao send` to anyone who can
	// post to the subscribed Slack surface.
	if (!allowedUserId) {
		return { ok: false, reason: "no_allowlist" };
	}
	if (message.user !== allowedUserId) {
		return { ok: false, reason: "unauthorized_user" };
	}

	const text = message.text.trim();
	if (!text) return { ok: false, reason: "empty" };

	// 1) Threaded reply -> route to the session bound to that thread.
	if (message.threadTs && threadMap) {
		const target = threadMap.lookup(message.threadTs);
		if (target) {
			return {
				ok: true,
				via: "thread",
				sessionId: target.sessionId,
				projectId: target.projectId,
				message: stripLeadingMention(text),
			};
		}
		// A threaded reply to an unknown thread is a miss, not an explicit cmd.
		return { ok: false, reason: "unknown_thread" };
	}

	// 2) Explicit "send <session> <message>" syntax at top level.
	const sendMatch = text.match(EXPLICIT_SEND_RE) ?? text.match(EXPLICIT_COLON_RE);
	if (sendMatch) {
		return { ok: true, via: "explicit", sessionId: sendMatch[1], projectId: "", message: sendMatch[2].trim() };
	}

	return { ok: false, reason: "no_route" };
}

function stripLeadingMention(text) {
	// Remove a leading "<@Uxxx>" mention of the bot if Nick @-replied it.
	return text.replace(/^<@[UW][A-Z0-9]+>\s*/, "").trim();
}

// buildAoSendArgs renders the argv for `ao send` from a successful route.
// Kept here so the exec surface is trivially auditable and testable.
export function buildAoSendArgs(route) {
	if (!route || !route.ok || !route.sessionId || !route.message) return null;
	return ["send", "--session", route.sessionId, "--message", route.message];
}

// Slack URL-verification handshake: echo the challenge on subscription setup.
export function urlVerificationResponse(payload) {
	if (payload && payload.type === "url_verification" && typeof payload.challenge === "string") {
		return { challenge: payload.challenge };
	}
	return null;
}

// extractMessageEvent pulls the normalized message shape out of a Slack Events
// API envelope ({type:'event_callback', event:{...}}). Returns null if the
// envelope is not a user message event we care about.
export function extractMessageEvent(payload) {
	if (!payload || payload.type !== "event_callback" || !payload.event) return null;
	const e = payload.event;
	if (e.type !== "message" && e.type !== "app_mention") return null;
	return {
		text: e.text ?? "",
		threadTs: e.thread_ts ?? "",
		ts: e.ts ?? "",
		user: e.user ?? "",
		botId: e.bot_id ?? "",
		subtype: e.subtype ?? "",
		channel: e.channel ?? "",
	};
}
