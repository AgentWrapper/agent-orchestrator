#!/usr/bin/env node
// what-needs-me — a single terminal view aggregating everything awaiting Nick
// across ALL projects, with reasons + links and an explicit "nothing needs you"
// empty state. Complements the in-place Slack digest for when Nick is at a shell.
//
// Vanilla rule: this is a pure RENDERER of the daemon's canonical operator
// attention projection (GET /api/v1/attention/operator). It owns no attention
// classification of its own — the daemon decides what needs the operator; this
// command only formats the Item DTOs (the same projection the web waiting page
// and `ao waiting` consume). See backend/internal/service/attention.

import { fetchMainCI, mainCIAttentionRecord } from "./ao-slack-notifier.mjs";
import { isMainModule } from "./main-module.mjs";

const ICONS = {
	decision: "🖐️",
	blocked: "🚧",
	pr: "🟢",
	parked_sensitive_merge: "🛑",
	prime_dead: "💀",
	orchestrator_dead: "💀",
	no_signal: "🛰️",
	main_ci_red: "🚨",
	worker_retry_exhausted: "🚨",
	duplicate_pr: "♊",
	orchestrator_replacement_capped: "🚨",
};

function itemsOf(payload) {
	if (Array.isArray(payload)) return payload;
	if (Array.isArray(payload?.items)) return payload.items;
	return [];
}

// projectionItems validates a GET /attention/operator response shape: a bare
// array or {items:[...]}. Anything else throws — a malformed payload must never
// silently render as "Nothing needs you" (it becomes a non-zero exit in main).
export function projectionItems(payload) {
	if (Array.isArray(payload)) return payload;
	if (Array.isArray(payload?.items)) return payload.items;
	throw new Error("attention: invalid payload shape (expected an items array)");
}

function itemTarget(item) {
	if (Number(item.prNumber) > 0) return `#${item.prNumber}`;
	return String(item.sessionId ?? item.projectId ?? "");
}

function itemLink(item) {
	return item.deepLink || item.prUrl || "";
}

// renderTerminal builds the plain-text "what needs me" view (pure/testable) from
// the projection response. The projection is already deduped and ordered
// newest-first by the daemon, so this only groups by project for display.
export function renderTerminal(payload, { now = new Date() } = {}) {
	const items = itemsOf(payload);
	const stamp = (now instanceof Date ? now : new Date(now)).toISOString().replace(/\.\d+Z$/, "Z");
	if (items.length === 0) {
		return `✅ Nothing needs you — all sessions healthy (as of ${stamp})`;
	}
	const byProject = new Map();
	for (const item of items) {
		const key = item.projectId || "(no project)";
		if (!byProject.has(key)) byProject.set(key, []);
		byProject.get(key).push(item);
	}
	const one = items.length === 1;
	const lines = [`🔔 ${items.length} thing${one ? "" : "s"} need${one ? "s" : ""} your attention (as of ${stamp})`, ""];
	for (const [proj, list] of byProject) {
		lines.push(`${proj}:`);
		for (const item of list) {
			const link = itemLink(item) ? `  ${itemLink(item)}` : "";
			const why = item.reason ? ` (${item.reason})` : "";
			lines.push(`  ${ICONS[item.kind] ?? "📌"} ${itemTarget(item)} — ${item.kind}${why}${link}`);
		}
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}

// mainCIItems maps fetchMainCI results to projection-shaped items so the
// terminal digest can prepend them. Main-branch CI health is the one condition
// the daemon does not compute into the projection, so this renderer keeps its
// own GitHub probe — the same exceptional carve-out the Slack notifier keeps.
export function mainCIItems(records = []) {
	return (Array.isArray(records) ? records : [])
		.map((main) => mainCIAttentionRecord(main))
		.filter(Boolean)
		.map((rec) => ({
			id: rec.id,
			kind: rec.kind,
			projectId: rec.projectId,
			sessionId: rec.sessionId,
			reason: rec.title,
			deepLink: rec.url,
		}));
}

function isMain() {
	return isMainModule(import.meta.url);
}

async function main() {
	const port = process.env.AO_PORT || "3001";
	let items;
	try {
		const res = await fetch(`http://127.0.0.1:${port}/api/v1/attention/operator`, {
			headers: { accept: "application/json" },
		});
		if (!res.ok) throw new Error(`attention: HTTP ${res.status}`);
		items = projectionItems(await res.json());
	} catch (e) {
		console.error(`what-needs-me: cannot read the ao attention projection on :${port} — ${e.message}`);
		process.exit(2);
	}
	try {
		items = [...mainCIItems(await fetchMainCI()), ...items];
	} catch (e) {
		console.error(`what-needs-me: main CI status unavailable — ${e.message}`);
	}
	console.log(renderTerminal({ items }));
}

if (isMain()) main();
