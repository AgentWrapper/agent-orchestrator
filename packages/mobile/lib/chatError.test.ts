import { describe, expect, it } from "vitest";
import { chatErrorCopy, isChatPreflightError } from "./chatError";

function apiError(code: string, message = "Conflict"): Error & { code: string } {
	return Object.assign(new Error(message), { code });
}

describe("Chat preflight errors", () => {
	it("recognizes every typed create-time failure that can fall back to TUI", () => {
		for (const code of [
			"SESSION_MODE_UNSUPPORTED",
			"CHAT_DRIVER_UNAVAILABLE",
			"CHAT_DRIVER_INCOMPATIBLE",
			"CHAT_AUTH_REQUIRED",
		]) {
			expect(isChatPreflightError(apiError(code))).toBe(true);
		}
	});

	it("does not offer TUI for unrelated conflicts and keeps daemon detail readable", () => {
		expect(isChatPreflightError(apiError("BRANCH_CHECKED_OUT_ELSEWHERE"))).toBe(false);
		expect(chatErrorCopy(apiError("CHAT_AUTH_REQUIRED", "409 Conflict - Sign in to Claude Code on the AO host"))).toBe(
			"Sign in to Claude Code on the AO host",
		);
	});
});
