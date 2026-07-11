// agent-health-core — poll the ao daemon's /api/v1/agents/health snapshot and
// @mention Nick in Slack when a harness transitions to unhealthy (a codex /
// claude / fugu login expiring, a binary going missing), plus a recovery post
// when it comes back. Read-only toward ao; no workflow logic. Mirrors the
// existing daemon-health `alertUnhealthy` precedent in ao-slack-notifier.
//
// Dedup + restart-safety: state is the last *settled* health we notified about
// per harness ("healthy" | "unauthorized" | "missing"), persisted to a JSON
// file. We alert on a change into an actionable state and recover on the return
// to healthy — keyed on the health VALUE, never a timestamp, so a daemon or
// notifier restart never re-pages a still-broken (or still-fine) harness.
// "unknown" is advisory and ignored entirely: probe flakiness must not page.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Actionable health states — the ones worth an operator alert.
const ACTIONABLE = new Set(["unauthorized", "missing"]);

export function loadHealthState(file) {
	try {
		const raw = JSON.parse(readFileSync(file, "utf8"));
		const health = raw && typeof raw.health === "object" && raw.health ? raw.health : {};
		return { health, initialized: Boolean(raw?.initialized) };
	} catch {
		return { health: {}, initialized: false };
	}
}

export function saveHealthState(file, state, logger = console) {
	try {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify({ health: state.health || {}, initialized: true }), "utf8");
	} catch (e) {
		logger?.warn?.("agent-health-notifier: failed to persist state:", e?.message);
	}
}

function label(h) {
	return h.label || h.id;
}

export function describeHealthAlert(h, { mentionUserId, host } = {}) {
	const mention = mentionUserId ? `<@${mentionUserId}> ` : "";
	const where = host ? ` on ${host}` : "";
	const reason = h.reason ? `: ${h.reason}` : "";
	const remedy = h.remedy ? ` — ${h.remedy}` : "";
	return `${mention}⚠️ *agent ${h.health}* ${h.id} (${label(h)})${where}${reason}${remedy}`;
}

export function describeHealthRecovery(h, { host } = {}) {
	const where = host ? ` on ${host}` : "";
	return `✅ *agent healthy* ${h.id} (${label(h)})${where} recovered`;
}

// diffHealth compares the last-notified state map (id -> settled health) against
// a fresh snapshot and returns the messages to post plus the next state map.
// Pure so the transition logic is unit-testable without Slack or a daemon.
export function diffHealth(prevHealth, harnesses, opts = {}) {
	const next = { ...prevHealth };
	const alerts = [];
	const recoveries = [];
	for (const h of harnesses || []) {
		if (!h || !h.id) continue;
		const health = h.health;
		if (health === "unknown" || !health) continue; // advisory: ignore
		const prev = prevHealth[h.id];
		if (ACTIONABLE.has(health)) {
			if (prev !== health) {
				alerts.push(describeHealthAlert(h, opts));
				next[h.id] = health;
			}
		} else if (health === "healthy") {
			if (prev !== undefined && prev !== "healthy") {
				recoveries.push(describeHealthRecovery(h, opts));
			}
			next[h.id] = "healthy";
		}
	}
	return { alerts, recoveries, next };
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

export class AgentHealthNotifier {
	constructor({
		baseUrl = `http://127.0.0.1:${process.env.AO_PORT || "3001"}/api/v1`,
		stateFile = process.env.AO_AGENT_HEALTH_NOTIFIER_STATE || "/home/orchestrator/.ao/agent-health-notifier-state.json",
		state = null,
		mentionUserId = "",
		host = "",
		postMessage,
		fetchImpl = globalThis.fetch,
		logger = console,
		pollMs = Number(process.env.AO_AGENT_HEALTH_POLL_MS || 60_000),
	} = {}) {
		this.baseUrl = baseUrl.replace(/\/$/, "");
		this.stateFile = stateFile;
		this.state = state || loadHealthState(stateFile);
		this.mentionUserId = mentionUserId;
		this.host = host;
		this.postMessage = postMessage;
		this.fetchImpl = fetchImpl;
		this.logger = logger;
		this.pollMs = pollMs;
	}

	// pollOnce fetches the snapshot, posts any transitions, and persists state.
	// Returns the posted messages (for tests). A 501 (monitor unwired) or any
	// non-2xx is treated as "nothing to report" rather than an error so a daemon
	// without the monitor never spams or crashes the loop.
	async pollOnce({ signal } = {}) {
		const res = await this.fetchImpl(`${this.baseUrl}/agents/health`, {
			headers: { accept: "application/json" },
			signal,
		});
		if (!res.ok) {
			if (res.status === 501) return [];
			throw new Error(`agents/health: HTTP ${res.status}`);
		}
		const payload = await res.json();
		const harnesses = Array.isArray(payload?.harnesses) ? payload.harnesses : [];
		const { alerts, recoveries, next } = diffHealth(this.state.health, harnesses, {
			mentionUserId: this.mentionUserId,
			host: this.host,
		});
		const posted = [];
		for (const msg of [...alerts, ...recoveries]) {
			await this.postMessage(msg);
			posted.push(msg);
		}
		this.state.health = next;
		this.state.initialized = true;
		saveHealthState(this.stateFile, this.state, this.logger);
		return posted;
	}

	async run({ signal } = {}) {
		// A non-positive or NaN interval means "disabled" — return immediately
		// rather than busy-looping on setTimeout(…, 0). The notifier main also
		// guards this, but the class is usable directly, so it self-defends.
		if (!(this.pollMs > 0)) {
			this.logger.info?.("agent-health-notifier disabled (poll interval <= 0)");
			return;
		}
		for (;;) {
			if (signal?.aborted) return;
			try {
				await this.pollOnce({ signal });
			} catch (e) {
				if (signal?.aborted) return;
				this.logger.error?.("agent-health poll error:", e?.message);
			}
			await sleep(this.pollMs, signal);
		}
	}
}
