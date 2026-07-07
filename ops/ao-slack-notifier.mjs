#!/usr/bin/env node
// ao-slack-notifier — read-only glue (decision D-b, adoption report).
// Consumes the ao daemon's notification stream and posts the operator-relevant
// notifications to Slack. Reads ao; never modifies it. No workflow logic lives here.
//
// Config (env or /home/orchestrator/agent-orchestrator/.env):
//   SLACK_BOT_TOKEN + SLACK_CHANNEL   -> chat.postMessage   (preferred)
//   SLACK_WEBHOOK_URL                 -> incoming webhook   (fallback)
//   SLACK_MEMBER_ID                   -> user id to @mention for attention
//   AO_PORT (default 3001)
//   AO_SLACK_NOTIFIER_STATE           -> persisted dedup cursor
//   AO_AGENT_HEALTH_POLL_MS           -> agent-health poll period (0 disables)
//   AO_AGENT_HEALTH_NOTIFIER_STATE    -> persisted per-harness health cursor
//
// Notifications forwarded:
//   needs_input    -> @mention
//   ready_to_merge -> @mention
//   pr_merged      -> plain post
//   pr_closed_unmerged -> plain post
//
// It also polls GET /api/v1/agents/health and @mentions on a harness going
// unhealthy (login expired / binary missing), with a recovery post — see
// agent-health-core.mjs.
//
// Reliability model: the live SSE stream has no durable sequence id today, so
// the notifier pairs it with a replay-safe catch-up poll of persisted unread
// notifications. A notification is marked read only after it has been delivered
// to Slack (or intentionally seeded during first bootstrap), which advances the
// server-side unread cursor so reconnects can drain backlogs larger than one
// API page without re-paging Nick.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { AgentHealthNotifier } from "./agent-health-core.mjs";
import { resolveMentionUserId } from "./attention-core.mjs";

const ENV_FILE = process.env.AO_ENV_FILE || "/home/orchestrator/agent-orchestrator/.env";
try {
	for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
		const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
		if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
	}
} catch {}

const PORT = process.env.AO_PORT || "3001";
const TOKEN = process.env.SLACK_BOT_TOKEN;
const CHANNEL = process.env.SLACK_CHANNEL;
const WEBHOOK = process.env.SLACK_WEBHOOK_URL;
// Acceptance #4 (issue #82): read SLACK_MEMBER_ID natively; the legacy
// SLACK_MENTION_USER_ID name is only a fallback for un-migrated hosts.
const MENTION_USER_ID = resolveMentionUserId();
const STATE_FILE = process.env.AO_SLACK_NOTIFIER_STATE || "/home/orchestrator/.ao/slack-notifier-state.json";
const SEEN_LIMIT = Number(process.env.AO_SLACK_NOTIFIER_SEEN_LIMIT || 2_000);
const HEARTBEAT_MS = Number(process.env.AO_SLACK_NOTIFIER_HEARTBEAT_MS || 15 * 60 * 1000);
const RECONNECT_MS = Number(process.env.AO_SLACK_NOTIFIER_RECONNECT_MS || 10_000);
const BOOTSTRAP_MODE = process.env.AO_SLACK_NOTIFIER_BOOTSTRAP_MODE || "attention_only";

if (isMain() && !(TOKEN && CHANNEL) && !WEBHOOK) {
	console.error(
		"ao-slack-notifier: no Slack sink configured. Add SLACK_BOT_TOKEN + SLACK_CHANNEL " +
			"(or SLACK_WEBHOOK_URL) to " +
			ENV_FILE +
			" — the app creds alone cannot post.",
	);
	process.exit(1);
}

async function post(text) {
	if (TOKEN && CHANNEL) {
		const r = await fetch("https://slack.com/api/chat.postMessage", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
			body: JSON.stringify({ channel: CHANNEL, text, unfurl_links: false }),
		});
		const j = await r.json();
		if (!j.ok) throw new Error(`slack error: ${j.error}`);
		return;
	}
	const r = await fetch(WEBHOOK, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text }),
	});
	if (r && r.ok === false) throw new Error(`slack webhook: HTTP ${r.status}`);
}

const INTERESTING = new Set(["needs_input", "ready_to_merge", "pr_merged", "pr_closed_unmerged"]);
const MENTIONABLE = new Set(["needs_input", "ready_to_merge"]);
const ICONS = { needs_input: "🖐️", ready_to_merge: "🟢", pr_merged: "🚀", pr_closed_unmerged: "🗑️" };

function isMain() {
	return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
}

export function normalizeNotification(raw) {
	if (!raw || typeof raw !== "object") return null;
	const n = raw.notification ?? raw.payload ?? raw;
	const type = n.type ?? n.kind ?? raw.type ?? raw.event ?? "";
	if (!INTERESTING.has(type)) return null;
	return {
		id: n.id ?? raw.id ?? null,
		type,
		sessionId: n.sessionId ?? n.session ?? raw.sessionId ?? "",
		projectId: n.projectId ?? n.project ?? raw.projectId ?? "",
		title: n.title ?? n.message ?? raw.title ?? "",
		body: n.body ?? raw.body ?? "",
		prUrl: n.prUrl ?? n.url ?? raw.prUrl ?? raw.url ?? "",
		createdAt: n.createdAt ?? raw.createdAt ?? "",
	};
}

export function notificationKey(raw) {
	const n = normalizeNotification(raw);
	if (!n) return null;
	return n.id || `${n.type}|${n.projectId}|${n.sessionId}|${n.createdAt}|${n.title}|${n.prUrl}`;
}

export function describeSlackMessage(raw, mentionUserId = MENTION_USER_ID) {
	const n = normalizeNotification(raw);
	if (!n) return null;
	const icon = ICONS[n.type] ?? "📌";
	const proj = n.projectId ? `[${n.projectId}] ` : "";
	const sess = n.sessionId ? `${n.sessionId}: ` : "";
	const title = n.title || n.body;
	const text = `${icon} *${n.type}* ${proj}${sess}${title} ${n.prUrl}`.trim();
	if (mentionUserId && MENTIONABLE.has(n.type)) return `<@${mentionUserId}> ${text}`;
	return text;
}

export function parseSSEFrames(buffer) {
	const frames = [];
	let rest = buffer;
	let idx;
	while ((idx = rest.indexOf("\n\n")) !== -1) {
		const frame = rest.slice(0, idx);
		rest = rest.slice(idx + 2);
		let id = "";
		let event = "";
		const data = [];
		for (const line of frame.split("\n")) {
			if (line.startsWith("id:")) id = line.slice(3).trim();
			else if (line.startsWith("event:")) event = line.slice(6).trim();
			else if (line.startsWith("data:")) data.push(line.slice(5).trim());
		}
		if (!data.length) continue;
		frames.push({ id, event, data: data.join("\n") });
	}
	return { frames, rest };
}

export function loadState(file = STATE_FILE) {
	try {
		const raw = JSON.parse(readFileSync(file, "utf8"));
		return {
			seen: new Set(Array.isArray(raw.seen) ? raw.seen : []),
			lastEventId: String(raw.lastEventId ?? ""),
			lastHeartbeatAt: Number(raw.lastHeartbeatAt ?? 0),
			initialized: Boolean(raw.initialized),
		};
	} catch {
		return { seen: new Set(), lastEventId: "", lastHeartbeatAt: 0, initialized: false };
	}
}

export function saveState(file, state, limit = SEEN_LIMIT, logger = console) {
	try {
		mkdirSync(dirname(file), { recursive: true });
		const seen = [...state.seen].slice(-limit);
		writeFileSync(
			file,
			JSON.stringify({
				seen,
				lastEventId: state.lastEventId || "",
				lastHeartbeatAt: state.lastHeartbeatAt || 0,
				initialized: Boolean(state.initialized),
			}),
			"utf8",
		);
	} catch (e) {
		logger?.warn?.("ao-slack-notifier: failed to persist state:", e.message);
	}
}

export class SlackNotificationNotifier {
	constructor({
		baseUrl = `http://127.0.0.1:${PORT}/api/v1`,
		state = loadState(),
		stateFile = STATE_FILE,
		mentionUserId = MENTION_USER_ID,
		postMessage = post,
		fetchImpl = globalThis.fetch,
		logger = console,
		clock = () => new Date(),
		heartbeatMs = HEARTBEAT_MS,
		reconnectMs = RECONNECT_MS,
		seenLimit = SEEN_LIMIT,
		bootstrapMode = BOOTSTRAP_MODE,
		pageLimit = 100,
	} = {}) {
		this.baseUrl = baseUrl.replace(/\/$/, "");
		this.state = state;
		this.stateFile = stateFile;
		this.mentionUserId = mentionUserId;
		this.postMessage = postMessage;
		this.fetchImpl = fetchImpl;
		this.logger = logger;
		this.clock = clock;
		this.heartbeatMs = heartbeatMs;
		this.reconnectMs = reconnectMs;
		this.seenLimit = seenLimit;
		this.bootstrapMode = bootstrapMode;
		this.pageLimit = pageLimit;
		this.consecutiveErrors = 0;
	}

	async catchUpUnread() {
		const sent = [];
		const bootstrapping = !this.state.initialized;
		for (;;) {
			const res = await this.fetchImpl(`${this.baseUrl}/notifications?status=unread&limit=${this.pageLimit}`, {
				headers: { accept: "application/json" },
			});
			if (!res.ok) throw new Error(`notifications list: HTTP ${res.status}`);
			const payload = await res.json();
			const list = Array.isArray(payload) ? payload : (payload.notifications ?? payload.data ?? []);
			// Oldest first keeps Slack chronology sensible after a reconnect gap.
			list.sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
			for (const raw of list) {
				const n = normalizeNotification(raw);
				// First deploy against an existing daemon can have a large backlog of old
				// unread informational notifications. Seed those as delivered so deploy
				// does not spam historical pr_merged posts, while still paging current
				// attention items that may have been silently missed before #87.
				if (bootstrapping && this.bootstrapMode === "attention_only" && n && !MENTIONABLE.has(n.type)) {
					await this.recordDelivered(raw, { post: false });
					continue;
				}
				if (await this.handleNotification(raw)) sent.push(n);
			}
			if (list.length < this.pageLimit) break;
		}
		if (bootstrapping) {
			this.state.initialized = true;
			saveState(this.stateFile, this.state, this.seenLimit, this.logger);
		}
		return sent;
	}

	async markRead(id) {
		if (!id) return;
		const res = await this.fetchImpl(`${this.baseUrl}/notifications/${encodeURIComponent(id)}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify({ status: "read" }),
		});
		if (!res.ok) throw new Error(`notifications mark-read ${id}: HTTP ${res.status}`);
	}

	async recordDelivered(raw, { post: shouldPost = true } = {}) {
		const key = notificationKey(raw);
		const n = normalizeNotification(raw);
		if (!key || !n) return false;
		if (!this.state.seen.has(key)) {
			const msg = shouldPost ? describeSlackMessage(raw, this.mentionUserId) : null;
			if (shouldPost && !msg) return false;
			if (msg) await this.postMessage(msg);
		}
		this.state.seen.add(key);
		this.pruneSeen();
		saveState(this.stateFile, this.state, this.seenLimit, this.logger);
		await this.markRead(n.id);
		return !this.state.seen.has(key) || shouldPost;
	}

	async handleNotification(raw) {
		const key = notificationKey(raw);
		if (!key) return false;
		if (this.state.seen.has(key)) {
			await this.recordDelivered(raw, { post: false });
			return false;
		}
		return this.recordDelivered(raw);
	}

	pruneSeen() {
		if (this.state.seen.size <= this.seenLimit) return;
		this.state.seen = new Set([...this.state.seen].slice(-this.seenLimit));
	}

	async maybeHeartbeat() {
		const now = this.clock().getTime();
		if (now - this.state.lastHeartbeatAt < this.heartbeatMs) return;
		this.state.lastHeartbeatAt = now;
		saveState(this.stateFile, this.state, this.seenLimit, this.logger);
		this.logger.info?.(`ao-slack-notifier heartbeat: watching ${this.baseUrl}/notifications/stream`);
	}

	async alertUnhealthy(message) {
		if (this.consecutiveErrors !== 3) return;
		const prefix = this.mentionUserId ? `<@${this.mentionUserId}> ` : "";
		try {
			await this.postMessage(
				`${prefix}❤️‍🩹 *daemon_unhealthy* Slack notifier cannot reach ao notifications (${message}) — alerts may be delayed until catch-up succeeds.`,
			);
		} catch (e) {
			this.logger.error?.("ao-slack-notifier: health alert failed:", e.message);
		}
	}

	async streamOnce({ signal } = {}) {
		await this.catchUpUnread();
		await this.maybeHeartbeat();
		const headers = { accept: "text/event-stream" };
		if (this.state.lastEventId) headers["Last-Event-ID"] = this.state.lastEventId;
		const res = await this.fetchImpl(`${this.baseUrl}/notifications/stream`, { headers, signal });
		if (!res.ok || !res.body) throw new Error(`notifications stream: HTTP ${res.status}`);
		this.consecutiveErrors = 0;
		this.logger.info?.("connected to ao notification stream");
		let buf = "";
		for await (const chunk of res.body) {
			buf += Buffer.from(chunk).toString("utf8");
			const parsed = parseSSEFrames(buf);
			buf = parsed.rest;
			for (const frame of parsed.frames) {
				let raw;
				try {
					raw = JSON.parse(frame.data);
				} catch {
					continue;
				}
				await this.handleNotification(raw);
				if (frame.id) {
					this.state.lastEventId = frame.id;
					saveState(this.stateFile, this.state, this.seenLimit, this.logger);
				}
			}
		}
		throw new Error("stream ended");
	}

	async run({ signal } = {}) {
		for (;;) {
			if (signal?.aborted) return;
			try {
				await this.streamOnce({ signal });
			} catch (e) {
				if (signal?.aborted) return;
				this.consecutiveErrors += 1;
				this.logger.error?.("notification stream error, reconnecting:", e.message);
				await this.alertUnhealthy(e.message);
				await new Promise((r) => setTimeout(r, this.reconnectMs));
			}
		}
	}
}

if (isMain()) {
	const notifier = new SlackNotificationNotifier();
	const loops = [
		notifier.run().catch((e) => {
			console.error("ao-slack-notifier fatal:", e.message);
			process.exit(1);
		}),
	];
	// Agent-health alerting shares this process (and the same Slack sink) so a
	// deploy that restarts ao-slack-notifier.service picks it up. Disabled with
	// AO_AGENT_HEALTH_POLL_MS=0 for hosts that don't want it.
	const healthPollMs = Number(process.env.AO_AGENT_HEALTH_POLL_MS || 60_000);
	if (healthPollMs > 0) {
		const health = new AgentHealthNotifier({
			mentionUserId: MENTION_USER_ID,
			host: hostname(),
			postMessage: post,
			pollMs: healthPollMs,
		});
		loops.push(
			health.run().catch((e) => {
				console.error("ao-agent-health fatal:", e.message);
			}),
		);
	}
	Promise.all(loops);
}
