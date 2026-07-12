#!/usr/bin/env node
// ao-slack-notifier — read-only glue (decision D-b, adoption report).
// Consumes the ao daemon's notification stream and posts the operator-relevant
// notifications to Slack. Reads ao; never modifies it. No workflow logic lives here.
//
// Config (env or /home/orchestrator/agent-orchestrator/.env):
//   SLACK_BOT_TOKEN + SLACK_CHANNEL_NOTIFY / SLACK_CHANNEL_NEEDS_RESPONSE -> chat.postMessage (preferred)
//   SLACK_BOT_TOKEN + SLACK_CHANNEL   -> single-channel legacy fallback
//   SLACK_WEBHOOK_URL                 -> incoming webhook   (fallback)
//   SLACK_MEMBER_ID                   -> user id to @mention for attention
//   AO_PORT (default 3001)
//   AO_SLACK_NOTIFIER_STATE           -> persisted dedup cursor
//   AO_SESSION_ATTENTION_POLL_MS      -> session attention poll period (0 disables)
//   AO_MAIN_CI_POLL_MS                -> main-branch CI poll/cache period (default 60s)
//   AO_AGENT_HEALTH_POLL_MS           -> agent-health poll period (0 disables)
//   AO_AGENT_HEALTH_NOTIFIER_STATE    -> persisted per-harness health cursor
//
// Notifications forwarded:
//   needs_input    -> @mention
//   ready_to_merge -> plain post, or @mention when server-marked sensitive
//   pr_merged      -> plain post
//   pr_closed_unmerged -> plain post
//   orchestrator_replaced -> plain post
//   orchestrator_replacement_capped -> @mention (needs-response)
//   worker_died_unfinished -> plain post
//   worker_retry_exhausted -> @mention (needs-response)
//   duplicate_pr -> @mention
//
// It also polls GET /api/v1/sessions and @mentions on blocked, no_signal,
// orchestrator_dead, and daemon_unhealthy conditions. A changed "what needs
// me" digest is posted when the current attention set changes.
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

import { AgentHealthNotifier } from "./agent-health-core.mjs";
import {
	AttentionTracker,
	attentionFromSessions,
	renderAlert,
	renderDigest,
	resolveMentionUserId,
	signature,
} from "./attention-core.mjs";
import { loadEnvFile } from "./env-file.mjs";
import { isMainModule } from "./main-module.mjs";

const ENV_FILE = process.env.AO_ENV_FILE || "/home/orchestrator/agent-orchestrator/.env";
loadEnvFile(ENV_FILE);

const PORT = process.env.AO_PORT || "3001";
const TOKEN = process.env.SLACK_BOT_TOKEN;
const LEGACY_CHANNEL = process.env.SLACK_CHANNEL;
const NOTIFY_CHANNEL = process.env.SLACK_CHANNEL_NOTIFY || LEGACY_CHANNEL || process.env.SLACK_CHANNEL_NEEDS_RESPONSE;
const NEEDS_RESPONSE_CHANNEL = process.env.SLACK_CHANNEL_NEEDS_RESPONSE || LEGACY_CHANNEL || NOTIFY_CHANNEL;
const WEBHOOK = process.env.SLACK_WEBHOOK_URL;
// Acceptance #4 (issue #82): read SLACK_MEMBER_ID natively; the legacy
// SLACK_MENTION_USER_ID name is only a fallback for un-migrated hosts.
const MENTION_USER_ID = resolveMentionUserId();
const STATE_FILE = process.env.AO_SLACK_NOTIFIER_STATE || "/home/orchestrator/.ao/slack-notifier-state.json";
const SEEN_LIMIT = Number(process.env.AO_SLACK_NOTIFIER_SEEN_LIMIT || 2_000);
const HEARTBEAT_MS = Number(process.env.AO_SLACK_NOTIFIER_HEARTBEAT_MS || 15 * 60 * 1000);
const RECONNECT_MS = Number(process.env.AO_SLACK_NOTIFIER_RECONNECT_MS || 10_000);
// Belt-and-suspenders content dedupe (issue #190): even if the daemon emits a
// fresh notification row for an unchanged PR state, suppress a Slack post whose
// (session, type, pr, sensitive) signature matches the last one we posted
// within this window. The lifecycle emitter is the primary, head-SHA-aware
// dedupe; this coarse cooldown only guards against re-fires the emitter missed
// (e.g. a pre-fix daemon, a replay, or a bug). 0 disables it.
const DEDUPE_COOLDOWN_MS = Number(process.env.AO_SLACK_NOTIFIER_DEDUPE_COOLDOWN_MS || 60 * 60 * 1000);
const BOOTSTRAP_MODE = process.env.AO_SLACK_NOTIFIER_BOOTSTRAP_MODE || "attention_only";
const SESSION_ATTENTION_POLL_MS = parsePollMs(process.env.AO_SESSION_ATTENTION_POLL_MS, 10_000);
const MAIN_CI_POLL_MS = parsePollMs(process.env.AO_MAIN_CI_POLL_MS, 60_000);

if (isMain() && !(TOKEN && (NOTIFY_CHANNEL || NEEDS_RESPONSE_CHANNEL)) && !WEBHOOK) {
	console.error(
		"ao-slack-notifier: no Slack sink configured. Add SLACK_BOT_TOKEN + SLACK_CHANNEL_NOTIFY/SLACK_CHANNEL_NEEDS_RESPONSE " +
			"(or legacy SLACK_CHANNEL) " +
			"(or SLACK_WEBHOOK_URL) to " +
			ENV_FILE +
			" — the app creds alone cannot post.",
	);
	process.exit(1);
}

async function post(text, { channel = NOTIFY_CHANNEL } = {}) {
	if (TOKEN && channel) {
		const r = await fetch("https://slack.com/api/chat.postMessage", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
			body: JSON.stringify({ channel, text, unfurl_links: false }),
		});
		const j = await r.json();
		if (!j.ok) throw new Error(`slack error: ${j.error}`);
		return { ts: j.ts };
	}
	const r = await fetch(WEBHOOK, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text }),
	});
	if (r && r.ok === false) throw new Error(`slack webhook: HTTP ${r.status}`);
}

async function updatePost(ts, text, { channel = NEEDS_RESPONSE_CHANNEL } = {}) {
	if (!(TOKEN && channel && ts)) return false;
	const r = await fetch("https://slack.com/api/chat.update", {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
		body: JSON.stringify({ channel, ts, text, unfurl_links: false }),
	});
	const j = await r.json();
	if (!j.ok) throw new Error(`slack update error: ${j.error}`);
	return true;
}

const INTERESTING = new Set([
	"needs_input",
	"ready_to_merge",
	"pr_merged",
	"pr_closed_unmerged",
	"orchestrator_replaced",
	"orchestrator_replacement_capped",
	"duplicate_pr",
	"worker_died_unfinished",
	"worker_retry_exhausted",
	"main_ci_red",
]);
const POLL_ALERT_KINDS = new Set(["blocked", "orchestrator_dead", "no_signal", "main_ci_red"]);
const ICONS = {
	needs_input: "🖐️",
	ready_to_merge: "🟢",
	parked_sensitive_merge: "🛑",
	pr_merged: "🚀",
	pr_closed_unmerged: "🗑️",
	orchestrator_replaced: "🔁",
	orchestrator_replacement_capped: "🚨",
	duplicate_pr: "♊",
	worker_died_unfinished: "🧯",
	worker_retry_exhausted: "🚨",
	main_ci_red: "🚨",
};

export function digestContentKey(records) {
	return (records ?? [])
		.filter((r) => r && r.attention)
		.map((r) => `${signature(r)}|${r.title}|${r.url ?? ""}`)
		.sort()
		.join("\n");
}

export function parsePollMs(raw, fallback) {
	if (raw == null || raw === "") return fallback;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 0) return fallback;
	if (n === 0) return 0;
	return Math.max(1_000, n);
}

export async function fetchMainCI({
	repo = process.env.AO_MAIN_CI_REPO || process.env.POLYPOWERS_REPO || process.env.AO_PROJECT_REPO || "",
	projectId = process.env.AO_MAIN_CI_PROJECT_ID || process.env.AO_PROJECT_ID || "ao",
	ref = process.env.AO_MAIN_CI_REF || "main",
	fetchImpl = globalThis.fetch,
	token = process.env.AO_GITHUB_TOKEN || process.env.GITHUB_TOKEN || "",
} = {}) {
	repo = String(repo || "").trim();
	if (!repo) return [];
	const headers = { accept: "application/vnd.github+json" };
	if (token) headers.authorization = `Bearer ${token}`;
	const res = await fetchImpl(
		`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`,
		{
			headers,
		},
	);
	if (!res.ok) throw new Error(`main CI: HTTP ${res.status}`);
	const payload = await res.json();
	const runs = Array.isArray(payload.check_runs) ? payload.check_runs : [];
	if (runs.length === 0) return [];
	if (Number(payload.total_count || 0) > runs.length) {
		throw new Error(`main CI: check runs truncated at ${runs.length}/${payload.total_count}`);
	}
	// The notifier pages only on hard-red conclusions. Deploy verification is
	// stricter and blocks on action_required/pending states because mutation must
	// fail closed when main is not known green.
	const bad = new Set(["failure", "cancelled", "timed_out"]);
	const failed = runs.filter(
		(r) => String(r.status || "").toLowerCase() === "completed" && bad.has(String(r.conclusion || "").toLowerCase()),
	);
	if (failed.length === 0) return [];
	const sha = String(failed[0]?.head_sha || runs[0]?.head_sha || ref);
	return [
		{
			projectId,
			status: "failing",
			sha,
			failedJobs: failed.map((r) => r.name || "unknown"),
			url: failed[0]?.html_url || `https://github.com/${repo}/actions`,
		},
	];
}

function sleep(ms, signal) {
	if (signal?.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		let timer;
		const done = () => {
			clearTimeout(timer);
			signal?.removeEventListener?.("abort", done);
			resolve();
		};
		timer = setTimeout(done, ms);
		signal?.addEventListener?.("abort", done, { once: true });
	});
}

function isMain() {
	return isMainModule(import.meta.url);
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
		sensitive: Boolean(n.sensitive ?? raw.sensitive),
		changedPaths: Array.isArray(n.changedPaths)
			? n.changedPaths
			: Array.isArray(raw.changedPaths)
				? raw.changedPaths
				: [],
		headSha: n.headSha ?? n.head_sha ?? raw.headSha ?? raw.head_sha ?? "",
		createdAt: n.createdAt ?? raw.createdAt ?? "",
	};
}

function notificationLabel(n) {
	if (n.type === "ready_to_merge" && n.sensitive) return "parked_sensitive_merge";
	return n.type;
}

function isMentionableNotification(n) {
	// duplicate_pr is a loud operator alert (issue #181): the fleet opened a
	// second PR for one issue and a human should intervene, so @mention it.
	return (
		n.type === "needs_input" ||
		n.type === "orchestrator_replacement_capped" ||
		n.type === "duplicate_pr" ||
		n.type === "worker_retry_exhausted" ||
		n.type === "main_ci_red" ||
		(n.type === "ready_to_merge" && n.sensitive)
	);
}

function isNeedsResponseNotification(n) {
	return (
		n.type === "needs_input" ||
		n.type === "orchestrator_replacement_capped" ||
		n.type === "main_ci_red" ||
		// Consecutive worker deaths exhausted the respawn cap (issue #230): respawns
		// are suspended and a human must intervene, so track it in the needs-response
		// channel until resolved rather than letting a one-shot @mention scroll away.
		n.type === "worker_retry_exhausted" ||
		(n.type === "ready_to_merge" && n.sensitive)
	);
}

function isTerminalPRNotification(n) {
	return n?.type === "pr_merged" || n?.type === "pr_closed_unmerged";
}

function needsResponseRecordFromNotification(raw) {
	const n = normalizeNotification(raw);
	if (!n || !isNeedsResponseNotification(n)) return null;
	return {
		kind: notificationLabel(n),
		sessionId: String(n.sessionId ?? ""),
		projectId: String(n.projectId ?? ""),
		title: String(n.title || n.body || ""),
		url: String(n.prUrl ?? ""),
		headSha: String(n.headSha ?? ""),
		attention: true,
	};
}

function needsResponseSignature(rec) {
	if (!rec) return "";
	const url = rec.url ? `|${rec.url}` : "";
	const head = rec.headSha ? `|${rec.headSha}` : "";
	return `${signature(rec)}${url}${head}`;
}

function renderResolvedNeedsResponse(rec, { reason, resolvedAt = new Date(), clearedBy = "" } = {}) {
	const stamp = (resolvedAt instanceof Date ? resolvedAt : new Date(resolvedAt)).toISOString().replace(/\.\d+Z$/, "Z");
	const base = renderAlert(rec, "");
	const detail = clearedBy ? `${reason}: ${clearedBy}` : reason;
	return `✅ *resolved* ~${base}~\n_resolved at ${stamp}${detail ? ` · ${detail}` : ""}_`;
}

export function notificationKey(raw) {
	const n = normalizeNotification(raw);
	if (!n) return null;
	return n.id || `${n.type}|${n.projectId}|${n.sessionId}|${n.createdAt}|${n.title}|${n.prUrl}`;
}

// contentSignature ignores the per-row id and createdAt (which change on every
// re-emission of the same underlying state) and fingerprints only the facts the
// operator actually sees: session, type, PR, and the sensitive flag. Two
// notifications with the same content signature describe the same state, so the
// cooldown suppresses the second post regardless of a fresh id/timestamp.
export function contentSignature(raw) {
	const n = normalizeNotification(raw);
	if (!n) return null;
	// head SHA is part of the signature: a new push (new head) is a real state
	// change that must re-notify even inside the cooldown window (issue #190).
	return `${n.type}|${n.projectId}|${n.sessionId}|${n.prUrl}|${n.sensitive ? "1" : "0"}|${n.headSha ?? ""}`;
}

export function describeSlackMessage(raw, mentionUserId = MENTION_USER_ID) {
	const n = normalizeNotification(raw);
	if (!n) return null;
	const label = notificationLabel(n);
	const icon = ICONS[label] ?? "📌";
	const proj = n.projectId ? `[${n.projectId}] ` : "";
	const sess = n.sessionId ? `${n.sessionId}: ` : "";
	const title = n.title || n.body;
	const text = `${icon} *${label}* ${proj}${sess}${title} ${n.prUrl}`.trim();
	if (mentionUserId && isMentionableNotification(n)) return `<@${mentionUserId}> ${text}`;
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

function requireSessionListPayload(payload) {
	if (Array.isArray(payload)) return;
	if (Array.isArray(payload?.sessions)) return;
	if (Array.isArray(payload?.data)) return;
	throw new Error("sessions: invalid payload shape");
}

export function loadState(file = STATE_FILE) {
	try {
		const raw = JSON.parse(readFileSync(file, "utf8"));
		return {
			seen: new Set(Array.isArray(raw.seen) ? raw.seen : []),
			lastEventId: String(raw.lastEventId ?? ""),
			lastHeartbeatAt: Number(raw.lastHeartbeatAt ?? 0),
			initialized: Boolean(raw.initialized),
			attentionTracker: AttentionTracker.deserialize(raw.attentionTracker ?? { open: [] }),
			lastDigestKey: raw.lastDigestKey ?? null,
			digestTs: raw.digestTs ?? null,
			postedSignatures: normalizePostedSignatures(raw.postedSignatures),
			needsResponseMessages: normalizeNeedsResponseMessages(raw.needsResponseMessages),
		};
	} catch {
		return {
			seen: new Set(),
			lastEventId: "",
			lastHeartbeatAt: 0,
			initialized: false,
			attentionTracker: new AttentionTracker(),
			lastDigestKey: null,
			digestTs: null,
			postedSignatures: {},
			needsResponseMessages: {},
		};
	}
}

// normalizePostedSignatures coerces the persisted {signature: epochMs} map back
// into a plain object of finite numbers, dropping any corrupt entries so a bad
// state file degrades to "no cooldown recorded" rather than crashing the loop.
function normalizePostedSignatures(raw) {
	const out = {};
	if (!raw || typeof raw !== "object") return out;
	for (const [sig, ts] of Object.entries(raw)) {
		const n = Number(ts);
		if (Number.isFinite(n)) out[sig] = n;
	}
	return out;
}

function normalizeNeedsResponseMessages(raw) {
	const out = {};
	if (!raw || typeof raw !== "object") return out;
	for (const [sig, msg] of Object.entries(raw)) {
		if (!msg || typeof msg !== "object") continue;
		out[sig] = {
			ts: String(msg.ts ?? ""),
			channel: String(msg.channel ?? ""),
			text: String(msg.text ?? ""),
			record: msg.record && typeof msg.record === "object" ? msg.record : null,
			openedAt: String(msg.openedAt ?? ""),
		};
	}
	return out;
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
				attentionTracker: state.attentionTracker ? JSON.parse(state.attentionTracker.serialize()) : { open: [] },
				lastDigestKey: state.lastDigestKey ?? null,
				digestTs: state.digestTs ?? null,
				postedSignatures: state.postedSignatures ?? {},
				needsResponseMessages: state.needsResponseMessages ?? {},
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
		state,
		stateFile = STATE_FILE,
		mentionUserId = MENTION_USER_ID,
		notifyChannel = NOTIFY_CHANNEL,
		needsResponseChannel = NEEDS_RESPONSE_CHANNEL,
		postMessage = post,
		updateMessage = updatePost,
		fetchImpl = globalThis.fetch,
		logger = console,
		clock = () => new Date(),
		heartbeatMs = HEARTBEAT_MS,
		reconnectMs = RECONNECT_MS,
		seenLimit = SEEN_LIMIT,
		bootstrapMode = BOOTSTRAP_MODE,
		pageLimit = 100,
		sessionPollMs = SESSION_ATTENTION_POLL_MS,
		dedupeCooldownMs = DEDUPE_COOLDOWN_MS,
		mainCISource = null,
		mainCIPollMs = MAIN_CI_POLL_MS,
	} = {}) {
		this.baseUrl = baseUrl.replace(/\/$/, "");
		this.stateFile = stateFile;
		this.state = state ?? loadState(this.stateFile);
		this.mentionUserId = mentionUserId;
		this.notifyChannel = notifyChannel;
		this.needsResponseChannel = needsResponseChannel || notifyChannel;
		this.postMessage = postMessage;
		this.updateMessage = updateMessage;
		this.fetchImpl = fetchImpl;
		this.logger = logger;
		this.clock = clock;
		this.heartbeatMs = heartbeatMs;
		this.reconnectMs = reconnectMs;
		this.seenLimit = seenLimit;
		this.bootstrapMode = bootstrapMode;
		this.pageLimit = pageLimit;
		this.sessionPollMs = parsePollMs(sessionPollMs, SESSION_ATTENTION_POLL_MS);
		this.dedupeCooldownMs = Number.isFinite(dedupeCooldownMs) && dedupeCooldownMs > 0 ? dedupeCooldownMs : 0;
		this.mainCISource = mainCISource;
		this.mainCIPollMs = parsePollMs(mainCIPollMs, MAIN_CI_POLL_MS);
		this.mainCICache = { checkedAt: Number.NEGATIVE_INFINITY, records: [] };
		this.consecutiveErrors = 0;
		this.consecutiveSessionPollErrors = 0;
		this.streamUnhealthyPaged = false;
		this.sessionUnhealthyPaged = false;
		this.emptySessionPolls = 0;
		this.state.attentionTracker ??= new AttentionTracker();
		this.state.lastDigestKey ??= null;
		this.state.digestTs ??= null;
		this.state.postedSignatures ??= {};
		this.state.needsResponseMessages ??= {};
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
				if (bootstrapping && this.bootstrapMode === "attention_only" && n && !isMentionableNotification(n)) {
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
			const suppressed = shouldPost && this.suppressedByCooldown(raw);
			const rec = shouldPost && !suppressed ? needsResponseRecordFromNotification(raw) : null;
			const msg = shouldPost && !suppressed && !rec ? describeSlackMessage(raw, this.mentionUserId) : null;
			if (shouldPost && !suppressed && !rec && !msg) return false;
			if (rec) {
				await this.postNeedsResponse(rec, { trackWithSessionAttention: rec.kind !== "parked_sensitive_merge" });
				this.recordPostedSignature(raw);
			} else if (msg) {
				await this.postMessage(msg, { channel: this.notifyChannel });
				this.recordPostedSignature(raw);
			} else if (suppressed) {
				// A matching post is still within the cooldown: swallow the Slack
				// message but keep advancing seen + the server-side read cursor so
				// the row is not re-paged forever (issue #190 belt-and-suspenders).
				this.logger.info?.(
					`ao-slack-notifier: suppressed duplicate ${n.type} for ${n.sessionId || n.prUrl} within cooldown`,
				);
			}
		}
		this.state.seen.add(key);
		this.pruneSeen();
		saveState(this.stateFile, this.state, this.seenLimit, this.logger);
		if (isTerminalPRNotification(n)) {
			await this.resolveNeedsResponsesForNotification(n);
			if (this.hasNeedsResponsesForNotification(n)) {
				saveState(this.stateFile, this.state, this.seenLimit, this.logger);
				return false;
			}
		}
		await this.markRead(n.id);
		return !this.state.seen.has(key) || shouldPost;
	}

	async postNeedsResponse(rec, { trackWithSessionAttention = true } = {}) {
		const sig = needsResponseSignature(rec);
		if (!sig) return false;
		if (this.state.needsResponseMessages?.[sig]) {
			if (trackWithSessionAttention) this.state.attentionTracker.markOpen(rec);
			return false;
		}
		const text = renderAlert(rec, this.mentionUserId);
		const posted = await this.postMessage(text, { channel: this.needsResponseChannel });
		if (trackWithSessionAttention) this.state.attentionTracker.markOpen(rec);
		if (posted?.ts) {
			this.state.needsResponseMessages[sig] = {
				ts: posted.ts,
				channel: this.needsResponseChannel,
				text,
				record: rec,
				openedAt: this.clock().toISOString(),
			};
		}
		saveState(this.stateFile, this.state, this.seenLimit, this.logger);
		return true;
	}

	async resolveNeedsResponse(rec, details) {
		const sig = needsResponseSignature(rec);
		const msg = this.state.needsResponseMessages?.[sig];
		if (!msg) return false;
		const text = renderResolvedNeedsResponse(msg.record ?? rec, {
			...details,
			resolvedAt: this.clock(),
		});
		try {
			if (msg.ts) {
				await this.updateMessage(msg.ts, text, { channel: msg.channel || this.needsResponseChannel });
			}
			delete this.state.needsResponseMessages[sig];
			return true;
		} catch (e) {
			this.state.attentionTracker.markOpen(msg.record ?? rec);
			this.logger.error?.("ao-slack-notifier: needs-response update failed:", e.message);
			return false;
		}
	}

	async resolveNeedsResponsesForNotification(n) {
		if (!isTerminalPRNotification(n)) return false;
		let changed = false;
		for (const [sig, msg] of Object.entries(this.state.needsResponseMessages ?? {})) {
			const rec = msg.record;
			if (!rec || rec.kind !== "parked_sensitive_merge") continue;
			if (!n.prUrl || rec.url !== n.prUrl) continue;
			const text = renderResolvedNeedsResponse(rec, {
				reason: n.type,
				clearedBy: n.title || n.prUrl,
				resolvedAt: this.clock(),
			});
			try {
				if (msg.ts) {
					await this.updateMessage(msg.ts, text, { channel: msg.channel || this.needsResponseChannel });
				}
				delete this.state.needsResponseMessages[sig];
				changed = true;
			} catch (e) {
				this.logger.error?.("ao-slack-notifier: PR needs-response update failed:", e.message);
			}
		}
		if (changed) saveState(this.stateFile, this.state, this.seenLimit, this.logger);
		return changed;
	}

	hasNeedsResponsesForNotification(n) {
		if (!isTerminalPRNotification(n)) return false;
		for (const msg of Object.values(this.state.needsResponseMessages ?? {})) {
			const rec = msg.record;
			if (rec?.kind === "parked_sensitive_merge" && n.prUrl && rec.url === n.prUrl) return true;
		}
		return false;
	}

	// suppressedByCooldown reports whether an identical-content notification was
	// posted within the configured cooldown window. Only the content signature
	// (session/type/pr/sensitive) is compared, so a re-emitted row for unchanged
	// state is suppressed even though its id/createdAt differ.
	suppressedByCooldown(raw) {
		if (this.dedupeCooldownMs <= 0) return false;
		const sig = contentSignature(raw);
		if (!sig) return false;
		const last = this.state.postedSignatures?.[sig];
		if (last == null) return false;
		return this.clock().getTime() - last < this.dedupeCooldownMs;
	}

	// recordPostedSignature stamps the just-posted content signature with the
	// current time and prunes signatures older than the cooldown so the map does
	// not grow without bound.
	recordPostedSignature(raw) {
		if (this.dedupeCooldownMs <= 0) return;
		const sig = contentSignature(raw);
		if (!sig) return;
		const now = this.clock().getTime();
		this.state.postedSignatures ??= {};
		this.state.postedSignatures[sig] = now;
		for (const [key, ts] of Object.entries(this.state.postedSignatures)) {
			if (now - ts >= this.dedupeCooldownMs) delete this.state.postedSignatures[key];
		}
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
		if (this.consecutiveErrors < 3) return;
		await this.alertDaemonUnhealthy(
			"stream",
			`Slack notifier cannot reach ao notifications (${message}) — alerts may be delayed until catch-up succeeds.`,
		);
	}

	async alertSessionPollUnhealthy(message) {
		if (this.consecutiveSessionPollErrors < 3) return;
		await this.alertDaemonUnhealthy(
			"session",
			`Slack notifier cannot poll ao sessions (${message}) — blocked/no-signal alerts may be delayed until this recovers.`,
		);
	}

	async alertDaemonUnhealthy(source, message) {
		const ownLatch = source === "session" ? "sessionUnhealthyPaged" : "streamUnhealthyPaged";
		if (this[ownLatch]) return;
		const prefix = this.mentionUserId ? `<@${this.mentionUserId}> ` : "";
		try {
			await this.postMessage(`${prefix}❤️‍🩹 *daemon_unhealthy* ${message}`, { channel: this.notifyChannel });
			this[ownLatch] = true;
		} catch (e) {
			this.logger.error?.("ao-slack-notifier: health alert failed:", e.message);
		}
	}

	async pollSessionAttention() {
		let payload;
		try {
			const res = await this.fetchImpl(`${this.baseUrl}/sessions?active=true`, {
				headers: { accept: "application/json" },
			});
			if (!res.ok) throw new Error(`sessions: HTTP ${res.status}`);
			payload = await res.json();
			requireSessionListPayload(payload);
			this.consecutiveSessionPollErrors = 0;
			this.sessionUnhealthyPaged = false;
		} catch (e) {
			this.consecutiveSessionPollErrors += 1;
			this.logger.error?.("ao-slack-notifier: session poll failed:", e.message);
			await this.alertSessionPollUnhealthy(e.message);
			return { alerted: [], resolved: [], error: true };
		}

		const current = attentionFromSessions(payload);
		if (this.mainCISource && this.mainCIPollMs > 0) {
			try {
				const now = this.clock().getTime();
				if (now - this.mainCICache.checkedAt >= this.mainCIPollMs) {
					this.mainCICache = { checkedAt: now, records: await this.mainCISource() };
				}
				const mainCI = this.mainCICache.records;
				current.unshift(...attentionFromSessions({ mainCI }));
			} catch (e) {
				this.logger.error?.("ao-slack-notifier: main CI poll failed:", e.message);
			}
		}
		const hadAttentionDigest = (this.state.lastDigestKey ?? "") !== "";
		if (current.length === 0 && (this.state.attentionTracker.pending().length > 0 || hadAttentionDigest)) {
			this.emptySessionPolls += 1;
			if (this.emptySessionPolls < 2) {
				return {
					alerted: [],
					resolved: [],
					current: this.state.attentionTracker.pending(),
					pendingEmptyConfirmation: true,
				};
			}
		} else {
			this.emptySessionPolls = 0;
		}
		const resolved = this.state.attentionTracker.reconcile(current);
		let changed = resolved.length > 0;
		for (const rec of resolved) {
			if (await this.resolveNeedsResponse(rec, { reason: "state cleared" })) changed = true;
		}
		const alerted = [];
		for (const rec of current) {
			if (!POLL_ALERT_KINDS.has(rec.kind)) continue;
			if (this.state.attentionTracker.isOpen(rec)) continue;
			try {
				await this.postNeedsResponse(rec);
				alerted.push(rec);
				changed = true;
			} catch (e) {
				this.logger.error?.("ao-slack-notifier: session attention post failed:", e.message);
			}
		}

		changed = (await this.refreshAttentionDigest(current)) || changed;
		if (changed) saveState(this.stateFile, this.state, this.seenLimit, this.logger);
		return { alerted, resolved, current };
	}

	async refreshAttentionDigest(current) {
		const key = digestContentKey(current);
		if (key === this.state.lastDigestKey) return false;
		if (this.state.lastDigestKey === null && key === "") {
			this.state.lastDigestKey = key;
			return true;
		}
		const text = renderDigest(current, { now: this.clock(), mentionUserId: "" });
		try {
			if (this.state.digestTs) {
				try {
					if (await this.updateMessage(this.state.digestTs, text, { channel: this.needsResponseChannel })) {
						this.state.lastDigestKey = key;
						return true;
					}
				} catch (e) {
					this.logger.error?.("ao-slack-notifier: attention digest update failed:", e.message);
					this.state.digestTs = null;
				}
			}
			const posted = await this.postMessage(text, { channel: this.needsResponseChannel });
			if (posted?.ts) this.state.digestTs = posted.ts;
			this.state.lastDigestKey = key;
			return true;
		} catch (e) {
			this.logger.error?.("ao-slack-notifier: attention digest post failed:", e.message);
			return false;
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
		this.streamUnhealthyPaged = false;
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
				await sleep(this.reconnectMs, signal);
			}
		}
	}

	async runSessionAttention({ signal } = {}) {
		if (this.sessionPollMs <= 0) return;
		this.logger.info?.(`ao-slack-notifier: polling ${this.baseUrl}/sessions for attention`);
		for (;;) {
			if (signal?.aborted) return;
			try {
				await this.pollSessionAttention();
			} catch (e) {
				this.logger.error?.("ao-slack-notifier: session attention loop error:", e.message);
			}
			await sleep(this.sessionPollMs, signal);
		}
	}
}

if (isMain()) {
	const mainCIRepo = process.env.AO_MAIN_CI_REPO || process.env.POLYPOWERS_REPO || process.env.AO_PROJECT_REPO || "";
	const notifier = new SlackNotificationNotifier({
		mainCISource: mainCIRepo ? () => fetchMainCI({ repo: mainCIRepo }) : null,
		mainCIPollMs: MAIN_CI_POLL_MS,
	});
	const controller = new AbortController();
	process.once("SIGINT", () => controller.abort());
	process.once("SIGTERM", () => controller.abort());
	const loops = [
		notifier.run({ signal: controller.signal }).catch((e) => {
			console.error("ao-slack-notifier fatal:", e.message);
			process.exit(1);
		}),
	];
	if (SESSION_ATTENTION_POLL_MS > 0) {
		loops.push(
			notifier.runSessionAttention({ signal: controller.signal }).catch((e) => {
				console.error("ao-slack-notifier session attention fatal:", e.message);
				process.exit(1);
			}),
		);
	}
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
			health.run({ signal: controller.signal }).catch((e) => {
				console.error("ao-agent-health fatal:", e.message);
			}),
		);
	}
	Promise.all(loops);
}
