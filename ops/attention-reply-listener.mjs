// attention-reply-listener — the inbound (two-way) half of issue #82.
// A minimal HTTP endpoint for the Slack Events API. When Nick replies in
// Slack (threaded reply to an alert, or an explicit "send <session> …"), the
// message is verified, routed to the originating session, and delivered via
// `ao send`. Nick can unblock a waiting worker from his phone.
//
// The request handler is injectable (verify, route, aoSend, threadMap) so the
// full path is unit-tested without a socket or a live daemon. The HTTP wiring
// + `ao send` exec live behind isMain().
//
// Vanilla rule: delivery shells out to the public `ao send` CLI; no ao core.

import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";

import {
	buildAoSendArgs,
	extractMessageEvent,
	routeReply,
	ThreadSessionMap,
	urlVerificationResponse,
	verifySlackSignature,
} from "./slack-reply-core.mjs";
import { loadEnvFile, loadState } from "./attention-notifier.mjs";
import { resolveMentionUserId } from "./attention-core.mjs";

// handleSlackRequest processes one raw inbound request body + headers and
// returns { status, body, sent? }. Pure aside from the injected aoSend.
export async function handleSlackRequest({
	rawBody,
	headers,
	signingSecret,
	threadMap,
	aoSend,
	allowedUserId,
	now = Date.now(),
	logger = console,
	refreshThreadMap,
}) {
	const ts = headers["x-slack-request-timestamp"];
	const sig = headers["x-slack-signature"];
	if (!verifySlackSignature({ signingSecret, timestamp: ts, body: rawBody, signature: sig, now })) {
		return { status: 401, body: "bad signature" };
	}

	let payload;
	try {
		payload = JSON.parse(rawBody);
	} catch {
		return { status: 400, body: "bad json" };
	}

	// Slack subscription handshake.
	const challenge = urlVerificationResponse(payload);
	if (challenge) return { status: 200, body: JSON.stringify(challenge), contentType: "application/json" };

	const msg = extractMessageEvent(payload);
	if (!msg) return { status: 200, body: "" }; // ack non-message events

	// Pick up thread->session bindings the notifier persisted AFTER this
	// listener started. Without this, a reply to any alert emitted post-startup
	// misses the in-memory map and is dropped as unknown_thread.
	if (typeof refreshThreadMap === "function") {
		try {
			refreshThreadMap(threadMap);
		} catch (e) {
			logger.error?.("reply-listener: thread map refresh failed:", e.message);
		}
	}

	const route = routeReply(msg, { threadMap, allowedUserId });
	if (!route.ok) {
		logger.info?.(`reply-listener: ignored (${route.reason})`);
		return { status: 200, body: "" };
	}

	const args = buildAoSendArgs(route);
	if (!args) return { status: 200, body: "" };
	try {
		await aoSend(args);
		logger.info?.(`reply-listener: routed to ${route.sessionId} via ${route.via}`);
		const sent = { sessionId: route.sessionId };
		if (route.option !== undefined) sent.option = route.option;
		else sent.message = route.message;
		return { status: 200, body: "", sent };
	} catch (e) {
		if (route.option !== undefined && shouldFallbackToSend(e)) {
			const fallbackArgs = buildAoSendArgs({ ok: true, sessionId: route.sessionId, message: route.message });
			if (fallbackArgs) {
				try {
					await aoSend(fallbackArgs);
					logger.info?.(`reply-listener: fell back to ao send for ${route.sessionId}`);
					return { status: 200, body: "", sent: { sessionId: route.sessionId, message: route.message } };
				} catch (fallbackErr) {
					logger.error?.("reply-listener: ao send fallback failed:", fallbackErr.message);
					return { status: 200, body: "" };
				}
			}
		}
		logger.error?.("reply-listener: ao command failed:", e.message);
		return { status: 200, body: "" }; // still 200 so Slack does not retry-storm
	}
}

function shouldFallbackToSend(err) {
	const message = err?.message ?? "";
	return /SESSION_DECISION_NOT_FOUND|SESSION_DECISION_NOT_ANSWERABLE|INVALID_DECISION_ANSWER/.test(message);
}

// default aoSend: exec the public `ao` CLI.
export function execAoSend(args, { bin = process.env.AO_BIN || "ao" } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
		let err = "";
		child.stderr.on("data", (d) => (err += d));
		child.on("error", reject);
		child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err || `ao exited ${code}`))));
	});
}

function readBody(req) {
	return new Promise((resolve) => {
		let b = "";
		req.on("data", (c) => (b += c));
		req.on("end", () => resolve(b));
	});
}

function isMain() {
	return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
}

export function createServer({ signingSecret, threadMap, aoSend, allowedUserId, logger = console, refreshThreadMap }) {
	return http.createServer(async (req, res) => {
		if (req.method !== "POST" || !/\/slack\/events\/?$/.test(req.url || "")) {
			res.writeHead(404);
			res.end("not found");
			return;
		}
		const rawBody = await readBody(req);
		const headers = {
			"x-slack-request-timestamp": req.headers["x-slack-request-timestamp"],
			"x-slack-signature": req.headers["x-slack-signature"],
		};
		const out = await handleSlackRequest({
			rawBody,
			headers,
			signingSecret,
			threadMap,
			aoSend,
			allowedUserId,
			logger,
			refreshThreadMap,
		});
		res.writeHead(out.status, { "content-type": out.contentType || "text/plain" });
		res.end(out.body || "");
	});
}

async function main() {
	loadEnvFile();
	const signingSecret = process.env.SLACK_SIGNING_SECRET;
	if (!signingSecret) {
		console.error("attention-reply-listener: SLACK_SIGNING_SECRET is required for inbound verification");
		process.exit(1);
	}
	const { threadMap } = loadState();
	// Honor the same member-id resolution as outbound alerts (SLACK_MEMBER_ID,
	// with the legacy SLACK_MENTION_USER_ID fallback) so un-migrated hosts can
	// still reply-to-unblock instead of failing closed.
	const allowedUserId = resolveMentionUserId() || undefined;
	if (!allowedUserId) {
		console.error(
			"attention-reply-listener: no SLACK_MEMBER_ID/SLACK_MENTION_USER_ID; inbound replies will be rejected (fail-closed).",
		);
	}
	const port = Number(process.env.AO_ATTENTION_REPLY_PORT || 3002);
	const server = createServer({
		signingSecret,
		threadMap,
		aoSend: execAoSend,
		allowedUserId,
		logger: console,
		// Re-read the shared state file so bindings the notifier persists after
		// this listener started are visible to threaded replies.
		refreshThreadMap: (tm) => {
			const fresh = loadState();
			tm.mergeFrom(fresh.threadMap);
		},
	});
	server.listen(port, "127.0.0.1", () => console.log(`attention-reply-listener on 127.0.0.1:${port}/slack/events`));
}

if (isMain()) main();

export { ThreadSessionMap };
