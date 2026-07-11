#!/usr/bin/env node
// what-needs-me — a single terminal view aggregating everything awaiting Nick
// across ALL projects (issue #82, acceptance #3), with reasons + links and an
// explicit "nothing needs you" empty state. Complements the in-place Slack
// digest for when Nick is at a shell.
//
// Vanilla rule: reads ao's public /api/v1/sessions only.

import { fileURLToPath } from "node:url";

import { attentionFromSessions } from "./attention-core.mjs";
import { fetchMainCI } from "./ao-slack-notifier.mjs";

// renderTerminal builds the plain-text "what needs me" view (pure/testable).
export function renderTerminal(sessionsPayload, { now = new Date() } = {}) {
	const recs = attentionFromSessions(sessionsPayload);
	const stamp = (now instanceof Date ? now : new Date(now)).toISOString().replace(/\.\d+Z$/, "Z");
	if (recs.length === 0) {
		return `✅ Nothing needs you — all sessions healthy (as of ${stamp})`;
	}
	const byProject = new Map();
	for (const r of recs) {
		const key = r.projectId || "(no project)";
		if (!byProject.has(key)) byProject.set(key, []);
		byProject.get(key).push(r);
	}
	const icon = { needs_input: "🖐️", blocked: "🚧" };
	const one = recs.length === 1;
	const lines = [`🔔 ${recs.length} thing${one ? "" : "s"} need${one ? "s" : ""} your attention (as of ${stamp})`, ""];
	for (const [proj, list] of byProject) {
		lines.push(`${proj}:`);
		for (const r of list) {
			const link = r.url ? `  ${r.url}` : "";
			lines.push(`  ${icon[r.kind] ?? "📌"} ${r.sessionId} — ${r.kind} (${r.title})${link}`);
		}
		lines.push("");
	}
	return lines.join("\n").trimEnd();
}

function isMain() {
	return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
}

async function main() {
	const port = process.env.AO_PORT || "3001";
	let payload;
	try {
		const res = await fetch(`http://127.0.0.1:${port}/api/v1/sessions`, {
			headers: { accept: "application/json" },
		});
		if (!res.ok) throw new Error(`sessions: HTTP ${res.status}`);
		payload = await res.json();
	} catch (e) {
		console.error(`what-needs-me: cannot reach the ao daemon on :${port} — ${e.message}`);
		process.exit(2);
	}
	try {
		payload = { ...payload, mainCI: await fetchMainCI() };
	} catch (e) {
		console.error(`what-needs-me: main CI status unavailable — ${e.message}`);
	}
	console.log(renderTerminal(payload));
}

if (isMain()) main();
