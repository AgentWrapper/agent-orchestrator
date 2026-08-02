/**
 * Timeline entries for the Chat surface.
 *
 * One component per durable item shape, keyed by sequence so a streaming rewrite
 * updates a message in place instead of remounting it. Every component is a pure
 * function of a domain item: no lifecycle decisions, no capability checks, no
 * re-sorting. Those belong to the daemon.
 */

import { useState } from "react";
import {
	AlertTriangle,
	Brain,
	ChevronRight,
	CircleAlert,
	FileDiff,
	Gauge,
	ListChecks,
	Loader2,
	ShieldQuestion,
	SquareTerminal,
	User,
} from "lucide-react";

/** Fixed icon column, matching the prototype's row anatomy. */
const activityIcon = {
	command: SquareTerminal,
	file_change: FileDiff,
	plan: ListChecks,
	reasoning: Brain,
	approval: ShieldQuestion,
	usage: Gauge,
	error: AlertTriangle,
	system: CircleAlert,
} as const;
import { cn } from "../../lib/utils";
import { ChatMarkdown } from "./ChatMarkdown";
import { Button } from "../ui/button";
import type {
	ConversationActivity,
	ConversationMessage,
	DecisionOption,
	DeliveryState,
} from "../../types/conversation";

const timeFormatter = new Intl.DateTimeFormat(undefined, {
	hour: "numeric",
	minute: "2-digit",
});

/** Collapse the home directory so a long absolute path does not eat the row. */
function shortenPaths(text: string): string {
	return text.replace(/\/(?:Users|home)\/[^/\s]+/g, "~");
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.round(ms / 60_000)}m`;
}

function formatTime(iso: string): string {
	const parsed = new Date(iso);
	return Number.isNaN(parsed.getTime()) ? "" : timeFormatter.format(parsed);
}

/* -------------------------------------------------------------------------- */
/* messages                                                                    */
/* -------------------------------------------------------------------------- */

/** What the user typed. Right-aligned and enclosed so it reads as theirs. */
export function HumanMessage({
	message,
	queued,
}: {
	message: ConversationMessage;
	/** Typed while the agent was busy, and not sent yet. */
	queued?: boolean;
}) {
	return (
		<div className="flex flex-col items-end gap-1">
			{/* A queued message reads as not-yet-sent rather than as sent-and-ignored:
			    the agent has not seen it, and the timeline should not imply it has. */}
			<div
				className={cn(
					"w-fit max-w-[min(78%,560px)] whitespace-pre-wrap rounded-[10px] border px-3 py-2.5 text-sm leading-[1.55]",
					queued
						? "border-dashed border-border-strong bg-transparent text-muted-foreground"
						: "border-border bg-raised text-foreground",
				)}
			>
				{message.text}
			</div>
			{queued ? (
				<span className="text-[11px] text-muted-foreground">Queued · sends when the agent finishes</span>
			) : null}
			{message.delivery && message.delivery !== "accepted" ? (
				<DeliveryNote state={message.delivery} />
			) : null}
		</div>
	);
}

/**
 * A message from a worker, automation, or the daemon. Attribution comes from the
 * durable origin field, never from a prefix parsed out of the text.
 */
export function OriginMessage({ message }: { message: ConversationMessage }) {
	return (
		<div className="rounded-md border border-border border-l-2 border-l-accent-dim bg-surface/60 px-3.5 py-2.5">
			<div className="mb-1.5 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
				<CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
				<span className="truncate">{message.senderLabel ?? message.origin}</span>
				<span className="ml-auto shrink-0 font-normal tabular-nums">
					{formatTime(message.createdAt)}
				</span>
			</div>
			<p className="text-sm leading-relaxed text-muted-foreground">{message.text}</p>
		</div>
	);
}

/** The agent's prose. A trailing caret marks text still arriving. */
export function AssistantMessage({ message }: { message: ConversationMessage }) {
	return (
		<div className="relative">
			<ChatMarkdown text={message.text} />
			{message.streaming ? (
				<span
					aria-label="still writing"
					className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 animate-pulse bg-accent align-baseline"
				/>
			) : null}
		</div>
	);
}

/**
 * Delivery state, stated rather than implied. `uncertain` is its own outcome:
 * the provider may have accepted the turn while AO lost the connection, and
 * pretending otherwise in either direction would be a lie.
 */
function DeliveryNote({ state }: { state: DeliveryState }) {
	const copy: Record<DeliveryState, string> = {
		queued: "Queued — will send when the agent is idle",
		sending: "Sending…",
		accepted: "Delivered",
		uncertain: "Delivery uncertain — not retried automatically",
		failed: "Not delivered",
	};
	return (
		<span
			className={cn(
				"text-[11px] leading-none",
				state === "uncertain" || state === "failed" ? "text-warning" : "text-muted-foreground",
			)}
		>
			{copy[state]}
		</span>
	);
}

/* -------------------------------------------------------------------------- */
/* activities                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A collapsed activity row: icon, label, target, state. Expands to its payload.
 *
 * A `running` activity with no completion is a real terminal state here, not a
 * spinner that hangs forever — a provider can start a command and supersede it.
 */
export function ActivityRow({ activity }: { activity: ConversationActivity }) {
	const [open, setOpen] = useState(false);
	const Icon = activityIcon[activity.activityKind] ?? SquareTerminal;
	const detail = activity.detail;
	const hasBody = Boolean(detail?.output || detail?.reason || detail?.text || detail?.files?.length);
	const { label, path } = splitSummary(activity);

	return (
		<div className="group/activity border-t border-border first:border-t-0">
			<button
				type="button"
				onClick={() => setOpen((prev) => !prev)}
				disabled={!hasBody}
				aria-expanded={hasBody ? open : undefined}
				className={cn(
					"flex min-h-[35px] w-full items-center gap-[9px] px-[11px] py-2 text-left text-[11px] transition-colors",
					hasBody && "hover:bg-interactive-hover",
					!hasBody && "cursor-default",
				)}
			>
				<Icon
					aria-hidden="true"
					className={cn(
						"w-[15px] shrink-0 text-center",
						activity.status === "failed" ? "text-destructive" : "text-muted-foreground/70",
					)}
					size={13}
				/>
				<strong
					className={cn(
						"shrink-0 font-medium",
						activity.status === "failed" ? "text-destructive" : "text-foreground",
					)}
				>
					{label}
				</strong>
				{path ? (
					<span
						className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted-foreground"
						title={path}
					>
						{path}
					</span>
				) : (
					<span className="flex-1" />
				)}
				<ActivityState activity={activity} open={open} hasBody={hasBody} />
			</button>

			{open && hasBody ? (
				<div className="flex flex-col gap-1.5 px-[11px] pb-2.5">
					{detail?.files?.length ? <FileChangeList files={detail.files} /> : null}
					{detail?.reason || detail?.text ? (
						<p className="whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">
							{detail.reason ?? detail.text}
						</p>
					) : null}
					{detail?.output ? (
						<>
							<pre className="max-h-64 overflow-auto rounded-md border border-border bg-background px-2.5 py-2 font-mono text-[10.5px] leading-relaxed text-muted-foreground">
								{detail.output}
							</pre>
							{detail.outputMayBePartial ? (
								<p className="text-[10px] leading-relaxed text-muted-foreground/70">
									Output is streamed best-effort and may be missing its beginning. Open a shell in the
									worktree for the full run.
								</p>
							) : null}
						</>
					) : null}
				</div>
			) : null}
		</div>
	);
}

/**
 * Split a summary into a bold action and a muted target, which is how the row
 * scans: what happened, then what it happened to. A command becomes its binary
 * plus its arguments; anything without a natural split keeps its whole label.
 */
function splitSummary(activity: ConversationActivity): { label: string; path?: string } {
	if (activity.activityKind === "command") {
		const command = shortenPaths(activity.summary).trim();
		const space = command.indexOf(" ");
		if (space > 0) {
			return { label: command.slice(0, space), path: command.slice(space + 1) };
		}
		return { label: command };
	}
	const files = activity.detail?.files;
	if (activity.activityKind === "file_change" && files?.length === 1) {
		return { label: "Edited", path: shortenPaths(files[0]!.path) };
	}
	return { label: activity.summary };
}

function ActivityState({
	activity,
	open,
	hasBody,
}: {
	activity: ConversationActivity;
	open: boolean;
	hasBody: boolean;
}) {
	const { status, detail } = activity;

	if (status === "running") {
		return (
			<Loader2
				aria-label="running"
				className="size-3 shrink-0 animate-spin self-center text-muted-foreground/60"
			/>
		);
	}
	if (detail?.files?.length) {
		const additions = detail.files.reduce((sum, file) => sum + file.additions, 0);
		const deletions = detail.files.reduce((sum, file) => sum + file.deletions, 0);
		return (
			<span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/70">
				<span className="text-success">+{additions}</span>{" "}
				<span className="text-destructive">&minus;{deletions}</span>
			</span>
		);
	}
	if (status === "failed") {
		return (
			<span className="shrink-0 font-mono text-[10px] tabular-nums text-destructive">
				{detail?.exitCode !== undefined ? `exit ${detail.exitCode}` : "failed"}
			</span>
		);
	}
	// Everything else settled fine, which is the boring majority. A chevron on
	// hover is the whole affordance; a duration or timestamp on every row builds a
	// column of numbers nobody reads.
	if (hasBody) {
		return (
			<ChevronRight
				aria-hidden="true"
				className={cn(
					"size-3 shrink-0 self-center text-muted-foreground/50 transition-all",
					open ? "rotate-90 opacity-100" : "opacity-0 group-hover/activity:opacity-100",
				)}
			/>
		);
	}
	return null;
}

function FileChangeList({
	files,
}: {
	files: NonNullable<ConversationActivity["detail"]>["files"];
}) {
	if (!files?.length) return null;
	return (
		<ul className="flex flex-col gap-1">
			{files.map((file) => (
				<li key={file.path} className="flex items-center gap-3 text-xs">
					<span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
						{file.path}
					</span>
					<span className="shrink-0 tabular-nums text-success">+{file.additions}</span>
					<span className="shrink-0 tabular-nums text-destructive">&minus;{file.deletions}</span>
				</li>
			))}
		</ul>
	);
}

/* -------------------------------------------------------------------------- */
/* approval                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A decision the agent is blocked on.
 *
 * Buttons come from `activity.decisions` — the provider's own list — never from a
 * fixed set. A real captured approval offered `accept`, an object-shaped
 * `acceptWithExecpolicyAmendment`, and `cancel`, and offered **no decline**: a
 * hardcoded three-button row would have drawn a control that cannot be honored.
 */
export function ApprovalCard({
	activity,
	onDecide,
	busy,
}: {
	activity: ConversationActivity;
	onDecide?: (requestId: string, decisionId: string) => void;
	busy?: boolean;
}) {
	const resolved = activity.status !== "pending";
	const decisions: DecisionOption[] = activity.decisions ?? [];
	const detail = activity.detail;

	return (
		<div
			className={cn(
				"rounded-lg border bg-surface",
				resolved ? "border-border" : "border-warning/40 ring-1 ring-warning/10",
			)}
		>
			<div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
				<ShieldQuestion
					aria-hidden="true"
					className={cn("size-4 shrink-0", resolved ? "text-muted-foreground" : "text-warning")}
				/>
				<strong className="text-xs font-semibold text-foreground">
					{resolved ? "Approval resolved" : "Approval required"}
				</strong>
				<span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">
					req {activity.requestId}
				</span>
			</div>

			<div className="flex flex-col gap-2.5 px-3.5 py-3">
				{detail?.reason ? (
					<p className="text-sm leading-relaxed text-muted-foreground">{detail.reason}</p>
				) : null}

				<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded bg-background px-2.5 py-2 font-mono text-[11px] leading-relaxed">
					<dt className="text-muted-foreground">command</dt>
					<dd className="min-w-0 break-all text-foreground">{detail?.command ?? activity.summary}</dd>
					{detail?.cwd ? (
						<>
							<dt className="text-muted-foreground">cwd</dt>
							<dd className="min-w-0 break-all text-muted-foreground">{detail.cwd}</dd>
						</>
					) : null}
				</dl>

				{resolved ? (
					<p className="text-[11px] text-muted-foreground">
						Already answered. This card is kept for the record.
					</p>
				) : (
					<div className="flex flex-wrap gap-2 pt-0.5">
						{decisions.map((decision, index) => (
							<Button
								key={decision.id}
								type="button"
								size="sm"
								variant={index === 0 ? "primary" : "outline"}
								disabled={busy}
								onClick={() => onDecide?.(activity.requestId ?? "", decision.id)}
							>
								{decision.label}
							</Button>
						))}
						{decisions.length === 0 ? (
							<p className="text-[11px] text-warning">
								The agent offered no decisions AO can present. Open diagnostics.
							</p>
						) : null}
					</div>
				)}
			</div>
		</div>
	);
}

/* -------------------------------------------------------------------------- */
/* turn boundary                                                               */
/* -------------------------------------------------------------------------- */

/**
 * How a turn ended. `interrupted` is reported as its own outcome because the
 * provider reports it that way — relabelling it as failed would misattribute a
 * deliberate cancellation.
 */
export function TurnOutcome({
	state,
	durationMs,
	error,
	onRollback,
}: {
	state: "completed" | "interrupted" | "failed";
	durationMs?: number;
	error?: string;
	/**
	 * Discard this turn and everything after it. Absent means the operation is not
	 * available right now — the agent cannot undo, or it is mid-turn — and the
	 * control is not drawn rather than drawn and then refused.
	 */
	onRollback?: () => void;
}) {
	const copy = {
		completed: { label: "Done", tone: "text-muted-foreground/70" },
		interrupted: { label: "Stopped", tone: "text-muted-foreground/70" },
		failed: { label: "Failed", tone: "text-destructive" },
	}[state];

	return (
		<div className="group/turn flex items-center gap-2 pt-1">
			<span aria-hidden="true" className="h-px flex-1 bg-border" />
			{onRollback ? (
				// Revealed on hover or keyboard focus. Undo belongs on the turn it undoes,
				// but a permanent button on every turn would compete with the conversation
				// for attention.
				<button
					type="button"
					onClick={onRollback}
					className="shrink-0 rounded px-1 text-[10px] uppercase tracking-[0.08em] text-muted-foreground/70 opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/turn:opacity-100"
				>
					Roll back to here
				</button>
			) : null}
			<span className={cn("shrink-0 text-[10px] uppercase tracking-[0.08em]", copy.tone)}>
				{copy.label}
			</span>
			{durationMs !== undefined && durationMs > 0 ? (
				<span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/70">
					{formatDuration(durationMs)}
				</span>
			) : null}
			{error ? (
				<span className="shrink-0 text-[10px] text-destructive" title={error}>
					{error.slice(0, 60)}
				</span>
			) : null}
		</div>
	);
}

export { User };
