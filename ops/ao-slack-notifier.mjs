#!/usr/bin/env node
// ao-slack-notifier — read-only Slack transport for ao (decision D-b, adoption
// report). It reads ao's public HTTP surface and posts to Slack; it never
// modifies ao and owns NO attention classification of its own (#268/#313).
//
// Config (env or /home/orchestrator/agent-orchestrator/.env):
//   SLACK_BOT_TOKEN + SLACK_CHANNEL_NOTIFY / SLACK_CHANNEL_NEEDS_RESPONSE -> chat.postMessage (preferred)
//   SLACK_BOT_TOKEN + SLACK_CHANNEL   -> single-channel legacy fallback
//   SLACK_WEBHOOK_URL                 -> incoming webhook   (fallback)
//   SLACK_MEMBER_ID                   -> user id to @mention for attention
//   AO_PORT (default 3001)
//   AO_SLACK_NOTIFIER_STATE           -> persisted delivery ledger
//   AO_SESSION_ATTENTION_POLL_MS      -> operator-attention poll period (0 disables)
//   AO_MAIN_CI_POLL_MS                -> main-branch CI poll/cache period (default 60s)
//   AO_AGENT_HEALTH_POLL_MS           -> agent-health poll period (0 disables)
//   AO_AGENT_HEALTH_NOTIFIER_STATE    -> persisted per-harness health cursor
//
// Two Slack surfaces, one attention source:
//
//   1. ATTENTION (loud). pollOperatorAttention() consumes the daemon's ONE
//      canonical projection, GET /api/v1/attention/operator (the same projection
//      `ao waiting` and the web waiting page render). Items whose kind is in
//      MENTION_KINDS get an individual, resolvable @mention in the needs-response
//      channel; every item feeds the rolling "what needs me" digest. The daemon
//      decides membership and item kind — this file only chooses how loudly to
//      render. The one exception is main-CI-red: the daemon does not compute it
//      into a notification, so a GitHub check-runs probe (mainCISource) is folded
//      in, exactly like the daemon-unreachable alarm the daemon cannot self-report.
//
//   2. INFORMATIONAL (quiet). The notification stream + catch-up poll forward
//      non-attention events (pr_merged, pr_closed_unmerged, orchestrator_replaced,
//      model_unreachable, model_recovered) as PLAIN posts.
//
// It also polls GET /api/v1/agents/health and @mentions on a harness going
// unhealthy (login expired / binary missing), with a recovery post — see
// agent-health-core.mjs.
//
// Read != delivery (#268/#313): the notifier NEVER marks notifications read on
// delivery — the daemon's notifications.status is operator acknowledgment only
// (web PATCH / read-all). The notifier's OWN persisted state (seen ids, posting
// cooldown, needs-response bindings, digest cursor) is its delivery ledger, so a
// reconnect drains backlogs without re-paging Nick and without silently clearing
// the durable operator-attention notification rows out of the projection.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";

import { AgentHealthNotifier } from "./agent-health-core.mjs";
import {
	AttentionTracker,
	attentionRecordsFromProjection,
	canonicalPrKey,
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
// Thread->session bindings kept for inbound reply routing (#293/M6). Matches
// ThreadSessionMap's own default bound.
const THREAD_BINDING_LIMIT = Number(process.env.AO_SLACK_NOTIFIER_THREAD_LIMIT || 5_000);
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

// INFORMATIONAL is the set of notification types the notifier forwards to Slack
// as PLAIN transport (never an @mention). Every operator-attention condition is
// now driven by the daemon's canonical projection (GET /attention/operator),
// polled in pollOperatorAttention — the notification stream carries only these
// informational events. needs_input, ready_to_merge, worker_died_unfinished,
// duplicate_pr, orchestrator_replacement_capped and main_ci_red are deliberately
// absent: they surface through the projection, not this stream, so they are
// never double-posted.
const INFORMATIONAL = new Set([
	"pr_merged",
	"pr_closed_unmerged",
	"orchestrator_replaced",
	"model_unreachable",
	"model_recovered",
]);
// MENTION_KINDS are the projection item kinds loud enough to earn an individual,
// resolvable @mention (a needs-response message) in addition to the rolling
// digest. "pr" (a routine locally-mergeable PR) is intentionally excluded: it
// gets a single plain (no-mention) post plus the digest line, matching the old plain
// ready_to_merge post.
const MENTION_KINDS = new Set([
	"decision",
	"blocked",
	"prime_dead",
	"orchestrator_dead",
	"no_signal",
	"main_ci_red",
	"worker_died_unfinished",
	"duplicate_pr",
	"orchestrator_replacement_capped",
	"parked_sensitive_merge",
]);
const ICONS = {
	pr_merged: "🚀",
	pr_closed_unmerged: "🗑️",
	orchestrator_replaced: "🔁",
	model_unreachable: "🧠",
	model_recovered: "🧠",
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
	if (!INFORMATIONAL.has(type)) return null;
	const subject = n.subject ?? raw.subject ?? {};
	const prUrl = n.prUrl ?? n.url ?? raw.prUrl ?? raw.url ?? "";
	const projectId = n.projectId ?? n.project ?? raw.projectId ?? "";
	const sessionId = n.sessionId ?? n.session ?? raw.sessionId ?? "";
	const subjectKind = subject.kind ?? (type === "main_ci_red" ? "project" : prUrl ? "pr" : sessionId ? "session" : "");
	const subjectId =
		subject.id ??
		(subjectKind === "project" ? projectId : subjectKind === "pr" ? prUrl : subjectKind === "session" ? sessionId : "");
	return {
		id: n.id ?? raw.id ?? null,
		type,
		sessionId,
		subjectKind,
		subjectId,
		projectId,
		title: n.title ?? n.message ?? raw.title ?? "",
		body: n.body ?? raw.body ?? "",
		prUrl,
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

function isTerminalPRNotification(n) {
	return n?.type === "pr_merged" || n?.type === "pr_closed_unmerged";
}

// rowIsNewerThanCursor compares a raw notification row against the persisted
// (createdAt, id) high-water mark using the same composite ordering the daemon
// paginates by. Both timestamps are compared as INSTANTS (epoch), never as raw
// strings, so representation differences (offset, sub-second precision) cannot
// misorder them. Rows with a missing/unparseable createdAt compare as NOT
// newer, so a malformed row can never wedge the high-water mark.
function rowIsNewerThanCursor(raw, cursor) {
	const rowAt = Date.parse(String(raw?.createdAt ?? ""));
	const cursorAt = Date.parse(String(cursor?.createdAt ?? ""));
	if (!Number.isFinite(rowAt) || !Number.isFinite(cursorAt)) return false;
	if (rowAt !== cursorAt) return rowAt > cursorAt;
	return String(raw?.id ?? "") > String(cursor?.id ?? "");
}

function compareNotificationRows(a, b) {
	const at = String(a?.createdAt ?? "");
	const bt = String(b?.createdAt ?? "");
	if (at !== bt) return at < bt ? -1 : 1;
	const ai = String(a?.id ?? "");
	const bi = String(b?.id ?? "");
	if (ai === bi) return 0;
	return ai < bi ? -1 : 1;
}

// The needs-response ledger is keyed on the projection item's stable, deduped id
// (signature(rec) === rec.id). The daemon already coalesces re-emissions (e.g. a
// new head SHA yields a new notification row and therefore a new item id), so no
// extra url/head disambiguation is needed here.
function needsResponseSignature(rec) {
	if (!rec) return "";
	return signature(rec);
}

// mainCIAttentionRecord maps a fetchMainCI result to a projection-shaped render
// record. Main-branch CI health is the one operator-attention condition the
// daemon does NOT compute into a notification, so this GitHub check-runs probe
// is its only source — kept as a transport alarm the daemon cannot self-report,
// exactly like the daemon-unreachable alarm.
export function mainCIAttentionRecord(main) {
	if (!main || typeof main !== "object") return null;
	if (main.status !== "failing" && main.state !== "failing") return null;
	const sha = String(main.sha ?? main.headSha ?? "").slice(0, 8);
	const jobs = Array.isArray(main.failedJobs) && main.failedJobs.length ? main.failedJobs.join(", ") : "unknown jobs";
	return {
		id: `main_ci_red:${String(main.projectId ?? "")}`,
		kind: "main_ci_red",
		sessionId: "main",
		projectId: String(main.projectId ?? ""),
		title: `main is red at ${sha || "unknown"}: ${jobs}`,
		url: String(main.url ?? main.htmlUrl ?? ""),
		attention: true,
	};
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
	return n.id || `${n.type}|${n.projectId}|${notificationSubjectKey(n)}|${n.createdAt}|${n.title}|${n.prUrl}`;
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
	return `${n.type}|${n.projectId}|${notificationSubjectKey(n)}|${n.prUrl}|${n.sensitive ? "1" : "0"}|${n.headSha ?? ""}`;
}

function notificationSubjectKey(n) {
	if (n?.subjectKind && n?.subjectId) return `${n.subjectKind}:${n.subjectId}`;
	return `session:${n?.sessionId ?? ""}`;
}

// describeSlackMessage renders an INFORMATIONAL notification (pr_merged,
// pr_closed_unmerged, orchestrator_replaced, model_*) as a plain Slack post.
// These are never @mentions — every attention condition is delivered by the
// projection poll, not this notification path.
export function describeSlackMessage(raw) {
	const n = normalizeNotification(raw);
	if (!n) return null;
	const icon = ICONS[n.type] ?? "📌";
	const proj = n.projectId ? `[${n.projectId}] ` : "";
	const displaySubject = n.sessionId || n.subjectId || "";
	const sess = displaySubject ? `${displaySubject}: ` : "";
	const title = n.title || n.body;
	const text = `${icon} *${n.type}* ${proj}${sess}${title} ${n.prUrl}`.trim();
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

// STATE_VERSION identifies the state-file schema. v2 keys attention records by
// the daemon projection's item ids; unversioned (v1) files carry records keyed
// by the deleted classifier's signatures and are re-keyed on load (see
// migrateLegacyAttentionState) so a deploy does not resolve every open Slack
// message and re-page every still-open condition.
export const STATE_VERSION = 2;

// migrateLegacyAttentionRecord maps a pre-projection (v1) attention record to
// its projection identity: the item id the daemon now emits for the same
// condition. Records with no projection counterpart (e.g. worker no_signal,
// which the daemon deliberately excludes) are returned unchanged; the next
// reconcile resolves them, which is the correct daemon-truth outcome.
function migrateLegacyAttentionRecord(rec) {
	if (!rec || typeof rec !== "object" || rec.id) return rec;
	const kind = String(rec.kind ?? "");
	const sessionId = String(rec.sessionId ?? "");
	const projectId = String(rec.projectId ?? "");
	const url = String(rec.url ?? "");
	if (kind === "needs_input" && sessionId) return { ...rec, id: `session:${sessionId}:decision`, kind: "decision" };
	if (kind === "blocked" && sessionId) return { ...rec, id: `session:${sessionId}:blocked` };
	if (kind === "orchestrator_dead" && sessionId) return { ...rec, id: `session:${sessionId}:no_signal` };
	// The old poll classified every non-orchestrator no-signal session —
	// including PRIME sessions — as plain no_signal. The projection emits
	// session:<id>:no_signal for prime (kind prime_dead) and orchestrator roles
	// and nothing for workers, so this mapping lets a prime record match its
	// projection item while a worker record reconciles away (daemon truth).
	if (kind === "no_signal" && sessionId) return { ...rec, id: `session:${sessionId}:no_signal` };
	if (kind === "main_ci_red" && projectId) return { ...rec, id: `main_ci_red:${projectId}` };
	if (kind === "parked_sensitive_merge" && url) {
		return { ...rec, id: `pr:${canonicalPrKey(url)}:parked_sensitive_merge`, prUrl: String(rec.prUrl || url) };
	}
	// Durable notification escalations were needs-response tracked too; the
	// projection keys them by subject identity (notification:<project>:<session>:
	// <type>), which is reconstructible from the legacy record.
	// worker_retry_exhausted is MIGRATION-ONLY: the daemon can no longer emit it
	// (#313 removed the respawn subsystem), so a migrated record simply reconciles
	// away on the next projection poll instead of lingering forever.
	if ((kind === "worker_retry_exhausted" || kind === "orchestrator_replacement_capped") && projectId && sessionId) {
		return { ...rec, id: `notification:${projectId}:${sessionId}:${kind}` };
	}
	return rec;
}

function migrateLegacyAttentionState(raw) {
	if (!raw || typeof raw !== "object" || Number(raw.version) >= STATE_VERSION) return raw;
	const open = Array.isArray(raw.attentionTracker?.open) ? raw.attentionTracker.open : [];
	const migratedOpen = open.map(([key, rec]) => {
		const migrated = migrateLegacyAttentionRecord(rec);
		return [migrated?.id ?? key, migrated];
	});
	const needsResponse = {};
	for (const [sig, msg] of Object.entries(raw.needsResponseMessages ?? {})) {
		if (!msg || typeof msg !== "object") continue;
		const record = migrateLegacyAttentionRecord(msg.record);
		needsResponse[sig] = { ...msg, record };
	}
	return {
		...raw,
		attentionTracker: { open: migratedOpen },
		needsResponseMessages: needsResponse,
	};
}

export function loadState(file = STATE_FILE) {
	try {
		const raw = migrateLegacyAttentionState(JSON.parse(readFileSync(file, "utf8")));
		return {
			seen: new Set(Array.isArray(raw.seen) ? raw.seen.map(String) : []),
			lastEventId: String(raw.lastEventId ?? ""),
			lastHeartbeatAt: Number(raw.lastHeartbeatAt ?? 0),
			initialized: Boolean(raw.initialized),
			attentionTracker: AttentionTracker.deserialize(raw.attentionTracker ?? { open: [] }),
			lastDigestKey: raw.lastDigestKey ?? null,
			digestTs: raw.digestTs ?? null,
			postedSignatures: normalizePostedSignatures(raw.postedSignatures),
			needsResponseMessages: normalizeNeedsResponseMessages(raw.needsResponseMessages),
			threadBindings: normalizeThreadBindings(raw.threadBindings),
			catchUpCursor: normalizeCatchUpCursor(raw.catchUpCursor),
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
			threadBindings: {},
			catchUpCursor: null,
		};
	}
}

// catchUpCursor is the durable high-water mark of the unread catch-up walk:
// the newest (createdAt, id) already processed. With read-on-delivery gone the
// unread list is append-mostly, so this cursor — not the ack status — decides
// where a catch-up stops walking, keeping the walk bounded and keeping rows
// evicted from the bounded seen-set from ever re-posting.
function normalizeCatchUpCursor(raw) {
	if (!raw || typeof raw !== "object") return null;
	return catchUpCursorFrom(raw.createdAt, raw.id);
}

// RFC3339_DATE_TIME accepts only a FULL date-time with an explicit offset or Z
// (fractional seconds optional). Date.parse alone is too lenient — it happily
// normalizes date-only, locale, or timezone-less strings — and a corrupted or
// hand-edited cursor must drop to the seeding path, never be "repaired" into a
// wrong high-water mark.
const RFC3339_DATE_TIME = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

// catchUpCursorFrom builds the persisted high-water mark: createdAt must be
// strict RFC 3339 and is stored normalized to UTC (toISOString), so an
// offset-equivalent cursor (…+02:00 vs …Z) can never replay history or
// suppress rows — the same defect class fixed in the Go store's cursor.
// Comparison happens on epoch time (see rowIsNewerThanCursor), never on raw
// strings. The id tie-breaks rows at the same instant; the empty id is valid
// only for the initialized-empty sentinel (every real id sorts above it).
function catchUpCursorFrom(createdAt, id) {
	const text = String(createdAt ?? "");
	if (!RFC3339_DATE_TIME.test(text)) return null;
	const at = Date.parse(text);
	if (!Number.isFinite(at)) return null;
	return { createdAt: new Date(at).toISOString(), id: String(id ?? "") };
}

// emptyCatchUpCursor is the explicit "initialized on an EMPTY unread snapshot"
// high-water marker: everything that appears later is genuinely new and must
// post. Persisting it (instead of nothing) keeps the next catch-up from
// mistaking the first future row for history and seeding it away silently.
function emptyCatchUpCursor() {
	return { createdAt: new Date(0).toISOString(), id: "" };
}

// threadBindings maps a posted Slack message ts -> the session that raised the
// alert, so the reply listener can route a threaded reply back to that worker
// (#293/M6). Corrupt or session-less entries are dropped: a MISSING binding
// degrades to `unknown_thread`, which is correct and safe; a WRONG one would
// `ao send` a human's reply straight into the wrong agent.
function normalizeThreadBindings(raw) {
	const out = {};
	if (!raw || typeof raw !== "object") return out;
	for (const [ts, target] of Object.entries(raw)) {
		const sessionId = String(target?.sessionId ?? "");
		if (!ts || !sessionId) continue;
		out[String(ts)] = { sessionId, projectId: String(target?.projectId ?? "") };
	}
	return out;
}

// normalizePostedSignatures coerces the persisted {signature: epochMs} map back
// into a plain object of finite numbers, dropping any corrupt entries so a bad
// state file degrades to "no cooldown recorded" rather than crashing the loop.
function normalizePostedSignatures(raw) {
	const out = {};
	if (!raw || typeof raw !== "object") return out;
	for (const [sig, ts] of Object.entries(raw)) {
		const n = Number(ts);
		if (Number.isFinite(n)) out[String(sig)] = n;
	}
	return out;
}

function normalizeNeedsResponseMessages(raw) {
	const out = {};
	if (!raw || typeof raw !== "object") return out;
	for (const [sig, msg] of Object.entries(raw)) {
		if (!msg || typeof msg !== "object") continue;
		const record = msg.record && typeof msg.record === "object" ? msg.record : null;
		const key = record ? needsResponseSignature(record) : String(sig);
		out[key] = {
			ts: String(msg.ts ?? ""),
			channel: String(msg.channel ?? ""),
			text: String(msg.text ?? ""),
			record,
			openedAt: String(msg.openedAt ?? ""),
		};
	}
	return out;
}

export function saveState(
	file,
	state,
	limit = SEEN_LIMIT,
	logger = console,
	threadBindingLimit = THREAD_BINDING_LIMIT,
) {
	// Write to a temp file and rename it into place (#293/M6, from the codex review
	// of #309). writeFileSync truncates the target FIRST, so a crash — or a full
	// disk — part-way through the write leaves a truncated/half-written JSON blob
	// where the state used to be, and loadState then falls back to empty: every
	// thread binding, every seen id and every open needs-response record gone at
	// once. The notifier would re-page history and could never route a threaded
	// reply again. rename(2) within the same directory is atomic: a reader sees
	// either the old complete file or the new complete file, never a partial one.
	const tmp = `${file}.tmp-${process.pid}`;
	try {
		mkdirSync(dirname(file), { recursive: true });
		const seen = [...state.seen].slice(-limit);
		// Bound the binding map the same way `seen` is bounded: a long-lived notifier
		// posts indefinitely, and an unbounded map would grow the state file forever.
		// Object key order is insertion order, so slicing the tail keeps the NEWEST
		// bindings — the ones a human could still be replying to.
		const bindingEntries = Object.entries(state.threadBindings ?? {}).slice(-threadBindingLimit);
		writeFileSync(
			tmp,
			JSON.stringify({
				version: STATE_VERSION,
				seen,
				lastEventId: state.lastEventId || "",
				lastHeartbeatAt: state.lastHeartbeatAt || 0,
				initialized: Boolean(state.initialized),
				attentionTracker: state.attentionTracker ? JSON.parse(state.attentionTracker.serialize()) : { open: [] },
				lastDigestKey: state.lastDigestKey ?? null,
				digestTs: state.digestTs ?? null,
				postedSignatures: state.postedSignatures ?? {},
				needsResponseMessages: state.needsResponseMessages ?? {},
				threadBindings: Object.fromEntries(bindingEntries),
				catchUpCursor: state.catchUpCursor ?? null,
			}),
			"utf8",
		);
		renameSync(tmp, file);
	} catch (e) {
		// The previous state file is still intact — only the temp is garbage.
		try {
			rmSync(tmp, { force: true });
		} catch {
			// Nothing more to do: the temp is inert (loadState only ever reads `file`).
		}
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
		threadBindingLimit = THREAD_BINDING_LIMIT,
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
		this.threadBindingLimit = threadBindingLimit;
		this.webhookThreadingWarned = false;
		this.bootstrapMode = bootstrapMode;
		this.pageLimit = pageLimit;
		this.attentionPollMs = parsePollMs(sessionPollMs, SESSION_ATTENTION_POLL_MS);
		this.dedupeCooldownMs = Number.isFinite(dedupeCooldownMs) && dedupeCooldownMs > 0 ? dedupeCooldownMs : 0;
		this.mainCISource = mainCISource;
		this.mainCIPollMs = parsePollMs(mainCIPollMs, MAIN_CI_POLL_MS);
		this.mainCICache = { checkedAt: Number.NEGATIVE_INFINITY, records: [] };
		this.consecutiveErrors = 0;
		this.consecutiveAttentionPollErrors = 0;
		this.streamUnhealthyPaged = false;
		this.attentionUnhealthyPaged = false;
		this.emptyAttentionPolls = 0;
		this.state.attentionTracker ??= new AttentionTracker();
		this.state.lastDigestKey ??= null;
		this.state.digestTs ??= null;
		this.state.postedSignatures ??= {};
		this.state.needsResponseMessages ??= {};
	}

	// catchUpUnread walks the unread backlog with the API's (createdAt, id)
	// cursor and stops at the notifier's own durable high-water mark
	// (state.catchUpCursor). Read != delivery makes the unread list append-mostly
	// (delivery never advances the server-side ack status), so ack-independent
	// pagination is what lets a backlog larger than one page drain, keeps every
	// catch-up bounded to rows not yet processed, and keeps rows evicted from the
	// bounded seen-set from ever re-posting.
	async catchUpUnread() {
		const sent = [];
		const bootstrapping = !this.state.initialized;
		const highWater = this.state.catchUpCursor;
		// An initialized state with NO cursor (a v1->v2 migration, or a corrupt
		// cursor dropped by normalizeCatchUpCursor) must never replay full
		// history: rows evicted from the bounded seen-set would re-post. Seed the
		// high-water mark at the current newest row without posting anything —
		// bootstrap semantics; genuinely new rows still arrive via the SSE stream
		// and every later catch-up has a cursor.
		if (!bootstrapping && !highWater) {
			const res = await this.fetchImpl(`${this.baseUrl}/notifications?status=unread&limit=${this.pageLimit}`, {
				headers: { accept: "application/json" },
			});
			if (!res.ok) throw new Error(`notifications list: HTTP ${res.status}`);
			const payload = await res.json();
			const list = Array.isArray(payload) ? payload : (payload.notifications ?? payload.data ?? []);
			const newest = list[0];
			// An EMPTY snapshot still persists an explicit epoch high-water marker:
			// leaving the cursor null would make the NEXT catch-up seed again and
			// silently swallow whatever row arrived in between.
			const seeded = list.length === 0 ? emptyCatchUpCursor() : catchUpCursorFrom(newest?.createdAt, newest?.id);
			if (seeded) {
				this.state.catchUpCursor = seeded;
				saveState(this.stateFile, this.state, this.seenLimit, this.logger);
				this.logger.warn?.(
					"ao-slack-notifier: catch-up cursor was missing; seeded at the newest unread row without replaying history",
				);
			}
			return sent;
		}
		const collected = [];
		let cursor = null;
		let previousFirstKey = null;
		pages: for (;;) {
			let url = `${this.baseUrl}/notifications?status=unread&limit=${this.pageLimit}`;
			if (cursor) {
				url += `&before=${encodeURIComponent(cursor.createdAt)}&beforeId=${encodeURIComponent(cursor.id)}`;
			}
			const res = await this.fetchImpl(url, { headers: { accept: "application/json" } });
			if (!res.ok) throw new Error(`notifications list: HTTP ${res.status}`);
			const payload = await res.json();
			const list = Array.isArray(payload) ? payload : (payload.notifications ?? payload.data ?? []);
			// A daemon that ignores the cursor params would return the same page
			// forever; detect that and stop rather than loop.
			const firstKey = list.length ? `${list[0]?.createdAt ?? ""}|${list[0]?.id ?? ""}` : "";
			if (cursor && firstKey && firstKey === previousFirstKey) {
				this.logger.warn?.("ao-slack-notifier: daemon ignored the notifications cursor; processing one page only");
				break;
			}
			previousFirstKey = firstKey;
			for (const raw of list) {
				// Newest-first pages: once a row is at or below the high-water mark,
				// everything after it has already been processed by a previous run.
				if (highWater && !rowIsNewerThanCursor(raw, highWater)) break pages;
				collected.push(raw);
			}
			if (list.length < this.pageLimit) break;
			const last = list[list.length - 1];
			const createdAt = String(last?.createdAt ?? "");
			const id = String(last?.id ?? "");
			if (!createdAt || !id) break; // cannot advance safely
			cursor = { createdAt, id };
		}
		// Oldest first keeps Slack chronology sensible after a reconnect gap.
		collected.sort(compareNotificationRows);
		let changed = bootstrapping;
		for (const raw of collected) {
			const n = normalizeNotification(raw);
			// First deploy against an existing daemon can have a large backlog of old
			// unread informational notifications. Seed them as delivered so deploy
			// does not spam historical pr_merged posts. Every attention condition is
			// delivered by the projection poll now, so the stream/catch-up path only
			// ever carries informational events — on bootstrap, seed them all.
			if (bootstrapping && this.bootstrapMode === "attention_only" && n) {
				await this.recordDelivered(raw, { post: false });
			} else if (await this.handleNotification(raw)) {
				sent.push(n);
			}
			// Advance the cursor as each row completes, so the NEXT row's delivery
			// ledger write persists the progress — a crash mid-drain replays at
			// most the one-row persistence lag, which the seen-set absorbs. The
			// advance deliberately happens AFTER successful processing: advancing
			// first would skip a row whose Slack post failed on the in-process
			// retry.
			if (raw?.id && (!this.state.catchUpCursor || rowIsNewerThanCursor(raw, this.state.catchUpCursor))) {
				const advanced = catchUpCursorFrom(raw.createdAt, raw.id);
				if (advanced) {
					this.state.catchUpCursor = advanced;
					changed = true;
				}
			}
		}
		if (bootstrapping) this.state.initialized = true;
		if (changed) saveState(this.stateFile, this.state, this.seenLimit, this.logger);
		return sent;
	}

	// recordDelivered posts one INFORMATIONAL notification to Slack and records it
	// as delivered in the notifier's OWN ledger (seen ids + posting cooldown).
	//
	// Read != delivery (#268/#313): the notifier NEVER PATCHes notifications.status
	// to read on delivery. The daemon's `status` column is now operator
	// acknowledgment ONLY (web PATCH / read-all); flipping it here would drop the
	// durable operator-attention notification types out of the unread projection
	// even though the operator never saw them. The notifier's persisted state IS
	// its delivery ledger.
	async recordDelivered(raw, { post: shouldPost = true } = {}) {
		const key = notificationKey(raw);
		const n = normalizeNotification(raw);
		if (!key || !n) return false;
		if (!this.state.seen.has(key)) {
			const suppressed = shouldPost && this.suppressedByCooldown(raw);
			if (shouldPost && !suppressed) {
				const msg = describeSlackMessage(raw);
				if (msg) {
					const posted = await this.postMessage(msg, { channel: this.notifyChannel });
					// Plain informational posts are threadable too — Nick can reply in the
					// thread of a pr_merged/worker_died post to talk to that session.
					this.rememberThreadBinding(posted, { sessionId: n.sessionId, projectId: n.projectId });
					this.recordPostedSignature(raw);
				}
			} else if (suppressed) {
				// A matching post is still within the cooldown: swallow the Slack
				// message but keep advancing seen so the row is not re-posted forever
				// (issue #190 belt-and-suspenders).
				this.logger.info?.(
					`ao-slack-notifier: suppressed duplicate ${n.type} for ${n.sessionId || n.prUrl} within cooldown`,
				);
			}
		}
		this.state.seen.add(key);
		this.pruneSeen();
		// A terminal PR event resolves any open parked-sensitive-merge needs-response
		// message for that PR (transport resolve of a posted Slack message).
		if (isTerminalPRNotification(n)) {
			await this.resolveNeedsResponsesForNotification(n);
		}
		saveState(this.stateFile, this.state, this.seenLimit, this.logger);
		return shouldPost;
	}

	// Bind the Slack message we just posted to the session that raised it, so a
	// threaded reply routes back to that worker (#293/M6).
	//
	// `posted` is whatever the sink returned: chat.postMessage yields { ts }, an
	// incoming WEBHOOK yields nothing at all. A webhook post therefore has no
	// thread to bind, and there is no honest way to invent one — say so (once) and
	// leave the thread unbound, so a reply degrades to `unknown_thread` instead of
	// being misrouted into some other agent.
	rememberThreadBinding(posted, { sessionId, projectId } = {}) {
		if (!sessionId) return false;
		const ts = posted?.ts;
		if (!ts) {
			if (!this.webhookThreadingWarned) {
				this.webhookThreadingWarned = true;
				this.logger?.warn?.(
					"ao-slack-notifier: Slack sink returned no message ts (incoming webhook), so no thread->session binding can be recorded; threaded replies will not route. Configure SLACK_BOT_TOKEN + a channel for two-way replies.",
				);
			}
			return false;
		}
		this.state.threadBindings ??= {};
		// Re-insert so the newest binding sits at the tail: object key order is
		// insertion order, which is what both the eviction below and saveState's
		// bound rely on.
		delete this.state.threadBindings[ts];
		this.state.threadBindings[ts] = { sessionId, projectId: projectId ?? "" };

		const keys = Object.keys(this.state.threadBindings);
		for (const stale of keys.slice(0, Math.max(0, keys.length - this.threadBindingLimit))) {
			delete this.state.threadBindings[stale];
		}
		return true;
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
		// A needs-response alert is precisely the post a human replies to, so its
		// thread MUST be routable back to the waiting worker (#293/M6).
		this.rememberThreadBinding(posted, { sessionId: rec.sessionId, projectId: rec.projectId });
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
			// PR identity is rec.prUrl (kept separately from the display url, which
			// prefers deepLink); fall back to url for records that predate the split.
			if (!n.prUrl || (rec.prUrl || rec.url) !== n.prUrl) continue;
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

	async alertOperatorPollUnhealthy(message) {
		if (this.consecutiveAttentionPollErrors < 3) return;
		// The daemon cannot self-report that its own attention endpoint is
		// unreachable, so this is a transport-level alarm we must raise ourselves.
		await this.alertDaemonUnhealthy(
			"attention",
			`Slack notifier cannot reach the ao attention projection (${message}) — operator-attention alerts may be delayed until this recovers.`,
		);
	}

	async alertDaemonUnhealthy(source, message) {
		const ownLatch = source === "attention" ? "attentionUnhealthyPaged" : "streamUnhealthyPaged";
		if (this[ownLatch]) return;
		const prefix = this.mentionUserId ? `<@${this.mentionUserId}> ` : "";
		try {
			await this.postMessage(`${prefix}❤️‍🩹 *daemon_unhealthy* ${message}`, { channel: this.notifyChannel });
			this[ownLatch] = true;
		} catch (e) {
			this.logger.error?.("ao-slack-notifier: health alert failed:", e.message);
		}
	}

	// pollOperatorAttention consumes the daemon's ONE canonical operator-attention
	// projection (GET /api/v1/attention/operator) and renders it to Slack. The
	// notifier owns no attention classification: the daemon decides membership and
	// item kind; this method only decides HOW LOUDLY to render each item
	// (MENTION_KINDS -> resolvable @mention; everything else -> digest) and keeps
	// the posting idempotent. The main-CI-red GitHub probe is folded in because
	// the daemon does not compute that condition into a notification.
	async pollOperatorAttention() {
		let current;
		try {
			const res = await this.fetchImpl(`${this.baseUrl}/attention/operator`, {
				headers: { accept: "application/json" },
			});
			if (!res.ok) throw new Error(`attention: HTTP ${res.status}`);
			const payload = await res.json();
			// Validate the payload shape BEFORE resetting the error latches: a 200
			// with a malformed body is an unreachable-class failure, never an
			// all-clear that would silently resolve every open attention item.
			const items = Array.isArray(payload) ? payload : payload?.items;
			if (!Array.isArray(items)) throw new Error("attention: invalid payload shape");
			current = attentionRecordsFromProjection(items);
			this.consecutiveAttentionPollErrors = 0;
			this.attentionUnhealthyPaged = false;
		} catch (e) {
			this.consecutiveAttentionPollErrors += 1;
			this.logger.error?.("ao-slack-notifier: attention poll failed:", e.message);
			await this.alertOperatorPollUnhealthy(e.message);
			return { alerted: [], resolved: [], error: true };
		}
		if (this.mainCISource && this.mainCIPollMs > 0) {
			try {
				const now = this.clock().getTime();
				if (now - this.mainCICache.checkedAt >= this.mainCIPollMs) {
					this.mainCICache = { checkedAt: now, records: await this.mainCISource() };
				}
				current.unshift(...this.mainCICache.records.map(mainCIAttentionRecord).filter(Boolean));
			} catch (e) {
				this.logger.error?.("ao-slack-notifier: main CI poll failed:", e.message);
			}
		}
		const hadAttentionDigest = (this.state.lastDigestKey ?? "") !== "";
		if (current.length === 0 && (this.state.attentionTracker.pending().length > 0 || hadAttentionDigest)) {
			this.emptyAttentionPolls += 1;
			if (this.emptyAttentionPolls < 2) {
				return {
					alerted: [],
					resolved: [],
					current: this.state.attentionTracker.pending(),
					pendingEmptyConfirmation: true,
				};
			}
		} else {
			this.emptyAttentionPolls = 0;
		}
		const resolved = this.state.attentionTracker.reconcile(current);
		let changed = resolved.length > 0;
		for (const rec of resolved) {
			if (await this.resolveNeedsResponse(rec, { reason: "state cleared" })) changed = true;
		}
		// Every projection record is TRACKED and appears in the digest — this
		// renderer never drops a daemon-declared attention item. The kind only
		// decides how loudly the item gets its individual post: MENTION_KINDS ->
		// resolvable @mention; "pr" -> one plain thread-bound post; anything else
		// (including kinds newer than this notifier) -> digest-only.
		const alerted = [];
		for (const rec of current) {
			if (this.state.attentionTracker.isOpen(rec)) continue;
			try {
				if (MENTION_KINDS.has(rec.kind)) {
					await this.postNeedsResponse(rec);
				} else if (rec.kind === "pr") {
					// A routine locally-mergeable PR gets one plain (no-mention) post in
					// the notify channel — the pre-projection ready_to_merge behavior —
					// deduped by the tracker and thread-bound so a reply reaches the
					// session that raised it.
					const posted = await this.postMessage(renderAlert(rec, ""), { channel: this.notifyChannel });
					this.state.attentionTracker.markOpen(rec);
					this.rememberThreadBinding(posted, { sessionId: rec.sessionId, projectId: rec.projectId });
				} else {
					this.state.attentionTracker.markOpen(rec);
					changed = true;
					continue;
				}
				alerted.push(rec);
				changed = true;
			} catch (e) {
				this.logger.error?.("ao-slack-notifier: operator attention post failed:", e.message);
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

	async runOperatorAttention({ signal } = {}) {
		if (this.attentionPollMs <= 0) return;
		this.logger.info?.(`ao-slack-notifier: polling ${this.baseUrl}/attention/operator`);
		for (;;) {
			if (signal?.aborted) return;
			try {
				await this.pollOperatorAttention();
			} catch (e) {
				this.logger.error?.("ao-slack-notifier: operator attention loop error:", e.message);
			}
			await sleep(this.attentionPollMs, signal);
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
			notifier.runOperatorAttention({ signal: controller.signal }).catch((e) => {
				console.error("ao-slack-notifier operator attention fatal:", e.message);
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
