import type {
	ConversationActivity,
	ConversationItem,
	ConversationSnapshot,
	ConversationTurn,
} from "./types";

export type ConversationGroup = {
	key: string;
	turnId?: string;
	anchor: number;
	items: ConversationItem[];
	turn?: ConversationTurn;
};

export type ConversationMarker = {
	key: string;
	sequence: number;
	title: string;
	detail?: string;
	state?: ConversationTurn["state"];
};

/** Keep conversation signal while removing provider telemetry/noise. */
export function readableConversationItems(snapshot: ConversationSnapshot): ConversationItem[] {
	const plannedTurns = new Set(snapshot.turns.filter((turn) => turn.plan?.steps.length).map((turn) => turn.id));
	return snapshot.items.filter((item) => item.kind === "message" || (
		item.activityKind !== "usage" &&
		item.activityKind !== "reasoning" &&
		!(item.activityKind === "plan" && item.turnId && plannedTurns.has(item.turnId))
	));
}

/**
 * A turn remains one readable exchange even when queued-message sequencing
 * interleaves it with the turn currently running. This is presentation grouping
 * over daemon-owned sequence/turn identities, never inferred lifecycle state.
 */
export function groupConversationByTurn(
	snapshot: ConversationSnapshot,
	items = readableConversationItems(snapshot),
): ConversationGroup[] {
	const turns = new Map(snapshot.turns.map((turn) => [turn.id, turn]));
	const byTurn = new Map<string, ConversationGroup>();
	const groups: ConversationGroup[] = [];
	for (const item of items) {
		if (!item.turnId) {
			const previous = groups.at(-1);
			if (previous && !previous.turnId) previous.items.push(item);
			else groups.push({ key: `loose-${item.sequence}`, anchor: item.sequence, items: [item] });
			continue;
		}
		const existing = byTurn.get(item.turnId);
		if (existing) existing.items.push(item);
		else {
			// The first loaded item can move backward when an older page arrives. The
			// durable turn identity cannot, so use it as the React/FlatList key and
			// preserve expanded rows and scroll measurements across pagination.
			const group = { key: `turn-${item.turnId}`, turnId: item.turnId, anchor: item.sequence, items: [item], turn: turns.get(item.turnId) } satisfies ConversationGroup;
			byTurn.set(item.turnId, group);
			groups.push(group);
		}
	}
	return groups.sort((left, right) => left.anchor - right.anchor);
}

export function conversationMarkers(snapshot: ConversationSnapshot): ConversationMarker[] {
	return groupConversationByTurn(snapshot).map((group) => {
		const human = group.items.find((item) => item.kind === "message" && item.role === "user" && item.origin === "human");
		const assistant = [...group.items].reverse().find((item) => item.kind === "message" && item.role === "assistant" && item.text.trim());
		const activity = group.items.find((item): item is ConversationActivity => item.kind === "activity");
		const title = previewText(human?.kind === "message" ? human.text : activity?.summary || "Conversation update", 120);
		const detailSource = assistant?.kind === "message" ? assistant.text : activity?.detail?.text || activity?.summary;
		const detail = detailSource ? previewText(String(detailSource), 240) : undefined;
		return { key: group.key, sequence: group.anchor, title, detail: detail && detail !== title ? detail : undefined, state: group.turn?.state };
	});
}

export function canRollbackTurn(snapshot: ConversationSnapshot, turn: ConversationTurn): boolean {
	return snapshot.capabilities?.includes("rollback") === true &&
		!snapshot.turns.some((candidate) => candidate.state === "running" || candidate.state === "queued") &&
		turn.state !== "running" && turn.state !== "queued" &&
		Boolean(turn.providerTurnId) &&
		!turn.rolledBack;
}

export function activityStartsExpanded(activity: ConversationActivity): boolean {
	const detail = activity.detail;
	const liveBody = activity.status === "running" && Boolean(
		detail?.output || detail?.result || detail?.error || detail?.patchOutput,
	);
	return activity.status === "failed" || liveBody;
}

function previewText(value: string, limit: number): string {
	const plain = value
		.replace(/```[\s\S]*?```/g, " code sample ")
		.replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
		.replace(/[*_`#>~]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return plain.length > limit ? `${plain.slice(0, limit - 1).trimEnd()}…` : plain;
}
