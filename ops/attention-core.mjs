// attention-core — TRANSPORT primitives for the Slack notifier (issue #268/#313).
//
// The daemon owns the ONE canonical operator-attention projection
// (GET /api/v1/attention/operator, backend/internal/service/attention). This
// module no longer classifies what needs the operator — that derivation was
// deleted with the #268 consolidation. What remains here is pure Slack transport
// glue the notifier reuses:
//   - Slack member-id resolution (config)
//   - a stable posting-dedup signature (keyed on the projection item id)
//   - an Item DTO -> render-record adapter
//   - alert/digest rendering
//   - AttentionTracker: the notifier's posting-dedup / resolve ledger
//
// Vanilla rule: this is the ops/nickify layer. It only READS ao's public HTTP
// surface and renders Slack messages; it never modifies ao core and never
// re-derives attention from raw /sessions or notification rows.

// --- Slack member id resolution -------------------------------------------
//
// The notifier reads SLACK_MEMBER_ID natively. The legacy SLACK_MENTION_USER_ID
// alias remains a fallback ONLY so an un-migrated host keeps working, but
// SLACK_MEMBER_ID wins when both are set.
export function resolveMentionUserId(env = process.env) {
	const native = (env.SLACK_MEMBER_ID ?? "").trim();
	if (native) return native;
	const legacy = (env.SLACK_MENTION_USER_ID ?? "").trim();
	return legacy || "";
}

// Display icons per projection item kind. Purely presentational — the daemon
// decides membership; this only chooses a glyph.
const ICONS = {
	decision: "🖐️",
	blocked: "🚧",
	pr: "🟢",
	parked_sensitive_merge: "🛑",
	prime_dead: "💀",
	orchestrator_dead: "💀",
	no_signal: "🛰️",
	daemon_unhealthy: "❤️‍🩹",
	main_ci_red: "🚨",
	worker_retry_exhausted: "🚨",
	duplicate_pr: "♊",
	orchestrator_replacement_capped: "🚨",
};

// signature is the posting-dedup key. Projection items carry a stable, already
// deduped id from the daemon, so that id IS the signature. The fallback covers
// synthetic transport records (e.g. the main-CI probe and the daemon-unreachable
// alarm) that are not projection items.
export function signature(rec) {
	if (rec?.id) return String(rec.id);
	return `${rec?.projectId ?? ""}/${rec?.sessionId ?? ""}#${rec?.kind ?? ""}`;
}

// canonicalPrKey mirrors the daemon's PR-identity normalization EXACTLY
// (backend/internal/service/attention canonicalPRKey): host/owner/repo#number,
// folding GitLab's "/-/merge_requests/N" web form and GitHub's
// "api.github.com/repos/o/r/pulls/N" API form onto the same identity, and
// falling back to the trimmed raw URL for anything unparseable. The shared
// contract table is ops/canonical-pr-key-fixtures.json — both languages' tests
// read it, so the parsers cannot drift. The notifier uses this only to migrate
// pre-projection state records onto projection item ids; it is not a classifier.
export function canonicalPrKey(raw) {
	const trimmed = String(raw ?? "").trim();
	let u;
	try {
		u = new URL(trimmed);
	} catch {
		return trimmed;
	}
	if (!u.host) return trimmed;
	const segs = u.pathname.replace(/^\/+|\/+$/g, "").split("/");
	if (segs.length < 4) return trimmed;
	const kind = segs[segs.length - 2];
	const number = segs[segs.length - 1];
	if (!(kind === "pull" || kind === "pulls" || kind === "merge_requests") || !/^[0-9]+$/.test(number)) {
		return trimmed;
	}
	let host = u.host.toLowerCase();
	let repoSegs = segs.slice(0, -2);
	if (repoSegs[repoSegs.length - 1] === "-") {
		repoSegs = repoSegs.slice(0, -1); // GitLab web form separator
	}
	if (repoSegs.length > 1 && repoSegs[0] === "repos" && host.startsWith("api.")) {
		repoSegs = repoSegs.slice(1); // GitHub API form
		host = host.slice("api.".length);
	}
	if (repoSegs.length === 0) return trimmed;
	return `${host}/${repoSegs.join("/").toLowerCase()}#${number}`;
}

// attentionRecordFromItem adapts one operator-attention projection Item DTO to
// the flat render-record the alert/digest renderers and AttentionTracker use.
// It is an adapter, not a classifier: every projection item is, by construction,
// something that needs the operator. `url` is the DISPLAY link (deepLink first);
// `prUrl` is kept separately as the PR identity so terminal pr_merged /
// pr_closed_unmerged events can resolve the record even when the two differ.
export function attentionRecordFromItem(item) {
	if (!item || typeof item !== "object") return null;
	return {
		id: String(item.id ?? ""),
		kind: String(item.kind ?? ""),
		sessionId: String(item.sessionId ?? ""),
		projectId: String(item.projectId ?? ""),
		title: String(item.reason || item.sessionTitle || ""),
		url: String(item.deepLink || item.prUrl || ""),
		prUrl: String(item.prUrl ?? ""),
		attention: true,
	};
}

// attentionRecordsFromProjection maps a GET /attention/operator response to the
// current set of render-records. Accepts {items:[...]} or a bare array.
export function attentionRecordsFromProjection(payload) {
	const items = Array.isArray(payload) ? payload : (payload?.items ?? []);
	return items.map(attentionRecordFromItem).filter(Boolean);
}

// --- Message rendering -----------------------------------------------------

// escapeMrkdwn escapes Slack's mrkdwn control characters (&, <, >) in
// projection-controlled text (reasons, titles, ids, URLs) so daemon data can
// never inject a fake mention/link into a Slack message. Per Slack's own
// escaping rules these three are the only characters that need escaping.
export function escapeMrkdwn(text) {
	return String(text ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

export function renderAlert(rec, mentionUserId) {
	const icon = ICONS[rec.kind] ?? "📌";
	const proj = rec.projectId ? `[${escapeMrkdwn(rec.projectId)}] ` : "";
	const sess = rec.sessionId ? `${escapeMrkdwn(rec.sessionId)}: ` : "";
	const text =
		`${icon} *${escapeMrkdwn(rec.kind)}* ${proj}${sess}${escapeMrkdwn(rec.title)} ${escapeMrkdwn(rec.url)}`.trim();
	if (mentionUserId && rec.attention) {
		return `<@${mentionUserId}> ${text}`;
	}
	return text;
}

// renderDigest builds the single "what needs me" view: every item currently
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
		lines.push(`*${escapeMrkdwn(proj)}*`);
		for (const r of recs) {
			const icon = ICONS[r.kind] ?? "📌";
			// Inside <url|label> Slack requires &, <, > escaped in the URL as well.
			const link = r.url ? ` <${escapeMrkdwn(r.url)}|link>` : "";
			const why = r.title ? ` — ${escapeMrkdwn(r.title)}` : "";
			lines.push(`  ${icon} \`${escapeMrkdwn(r.sessionId || r.kind)}\` (${escapeMrkdwn(r.kind)})${why}${link}`);
		}
	}
	return lines.join("\n");
}

// --- Posting dedup / resolve ledger ---------------------------------------
//
// Tracks which projection items Nick has already been alerted about so a
// repeated poll of the same unchanged projection does not re-spam, while a
// genuinely new item (or a re-entry after it left and returned) does alert.
// This is transport state — the daemon decides membership; the tracker only
// remembers what has already been POSTED so delivery is idempotent.
export class AttentionTracker {
	constructor() {
		// signature -> record (currently-open attention items)
		this.open = new Map();
		// notification ids already handled (idempotency across replay/reconnect)
		this.seenIds = new Set();
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

	// reconcile against the authoritative current pending set (from a full
	// projection poll). Signatures no longer present are considered resolved and
	// dropped so a later re-entry alerts again. Returns the resolved records.
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

	// serialize/deserialize let the open-signature set survive a notifier restart,
	// so a routine deploy does not re-alert every still-pending item as if it were
	// a brand-new transition.
	serialize() {
		return JSON.stringify({ open: [...this.open.entries()] });
	}

	static deserialize(json) {
		const t = new AttentionTracker();
		try {
			const raw = typeof json === "string" ? JSON.parse(json) : json;
			for (const [, rec] of raw.open ?? []) {
				t.open.set(signature(rec), rec);
			}
		} catch {}
		return t;
	}
}
