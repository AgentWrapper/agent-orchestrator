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

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Loader2, MessageSquare, Square, TriangleAlert } from "lucide-react";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import {
	ActivityRow,
	ApprovalCard,
	AssistantMessage,
	HumanMessage,
	OriginMessage,
	TurnOutcome,
} from "./ChatTimelineItems";
import { ChatComposer, type PermissionMode } from "./ChatComposer";
import {
	activeTurn,
	pendingApproval,
	type ConversationSnapshot,
	type ControllerState,
	type ConversationItem,
} from "../../types/conversation";

export interface ChatWorkspaceProps {
	snapshot: ConversationSnapshot;
	onSend?: (text: string) => void;
	onDecide?: (requestId: string, decisionId: string) => void;
	onInterrupt?: () => void;
	permission?: PermissionMode;
	onPermissionChange?: (mode: PermissionMode) => void;
	/** A send or decision is in flight. */
	busy?: boolean;
}

export function ChatWorkspace({
	snapshot,
	onSend,
	onDecide,
	onInterrupt,
	permission = "default",
	onPermissionChange,
	busy,
}: ChatWorkspaceProps) {
	const turn = activeTurn(snapshot);
	const approval = pendingApproval(snapshot);
	const [mode, setMode] = useState<PermissionMode>(permission);

	return (
		<section
			aria-label="Chat"
			className="flex h-full min-h-0 flex-col bg-background"
			data-session-mode={snapshot.mode}
		>
			<ChatHeader snapshot={snapshot} />
			<ControllerBanner controller={snapshot.controller} />

			<Timeline snapshot={snapshot} onDecide={onDecide} busy={busy} />

			<div className="flex shrink-0 flex-col gap-2 border-t border-border px-4 py-3">
				{turn ? (
					<LiveTurnBar
						startedAt={turn.startedAt ?? turn.requestedAt}
						blocked={Boolean(approval)}
						onInterrupt={onInterrupt}
					/>
				) : null}
				<ChatComposer
					onSend={(text) => onSend?.(text)}
					permission={mode}
					onPermissionChange={(next) => {
						setMode(next);
						onPermissionChange?.(next);
					}}
					busy={busy}
					willQueue={Boolean(turn)}
					disabled={snapshot.controller.state === "stopped"}
				/>
			</div>
		</section>
	);
}

/* -------------------------------------------------------------------------- */

function ChatHeader({ snapshot }: { snapshot: ConversationSnapshot }) {
	return (
		<header className="flex h-toolbar shrink-0 items-center gap-3 border-b border-border px-4">
			<MessageSquare aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
			<div className="flex min-w-0 items-baseline gap-2">
				<strong className="truncate text-sm font-medium text-foreground">
					{snapshot.sessionId}
				</strong>
				<span className="shrink-0 text-xs text-muted-foreground">{snapshot.harness}</span>
			</div>
			{/* The mode is a durable session fact, so it is stated rather than implied
			    by which surface happens to be open. */}
			<span className="ml-auto shrink-0 rounded border border-border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
				chat
			</span>
		</header>
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
 */
function Timeline({
	snapshot,
	onDecide,
	busy,
}: {
	snapshot: ConversationSnapshot;
	onDecide?: (requestId: string, decisionId: string) => void;
	busy?: boolean;
}) {
	const scroller = useRef<HTMLDivElement>(null);
	const [pinned, setPinned] = useState(true);

	const groups = useMemo(() => groupByTurn(snapshot), [snapshot]);

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

	if (snapshot.items.length === 0) {
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
				<div className="mx-auto flex max-w-3xl flex-col gap-3">
					{groups.map((group) => (
						<div key={group.key} className="flex flex-col gap-3">
							{group.items.map((item) => (
								<TimelineItem key={item.id} item={item} onDecide={onDecide} busy={busy} />
							))}
							{group.outcome ? (
								<TurnOutcome
									state={group.outcome.state}
									durationMs={group.outcome.durationMs}
									error={group.outcome.error}
								/>
							) : null}
						</div>
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

function TimelineItem({
	item,
	onDecide,
	busy,
}: {
	item: ConversationItem;
	onDecide?: (requestId: string, decisionId: string) => void;
	busy?: boolean;
}) {
	if (item.kind === "message") {
		if (item.role === "assistant") return <AssistantMessage message={item} />;
		// A user-role message that did not come from this human is an automation or
		// worker relay, and is attributed differently.
		if (item.origin === "human") return <HumanMessage message={item} />;
		return <OriginMessage message={item} />;
	}
	if (item.activityKind === "approval") {
		return <ApprovalCard activity={item} onDecide={onDecide} busy={busy} />;
	}
	return <ActivityRow activity={item} />;
}

/**
 * Group items by the turn that produced them, so a completed turn can be closed
 * off with its outcome. Items with no turn (an automation relay that arrived
 * between turns) form their own group and keep their sequence position.
 */
function groupByTurn(snapshot: ConversationSnapshot) {
	const byTurn = new Map(snapshot.turns.map((turn) => [turn.id, turn]));
	const groups: {
		/** Unique per group. A turn can legitimately appear in several groups when
		 *  an automation relay arrives between its items, so the key carries the
		 *  starting sequence rather than the turn id alone. */
		key: string;
		turnId?: string;
		items: ConversationItem[];
		outcome?: { state: "completed" | "interrupted" | "failed"; durationMs?: number; error?: string };
	}[] = [];

	for (const item of snapshot.items) {
		const last = groups.at(-1);
		if (last && last.turnId === item.turnId && item.turnId !== undefined) {
			last.items.push(item);
			continue;
		}
		groups.push({
			key: `${item.turnId ?? "loose"}-${item.sequence}`,
			turnId: item.turnId,
			items: [item],
		});
	}

	// Only the group that carries a turn's last item closes it off, so a turn split
	// by a relay does not print its outcome twice.
	const lastGroupForTurn = new Map<string, string>();
	for (const group of groups) {
		if (group.turnId) lastGroupForTurn.set(group.turnId, group.key);
	}

	for (const group of groups) {
		if (!group.turnId) continue;
		if (lastGroupForTurn.get(group.turnId) !== group.key) continue;
		const turn = byTurn.get(group.turnId);
		if (!turn) continue;
		if (turn.state === "running" || turn.state === "queued") continue;
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
	onInterrupt,
}: {
	startedAt: string;
	blocked?: boolean;
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
			<Button
				type="button"
				size="sm"
				variant="ghost"
				onClick={onInterrupt}
				className="ml-auto gap-1.5"
			>
				<Square aria-hidden="true" className="size-3" />
				Stop turn
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
