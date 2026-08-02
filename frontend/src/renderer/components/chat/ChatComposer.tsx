/**
 * The Chat composer.
 *
 * Submitting is a typed send, not a keystroke: there is no notion of "press
 * Enter at the agent" here, and an empty message is never a way to nudge it.
 *
 * A message typed mid-turn is held by the daemon and sent when the turn ends,
 * because the agent is one conversation and cannot run a second turn alongside
 * the first. The placeholder says so rather than leaving the user to guess where
 * their text went, and the queued message stays visible in the timeline.
 */

import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowUp, ChevronUp, Shield } from "lucide-react";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";

/** AO's existing per-session approval policy, unchanged for Chat. */
export type PermissionMode = "default" | "acceptEdits" | "auto" | "bypassPermissions";

const PERMISSION_COPY: Record<PermissionMode, { label: string; hint: string }> = {
	default: { label: "Default", hint: "Use the agent's standard approval behavior" },
	acceptEdits: { label: "Accept edits", hint: "Allow file edits, still ask for other actions" },
	auto: { label: "Auto", hint: "Auto-approve routine actions the agent supports" },
	bypassPermissions: { label: "Bypass", hint: "Never ask — the worktree is the boundary" },
};

export function ChatComposer({
	onSend,
	permission,
	onPermissionChange,
	busy,
	willQueue,
	disabled,
}: {
	onSend: (text: string) => void;
	permission: PermissionMode;
	onPermissionChange: (mode: PermissionMode) => void;
	/** A send is in flight. */
	busy?: boolean;
	/** The agent is mid-turn, so this message is held until the turn ends. */
	willQueue?: boolean;
	disabled?: boolean;
}) {
	const [text, setText] = useState("");
	const textarea = useRef<HTMLTextAreaElement>(null);
	const canSend = text.trim().length > 0 && !busy && !disabled;

	function submit(event?: FormEvent) {
		event?.preventDefault();
		if (!canSend) return;
		onSend(text.trim());
		setText("");
		textarea.current?.focus();
	}

	function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
		// Enter sends; Shift+Enter makes a newline. Cmd/Ctrl+Enter also sends, so
		// the habit from other editors does not silently do nothing.
		if (event.key !== "Enter") return;
		if (event.shiftKey) return;
		event.preventDefault();
		submit();
	}

	return (
		<form
			onSubmit={submit}
			className="flex flex-col gap-2 rounded-lg border border-border-strong bg-surface p-2 focus-within:border-accent-dim"
		>
			<textarea
				ref={textarea}
				value={text}
				onChange={(event) => setText(event.target.value)}
				onKeyDown={onKeyDown}
				rows={2}
				disabled={disabled}
				aria-label="Message the agent"
				placeholder={
					disabled
						? "The controller is not connected"
						: willQueue
							? "Agent is working — this sends when it finishes"
							: "Ask the agent…"
				}
				className="max-h-48 min-h-[3.25rem] w-full resize-none bg-transparent px-1.5 py-1 text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-50"
			/>

			<div className="flex items-center gap-2">
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button type="button" variant="ghost" size="sm" className="gap-1.5">
							<Shield aria-hidden="true" className="size-3.5" />
							<span className="text-xs">Next run · {PERMISSION_COPY[permission].label}</span>
							<ChevronUp aria-hidden="true" className="size-3" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start" side="top" className="w-72">
						<DropdownMenuLabel className="flex items-baseline justify-between gap-2">
							<span>Permission for next run</span>
							<span className="text-[11px] font-normal text-muted-foreground">
								Applied at launch
							</span>
						</DropdownMenuLabel>
						{(Object.keys(PERMISSION_COPY) as PermissionMode[]).map((mode) => (
							<DropdownMenuItem
								key={mode}
								onSelect={() => onPermissionChange(mode)}
								className="flex flex-col items-start gap-0.5"
							>
								<span
									className={cn(
										"text-xs",
										mode === permission ? "text-foreground" : "text-muted-foreground",
									)}
								>
									{PERMISSION_COPY[mode].label}
									{mode === permission ? " ·  current" : ""}
								</span>
								<span className="text-[11px] leading-snug text-muted-foreground">
									{PERMISSION_COPY[mode].hint}
								</span>
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>

				<span className="ml-auto text-[11px] text-muted-foreground">
					{willQueue ? "Enter to queue" : "Enter to send"}
				</span>
				<Button type="submit" size="icon-sm" disabled={!canSend} aria-label="Send message">
					<ArrowUp aria-hidden="true" className="size-3.5" />
				</Button>
			</div>
		</form>
	);
}
