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
	Terminal,
	User,
} from "lucide-react";
import { cn } from "../../lib/utils";
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

function formatTime(iso: string): string {
	const parsed = new Date(iso);
	return Number.isNaN(parsed.getTime()) ? "" : timeFormatter.format(parsed);
}

/* -------------------------------------------------------------------------- */
/* messages                                                                    */
/* -------------------------------------------------------------------------- */

/** What the user typed. Right-aligned and enclosed so it reads as theirs. */
export function HumanMessage({ message }: { message: ConversationMessage }) {
	return (
		<div className="flex flex-col items-end gap-1">
			<div className="max-w-[85%] rounded-lg rounded-br-sm border border-border-strong bg-surface px-3.5 py-2.5 text-sm leading-relaxed text-foreground">
				{message.text}
			</div>
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
		<div className="text-sm leading-relaxed text-foreground">
			<p className="whitespace-pre-wrap">
				{message.text}
				{message.streaming ? (
					<span
						aria-label="still writing"
						className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 animate-pulse bg-accent align-baseline"
					/>
				) : null}
			</p>
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

/**
 * A collapsed activity row: icon, label, target, state. Expands to its payload.
 *
 * A `running` activity with no completion is a real terminal state here, not a
 * spinner that hangs forever — a provider can start a command and supersede it.
 */
export function ActivityRow({ activity }: { activity: ConversationActivity }) {
	const [open, setOpen] = useState(false);
	const Icon = activityIcon[activity.activityKind] ?? Terminal;
	const detail = activity.detail;
	const hasBody = Boolean(
		detail?.output || detail?.reason || detail?.files?.length || detail?.totalTokens,
	);

	return (
		<div className="rounded-md border border-border bg-surface/50">
			<button
				type="button"
				onClick={() => setOpen((prev) => !prev)}
				disabled={!hasBody}
				aria-expanded={hasBody ? open : undefined}
				className={cn(
					"flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs transition-colors",
					hasBody && "hover:bg-interactive-hover",
					!hasBody && "cursor-default",
				)}
			>
				{hasBody ? (
					<ChevronRight
						aria-hidden="true"
						className={cn(
							"size-3.5 shrink-0 text-muted-foreground transition-transform",
							open && "rotate-90",
						)}
					/>
				) : (
					<span aria-hidden="true" className="size-3.5 shrink-0" />
				)}
				<Icon
					aria-hidden="true"
					className={cn(
						"size-3.5 shrink-0",
						activity.status === "failed" ? "text-destructive" : "text-muted-foreground",
					)}
				/>
				<span className="min-w-0 flex-1 truncate font-mono text-foreground">
					{activity.summary}
				</span>
				<ActivityState activity={activity} />
			</button>

			{open && hasBody ? (
				<div className="border-t border-border px-3 py-2.5">
					{detail?.files?.length ? <FileChangeList files={detail.files} /> : null}
					{detail?.reason ? (
						<pre className="whitespace-pre-wrap font-sans text-xs leading-relaxed text-muted-foreground">
							{detail.reason}
						</pre>
					) : null}
					{detail?.output ? (
						<>
							<pre className="max-h-64 overflow-auto rounded bg-background px-2.5 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
								{detail.output}
							</pre>
							{detail.outputMayBePartial ? (
								<p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
									The provider streams command output on a best-effort basis; the beginning may be
									missing. Open a shell in the worktree to see the full run.
								</p>
							) : null}
						</>
					) : null}
					{detail?.totalTokens ? (
						<div className="flex gap-5 text-xs tabular-nums text-muted-foreground">
							<span>{detail.inputTokens?.toLocaleString()} in</span>
							<span>{detail.outputTokens?.toLocaleString()} out</span>
							<span className="text-foreground">{detail.totalTokens.toLocaleString()} total</span>
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
}

function ActivityState({ activity }: { activity: ConversationActivity }) {
	const { status, detail } = activity;

	if (status === "running") {
		return (
			<span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
				<Loader2 aria-hidden="true" className="size-3 animate-spin" />
				Running
			</span>
		);
	}
	if (detail?.files?.length) {
		const additions = detail.files.reduce((sum, file) => sum + file.additions, 0);
		const deletions = detail.files.reduce((sum, file) => sum + file.deletions, 0);
		return (
			<span className="flex shrink-0 gap-1.5 text-[11px] tabular-nums">
				<span className="text-success">+{additions}</span>
				<span className="text-destructive">&minus;{deletions}</span>
			</span>
		);
	}
	if (status === "failed") {
		return (
			<span className="shrink-0 text-[11px] tabular-nums text-destructive">
				{detail?.exitCode !== undefined ? `exit ${detail.exitCode}` : "Failed"}
			</span>
		);
	}
	if (detail?.durationMs !== undefined) {
		return (
			<span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
				{detail.durationMs}ms
			</span>
		);
	}
	return (
		<span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
			{formatTime(activity.createdAt)}
		</span>
	);
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
}: {
	state: "completed" | "interrupted" | "failed";
	durationMs?: number;
	error?: string;
}) {
	const copy = {
		completed: { label: "Turn complete", tone: "text-success" },
		interrupted: { label: "Stopped by you", tone: "text-muted-foreground" },
		failed: { label: "Turn failed", tone: "text-destructive" },
	}[state];

	return (
		<div className="flex items-center gap-2.5 py-0.5">
			<span aria-hidden="true" className="h-px flex-1 bg-border" />
			<span className={cn("shrink-0 text-[11px] font-medium", copy.tone)}>{copy.label}</span>
			{durationMs !== undefined ? (
				<span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
					{(durationMs / 1000).toFixed(1)}s
				</span>
			) : null}
			{error ? <span className="shrink-0 text-[11px] text-destructive">{error}</span> : null}
			<span aria-hidden="true" className="h-px flex-1 bg-border" />
		</div>
	);
}

export { User };
