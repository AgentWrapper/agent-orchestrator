import { describe, expect, it } from "vitest";
import { conversationActionError } from "./conversationErrors";

describe("mobile conversation action errors", () => {
	it("turns protocol codes into instructions the user can act on", () => {
		expect(conversationActionError(Object.assign(new Error("conflict"), { code: "CHAT_NO_ACTIVE_TURN" })))
			.toContain("Queue it as a new message");
		expect(conversationActionError(Object.assign(new Error("busy"), { code: "CHAT_COMPACTION_BUSY" })))
			.toBe("Stop the current turn before compacting history.");
		expect(conversationActionError(Object.assign(new Error("nope"), { code: "CHAT_MCP_RELOAD_UNSUPPORTED" })))
			.toBe("This agent cannot reload its MCP servers.");
	});
});
