/**
 * The Chat surface for a session whose persisted mode is `chat`.
 *
 * Rendered from a durable snapshot the daemon serves. The renderer stays thin:
 * items arrive already ordered by sequence and are never re-sorted here, turn
 * state comes from the daemon rather than being inferred from the last message,
 * and a decision is a typed action carrying the provider's request id.
 *
 * State this surface must be able to show, because each one happens: empty,
 * streaming, waiting on an approval, a command still running with no completion,
 * a turn the user stopped, a controller that died mid-turn, and history the user
 * has scrolled away from.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	Archive,
	ArrowDown,
	Brain,
	Loader2,
	MessageSquare,
	Square,
	TriangleAlert,
	Undo2,
} from "lucide-react";
import { cn } from "../../lib/utils";
import { sameContent, useStableList } from "../../lib/stable-list";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ConfirmDialog";
import {
	ActivityRow,
	ApprovalCard,
	AssistantMessage,
	CompactionMarker,
	HumanMessage,
	OriginMessage,
	TurnChangedFiles,
	TurnOutcome,
} from "./ChatTimelineItems";
import { ChatComposer } from "./ChatComposer";
import { ActivityRun } from "./ActivityRun";
import { TurnSettingsBar } from "./TurnSettingsBar";
import { ContextMeter } from "./ContextMeter";
import {
	activeTurn,
	isCompaction,
	pendingApproval,
	queuedTurnIds,
	type ConversationSnapshot,
	type ControllerState,
	type ChatModel,
	type ChatSkill,
	type ConversationActivity,
	type ConversationItem,
	type TurnDiff,
	type TurnSettings,
} from "../../types/conversation";

export interface ChatWorkspaceProps {
	snapshot: ConversationSnapshot;
	onSend?: (text: string) => void;
	onDecide?: (requestId: string, decisionId: string) => void;
	onInterrupt?: () => void;
	/** A send or decision is in flight. */
	busy?: boolean;
	/** The provider's model catalog. Empty hides the model control. */
	models?: ChatModel[];
	onChooseSettings?: (settings: TurnSettings) => void;
	/** Summarize earlier history to reclaim context. */
	onCompact?: () => void;
	/** A compaction is running provider-side. It takes seconds, not milliseconds. */
	compacting?: boolean;
	/** Why compaction is not available right now, from the daemon's typed refusal. */
	compactUnavailable?: string;
	/**
	 * Discard a turn and everything after it. Absent means the agent cannot undo,
	 * and the affordance is not drawn at all rather than shown and then refused.
	 */
	onRollback?: (turnId: string) => void;
	rollbackPending?: boolean;
	rollbackError?: string;
	/** The provider's skills. Empty leaves `/` an ordinary character. */
	skills?: ChatSkill[];
	/** Worktree paths offered for `@`. */
	filePaths?: string[];
	/** The path list was capped by the daemon rather than being all of them. */
	filePathsTruncated?: boolean;
	/**
	 * Writes staged images into the worktree and answers with the paths the agent
	 * can open. Absent means no attach control is offered — the fixture preview has
	 * no worktree to write into.
	 */
	onStageAttachments?: (attachments: { mimeType: string; data: string }[]) => Promise<string[]>;
}

export function ChatWorkspace({
	snapshot,
	onSend,
	onDecide,
	onInterrupt,
	busy,
	models,
	onChooseSettings,
	onCompact,
	compacting,
	compactUnavailable,
	onRollback,
	rollbackPending,
	rollbackError,
	skills,
	filePaths,
	filePathsTruncated,
	onStageAttachments,
}: ChatWorkspaceProps) {
	const turn = activeTurn(snapshot);
	const approval = pendingApproval(snapshot);
	const queuedCount = queuedTurnIds(snapshot).size;
	// Reasoning is hidden by default. The provider emits a reasoning item per tool
	// call, usually with no readable body, so showing them turns the timeline into
	// a log. Kept behind a toggle rather than dropped, since they are occasionally
	// the only explanation of why the agent did something.
	const [showReasoning, setShowReasoning] = useState(false);
	// The turn a confirmation is open for. Undo is not reversible and it changes what
	// the agent knows, so it is never one click.
	const [confirming, setConfirming] = useState<string | undefined>(undefined);

	// Offered only while the agent is idle. The daemon refuses a rollback mid-turn,
	// and a control that exists to be refused is worse than one that waits.
	const rollbackTarget = onRollback && !turn ? (id: string) => setConfirming(id) : undefined;
	const discarded = snapshot.turns.filter((t) => t.rolledBack).length;

	return (
		<section
			aria-label="Chat"
			className="flex h-full min-h-0 flex-col bg-background"
			data-session-mode={snapshot.mode}
		>
			<ChatHeader
				snapshot={snapshot}
				showReasoning={showReasoning}
				onToggleReasoning={() => setShowReasoning((prev) => !prev)}
				onCompact={onCompact}
				compacting={compacting}
				compactUnavailable={compactUnavailable}
				// The daemon refuses a compaction mid-turn, because the provider would
				// silently discard the running turn to make room. Said here too so the
				// control explains itself before it is pressed.
				turnInFlight={Boolean(turn)}
			/>
			<ControllerBanner controller={snapshot.controller} />

			<Timeline
				snapshot={snapshot}
				onDecide={onDecide}
				busy={busy}
				showReasoning={showReasoning}
				onRollback={rollbackTarget}
			/>

			<div className="flex shrink-0 flex-col gap-2 border-t border-border px-4 py-3">
				{discarded > 0 ? <RolledBackNotice count={discarded} /> : null}
				{turn ? (
					<LiveTurnBar
						startedAt={turn.startedAt ?? turn.requestedAt}
						blocked={Boolean(approval)}
						queuedCount={queuedCount}
						onInterrupt={onInterrupt}
					/>
				) : null}
				<ChatComposer
					onSend={(text) => onSend?.(text)}
					settings={
						onChooseSettings ? (
							<TurnSettingsBar
								models={models ?? []}
								settings={snapshot.settings}
								onChange={onChooseSettings}
								disabled={snapshot.controller.state === "stopped"}
							/>
						) : null
					}
					busy={busy}
					willQueue={Boolean(turn)}
					disabled={snapshot.controller.state === "stopped"}
					skills={skills}
					filePaths={filePaths}
					filePathsTruncated={filePathsTruncated}
					onStageAttachments={onStageAttachments}
				/>
			</div>

			{/* The copy has to be honest about the cost: this is not "hide these
			    messages", it is "the agent forgets them". Nothing in the worktree is
			    reverted either, and a user who assumed otherwise would be badly
			    surprised, so it is said out loud. */}
			<ConfirmDialog
				open={Boolean(confirming)}
				onOpenChange={(open) => {
					if (!open) setConfirming(undefined);
				}}
				title="Roll back to this point?"
				description={
					<>
						<p className="text-sm font-medium text-foreground">
							The agent will forget this exchange and everything after it.
						</p>
						<p className="mt-1 text-xs text-muted-foreground">
							Its memory of the conversation is discarded up to this point, so it will not know
							about anything you or it said later. Files it already changed in the worktree are
							left exactly as they are; only the conversation is rolled back. This cannot be
							undone.
						</p>
					</>
				}
				confirmLabel="Roll back"
				destructive
				busy={rollbackPending}
				error={rollbackError ?? null}
				onConfirm={() => {
					const turnId = confirming;
					if (!turnId) return;
					setConfirming(undefined);
					onRollback?.(turnId);
				}}
			/>
		</section>
	);
}

/**
 * What an undo took away.
 *
 * Stated above the composer rather than as a timeline entry, because the discarded
 * turns keep their original sequence positions and this notice has none of its own —
 * placing it in the timeline would be claiming an order it cannot know. It sits where
 * the user is looking after an undo, and it says the part that matters: the agent
 * does not remember.
 */
function RolledBackNotice({ count }: { count: number }) {
	return (
		<p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
			<Undo2 aria-hidden="true" className="size-3 shrink-0" />
			{count === 1
				? "1 turn was rolled back. The agent no longer remembers it."
				: `${count} turns were rolled back. The agent no longer remembers them.`}
		</p>
	);
}


/**
 * Batch consecutive plain activities into a run.
 *
 * A run of tool calls is one thought, not several, so it renders as one tight
 * block on a shared rail. Messages and approvals break a run because each is
 * something the reader stops on: prose to read, or a decision to make.
 */
type TimelineRun =
	| { kind: "activities"; key: string; items: ConversationItem[] }
	| { kind: "single"; key: string; items: [ConversationItem] };

function runsOf(items: ConversationItem[]): TimelineRun[] {
	const runs: TimelineRun[] = [];
	for (const item of items) {
		const runnable =
			item.kind === "activity" &&
			item.activityKind !== "approval" &&
			item.activityKind !== "error" &&
			// An edit is a result, not a mechanic. Burying it in a summary would hide
			// the one kind of activity that changed the user's worktree.
			item.activityKind !== "file_change" &&
			// A compaction is a boundary in the conversation, not a step in one. Folding
			// it into a run of tool calls would hide that everything above it is no
			// longer what the agent sees verbatim.
			!isCompaction(item);
		const last = runs.at(-1);
		if (runnable && last?.kind === "activities") {
			last.items.push(item);
			continue;
		}
		runs.push(
			runnable
				? { kind: "activities", key: `run-${item.sequence}`, items: [item] }
				: { kind: "single", key: item.id, items: [item] },
		);
	}
	return runs;
}

/**
 * What belongs in a conversation, as opposed to what the provider happens to emit.
 *
 * Two kinds are dropped:
 *
 *   - usage. The daemon now projects it as current state on the snapshot rather
 *     than as a timeline entry, so this filter is a guard for conversations
 *     recorded by an older build whose usage rows are still on disk. Rendering one
 *     row per report is what buried the actual conversation; it lives in the
 *     header meter instead.
 *   - reasoning, unless asked for. The provider emits one per tool call and they
 *     usually carry no readable body, so by default they are pure chrome.
 *
 * Everything else is kept, including an activity this build does not fully
 * understand — dropping an unrecognized item would hide work the agent really did.
 */
function readableItems(snapshot: ConversationSnapshot, showReasoning: boolean): ConversationItem[] {
	return snapshot.items.filter((item) => {
		if (item.kind !== "activity") return true;
		if (item.activityKind === "usage") return false;
		if (item.activityKind === "reasoning") {
			// Even when shown, a reasoning item with nothing to read is just a label.
			return showReasoning && Boolean(item.detail?.reason || item.detail?.text);
		}
		return true;
	});
}

/* -------------------------------------------------------------------------- */

function ChatHeader({
	snapshot,
	showReasoning,
	onToggleReasoning,
	onCompact,
	compacting,
	compactUnavailable,
	turnInFlight,
}: {
	snapshot: ConversationSnapshot;
	showReasoning: boolean;
	onToggleReasoning: () => void;
	onCompact?: () => void;
	compacting?: boolean;
	compactUnavailable?: string;
	turnInFlight?: boolean;
}) {
	const hasReasoning = snapshot.items.some(
		(item) => item.kind === "activity" && item.activityKind === "reasoning",
	);
	return (
		<header className="flex h-toolbar shrink-0 items-center gap-3 border-b border-border px-4">
			<MessageSquare aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
			<div className="flex min-w-0 items-baseline gap-2">
				{/* The thread's own name when it has one. The daemon also pushes it into
				    the session's display name, so the sidebar and this header agree
				    without either deriving a label of its own. */}
				<strong className="truncate text-sm font-medium text-foreground" title={snapshot.title}>
					{snapshot.title || snapshot.sessionId}
				</strong>
				<span className="shrink-0 text-xs text-muted-foreground">{snapshot.harness}</span>
			</div>
			<div className="ml-auto flex shrink-0 items-center gap-2">
				{/* Current state from the snapshot, not a timeline event: the provider
				    reports usage after every tool call, and a row per report is what
				    buried the conversation. A bare total used to live here, which could
				    not answer the question the user actually has -- how full is this,
				    and am I about to hit a quota wall. */}
				<ContextMeter usage={snapshot.usage} rateLimits={snapshot.rateLimits} />
				{/* Beside the meter on purpose: the meter is what tells a user the
				    context is filling, and this is what they can do about it. */}
				<CompactButton
					onCompact={onCompact}
					compacting={compacting}
					unavailable={compactUnavailable}
					turnInFlight={turnInFlight}
					compactedAt={snapshot.compactedAt}
				/>
				{hasReasoning ? (
					<Button
						type="button"
						size="sm"
						variant="ghost"
						onClick={onToggleReasoning}
						aria-pressed={showReasoning}
						className="h-5 gap-1 px-1.5 text-[11px]"
					>
						<Brain aria-hidden="true" className="size-3" />
						{showReasoning ? "Hide reasoning" : "Reasoning"}
					</Button>
				) : null}
				{/* The mode is a durable session fact, so it is stated rather than
				    implied by which surface happens to be open. */}
				<span className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
					chat
				</span>
			</div>
		</header>
	);
}

/**
 * Reclaim context by summarizing earlier history.
 *
 * Worth a control of its own because without it a long conversation eventually
 * cannot accept another turn at all: every turn re-sends the history, so context
 * fills whether or not the user does anything unusual. This is the difference
 * between a session that works for an hour and one that works for a day.
 *
 * Disabled mid-turn rather than hidden: the daemon refuses it then, because the
 * provider would silently discard the running turn to make room, and a control
 * that vanishes teaches nothing. The tooltip says which of those it is.
 *
 * A harness whose provider cannot compact makes the control disappear once the
 * daemon has said so. It is not hidden up front because the snapshot does not
 * carry driver capabilities, and adding them for one button would be a wider
 * contract change than the affordance is worth.
 */
function CompactButton({
	onCompact,
	compacting,
	unavailable,
	turnInFlight,
	compactedAt,
}: {
	onCompact?: () => void;
	compacting?: boolean;
	unavailable?: string;
	turnInFlight?: boolean;
	compactedAt?: string;
}) {
	if (!onCompact) return null;
	if (unavailable === "This agent cannot compact its history") {
		return <span className="text-[11px] text-muted-foreground">{unavailable}</span>;
	}

	const title = turnInFlight
		? "Finish or stop the current turn before compacting"
		: compactedAt
			? `Summarize earlier history to reclaim context. Last compacted ${new Date(compactedAt).toLocaleString()}.`
			: "Summarize earlier history to reclaim context";

	return (
		<Button
			type="button"
			size="sm"
			variant="ghost"
			onClick={onCompact}
			disabled={compacting || turnInFlight}
			title={title}
			aria-label="Compact conversation history"
			className="h-5 gap-1 px-1.5 text-[11px]"
		>
			{compacting ? (
				<Loader2 aria-hidden="true" className="size-3 animate-spin" />
			) : (
				<Archive aria-hidden="true" className="size-3" />
			)}
			{compacting ? "Compacting…" : "Compact"}
		</Button>
	);
}

/**
 * Controller health. A stopped or recovering controller is announced, because a
 * silent surface is indistinguishable from an agent that is simply thinking.
 */
function ControllerBanner({
	controller,
}: {
	controller: { state: ControllerState; error?: string };
}) {
	if (controller.state === "ready" || controller.state === "busy") return null;

	const copy: Partial<Record<ControllerState, { title: string; tone: string }>> = {
		connecting: { title: "Connecting to the agent…", tone: "text-muted-foreground" },
		recovering: { title: "Reconnecting to the agent", tone: "text-warning" },
		stopped: { title: "The agent controller stopped", tone: "text-destructive" },
	};
	const shown = copy[controller.state];
	if (!shown) return null;

	return (
		<div className="flex shrink-0 items-start gap-2.5 border-b border-border bg-surface px-4 py-2.5">
			{controller.state === "connecting" ? (
				<Loader2 aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 animate-spin text-muted-foreground" />
			) : (
				<TriangleAlert aria-hidden="true" className={cn("mt-0.5 size-3.5 shrink-0", shown.tone)} />
			)}
			<div className="flex min-w-0 flex-col gap-0.5">
				<strong className={cn("text-xs font-medium", shown.tone)}>{shown.title}</strong>
				{controller.error ? (
					<span className="text-[11px] leading-snug text-muted-foreground">{controller.error}</span>
				) : null}
				{controller.state === "stopped" ? (
					<span className="text-[11px] leading-snug text-muted-foreground">
						History is kept. The conversation can be resumed, or you can open a shell in the
						worktree.
					</span>
				) : null}
			</div>
		</div>
	);
}

/* -------------------------------------------------------------------------- */

/**
 * The scrolling timeline.
 *
 * Auto-scroll only follows new items while the user is already near the bottom.
 * Once they scroll up to read, new output must not yank them away — it surfaces a
 * jump control instead.
 *
 * Everything below the scroller is memoized per turn, and the reason is the poll
 * loop rather than the item count: `useConversation` rebuilds the snapshot from
 * JSON every second while a turn runs, so an idle conversation re-renders on a
 * timer. Measured on a 1,400-item history that cost 60ms of main-thread work per
 * poll — four dropped frames a second for a conversation nobody was touching.
 * Scrolling the same history never exceeded a 16.7ms frame, which is why this is
 * memoization and not virtualization: the DOM was never the problem.
 */
function Timeline({
	snapshot,
	onDecide,
	busy,
	showReasoning,
	onRollback,
}: {
	snapshot: ConversationSnapshot;
	onDecide?: (requestId: string, decisionId: string) => void;
	busy?: boolean;
	showReasoning: boolean;
	onRollback?: (turnId: string) => void;
}) {
	const scroller = useRef<HTMLDivElement>(null);
	const [pinned, setPinned] = useState(true);
	const queued = useMemo(() => queuedTurnIds(snapshot), [snapshot]);
	const decide = useStableCallback(onDecide);
	const rollback = useStableCallback(onRollback);

	const readable = useMemo(() => readableItems(snapshot, showReasoning), [snapshot, showReasoning]);
	const items = useStableList(readable, itemKey, sameContent);
	const grouped = useMemo(() => groupByTurn({ ...snapshot, items }), [snapshot, items]);
	const groups = useStableList(grouped, groupKey, sameGroup);

	useEffect(() => {
		if (!pinned) return;
		const node = scroller.current;
		if (node) node.scrollTop = node.scrollHeight;
	}, [pinned, snapshot.latestSequence]);

	function onScroll() {
		const node = scroller.current;
		if (!node) return;
		const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
		setPinned(distance < 64);
	}

	if (items.length === 0) {
		return <EmptyState harness={snapshot.harness} />;
	}

	return (
		<div className="relative min-h-0 flex-1">
			<div
				ref={scroller}
				onScroll={onScroll}
				className="h-full overflow-y-auto px-4 py-4"
				role="log"
				aria-live="polite"
				aria-label="Conversation"
			>
				<div className="mx-auto flex max-w-3xl flex-col gap-5">
					{groups.map((group) => (
						<TurnGroup
							key={group.key}
							group={group}
							onDecide={decide}
							onRollback={rollback}
							// Only a turn the provider actually accepted can be undone: a turn it
							// never saw holds no history to discard, and the daemon refuses it
							// rather than hiding rows the agent still remembers.
							canRollback={Boolean(onRollback && group.turnId && group.rollbackable)}
							busy={busy}
							queued={Boolean(group.turnId && queued.has(group.turnId))}
						/>
					))}
				</div>
			</div>

			{!pinned ? (
				<Button
					type="button"
					size="sm"
					variant="outline"
					onClick={() => setPinned(true)}
					className="absolute bottom-3 left-1/2 -translate-x-1/2 gap-1.5 shadow-sm"
				>
					<ArrowDown aria-hidden="true" className="size-3.5" />
					Jump to latest
				</Button>
			) : null}
		</div>
	);
}

/**
 * One turn, and the memo boundary that keeps a poll from re-rendering the whole
 * conversation. A turn is the right granularity because it is what changes: while
 * the agent works, one group grows and every other group is finished history.
 */
const TurnGroup = memo(function TurnGroup({
	group,
	onDecide,
	onRollback,
	canRollback,
	busy,
	queued,
}: {
	group: TimelineGroup;
	onDecide: (requestId: string, decisionId: string) => void;
	onRollback: (turnId: string) => void;
	/** The daemon would accept a rollback of this turn, so offer the affordance. */
	canRollback: boolean;
	busy?: boolean;
	/** This turn was recorded but not sent, so its message can say so. */
	queued: boolean;
}) {
	const runs = useMemo(() => runsOf(group.items), [group.items]);
	return (
		<div className="flex flex-col gap-3">
			{runs.map((run) =>
				run.kind === "activities" ? (
					<ActivityRun
						key={run.key}
						activities={run.items.filter(
							(item): item is ConversationActivity => item.kind === "activity",
						)}
					/>
				) : (
					<TimelineItem
						key={run.key}
						item={run.items[0]!}
						onDecide={onDecide}
						busy={busy}
						queued={queued}
					/>
				),
			)}
			{/* Above the outcome divider: the changed files are part of what the turn
			    did, and belong inside it rather than after it closes. */}
			{group.diff ? <TurnChangedFiles diff={group.diff} live={group.live} /> : null}
			{group.outcome ? (
				<TurnOutcome
					state={group.outcome.state}
					durationMs={group.outcome.durationMs}
					error={group.outcome.error}
					onRollback={canRollback ? () => onRollback(group.turnId as string) : undefined}
				/>
			) : null}
		</div>
	);
});

function TimelineItem({
	item,
	onDecide,
	busy,
	queued,
}: {
	item: ConversationItem;
	onDecide?: (requestId: string, decisionId: string) => void;
	busy?: boolean;
	/**
	 * The enclosing turn was recorded but not yet sent, so a waiting message can say
	 * so. A group is one turn, so this holds for every item in it.
	 */
	queued?: boolean;
}) {
	if (item.kind === "message") {
		if (item.role === "assistant") return <AssistantMessage message={item} />;
		// A user-role message that did not come from this human is an automation or
		// worker relay, and is attributed differently.
		if (item.origin === "human") return <HumanMessage message={item} queued={queued} />;
		return <OriginMessage message={item} />;
	}
	if (item.activityKind === "approval") {
		return <ApprovalCard activity={item} onDecide={onDecide} busy={busy} />;
	}
	if (isCompaction(item)) {
		return <CompactionMarker activity={item} />;
	}
	return <ActivityRow activity={item} />;
}

/* -------------------------------------------------------------------------- */
/* identity                                                                    */
/* -------------------------------------------------------------------------- */

const itemKey = (item: ConversationItem): string => item.id;
const groupKey = (group: TimelineGroup): string => group.key;

function sameGroup(a: TimelineGroup, b: TimelineGroup): boolean {
	return (
		a.anchor === b.anchor &&
		a.turnId === b.turnId &&
		sameContent(a.outcome, b.outcome) &&
		a.items.length === b.items.length &&
		// The items are already identity-stable by the time a group is compared, so a
		// reference check here is exact and avoids walking their contents twice.
		a.items.every((item, index) => item === b.items[index])
	);
}

/**
 * A callback whose identity survives its caller re-rendering.
 *
 * `useConversationCommands` returns fresh arrows every render and the preview
 * harness passes literals, so without this every memo boundary below would be
 * invalidated by the one prop that never meaningfully changes.
 */
function useStableCallback<Args extends unknown[]>(
	fn: ((...args: Args) => void) | undefined,
): (...args: Args) => void {
	const latest = useRef(fn);
	useEffect(() => {
		latest.current = fn;
	});
	// Only ever called from an event handler, which runs after the commit that
	// updated the ref — there is no render-phase caller to read a stale closure.
	return useCallback((...args: Args) => latest.current?.(...args), []);
}

type TimelineGroup = {
	key: string;
	turnId?: string;
	/** Where this group sits in the timeline: the lowest sequence it contains. */
	anchor: number;
	items: ConversationItem[];
	outcome?: { state: "completed" | "interrupted" | "failed"; durationMs?: number; error?: string };
	/** What the turn changed on disk, when the daemon reported anything. */
	diff?: TurnDiff;
	/** The turn is still running, so its diff can still grow. */
	live?: boolean;
	/** The provider accepted this turn, so there is history it can be asked to drop. */
	rollbackable?: boolean;
};

/**
 * Group items by the turn that produced them, so a completed turn can be closed
 * off with its outcome.
 *
 * A turn is one block, even when its items are not contiguous in sequence. That
 * matters because of the send queue: a message typed mid-turn is recorded
 * immediately, so its sequence lands before the answers to everything ahead of
 * it. Reading strictly by sequence would stack every queued question at the top
 * and every answer below, separating each question from its own reply.
 *
 * Sequence still decides order — a turn takes the position of its first item, and
 * items inside a turn stay in sequence order. Nothing is re-derived: this is the
 * daemon's ordering, grouped.
 *
 * Items with no turn (an automation relay that arrived between turns) form their
 * own group and keep their sequence position.
 */
function groupByTurn(snapshot: ConversationSnapshot): TimelineGroup[] {
	const byTurn = new Map(snapshot.turns.map((turn) => [turn.id, turn]));
	const groups: TimelineGroup[] = [];
	const groupForTurn = new Map<string, TimelineGroup>();

	for (const item of snapshot.items) {
		if (item.turnId === undefined) {
			// Consecutive turn-less items share one group rather than getting one each.
			// A provider can run a turn AO never dispatched — a compaction, or a turn
			// resumed inside the provider's own history — and every item it emits then
			// correlates to no AO turn. One group per item made `runsOf` see no two
			// adjacent activities, so a wall of tool calls stopped collapsing and the
			// conversation turned back into a log. Grouping must not depend on
			// correlation succeeding.
			const last = groups.at(-1);
			if (last && last.turnId === undefined) {
				last.items.push(item);
				continue;
			}
			groups.push({ key: `loose-${item.sequence}`, anchor: item.sequence, items: [item] });
			continue;
		}
		const existing = groupForTurn.get(item.turnId);
		if (existing) {
			existing.items.push(item);
			continue;
		}
		const group: TimelineGroup = {
			key: `${item.turnId}-${item.sequence}`,
			turnId: item.turnId,
			anchor: item.sequence,
			items: [item],
		};
		groupForTurn.set(item.turnId, group);
		groups.push(group);
	}

	groups.sort((a, b) => a.anchor - b.anchor);

	for (const group of groups) {
		if (!group.turnId) continue;
		const turn = byTurn.get(group.turnId);
		if (!turn) continue;
		// The diff is attached whether or not the turn has finished: a running turn's
		// changed-file list growing is the useful part.
		group.diff = turn.diff;
		group.live = turn.state === "running";
		if (turn.state === "running" || turn.state === "queued") continue;
		group.rollbackable = Boolean(turn.providerTurnId);
		group.outcome = {
			state: turn.state,
			durationMs:
				turn.completedAt && turn.startedAt
					? new Date(turn.completedAt).getTime() - new Date(turn.startedAt).getTime()
					: undefined,
			error: turn.errorMessage,
		};
	}

	return groups;
}

function EmptyState({ harness }: { harness: string }) {
	return (
		<div className="flex min-h-0 flex-1 items-center justify-center px-6">
			<div className="flex max-w-sm flex-col items-center gap-2 text-center">
				<MessageSquare aria-hidden="true" className="size-6 text-muted-foreground" />
				<strong className="text-sm font-medium text-foreground">Start the conversation</strong>
				<p className="text-xs leading-relaxed text-muted-foreground">
					This session talks to {harness} over a structured connection. Tool calls, file changes,
					and approvals appear here as they happen. The Terminal tab opens a plain shell in the
					same worktree — it is not a second copy of the agent.
				</p>
			</div>
		</div>
	);
}

/* -------------------------------------------------------------------------- */

/**
 * The in-flight turn. Elapsed time is shown because a long silence is otherwise
 * indistinguishable from a hang, and "waiting on you" is called out so a blocked
 * turn is not mistaken for a slow one.
 */
function LiveTurnBar({
	startedAt,
	blocked,
	queuedCount = 0,
	onInterrupt,
}: {
	startedAt: string;
	blocked?: boolean;
	/** Messages typed during this turn, waiting to be sent after it. */
	queuedCount?: number;
	onInterrupt?: () => void;
}) {
	const [elapsed, setElapsed] = useState(() => since(startedAt));

	useEffect(() => {
		const timer = setInterval(() => setElapsed(since(startedAt)), 1000);
		return () => clearInterval(timer);
	}, [startedAt]);

	return (
		<div className="flex items-center gap-2.5 rounded-md border border-border bg-surface px-3 py-2">
			{blocked ? (
				<TriangleAlert aria-hidden="true" className="size-3.5 shrink-0 text-warning" />
			) : (
				<Loader2 aria-hidden="true" className="size-3.5 shrink-0 animate-spin text-accent" />
			)}
			<strong className={cn("text-xs font-medium", blocked ? "text-warning" : "text-foreground")}>
				{blocked ? "Waiting for your decision" : "Working"}
			</strong>
			<span className="text-[11px] tabular-nums text-muted-foreground">{elapsed}</span>
			{queuedCount > 0 ? (
				<span className="text-[11px] text-muted-foreground">
					{queuedCount} {queuedCount === 1 ? "message" : "messages"} queued
				</span>
			) : null}
			<Button
				type="button"
				size="sm"
				variant="ghost"
				onClick={onInterrupt}
				className="ml-auto gap-1.5"
			>
				<Square aria-hidden="true" className="size-3" />
				{queuedCount > 0 ? "Stop and clear queue" : "Stop turn"}
			</Button>
		</div>
	);
}

function since(iso: string): string {
	const start = new Date(iso).getTime();
	if (Number.isNaN(start)) return "";
	const seconds = Math.max(0, Math.round((Date.now() - start) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
