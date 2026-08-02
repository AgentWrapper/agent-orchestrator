/**
 * Chat conversation view model.
 *
 * These mirror `backend/internal/domain/conversation.go` field for field. They
 * are hand-written for now because the conversation endpoints are not in the
 * OpenAPI spec yet; once they are, this file is replaced by
 * `components["schemas"][...]` from the generated client and the shapes must not
 * drift in the meantime.
 *
 * The renderer is thin on purpose: ordering, capability, permission, and
 * lifecycle decisions all belong to the daemon. Nothing here recomputes them.
 */

/** Which controller a session was created with. Immutable for its lifetime. */
export type SessionMode = "chat" | "tui";

/** One request and the agent work that followed it. */
export type TurnState = "queued" | "running" | "completed" | "interrupted" | "failed";

export type MessageRole = "user" | "assistant";

/**
 * Who produced a message. Durable and structural — a worker or automation is
 * never identified by sniffing a text prefix.
 */
export type MessageOrigin = "human" | "automation" | "daemon" | "provider";

export type ActivityKind =
	| "command"
	| "file_change"
	| "plan"
	| "reasoning"
	| "approval"
	| "usage"
	| "error"
	| "system";

/**
 * `running` can be where an activity stops: a provider may start a command and
 * supersede it without ever completing it, so the UI must render that state
 * rather than waiting forever for a completion that is not coming.
 */
export type ActivityStatus = "running" | "completed" | "failed" | "pending" | "resolved";

/**
 * Delivery state for a message AO sent. `uncertain` is deliberately not merged
 * into `failed`: the provider may have accepted the turn while AO lost the
 * connection, and silently retrying would run the work twice.
 */
export type DeliveryState = "queued" | "sending" | "accepted" | "uncertain" | "failed";

export interface ConversationTurn {
	id: string;
	state: TurnState;
	providerTurnId?: string;
	errorMessage?: string;
	requestedAt: string;
	startedAt?: string;
	completedAt?: string;
}

export interface ConversationMessage {
	kind: "message";
	id: string;
	turnId?: string;
	/** Conversation-scoped, immutable. The only ordering key. */
	sequence: number;
	/** Bumped on each streaming rewrite so a gap is detectable. */
	revision: number;
	role: MessageRole;
	origin: MessageOrigin;
	text: string;
	/** True while more deltas are expected. */
	streaming: boolean;
	delivery?: DeliveryState;
	/** Set when origin is a worker or automation, for the attribution line. */
	senderLabel?: string;
	createdAt: string;
}

/** One choice the provider says is valid for a pending request. */
export interface DecisionOption {
	/** e.g. "accept", "acceptForSession", "acceptWithExecpolicyAmendment". */
	id: string;
	label: string;
}

export interface CommandDetail {
	/** Free text payload: a plan body, a reasoning summary, a message. */
	text?: string;
	command?: string;
	rawCommand?: string;
	cwd?: string;
	output?: string;
	/**
	 * Provider output aggregation was observed to drop leading bytes even on tiny
	 * commands, so this is display data and the UI says so rather than presenting
	 * it as the record of what ran.
	 */
	outputMayBePartial?: boolean;
	exitCode?: number;
	durationMs?: number;
	reason?: string;
}

export interface FileChangeDetail {
	files?: { path: string; additions: number; deletions: number }[];
}

export interface UsageDetail {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
}

export interface ConversationActivity {
	kind: "activity";
	id: string;
	turnId?: string;
	sequence: number;
	revision: number;
	activityKind: ActivityKind;
	status: ActivityStatus;
	/** The one-line label shown when collapsed. */
	summary: string;
	detail?: CommandDetail & FileChangeDetail & UsageDetail;
	/**
	 * The provider's identifier for an approval. Resolving matches on this, so a
	 * card left on screen cannot answer a request that replaced it.
	 */
	requestId?: string;
	/**
	 * Authoritative for an approval. The provider varies what it offers per
	 * request and does not always include a decline, so buttons are rendered
	 * from this list and never from a fixed set.
	 */
	decisions?: DecisionOption[];
	createdAt: string;
}

/** One ordered entry in the timeline. */
export type ConversationItem = ConversationMessage | ConversationActivity;

/** AO's permission vocabulary, applied per turn in chat mode. */
export type ApprovalMode = "default" | "accept-edits" | "auto" | "bypass-permissions";

/**
 * The provider choices for the next turn.
 *
 * Every field is optional and empty means the provider's own default, so clearing
 * a choice and never making one are the same thing.
 */
export interface TurnSettings {
	model?: string;
	reasoningEffort?: string;
	approvalMode?: ApprovalMode;
}

/** One model the provider offers for this session. */
export interface ChatModel {
	id: string;
	displayName: string;
	description?: string;
	/** The model the provider would pick on its own. */
	default: boolean;
	/** Reasoning levels this model supports, in the provider's order. */
	efforts?: string[];
	defaultEffort?: string;
}

/** Health of the daemon's connection to the provider. */
export type ControllerState = "connecting" | "ready" | "busy" | "recovering" | "stopped";

export interface ConversationSnapshot {
	conversationId: string;
	sessionId: string;
	harness: string;
	mode: SessionMode;
	controller: { state: ControllerState; error?: string };
	turns: ConversationTurn[];
	/** Already ordered by sequence. The renderer does not re-sort. */
	items: ConversationItem[];
	latestSequence: number;
	/** What the next turn will be sent with. Daemon-owned, so it survives a
	 *  restart and applies to turns AO dispatches on the user's behalf. */
	settings: TurnSettings;
}

/**
 * The turn currently in flight, if any.
 *
 * A running turn wins over a queued one: with a send queue both exist at once,
 * and the one the agent is actually working on is what the user is waiting on.
 */
export function activeTurn(snapshot: ConversationSnapshot): ConversationTurn | undefined {
	return (
		snapshot.turns.find((turn) => turn.state === "running") ??
		snapshot.turns.find((turn) => turn.state === "queued")
	);
}

/**
 * Turn ids for messages recorded but not yet sent.
 *
 * The daemon holds a mid-turn message instead of pushing it at a busy agent, so
 * the timeline has to distinguish "waiting to be sent" from "sent".
 */
export function queuedTurnIds(snapshot: ConversationSnapshot): Set<string> {
	return new Set(
		snapshot.turns.filter((turn) => turn.state === "queued").map((turn) => turn.id),
	);
}

/** The pending approval a user must answer, if any. */
export function pendingApproval(
	snapshot: ConversationSnapshot,
): ConversationActivity | undefined {
	return snapshot.items.find(
		(item): item is ConversationActivity =>
			item.kind === "activity" && item.activityKind === "approval" && item.status === "pending",
	);
}
