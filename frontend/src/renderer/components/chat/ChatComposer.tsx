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
 *
 * Three completions live on top of a plain textarea — `/` for the agent's own
 * skills, `@` for worktree files, and pasted or dropped images. It is a textarea and
 * not a rich editor; the reasoning is in composerSuggest.ts, where the logic that
 * would otherwise justify one lives. What matters here is that the original
 * keyboard contract survives: Enter sends, Shift+Enter makes a newline, and no
 * keystroke is ever swallowed, because the menu is derived from (text, caret)
 * rather than intercepting input.
 *
 * Every affordance is conditional on being able to deliver. The `/` menu only opens
 * when the provider actually reported skills, and the attach control only appears
 * when a caller supplied somewhere to put the bytes — a control that cannot do what
 * it says should not be drawn.
 */

import {
	useCallback,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type ChangeEvent,
	type ClipboardEvent,
	type DragEvent,
	type FormEvent,
	type KeyboardEvent,
	type ReactNode,
} from "react";
import { ArrowUp, CornerDownRight, Loader2, Paperclip, X } from "lucide-react";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";
import { ComposerSuggestMenu } from "./ComposerSuggestMenu";
import {
	applySuggestion,
	findActiveTrigger,
	moveHighlight,
	rankFiles,
	rankSkills,
	type Suggestion,
} from "./composerSuggest";
import {
	useImageAttachments,
	type ImageAttachmentPayload,
} from "../../hooks/useImageAttachments";
import type { ChatSkill } from "../../types/conversation";

/**
 * Tell the agent to open the images. Mirrors the wording spawn uses for a task
 * brief, so the same instruction reaches the agent whether an image was attached at
 * spawn or mid-conversation.
 */
function withAttachmentReferences(text: string, paths: string[]): string {
	if (paths.length === 0) return text;
	const lead = text.trim() === "" ? "" : `${text}\n\n`;
	return `${lead}Attached images (read these files in the workspace for visual context):\n${paths
		.map((path) => `- ${path}`)
		.join("\n")}`;
}

export function ChatComposer({
	onSend,
	busy,
	willQueue,
	disabled,
	settings,
	skills = [],
	filePaths = [],
	filePathsTruncated,
	onStageAttachments,
	nativeImages,
	onSteer,
	canSteer,
	steerPending,
	steerRefusal,
}: {
	onSend: (text: string, attachments?: ImageAttachmentPayload[]) => void;
	/** The next-turn controls, rendered inline. Omitted in the fixture preview. */
	settings?: ReactNode;
	/** A send is in flight. */
	busy?: boolean;
	/** The agent is mid-turn, so this message is held until the turn ends. */
	willQueue?: boolean;
	disabled?: boolean;
	/** The provider's skills. Empty leaves `/` an ordinary character. */
	skills?: ChatSkill[];
	/** Worktree-relative paths offered for `@`. Empty leaves `@` ordinary. */
	filePaths?: string[];
	/** The path list was capped, so the menu says so rather than implying it is all. */
	filePathsTruncated?: boolean;
	/**
	 * Writes staged images into the worktree and answers with the paths the agent
	 * can open. Absent means images cannot be delivered, and no attach control is
	 * offered at all.
	 */
	onStageAttachments?: (attachments: ImageAttachmentPayload[]) => Promise<string[]>;
	/** Send the same staged bytes as native ACP image blocks when negotiated. */
	nativeImages?: boolean;
	/**
	 * Deliver this text into the turn already running. Absent means the harness
	 * cannot steer and the choice is never offered.
	 */
	onSteer?: (text: string) => Promise<unknown>;
	/** A turn is actually running, so there is something to steer into. */
	canSteer?: boolean;
	steerPending?: boolean;
	/** Why the last steer was refused. */
	steerRefusal?: string;
}) {
	const [text, setText] = useState("");
	const [caret, setCaret] = useState(0);
	/**
	 * The trigger position the user dismissed with Escape. Held so the menu stays
	 * shut for the completion they rejected, while a new `/` or `@` still opens one.
	 */
	const [dismissedAt, setDismissedAt] = useState<number | null>(null);
	const [highlighted, setHighlighted] = useState(0);
	const [dragging, setDragging] = useState(false);
	const [sendError, setSendError] = useState<string | null>(null);
	/**
	 * What Enter does while the agent is working.
	 *
	 * Steering is the better answer when a turn is live — the correction reaches the
	 * work in flight instead of waiting behind it — so it is the default. But it is a
	 * different thing to do with the user's words, and quietly changing what Enter
	 * means would be worse than the queueing it replaces. So the choice is drawn, and
	 * the send hint names whichever one is armed.
	 */
	const [delivery, setDelivery] = useState<"steer" | "queue">("steer");

	const textarea = useRef<HTMLTextAreaElement>(null);
	const filePicker = useRef<HTMLInputElement>(null);
	/** Where the caret should land once React has committed the new text. */
	const pendingCaret = useRef<number | null>(null);
	const menuId = useId();

	const images = useImageAttachments();
	const canAttach = Boolean(onStageAttachments);

	const trigger = useMemo(() => findActiveTrigger(text, caret), [text, caret]);

	const suggestions: Suggestion[] = useMemo(() => {
		if (!trigger || trigger.start === dismissedAt) return [];
		// An empty candidate list is the whole reason the sigil stays ordinary: with
		// no skills there is nothing to open, so `/` types a slash.
		if (trigger.kind === "skill") return rankSkills(skills, trigger.query);
		return rankFiles(filePaths, trigger.query);
	}, [trigger, dismissedAt, skills, filePaths]);

	const menuOpen = suggestions.length > 0;
	// Clamped rather than trusted: the list re-ranks on every keystroke, so the
	// index from the previous list can point past the end of this one.
	const activeIndex = Math.min(highlighted, suggestions.length - 1);

	const staged = images.attachments.length > 0;
	// The control disappears the moment the turn ends, and the armed mode degrades
	// with it: a steer with nothing in flight is refused, so it must never be what
	// Enter is still pointing at.
	const steering = Boolean(canSteer && onSteer) && delivery === "steer";
	const canSend = (text.trim().length > 0 || staged) && !busy && !disabled && !steerPending;

	/**
	 * Write text and caret back into the field.
	 *
	 * The caret is applied after the render rather than alongside it: setting it
	 * before React has written the new value would place it against the old string,
	 * and the controlled re-render would then drop it to the end of the new one.
	 */
	const applyText = useCallback((next: string, nextCaret: number) => {
		pendingCaret.current = nextCaret;
		setText(next);
		setCaret(nextCaret);
	}, []);

	useLayoutEffect(() => {
		const target = pendingCaret.current;
		if (target === null) return;
		pendingCaret.current = null;
		const node = textarea.current;
		if (!node) return;
		node.setSelectionRange(target, target);
		node.focus();
	}, [text]);

	const pick = useCallback(
		(value: string) => {
			if (!trigger) return;
			const next = applySuggestion(text, trigger, value);
			applyText(next.text, next.caret);
			setHighlighted(0);
			setDismissedAt(null);
		},
		[applyText, text, trigger],
	);

	async function submit(event?: FormEvent) {
		event?.preventDefault();
		if (!canSend) return;
		setSendError(null);

		const body = text.trim();

		// Steering keeps the text in the box until the provider has taken it. The turn
		// is already running, so a refusal is a real possibility — and a refusal that
		// had already cleared the composer would lose what the user typed.
		if (steering && onSteer) {
			if (body === "") return;
			try {
				await onSteer(body);
			} catch {
				// The refusal is the daemon's typed answer and the surface renders it from
				// `steerRefusal`; saying it twice here would be two messages for one event.
				return;
			}
			applyText("", 0);
			setDismissedAt(null);
			setHighlighted(0);
			return;
		}

		if (staged && onStageAttachments) {
			// Staged before the send so a failed write is reported instead of a
			// message that claims attachments the agent cannot open.
			let paths: string[];
			try {
				paths = await onStageAttachments(images.toPayload());
			} catch {
				setSendError("The images could not be attached. Nothing was sent.");
				return;
			}
			const message = withAttachmentReferences(body, paths);
			if (nativeImages) onSend(message, images.toPayload());
			else onSend(message);
			images.clear();
		} else {
			onSend(body);
		}

		applyText("", 0);
		setDismissedAt(null);
		setHighlighted(0);
	}

	function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
		if (menuOpen) {
			// Only these keys are taken while the menu is open. Everything else falls
			// through to the textarea, which is what keeps typing from being swallowed.
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				setHighlighted((current) =>
					moveHighlight(
						Math.min(current, suggestions.length - 1),
						event.key === "ArrowDown" ? 1 : -1,
						suggestions.length,
					),
				);
				return;
			}
			if (event.key === "Enter" || event.key === "Tab") {
				event.preventDefault();
				const chosen = suggestions[activeIndex];
				if (chosen) pick(chosen.value);
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				// Stopped here so Escape closes the menu rather than travelling on to
				// whatever surface is hosting the composer.
				event.stopPropagation();
				setDismissedAt(trigger?.start ?? null);
				return;
			}
		}

		// Enter sends; Shift+Enter makes a newline.
		if (event.key !== "Enter") return;
		if (event.shiftKey) return;
		event.preventDefault();
		void submit();
	}

	function onChange(event: ChangeEvent<HTMLTextAreaElement>) {
		const value = event.target.value;
		const nextCaret = event.target.selectionStart ?? value.length;
		setText(value);
		setCaret(nextCaret);
		setHighlighted(0);
		// A dismissal covers one trigger. It is released as soon as that trigger is no
		// longer the one under the caret, so a fresh `/` or `@` opens a menu again
		// without the user having to guess why the last one stayed shut.
		const next = findActiveTrigger(value, nextCaret);
		setDismissedAt((current) =>
			current !== null && next?.start === current ? current : null,
		);
	}

	/** Caret moves that are not edits: arrow keys, clicks, selection changes. */
	function onSelectionChange(event: { currentTarget: HTMLTextAreaElement }) {
		setCaret(event.currentTarget.selectionStart ?? 0);
	}

	function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
		if (!canAttach) return;
		const clipboard = event.clipboardData;
		const files = Array.from(clipboard?.files ?? []);
		if (files.length === 0) return;
		// The paste is only claimed when there is no text alongside the image: a copy
		// carrying both should still paste its text.
		const hasText =
			typeof clipboard?.getData === "function" && clipboard.getData("text/plain") !== "";
		if (!hasText) event.preventDefault();
		void images.addFiles(files);
	}

	function onDrop(event: DragEvent<HTMLFormElement>) {
		setDragging(false);
		if (!canAttach) return;
		const files = Array.from(event.dataTransfer?.files ?? []);
		if (files.length === 0) return;
		event.preventDefault();
		void images.addFiles(files);
	}

	const attachmentError = images.error ?? sendError;

	return (
		<form
			onSubmit={(event) => void submit(event)}
			onDragOver={(event) => {
				if (!canAttach) return;
				event.preventDefault();
				setDragging(true);
			}}
			onDragLeave={() => setDragging(false)}
			onDrop={onDrop}
			className={cn(
				"relative flex flex-col gap-2 rounded-lg border bg-surface p-2 focus-within:border-logo-accent/45",
				dragging ? "border-logo-accent" : "border-border-strong",
			)}
		>
			{menuOpen && trigger ? (
				<ComposerSuggestMenu
					id={menuId}
					kind={trigger.kind}
					items={suggestions}
					highlighted={activeIndex}
					onPick={pick}
					onHighlight={setHighlighted}
					truncated={trigger.kind === "file" && filePathsTruncated}
				/>
			) : null}

			{staged ? (
				<ul className="flex flex-wrap gap-1.5" aria-label="Attached images">
					{images.attachments.map((image, index) => (
						<li
							key={image.id}
							className="flex items-center gap-1.5 rounded border border-border bg-background py-0.5 pl-0.5 pr-1"
						>
							<img
								src={image.dataUrl}
								alt=""
								className="size-6 rounded-sm object-cover"
							/>
							<span className="text-[11px] text-muted-foreground">
								Image {index + 1}
							</span>
							<button
								type="button"
								onClick={() => images.remove(image.id)}
								aria-label={`Remove image ${index + 1}`}
								className="text-muted-foreground hover:text-foreground"
							>
								<X aria-hidden="true" className="size-3" />
							</button>
						</li>
					))}
				</ul>
			) : null}

			<textarea
				ref={textarea}
				value={text}
				onChange={onChange}
				onKeyDown={onKeyDown}
				onSelect={onSelectionChange}
				onClick={onSelectionChange}
				onPaste={onPaste}
				rows={2}
				disabled={disabled}
				aria-label="Message the agent"
				role="combobox"
				aria-expanded={menuOpen}
				aria-controls={menuOpen ? menuId : undefined}
				aria-activedescendant={menuOpen ? `${menuId}-option-${activeIndex}` : undefined}
				aria-autocomplete="list"
				placeholder={
					disabled
						? "The controller is not connected"
						: steering
							? "Agent is working — this goes into the turn it is running"
							: willQueue
								? "Agent is working — this sends when it finishes"
								: skills.length > 0
									? "Ask the agent…  /  for skills, @ for files"
									: "Ask the agent…  @ for files"
				}
				className="max-h-48 min-h-[3.25rem] w-full resize-none bg-transparent px-1.5 py-1 text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-50"
			/>

			{attachmentError ? (
				<p role="alert" className="px-1.5 text-[11px] leading-snug text-destructive">
					{attachmentError}
				</p>
			) : null}

			{/* A refused steer is an ordinary outcome, not a failure: the text is still
			    in the box and the message says which of "send it instead" and "try again
			    in a moment" applies. */}
			{steerRefusal ? (
				<p role="status" className="px-1.5 text-[11px] leading-snug text-warning">
					{steerRefusal}
				</p>
			) : null}

			{canSteer && onSteer ? (
				<DeliveryChoice value={delivery} onChange={setDelivery} disabled={steerPending} />
			) : null}

			<div className="flex items-center gap-2">
				{settings}
				{canAttach ? (
					<>
						<input
							ref={filePicker}
							type="file"
							accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
							multiple
							hidden
							onChange={(event) => {
								void images.addFiles(Array.from(event.target.files ?? []));
								// Cleared so picking the same file twice still fires a change.
								event.target.value = "";
							}}
						/>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							disabled={disabled}
							onClick={() => filePicker.current?.click()}
							aria-label="Attach an image"
							title="Attach an image"
							className="h-6 px-1.5"
						>
							<Paperclip aria-hidden="true" className="size-3.5 text-muted-foreground" />
						</Button>
					</>
				) : null}
				<span className="ml-auto text-[11px] text-muted-foreground">
					{menuOpen
						? "Enter to insert"
						: steering
							? "Enter to steer"
							: willQueue
								? "Enter to queue"
								: "Enter to send"}
				</span>
				<Button
					type="submit"
					size="icon-sm"
					disabled={!canSend}
					aria-label={steering ? "Steer the running turn" : "Send message"}
					className="border-logo-accent bg-logo-accent text-logo-accent-foreground hover:bg-logo-accent-bright focus-visible:ring-logo-accent/45"
				>
					{steerPending ? (
						<Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
					) : steering ? (
						<CornerDownRight aria-hidden="true" className="size-3.5" />
					) : (
						<ArrowUp aria-hidden="true" className="size-3.5" />
					)}
				</Button>
			</div>
		</form>
	);
}

/**
 * Where the next message goes while the agent is working.
 *
 * Two words rather than a switch, because the difference is not a preference — it is
 * two different things happening to what the user typed. Steering joins the turn in
 * flight: the agent keeps its context, its reasoning and the command it has running,
 * and decides for itself what to abandon. Queueing waits for the turn to end and
 * then starts a new one from a cold start. For someone who has just realized they
 * asked for the wrong thing, that is the whole difference, so both are named and the
 * hint below says which one Enter is armed with.
 */
function DeliveryChoice({
	value,
	onChange,
	disabled,
}: {
	value: "steer" | "queue";
	onChange: (next: "steer" | "queue") => void;
	disabled?: boolean;
}) {
	return (
		<div
			role="group"
			aria-label="Where this message goes while the agent is working"
			className="flex items-center gap-1 px-1.5"
		>
			{(["steer", "queue"] as const).map((option) => (
				<button
					key={option}
					type="button"
					onClick={() => onChange(option)}
					disabled={disabled}
					aria-pressed={value === option}
					title={
						option === "steer"
							? "Send this into the running turn. The agent keeps its context and its work in flight."
							: "Hold this until the turn ends, then send it as a new message."
					}
					className={cn(
						"rounded px-1.5 py-0.5 text-[11px] transition-colors disabled:opacity-50",
						value === option
							? "bg-raised text-foreground"
							: "text-muted-foreground hover:bg-interactive-hover hover:text-foreground",
					)}
				>
					{option === "steer" ? "Steer this turn" : "Queue for next"}
				</button>
			))}
		</div>
	);
}
