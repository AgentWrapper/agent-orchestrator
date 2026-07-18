import { matchesNewSessionShortcut, NEW_SESSION_SHORTCUT_CHANNEL } from "../shared/shortcuts";

// The slice of electron's Input we read, plus the emitter shape. Declared
// locally (rather than Pick<WebContents>) so tests can supply a plain fake and
// a real WebContents still structurally satisfies it.
type BeforeInput = {
	key: string;
	control: boolean;
	meta: boolean;
	shift: boolean;
	alt: boolean;
	type: string;
	isAutoRepeat?: boolean;
};
type BeforeInputContents = {
	on(
		event: "before-input-event",
		listener: (event: { preventDefault: () => void }, input: BeforeInput) => void,
	): unknown;
};
type ShortcutTargetContents = {
	focus: () => void;
	send: (channel: string) => void;
};

// Handled application-side (below) rather than by a renderer window listener so
// it fires regardless of which web contents holds focus — including xterm's
// helper textarea and the native Browser-preview WebContentsView, the two cases
// a renderer-only keydown listener cannot see.
//
// Attach a before-input-event hook to a web contents and forward matches to the
// shell. Preview views opt into focusing the shell before delivery; the main
// window already owns focus and only needs the IPC event.
export function attachNewSessionShortcut(
	contents: BeforeInputContents,
	isMac: boolean,
	target: ShortcutTargetContents,
	focusTarget = false,
): void {
	contents.on("before-input-event", (event, input) => {
		// keyDown only, and ignore auto-repeat so holding the combo opens the flow
		// once rather than spamming it.
		if (input.type !== "keyDown" || input.isAutoRepeat) return;
		const chord = {
			key: input.key,
			ctrl: input.control,
			meta: input.meta,
			shift: input.shift,
			alt: input.alt,
		};
		if (!matchesNewSessionShortcut(chord, isMac)) return;
		event.preventDefault();
		if (focusTarget) target.focus();
		target.send(NEW_SESSION_SHORTCUT_CHANNEL);
	});
}
