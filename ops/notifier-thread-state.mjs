// notifier-thread-state — the thread->session bindings written by the CURRENT
// outbound Slack notifier, read by the inbound reply listener (#293/M6).
//
// Two-way replies (issue #82) route a threaded Slack reply back to the session
// that raised the alert by looking up the alert's message `ts`. Only the RETIRED
// notifier ever wrote those bindings (into ~/.ao/attention-state.json, which
// deploy now actively deletes); the current notifier discarded
// `chat.postMessage.ts` and persisted only seen ids. So the listener had nothing
// to look up and every threaded reply to a live alert became `unknown_thread`.
//
// The binding now lives in the notifier's own state file, alongside the rest of
// its durable state, and this module is the shared reader — the listener does not
// import the notifier itself (which has main-module side effects).

import { readFileSync } from "node:fs";

import { ThreadSessionMap } from "./slack-reply-core.mjs";

export function defaultNotifierStateFile(env = process.env) {
	return env.AO_SLACK_NOTIFIER_STATE || `${env.HOME || "/home/orchestrator"}/.ao/slack-notifier-state.json`;
}

// loadNotifierThreadMap rebuilds the thread map from the notifier's persisted
// `threadBindings` ({ ts: { sessionId, projectId } }). Insertion order is the
// file's order, which the notifier keeps oldest-first, so the map's bounded LRU
// eviction stays meaningful across a restart.
export function loadNotifierThreadMap(file = defaultNotifierStateFile()) {
	const map = new ThreadSessionMap();
	try {
		const raw = JSON.parse(readFileSync(file, "utf8"));
		const bindings = raw?.threadBindings;
		if (!bindings || typeof bindings !== "object") return map;
		for (const [ts, target] of Object.entries(bindings)) {
			// remember() drops anything without a sessionId, so a corrupt or partial
			// entry degrades to "no binding" rather than a misroute.
			map.remember(String(ts), {
				sessionId: String(target?.sessionId ?? ""),
				projectId: String(target?.projectId ?? ""),
			});
		}
	} catch {
		// An unreadable/absent state file means no bindings, never a crash: the
		// listener still serves explicit `send <session> …` replies.
	}
	return map;
}
