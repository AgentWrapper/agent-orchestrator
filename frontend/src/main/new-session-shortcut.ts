import { matchesNewSessionShortcut } from "../shared/shortcuts";

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

// Handled application-side (below) rather than by a renderer window listener so
// it fires regardless of which web contents holds focus — including xterm's
// helper textarea and the native Browser-preview WebContentsView, the two cases
// a renderer-only keydown listener cannot see.
//
// Attach a before-input-event hook to a web contents that fires `notify` when
// the new-session chord is pressed. Works for the main window and every browser
// preview view; the caller decides where `notify` sends the signal.
export function attachNewSessionShortcut(contents: BeforeInputContents, isMac: boolean, notify: () => void): void {
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
		notify();
	});
}
