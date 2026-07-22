import {
	KEYBOARD_SHORTCUTS_HELP_CHANNEL,
	matchesKeyboardShortcutsHelpShortcut,
	matchesNewSessionShortcut,
	matchesNewShellTerminalShortcut,
	NEW_SESSION_SHORTCUT_CHANNEL,
	NEW_SHELL_TERMINAL_SHORTCUT_CHANNEL,
	type ShortcutChord,
} from "../shared/shortcuts";

// The slice of Electron's Input we read, plus the emitter shape. Declared
// locally so tests can supply a plain fake while WebContents still satisfies it.
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

const appShortcutChannel = (chord: ShortcutChord, isMac: boolean): string | null => {
	if (matchesNewSessionShortcut(chord, isMac)) return NEW_SESSION_SHORTCUT_CHANNEL;
	if (matchesNewShellTerminalShortcut(chord, isMac)) return NEW_SHELL_TERMINAL_SHORTCUT_CHANNEL;
	if (matchesKeyboardShortcutsHelpShortcut(chord, isMac)) return KEYBOARD_SHORTCUTS_HELP_CHANNEL;
	return null;
};

// Handle application-owned shortcuts in the main process so they work no
// matter which web contents holds focus, including xterm's helper textarea and
// the native Browser-preview WebContentsView.
export function attachAppShortcuts(
	contents: BeforeInputContents,
	isMac: boolean,
	target: ShortcutTargetContents,
	focusTarget = false,
): void {
	contents.on("before-input-event", (event, input) => {
		if (input.type !== "keyDown" || input.isAutoRepeat) return;
		const channel = appShortcutChannel(
			{
				key: input.key,
				ctrl: input.control,
				meta: input.meta,
				shift: input.shift,
				alt: input.alt,
			},
			isMac,
		);
		if (!channel) return;

		event.preventDefault();
		if (focusTarget) target.focus();
		target.send(channel);
	});
}
