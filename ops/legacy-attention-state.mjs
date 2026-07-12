import { readFileSync } from "node:fs";

import { ThreadSessionMap } from "./slack-reply-core.mjs";

function defaultStateFile(env = process.env) {
	return (
		env.AO_ATTENTION_LEGACY_STATE ||
		env.AO_ATTENTION_STATE ||
		`${env.HOME || "/home/orchestrator"}/.ao/attention-state.json`
	);
}

// The retired outbound notifier used this file for several kinds of state.
// The reply listener needs only thread-to-session bindings during migration.
export function loadLegacyThreadMap(file = defaultStateFile()) {
	try {
		const raw = JSON.parse(readFileSync(file, "utf8"));
		return ThreadSessionMap.deserialize(JSON.stringify(raw.threadMap ?? []));
	} catch {
		return new ThreadSessionMap();
	}
}
