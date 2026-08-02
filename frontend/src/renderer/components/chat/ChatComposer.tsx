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
 *
 * The model, reasoning effort and approval controls belong here rather than in
 * settings because the provider takes all three per turn: choosing one changes the
 * next message and never restarts the agent.
 */

import { useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { ArrowUp } from "lucide-react";
import { Button } from "../ui/button";

export function ChatComposer({
	onSend,
	busy,
	willQueue,
	disabled,
	settings,
}: {
	onSend: (text: string) => void;
	/** The next-turn controls, rendered inline. Omitted in the fixture preview. */
	settings?: ReactNode;
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
		// Enter sends; Shift+Enter makes a newline.
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
				{settings}
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
