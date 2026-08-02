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
	/**
	 * What this turn changed on disk. Absent is not "changed nothing": an agent
	 * that cannot report diffs never reports at all, and the UI must not draw an
	 * empty changed-files panel as if the turn had been inspected.
	 */
	diff?: TurnDiff;
}

/** How a file changed. The daemon's neutral names, not a provider's. */
export type DiffStatus = "added" | "modified" | "deleted" | "renamed";

export interface DiffFile {
	path: string;
	additions: number;
	deletions: number;
	status: DiffStatus;
	/** Set only for a rename. */
	oldPath?: string;
}

export interface TurnDiff {
	files: DiffFile[];
	/** The daemon cut the list at its cap; the change is larger than what is shown. */
	truncated?: boolean;
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
	 *
	 * Set for BOTH output sources. Measured on codex-cli 0.146.0: a command
	 * printing tick-1..tick-8 lost tick-1 from the delta stream and from the
	 * aggregate alike, so accumulating deltas buys liveness, not completeness.
	 */
	outputMayBePartial?: boolean;
	/**
	 * Which channel the text came from.
	 *
	 * `stream` is accumulated output deltas: it exists while the command is still
	 * running, and it is the only source for a command that never completes.
	 * `aggregate` is the provider's own roll-up, which only appears on completion
	 * and is all a fast command produces. Both are partial, for different reasons,
	 * which is why the UI names the reason instead of hedging identically.
	 */
	outputSource?: "stream" | "aggregate";
	/** Accumulation stopped at the daemon's cap; the command printed more. */
	outputTruncated?: boolean;
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

/**
 * What a compaction reclaimed.
 *
 * Every field is optional because the provider reports none of them on its own
 * compaction event — the driver brackets them from the token-usage reports either
 * side of it, and omits what it could not observe. A compaction right after a
 * restart genuinely does not know what it saved, so the UI says nothing rather
 * than showing a zero.
 */
export interface CompactionDetail {
	/**
	 * Which kind of system event this row is. `system` is a general bucket, so the
	 * daemon stamps the discriminator rather than leaving the renderer to guess a
	 * compaction from the presence of token fields, which are all optional.
	 */
	event?: "compaction";
	tokensBefore?: number;
	tokensAfter?: number;
	tokensReclaimed?: number;
	contextWindow?: number;
}

/**
 * Whether a timeline item is the marker for a history compaction.
 *
 * Deliberately not a type predicate: it is used inside a boolean expression that
 * has already narrowed the item to an activity, and a predicate there would narrow
 * the negation to `never`.
 */
export function isCompaction(item: ConversationItem): boolean {
	return item.kind === "activity" && item.detail?.event === "compaction";
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
	detail?: CommandDetail & FileChangeDetail & UsageDetail & CompactionDetail;
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

/**
 * How full this conversation is.
 *
 * Current state, not a timeline entry: the provider reports it after every tool
 * call, and one row per report is what buried the conversation. What a reader
 * needs is the fraction, not the raw figure -- a token count with no window is a
 * number with no scale.
 */
export interface ConversationUsage {
	contextUsed: number;
	/** 0 when the provider would not state a window for this model. */
	contextWindow: number;
	/** The conversation's cumulative spend, which is a different question from
	 *  fullness: it grows without bound while context rises and falls. */
	inputTokens: number;
	outputTokens: number;
	cachedTokens: number;
	totalTokens: number;
}

/**
 * The account's quota position, which is why a turn can fail for reasons that
 * have nothing to do with what the user asked.
 */
export interface ConversationRateLimits {
	/** Percentages in 0..100. Negative means the provider did not report that
	 *  window, which is not the same as reporting it empty. */
	primaryUsedPercent: number;
	secondaryUsedPercent: number;
	/** Seconds remaining, not an absolute instant. */
	primaryResetsInSeconds?: number;
	secondaryResetsInSeconds?: number;
	planLabel?: string;
}

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
	/** Undefined until the provider reports. Distinct from a conversation using
	 *  nothing, so the meter is withheld rather than drawn empty. */
	usage?: ConversationUsage;
	rateLimits?: ConversationRateLimits;
	/**
	 * When history was last summarized to reclaim context, or absent if never.
	 *
	 * Read from the snapshot rather than scanned out of the timeline: the timeline
	 * is unbounded and this is consulted on every render.
	 */
	compactedAt?: string;
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
