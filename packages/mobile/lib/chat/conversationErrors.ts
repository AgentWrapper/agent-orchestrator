/** Stable, user-actionable copy for conversation protocol failures. */
export function conversationActionError(error: unknown): string {
	const code = typeof error === "object" && error !== null && "code" in error ? String(error.code ?? "") : "";
	switch (code) {
		case "CHAT_NO_ACTIVE_TURN": return "The turn finished before this guidance landed. Queue it as a new message instead.";
		case "CHAT_TURN_NOT_STEERABLE": return `${error instanceof Error ? error.message : "This turn cannot be steered right now."} Try again when it finishes, or queue a new message.`;
		case "CHAT_STEER_UNSUPPORTED": return "This agent cannot steer a running turn. Queue the message for next instead.";
		case "CHAT_STEER_TEXT_REQUIRED": return "Type something to steer with.";
		case "CHAT_COMPACTION_BUSY": return "Stop the current turn before compacting history.";
		case "CHAT_COMPACTION_UNSUPPORTED": return "This agent cannot compact its history.";
		case "CHAT_MCP_RELOAD_UNSUPPORTED": return "This agent cannot reload its MCP servers.";
		default: return error instanceof Error ? error.message : String(error);
	}
}
