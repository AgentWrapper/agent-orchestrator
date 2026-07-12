// attention-core — pure, side-effect-free logic for the two-way attention
// system (issue #82). Everything here is a plain function or a small in-memory
// state machine so it is exhaustively unit-testable without a live daemon or
// Slack. Runtime glue (SSE, HTTP, `ao send`) lives in the sibling *.mjs
// runners and delegates every decision to this module.
//
// Vanilla rule: this is the ops/nickify layer. It only READS ao's public
// HTTP surface and shells out to `ao send`; it never modifies ao core.

// --- Slack member id resolution -------------------------------------------
//
// Acceptance #4: the notifier reads SLACK_MEMBER_ID natively. The legacy
// SLACK_MENTION_USER_ID alias remains a fallback ONLY so an un-migrated host
// keeps working, but SLACK_MEMBER_ID wins when both are set.
export function resolveMentionUserId(env = process.env) {
	const native = (env.SLACK_MEMBER_ID ?? "").trim();
	if (native) return native;
	const legacy = (env.SLACK_MENTION_USER_ID ?? "").trim();
	return legacy || "";
}

// --- Attention classification ---------------------------------------------
//
// The set of transitions that must ping Nick with an @mention. Keyed on the
// notifier's normalized "kind" (derived below).
export const ATTENTION_KINDS = new Set([
	"needs_input", // a worker is waiting for input
	"blocked", // a worker/queue parked or is stuck
	"parked_sensitive_merge", // ready_to_merge on a sensitive path (human gate)
	"orchestrator_dead", // a dead/errored orchestrator
	"daemon_unhealthy", // the daemon health probe is failing
	"no_signal", // a session whose activity hook went silent (stuck/dead)
	"main_ci_red", // main-branch CI is failing and merges/deploys are frozen
	"worker_retry_exhausted", // worker respawn is capped and needs operator action
]);

// Informational kinds we forward but never @mention.
export const INFO_KINDS = new Set(["pr_merged", "pr_closed_unmerged", "heartbeat", "worker_died_unfinished"]);

const ICONS = {
	needs_input: "🖐️",
	blocked: "🚧",
	parked_sensitive_merge: "🛑",
	orchestrator_dead: "💀",
	daemon_unhealthy: "❤️‍🩹",
	no_signal: "🛰️",
	main_ci_red: "🚨",
	worker_retry_exhausted: "🚨",
	worker_died_unfinished: "🧯",
	ready_to_merge: "🟢",
	pr_merged: "🚀",
	pr_closed_unmerged: "🗑️",
	heartbeat: "💓",
};

// Sensitive backend paths per the repo CLAUDE.md: an autonomous merge parked
// for a human. A ready_to_merge whose PR touches one of these is a human-gate
// attention event, not a routine "green PR" info ping.
export const SENSITIVE_PATH_PREFIXES = [
	"backend/internal/daemon/",
	"backend/internal/session_manager/",
	"backend/internal/lifecycle/",
];

export function touchesSensitivePath(paths = []) {
	return paths.some((p) => SENSITIVE_PATH_PREFIXES.some((prefix) => String(p).startsWith(prefix)));
}

// normalizeEvent maps a raw ao notification/CDC payload to a stable, minimal
// attention record. Returns null for anything not worth surfacing.
//
// It accepts both shapes the daemon can emit:
//   - typed notifications (/api/v1/notifications[/stream]): {type,sessionId,...}
//   - raw CDC events (/api/v1/events): {type,payload:{...}}
export function normalizeEvent(raw, { sensitivePaths } = {}) {
	if (!raw || typeof raw !== "object") return null;
	const outerType = raw.type ?? raw.event ?? "";
	const n = raw.notification ?? raw.payload ?? raw ?? {};
	const projectId = n.projectId ?? n.project ?? raw.projectId ?? "";
	const title = n.title ?? n.message ?? "";
	const url = n.url ?? n.prUrl ?? "";
	const rawKind = n.kind ?? n.type ?? outerType;
	const subject = n.subject ?? raw.subject ?? {};
	const sessionId =
		rawKind === "main_ci_red"
			? (n.sessionId || n.session || raw.sessionId || "main")
			: (n.sessionId ?? n.session ?? raw.sessionId ?? "");
	const subjectKind =
		subject.kind ??
		(rawKind === "main_ci_red"
			? "project"
			: rawKind === "worker_died_unfinished" || rawKind === "worker_retry_exhausted"
				? "session"
				: url
					? "pr"
					: sessionId
						? "session"
						: "");
	const subjectId =
		subject.id ??
		(subjectKind === "project" ? projectId : subjectKind === "pr" ? url : subjectKind === "session" ? sessionId : "");

	// A park anywhere in the payload text is an attention/blocked signal even
	// when the daemon labels the envelope generically (queue_update, etc.).
	const isPark = /park|blocked|stuck/i.test(JSON.stringify(n).slice(0, 500));

	let kind = rawKind;
	if (kind === "ready_to_merge") {
		// A ready_to_merge is only an attention event when it is parked for a
		// human because the diff touches a sensitive path.
		const paths = sensitivePaths ?? n.changedPaths ?? n.paths ?? [];
		kind = touchesSensitivePath(paths) ? "parked_sensitive_merge" : "ready_to_merge";
	} else if (!ATTENTION_KINDS.has(kind) && !INFO_KINDS.has(kind) && isPark) {
		kind = "blocked";
	}

	const known = ATTENTION_KINDS.has(kind) || INFO_KINDS.has(kind) || kind === "ready_to_merge";
	if (!known) return null;

	return {
		kind,
		sessionId: String(sessionId),
		subjectKind: String(subjectKind),
		subjectId: String(subjectId),
		projectId: String(projectId),
		title: String(title),
		url: String(url),
		attention: ATTENTION_KINDS.has(kind),
	};
}

// signature is the dedup key: the same (session, kind) that has not resolved in
// between must not re-alert. Distinct kinds for the same session DO alert (a
// worker going needs_input -> blocked is a real new transition).
export function signature(rec) {
	const subject = attentionSubject(rec);
	if (subject.kind && subject.id) {
		return `${rec.projectId}/${subject.kind}:${subject.id}#${rec.kind}`;
	}
	return `${rec.projectId}/${rec.sessionId}#${rec.kind}`;
}

function attentionSubject(rec) {
	if (rec?.subjectKind && rec?.subjectId) return { kind: rec.subjectKind, id: rec.subjectId };
	if (rec?.kind === "main_ci_red" && rec?.projectId) return { kind: "project", id: rec.projectId };
	if (rec?.sessionId) return { kind: "session", id: rec.sessionId };
	return { kind: "", id: "" };
}

function withAttentionSubject(rec) {
	if (!rec || typeof rec !== "object") return rec;
	const subject = attentionSubject(rec);
	if (!subject.kind || !subject.id) return rec;
	return { ...rec, subjectKind: subject.kind, subjectId: subject.id };
}

// --- Message rendering -----------------------------------------------------

export function renderAlert(rec, mentionUserId) {
	const icon = ICONS[rec.kind] ?? "📌";
	const proj = rec.projectId ? `[${rec.projectId}] ` : "";
	const sess = rec.sessionId ? `${rec.sessionId}: ` : "";
	const text = `${icon} *${rec.kind}* ${proj}${sess}${rec.title} ${rec.url}`.trim();
	if (mentionUserId && rec.attention) {
		return `<@${mentionUserId}> ${text}`;
	}
	return text;
}

// renderDigest builds the single "what needs me" view: every session currently
// awaiting Nick, grouped by project, with reason + link. Explicit empty state.
export function renderDigest(records, { now = new Date(), mentionUserId = "" } = {}) {
	const pending = records.filter((r) => r && r.attention);
	const stamp = (now instanceof Date ? now : new Date(now)).toISOString().replace(/\.\d+Z$/, "Z");
	if (pending.length === 0) {
		return `✅ *Nothing needs you* — all sessions healthy _(as of ${stamp})_`;
	}
	const mention = mentionUserId ? `<@${mentionUserId}> ` : "";
	const header = `${mention}🔔 *${pending.length} thing${pending.length === 1 ? "" : "s"} need${
		pending.length === 1 ? "s" : ""
	} you* _(as of ${stamp})_`;
	const byProject = new Map();
	for (const r of pending) {
		const key = r.projectId || "(no project)";
		if (!byProject.has(key)) byProject.set(key, []);
		byProject.get(key).push(r);
	}
	const lines = [header];
	for (const [proj, recs] of byProject) {
		lines.push(`*${proj}*`);
		for (const r of recs) {
			const icon = ICONS[r.kind] ?? "📌";
			const link = r.url ? ` <${r.url}|link>` : "";
			const why = r.title ? ` — ${r.title}` : "";
			lines.push(`  ${icon} \`${r.sessionId}\` (${r.kind})${why}${link}`);
		}
	}
	return lines.join("\n");
}

// --- Dedup / attention state machine --------------------------------------
//
// Tracks which (session, kind) signatures Nick has already been alerted about
// so a repeated poll of the same unchanged state does not re-spam, while a
// genuinely new transition (or a re-entry after resolution) does alert.
export class AttentionTracker {
	constructor() {
		// signature -> record (currently-open attention items)
		this.open = new Map();
		// notification ids already handled (idempotency across replay/reconnect)
		this.seenIds = new Set();
	}

	// observe a single normalized attention record (+ optional stable id).
	// Returns { alert: boolean, record }. alert=true exactly once per new
	// signature until it resolves.
	observe(rec, id) {
		if (!rec || !rec.attention) return { alert: false, record: rec };
		if (id != null) {
			if (this.seenIds.has(id)) return { alert: false, record: rec };
			this.seenIds.add(id);
		}
		const sig = signature(rec);
		if (this.open.has(sig)) {
			// Same unchanged state — refresh payload, do not re-alert.
			this.open.set(sig, rec);
			return { alert: false, record: rec };
		}
		this.open.set(sig, rec);
		return { alert: true, record: rec };
	}

	// isOpen reports whether this signature has already been alerted and not yet
	// resolved. Used by the notifier to decide whether to (re)post an alert
	// WITHOUT committing the signature — so a failed Slack post is retried on the
	// next poll instead of being silently marked handled.
	isOpen(rec) {
		if (!rec) return false;
		return this.open.has(signature(rec));
	}

	// markOpen commits a signature as alerted. Call this only AFTER the alert has
	// actually been delivered, so transient delivery failures are retried.
	markOpen(rec) {
		if (!rec || !rec.attention) return;
		this.open.set(signature(rec), rec);
	}

	// reconcile against the authoritative current pending set (from a full list
	// poll). Signatures no longer present are considered resolved and dropped so
	// a later re-entry alerts again. Returns the list of resolved records.
	reconcile(currentRecords) {
		const currentSigs = new Set(currentRecords.filter((r) => r && r.attention).map((r) => signature(r)));
		const resolved = [];
		for (const [sig, rec] of this.open) {
			if (!currentSigs.has(sig)) {
				resolved.push(rec);
				this.open.delete(sig);
			}
		}
		return resolved;
	}

	// snapshot of everything currently awaiting attention (for the digest).
	pending() {
		return [...this.open.values()];
	}

	// serialize/deserialize let the open-signature set survive a notifier
	// restart, so a routine deploy does not re-alert every still-pending session
	// as if it were a brand-new transition.
	serialize() {
		return JSON.stringify({ open: [...this.open.entries()] });
	}

	static deserialize(json) {
		const t = new AttentionTracker();
		try {
			const raw = typeof json === "string" ? JSON.parse(json) : json;
			for (const [, rec] of raw.open ?? []) {
				const normalized = withAttentionSubject(rec);
				t.open.set(signature(normalized), normalized);
			}
		} catch {}
		return t;
	}
}

// --- Session-poll → attention mapping -------------------------------------
//
// The most robust attention source is a full poll of /api/v1/sessions: it is
// the authoritative CURRENT state (so reconcile/dedup and the "what needs me"
// digest never drift), whereas creation events can be missed on a notifier
// restart. attentionFromSession maps one session DTO to an attention record,
// or null when the session needs nothing.
//
// DTO shape (see backend/internal/httpd sessions controller):
//   { id, projectId, kind, activity:{state}, status, isTerminated, prs:[...] }
export function attentionFromSession(s) {
	if (!s || typeof s !== "object") return null;
	if (s.isTerminated) return null;
	const state = s.activity?.state ?? "";
	const status = s.status ?? "";
	const isOrchestrator = s.kind === "orchestrator";
	let kind = null;
	// Check the explicit activity states BEFORE the status-derived fallback:
	// the backend reports a blocked session with status "needs_input" too, so a
	// status-first test would misclassify blocked as needs_input and lose the
	// blocked reason (and its distinct dedup signature on a waiting->blocked
	// transition).
	if (state === "blocked") {
		kind = "blocked";
	} else if (state === "waiting_input" || status === "needs_input") {
		kind = "needs_input";
	} else if (status === "no_signal") {
		// The activity hook went silent. For an orchestrator this is a
		// dead/errored orchestrator; for a worker it is a stuck/no-signal session.
		kind = isOrchestrator ? "orchestrator_dead" : "no_signal";
	}
	if (!kind) return null;
	return {
		kind,
		sessionId: String(s.id ?? ""),
		subjectKind: "session",
		subjectId: String(s.id ?? ""),
		projectId: String(s.projectId ?? ""),
		title: attentionTitle(kind, s),
		url: sessionUrl(s),
		attention: true,
	};
}

export function attentionFromMainCI(main) {
	if (!main || typeof main !== "object") return null;
	if (main.status !== "failing" && main.state !== "failing") return null;
	const sha = String(main.sha ?? main.headSha ?? "").slice(0, 8);
	const failedJobs = Array.isArray(main.failedJobs) ? main.failedJobs.map(String).filter(Boolean) : [];
	const jobs = failedJobs.length ? failedJobs.join(", ") : "unknown jobs";
	return {
		kind: "main_ci_red",
		sessionId: "main",
		subjectKind: "project",
		subjectId: String(main.projectId ?? ""),
		projectId: String(main.projectId ?? ""),
		title: `main is red at ${sha || "unknown"}: ${jobs}`,
		url: String(main.url ?? main.htmlUrl ?? ""),
		attention: true,
	};
}

export function attentionFromMainCIRecords(records = []) {
	const list = Array.isArray(records) ? records : [];
	return list.map((r) => attentionFromMainCI(r)).filter(Boolean);
}

function attentionTitle(kind, s) {
	if (kind === "needs_input") return "waiting for input";
	if (kind === "blocked") return "blocked / stuck";
	if (kind === "orchestrator_dead") return "orchestrator down (no live process)";
	if (kind === "no_signal") return "activity signal lost";
	return s.status ?? "";
}

function sessionUrl(s) {
	const pr = Array.isArray(s.prs) && s.prs.length ? s.prs[0] : null;
	if (pr && (pr.url || pr.prUrl)) return pr.url ?? pr.prUrl;
	return "";
}

// attentionFromSessions maps a full /api/v1/sessions payload to the current
// set of attention records (dropping non-attention sessions).
export function attentionFromSessions(payload) {
	const list = Array.isArray(payload) ? payload : (payload?.sessions ?? payload?.data ?? []);
	const out = attentionFromMainCIRecords(payload?.mainCI ?? payload?.mainCi ?? []);
	for (const s of list) {
		const rec = attentionFromSession(s);
		if (rec) out.push(rec);
	}
	return out;
}
