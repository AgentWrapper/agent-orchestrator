// Pure, platform-parameterized shortcut matchers shared by the main process
// (Electron `before-input-event`) and any renderer code. Kept free of Electron
// and DOM types so it is trivially unit-testable and usable on both sides.

export type ShortcutChord = {
	key: string;
	ctrl: boolean;
	meta: boolean;
	shift: boolean;
	alt: boolean;
};

// IPC channel the main process uses to tell the renderer shell to open the New
// Task flow. Lives here (not in main/) so the main process, preload, and
// renderer can all reference one constant without crossing bundle boundaries.
export const NEW_SESSION_SHORTCUT_CHANNEL = "app:new-session";

// New session: ⌘N on macOS, Ctrl+Shift+N on Windows/Linux. Plain Ctrl+N is a
// live terminal keystroke (readline/vim "next line"), so the non-mac binding
// adds Shift to stay clear of the shell. Handled at the application level
// (main-process before-input-event) so it fires even when focus is inside
// xterm's helper textarea or a native Browser-preview WebContentsView.
export function matchesNewSessionShortcut(chord: ShortcutChord, isMac: boolean): boolean {
	if (chord.key.toLowerCase() !== "n") return false;
	return isMac
		? chord.meta && !chord.ctrl && !chord.alt && !chord.shift
		: chord.ctrl && chord.shift && !chord.alt && !chord.meta;
}
