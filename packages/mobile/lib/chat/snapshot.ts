import type { ConversationItem, ConversationSnapshot, ConversationTurn } from "./types";

export type ConversationPage = ConversationSnapshot;

/**
 * A rollback rewrites the projection by removing rows. A live first page cannot
 * carry tombstones for rows cached in older pages, so those pages must be
 * discarded before the authoritative refresh and may be paged in again later.
 */
export function discardHistoricalPages(pages: ConversationPage[]): ConversationPage[] {
	return pages.length ? pages.slice(0, 1) : pages;
}

/** Merge historical pages behind the current live page without duplicating revisions. */
export function mergeConversationPages(pages: ConversationPage[]): ConversationSnapshot | undefined {
	const live = pages[0];
	if (!live) return undefined;
	const items = new Map<string, ConversationItem>();
	const turns = new Map<string, ConversationTurn>();
	// Oldest first, so newer pages replace the same item/turn with its latest
	// revision when a page boundary overlaps a streaming update.
	for (const page of [...pages].reverse()) {
		for (const item of page.items) items.set(`${item.kind}:${item.id}`, item);
		for (const turn of page.turns) turns.set(turn.id, turn);
	}
	const oldest = pages[pages.length - 1] ?? live;
	return {
		...live,
		oldestSequence: oldest.oldestSequence,
		hasMoreBefore: oldest.hasMoreBefore,
		items: [...items.values()].sort((a, b) => a.sequence - b.sequence),
		turns: [...turns.values()].sort((a, b) => a.requestedAt.localeCompare(b.requestedAt)),
	};
}
