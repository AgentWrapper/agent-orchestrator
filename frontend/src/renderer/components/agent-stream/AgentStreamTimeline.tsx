/**
 * Renders reduced StreamMessage rows: assistant text, thinking, tools.
 * AO chrome only — not a clone of ABF ConversationView layout.
 */

import { ChevronDown, ChevronRight, LoaderCircle, Wrench } from "lucide-react";
import { useMemo, useState } from "react";
import type { StreamMessage } from "../../types/streamMessages";
import { cn } from "../../lib/utils";

export interface AgentStreamTimelineProps {
	messages: StreamMessage[];
	streaming?: boolean;
	className?: string;
}

type TimelineItem =
	| { kind: "text"; message: StreamMessage; key: string }
	| { kind: "thinking"; message: StreamMessage; key: string }
	| { kind: "tool"; call?: StreamMessage; result?: StreamMessage; key: string }
	| { kind: "other"; message: StreamMessage; key: string };

function messageKey(message: StreamMessage, index: number): string {
	return message.id || message.streamItemId || message.toolUseId || message.toolCallId || `msg-${index}`;
}

function toolId(message: StreamMessage): string | undefined {
	return message.toolUseId || message.toolCallId;
}

/** Pair tool_use with following tool_result by id; keep narrative order. */
export function groupStreamMessages(messages: StreamMessage[]): TimelineItem[] {
	const items: TimelineItem[] = [];
	const pendingTools = new Map<string, number>();

	messages.forEach((message, index) => {
		const key = messageKey(message, index);
		if (message.role === "thinking" || message.isThinking) {
			items.push({ kind: "thinking", message, key });
			return;
		}
		if (message.role === "assistant" || message.role === "user") {
			items.push({ kind: "text", message, key });
			return;
		}
		if (message.role === "tool_use") {
			const id = toolId(message);
			items.push({ kind: "tool", call: message, key });
			if (id) pendingTools.set(id, items.length - 1);
			return;
		}
		if (message.role === "tool_result") {
			const id = toolId(message);
			const slot = id !== undefined ? pendingTools.get(id) : undefined;
			if (slot !== undefined) {
				const existing = items[slot];
				if (existing.kind === "tool") {
					items[slot] = { ...existing, result: message };
					pendingTools.delete(id!);
					return;
				}
			}
			items.push({ kind: "tool", result: message, key });
			return;
		}
		items.push({ kind: "other", message, key });
	});

	return items;
}

function ThinkingBubble({ message }: { message: StreamMessage }) {
	const live = Boolean(message.partial);
	return (
		<div
			className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground"
			data-testid="stream-thinking"
		>
			<div className="mb-1 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-passive">
				{live ? <LoaderCircle className="size-3 animate-spin" aria-hidden="true" /> : null}
				Thinking
			</div>
			<pre className="whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-muted-foreground">
				{message.content || (live ? "…" : "")}
			</pre>
		</div>
	);
}

function TextBubble({ message }: { message: StreamMessage }) {
	const isUser = message.role === "user";
	return (
		<div
			className={cn(
				"rounded-lg border px-3.5 py-2.5 text-sm leading-relaxed",
				isUser
					? "ml-8 border-border bg-muted/40 text-foreground"
					: "mr-4 border-border bg-background text-foreground",
			)}
			data-testid={isUser ? "stream-user" : "stream-assistant"}
			data-partial={message.partial ? "true" : undefined}
		>
			<div className="whitespace-pre-wrap break-words">
				{message.content}
				{message.partial ? (
					<span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-accent align-middle" aria-hidden="true" />
				) : null}
			</div>
		</div>
	);
}

function ToolCard({ call, result }: { call?: StreamMessage; result?: StreamMessage }) {
	const [open, setOpen] = useState(false);
	const name = result?.toolName || call?.toolName || call?.content || "Tool";
	const status = call?.toolStatus || (result ? (result.isError ? "failed" : "completed") : "pending");
	const live = Boolean(call?.partial || result?.partial || call?.isDelta || result?.isDelta);
	const output = result?.toolResult || result?.content || "";
	const input = call?.toolInput ?? result?.toolInput;

	return (
		<div
			className="overflow-hidden rounded-lg border border-border bg-muted/15"
			data-testid="stream-tool"
			data-tool-status={status}
		>
			<button
				type="button"
				className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground hover:bg-interactive-hover"
				onClick={() => setOpen((v) => !v)}
				aria-expanded={open}
			>
				{open ? (
					<ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
				) : (
					<ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
				)}
				<Wrench className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
				<span className="min-w-0 flex-1 truncate font-medium">{name}</span>
				{live ? (
					<LoaderCircle className="size-3.5 animate-spin text-status-working" aria-hidden="true" />
				) : (
					<span
						className={cn(
							"text-[10px] uppercase tracking-wide",
							status === "failed" ? "text-destructive" : "text-passive",
						)}
					>
						{status}
					</span>
				)}
			</button>
			{open ? (
				<div className="space-y-2 border-t border-border px-3 py-2 font-mono text-[11px] text-muted-foreground">
					{input && Object.keys(input).length > 0 ? (
						<pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-background/60 p-2">
							{JSON.stringify(input, null, 2)}
						</pre>
					) : null}
					{output ? (
						<pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-background/60 p-2">
							{output}
						</pre>
					) : live ? (
						<p className="text-passive">Running…</p>
					) : null}
				</div>
			) : null}
		</div>
	);
}

export function AgentStreamTimeline({ messages, streaming, className }: AgentStreamTimelineProps) {
	const items = useMemo(() => groupStreamMessages(messages), [messages]);

	if (items.length === 0) {
		return (
			<div
				className={cn("flex h-full items-center justify-center text-xs text-muted-foreground", className)}
				data-testid="stream-timeline-empty"
			>
				{streaming ? "Waiting for agent output…" : "No stream messages yet."}
			</div>
		);
	}

	return (
		<div className={cn("flex flex-col gap-2.5", className)} data-testid="stream-timeline" data-streaming={streaming ? "true" : undefined}>
			{items.map((item) => {
				if (item.kind === "thinking") {
					return <ThinkingBubble key={item.key} message={item.message} />;
				}
				if (item.kind === "text") {
					return <TextBubble key={item.key} message={item.message} />;
				}
				if (item.kind === "tool") {
					return <ToolCard key={item.key} call={item.call} result={item.result} />;
				}
				return (
					<div key={item.key} className="text-xs text-muted-foreground" data-testid="stream-other">
						{item.message.content}
					</div>
				);
			})}
		</div>
	);
}
