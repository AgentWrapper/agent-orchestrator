// attention-notifier — the outbound engine for the two-way attention system
// (issue #82). It POLLS ao's authoritative /api/v1/sessions surface, alerts
// Nick on every new attention transition (deduped), maintains a single
// "what needs me" digest edited in place, and emits a heartbeat so silence
// means "healthy" not "notifier died".
//
// The engine is fully injectable (sessionSource, slack, clock, tracker,
// threadMap, logger) so its orchestration is unit-tested without a live
// daemon or Slack. The runnable wiring lives at the bottom behind isMain().
//
// Vanilla rule: reads ao's public HTTP API only; never modifies ao core.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
	AttentionTracker,
	attentionFromSessions,
	renderAlert,
	renderDigest,
	resolveMentionUserId,
	signature,
} from "./attention-core.mjs";
import { createSlackClient } from "./slack-client.mjs";
import { ThreadSessionMap } from "./slack-reply-core.mjs";

const ENV_FILE = process.env.AO_ENV_FILE || "/home/orchestrator/agent-orchestrator/.env";

// digestContentKey is a stable, order-independent fingerprint of the current
// pending set (signature + title). It intentionally excludes the "as of"
// timestamp so the anti-spam guard only fires the digest when the actual set of
// things-that-need-Nick changes, not on every poll tick.
export function digestContentKey(records) {
	return (records ?? [])
		.filter((r) => r && r.attention)
		.map((r) => `${signature(r)}|${r.title}`)
		.sort()
		.join("\n");
}

export function loadEnvFile(file = ENV_FILE, env = process.env) {
	try {
		for (const line of readFileSync(file, "utf8").split("\n")) {
			const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
			if (m && !(m[1] in env)) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
		}
	} catch {}
	return env;
}

export class AttentionNotifier {
	constructor({
		sessionSource, // async () => sessions payload
		slack, // { postMessage, update }
		mentionUserId = "",
		tracker = new AttentionTracker(),
		threadMap = new ThreadSessionMap(),
		clock = () => new Date(),
		logger = console,
		heartbeatMs = 15 * 60 * 1000, // emit a liveness beat at most this often
		digestState = null, // { ts } persisted digest message handle
		onThreadBind = () => {}, // (threadTs, {projectId,sessionId}) persistence hook
	}) {
		this.sessionSource = sessionSource;
		this.slack = slack;
		this.mentionUserId = mentionUserId;
		this.tracker = tracker;
		this.threadMap = threadMap;
		this.clock = clock;
		this.logger = logger;
		this.heartbeatMs = heartbeatMs;
		this.digest = digestState ?? { ts: null };
		this.onThreadBind = onThreadBind;
		this.lastHeartbeatAt = 0;
		this.consecutiveErrors = 0;
		this.lastDigestKey = null;
	}

	// One poll cycle: alert on new transitions, refresh the digest, beat.
	async tick() {
		let payload;
		try {
			payload = await this.sessionSource();
			this.consecutiveErrors = 0;
		} catch (e) {
			this.consecutiveErrors += 1;
			this.logger.error?.("attention-notifier: session poll failed:", e.message);
			// Self-health: after repeated failures, tell Nick the eyes are dark.
			if (this.consecutiveErrors === 3) {
				await this.safePost(
					`${this.mentionText()}❤️‍🩹 *daemon_unhealthy* attention notifier cannot reach the ao daemon (3 consecutive failures) — alerts may be missed until this recovers.`,
				);
			}
			return { alerted: [], resolved: [], error: true };
		}

		const current = attentionFromSessions(payload);
		const resolved = this.tracker.reconcile(current);
		const alerted = [];

		for (const rec of current) {
			// Only alert on a NOT-yet-open signature. Crucially, commit the
			// signature (markOpen) AFTER a successful post, so a transient Slack
			// failure is retried on the next poll instead of being lost.
			if (this.tracker.isOpen(rec)) continue;
			const text = renderAlert(rec, this.mentionUserId);
			try {
				const posted = await this.slack.postMessage(text);
				this.tracker.markOpen(rec);
				alerted.push(rec);
				if (posted?.ts) {
					this.threadMap.remember(posted.ts, { projectId: rec.projectId, sessionId: rec.sessionId });
					this.onThreadBind(posted.ts, { projectId: rec.projectId, sessionId: rec.sessionId });
				}
			} catch (e) {
				this.logger.error?.("attention-notifier: alert post failed:", e.message);
				// Leave the signature un-committed so the next poll retries it.
			}
		}

		await this.refreshDigest(current);
		await this.maybeHeartbeat(current.length);

		return { alerted, resolved, current };
	}

	async refreshDigest(current) {
		// Anti-spam guard keyed on the pending SET, not the rendered text: the
		// digest's "as of" timestamp changes every tick, so comparing rendered
		// text would never match. Compare a stable content key instead so we only
		// post/edit when the set of pending items actually changes.
		const key = digestContentKey(current);
		if (key === this.lastDigestKey) return;
		const text = renderDigest(current, { now: this.clock(), mentionUserId: "" });
		try {
			if (this.digest.ts) {
				await this.slack.update(this.digest.ts, text);
				this.lastDigestKey = key;
			} else {
				const posted = await this.slack.postMessage(text);
				if (posted?.ts) this.digest.ts = posted.ts;
				this.lastDigestKey = key;
			}
		} catch (e) {
			this.logger.error?.("attention-notifier: digest update failed:", e.message);
		}
	}

	async maybeHeartbeat(pendingCount) {
		const now = this.clock().getTime();
		if (now - this.lastHeartbeatAt < this.heartbeatMs) return;
		this.lastHeartbeatAt = now;
		this.logger.info?.(
			`attention-notifier heartbeat: ${pendingCount} pending, ${this.tracker.pending().length} tracked`,
		);
	}

	mentionText() {
		return this.mentionUserId ? `<@${this.mentionUserId}> ` : "";
	}

	async safePost(text) {
		try {
			await this.slack.postMessage(text);
		} catch (e) {
			this.logger.error?.("attention-notifier: post failed:", e.message);
		}
	}

	async run({ intervalMs = 10_000, signal } = {}) {
		this.logger.info?.("attention-notifier: starting poll loop");
		for (;;) {
			if (signal?.aborted) return;
			await this.tick();
			await new Promise((r) => setTimeout(r, intervalMs));
		}
	}
}

// --- Persistence for the thread map + digest handle (survive restarts) -----

const STATE_FILE = process.env.AO_ATTENTION_STATE || "/home/orchestrator/.ao/attention-state.json";

export function loadState(file = STATE_FILE) {
	try {
		const raw = JSON.parse(readFileSync(file, "utf8"));
		return {
			threadMap: ThreadSessionMap.deserialize(JSON.stringify(raw.threadMap ?? [])),
			digest: raw.digest ?? { ts: null },
			tracker: AttentionTracker.deserialize(raw.tracker ?? { open: [] }),
		};
	} catch {
		return { threadMap: new ThreadSessionMap(), digest: { ts: null }, tracker: new AttentionTracker() };
	}
}

export function saveState(file, { threadMap, digest, tracker }) {
	try {
		writeFileSync(
			file,
			JSON.stringify({
				threadMap: JSON.parse(threadMap.serialize()),
				digest,
				tracker: tracker ? JSON.parse(tracker.serialize()) : { open: [] },
			}),
			"utf8",
		);
	} catch {}
}

function isMain() {
	return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
}

async function main() {
	loadEnvFile();
	const port = process.env.AO_PORT || "3001";
	const slack = createSlackClient();
	const mentionUserId = resolveMentionUserId();
	if (!mentionUserId) console.error("attention-notifier: no SLACK_MEMBER_ID; alerts will not @mention");
	const { threadMap, digest, tracker } = loadState();

	const notifier = new AttentionNotifier({
		sessionSource: async () => {
			const res = await fetch(`http://127.0.0.1:${port}/api/v1/sessions`, {
				headers: { accept: "application/json" },
			});
			if (!res.ok) throw new Error(`sessions: HTTP ${res.status}`);
			return res.json();
		},
		slack,
		mentionUserId,
		threadMap,
		tracker,
		digestState: digest,
		onThreadBind: () => saveState(STATE_FILE, { threadMap, digest, tracker }),
	});

	// Persist digest handle after each tick too.
	const origTick = notifier.tick.bind(notifier);
	notifier.tick = async (...a) => {
		const r = await origTick(...a);
		saveState(STATE_FILE, { threadMap, digest, tracker });
		return r;
	};

	await notifier.run({ intervalMs: Number(process.env.AO_ATTENTION_INTERVAL_MS || 10_000) });
}

if (isMain()) main();
