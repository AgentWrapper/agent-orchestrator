import { describe, expect, it } from "vitest";
import { discardHistoricalPages, mergeConversationPages, type ConversationPage } from "./snapshot";

function page(overrides: Partial<ConversationPage> = {}): ConversationPage {
	return {
		conversationId: "conv-1",
		sessionId: "session-1",
		harness: "codex",
		mode: "chat",
		controller: { state: "ready" },
		latestSequence: 3,
		oldestSequence: 1,
		hasMoreBefore: false,
		turns: [],
		items: [],
		settings: {},
		...overrides,
	};
}

describe("mobile conversation pagination", () => {
	it("keeps chronological order and the oldest page cursor", () => {
		const merged = mergeConversationPages([
			page({ oldestSequence: 3, hasMoreBefore: true, items: [{ kind: "message", id: "m3", sequence: 3, revision: 1, role: "assistant", origin: "provider", text: "new", streaming: false, createdAt: "2026-01-01" }] }),
			page({ oldestSequence: 1, hasMoreBefore: false, items: [{ kind: "message", id: "m1", sequence: 1, revision: 1, role: "user", origin: "human", text: "old", streaming: false, createdAt: "2026-01-01" }] }),
		]);
		expect(merged?.items.map((item) => item.id)).toEqual(["m1", "m3"]);
		expect(merged?.oldestSequence).toBe(1);
		expect(merged?.hasMoreBefore).toBe(false);
	});

	it("lets the live page replace an overlapping streaming revision", () => {
		const historical = { kind: "message" as const, id: "m2", sequence: 2, revision: 1, role: "assistant" as const, origin: "provider" as const, text: "hel", streaming: true, createdAt: "2026-01-01" };
		const live = { ...historical, revision: 2, text: "hello", streaming: false };
		const merged = mergeConversationPages([page({ items: [live] }), page({ items: [historical] })]);
		expect(merged?.items).toEqual([live]);
	});

	it("drops stale historical rows before a rollback projection is reloaded", () => {
		const live = page({ oldestSequence: 3, hasMoreBefore: true });
		const historical = page({ oldestSequence: 1, hasMoreBefore: false });
		expect(discardHistoricalPages([live, historical])).toEqual([live]);
	});
});
