// Pure, platform-parameterized shortcut matchers shared by the main process
// (Electron `before-input-event`) and any renderer code. Kept free of Electron
// and DOM types so it is trivially unit-testable and usable on both sides.

export type ShortcutChord = {
	key: string;
	// Physical key (KeyboardEvent.code / Electron input.code), independent of
	// layout and modifiers. Needed for chords whose character shifts — e.g.
	// Ctrl+Shift+` reports key "~" on a US layout but code "Backquote".
	code?: string;
	ctrl: boolean;
	meta: boolean;
	shift: boolean;
	alt: boolean;
};

// prettier-ignore
export type AppShortcutId =
	"new-session" | "new-shell-terminal" | "keyboard-shortcuts" | "toggle-sidebar" | "open-project" | "toggle-inspector" | "command-palette" | "open-settings" | "previous-session" | "next-session" | "focus-terminal";

export type ShortcutCategory = "General" | "Navigation" | "Session";

export type ShortcutDefinition = {
	id: AppShortcutId;
	label: string;
	category: ShortcutCategory;
	mac: readonly string[];
	windowsLinux: readonly string[];
};

export const SHORTCUT_CATEGORIES: readonly ShortcutCategory[] = ["General", "Navigation", "Session"];

// The user-facing shortcut catalog. Keep bindings here so the help dialog does
// not duplicate platform labels from the handlers that implement them.
export const APP_SHORTCUTS: readonly ShortcutDefinition[] = [
	{
		id: "new-session",
		label: "New session",
		category: "General",
		mac: ["⌘", "N"],
		windowsLinux: ["Ctrl", "Shift", "N"],
	},
	{
		id: "new-shell-terminal",
		label: "New terminal",
		category: "General",
		mac: ["Ctrl", "Shift", "`"],
		windowsLinux: ["Ctrl", "Shift", "`"],
	},
	{
		id: "keyboard-shortcuts",
		label: "Show keyboard shortcuts",
		category: "General",
		mac: ["⌘", "/"],
		windowsLinux: ["Ctrl", "/"],
	},
	{
		id: "command-palette",
		label: "Open command palette",
		category: "General",
		mac: ["⌘", "K"],
		windowsLinux: ["Ctrl", "K"],
	},
	{
		id: "open-settings",
		label: "Open settings",
		category: "General",
		mac: ["⌘", ","],
		windowsLinux: ["Ctrl", ","],
	},
	{
		id: "toggle-sidebar",
		label: "Toggle sidebar",
		category: "General",
		mac: ["⌘", "B"],
		windowsLinux: ["Ctrl", "B"],
	},
	{
		id: "open-project",
		label: "Open project 1–9",
		category: "Navigation",
		mac: ["⌘", "1–9"],
		windowsLinux: ["Ctrl", "1–9"],
	},
	{
		id: "previous-session",
		label: "Previous session",
		category: "Navigation",
		mac: ["⌘", "Alt", "↑"],
		windowsLinux: ["Ctrl", "PageUp"],
	},
	{
		id: "next-session",
		label: "Next session",
		category: "Navigation",
		mac: ["⌘", "Alt", "↓"],
		windowsLinux: ["Ctrl", "PageDown"],
	},
	{
		id: "toggle-inspector",
		label: "Toggle inspector",
		category: "Session",
		mac: ["⌘", "Shift", "B"],
		windowsLinux: ["Ctrl", "Shift", "B"],
	},
	{
		id: "focus-terminal",
		label: "Focus terminal",
		category: "Session",
		mac: ["⌘", "Shift", "T"],
		windowsLinux: ["Ctrl", "Shift", "T"],
	},
];

export function shortcutKeys(shortcut: ShortcutDefinition, isMac: boolean): readonly string[] {
	return isMac ? shortcut.mac : shortcut.windowsLinux;
}

// IPC channel the main process uses to tell the renderer shell to open the New
// Task flow. Lives here (not in main/) so the main process, preload, and
// renderer can all reference one constant without crossing bundle boundaries.
export const NEW_SESSION_SHORTCUT_CHANNEL = "app:new-session";
export const KEYBOARD_SHORTCUTS_HELP_CHANNEL = "app:keyboard-shortcuts-help";
export const NEW_SHELL_TERMINAL_SHORTCUT_CHANNEL = "app:new-shell-terminal";
export const OPEN_SETTINGS_SHORTCUT_CHANNEL = "app:open-settings";
export const PREVIOUS_SESSION_SHORTCUT_CHANNEL = "app:previous-session";
export const NEXT_SESSION_SHORTCUT_CHANNEL = "app:next-session";
export const FOCUS_TERMINAL_SHORTCUT_CHANNEL = "app:focus-terminal";

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

// New standalone terminal, bound to the backtick chords VS Code / Cursor /
// Codex use for the integrated terminal — Ctrl (never ⌘) on every platform, so
// there is nothing platform-specific to learn (⌘` is taken by the OS on macOS):
//
//   • Ctrl+Shift+` — "Create New Terminal" (the primary, advertised binding).
//   • Ctrl+`       — VS Code's toggle/focus chord; also opens one here.
//
// Handled in the main process so it fires even while focus is inside xterm; the
// tradeoff (no pane shell can receive these chords while AO owns them) matches
// VS Code.
export function matchesNewShellTerminalShortcut(chord: ShortcutChord, _isMac: boolean): boolean {
	// Match on the physical `code` (Backquote), not the character: with Shift
	// held the character is layout-shifted — US Ctrl+Shift+` reports key "~", not
	// "`" — so keying off `key` would miss the advertised Ctrl+Shift+` chord. Fall
	// back to the `key` spelling for chords supplied without a code. Shift is
	// optional (Ctrl+` and Ctrl+Shift+` both open a terminal); ⌘/Alt must not hold.
	const isBackquote = chord.code === "Backquote" || chord.key === "`" || chord.key === "Backquote";
	if (!isBackquote) return false;
	return chord.ctrl && !chord.meta && !chord.alt;
}

// Keyboard shortcut help: ⌘/ on macOS, Ctrl+/ on Windows/Linux. This is also
// handled at the application level so the terminal and Browser preview cannot
// swallow the command before the shell sees it.
export function matchesKeyboardShortcutsHelpShortcut(chord: ShortcutChord, isMac: boolean): boolean {
	if (chord.key !== "/") return false;
	return isMac
		? chord.meta && !chord.ctrl && !chord.alt && !chord.shift
		: chord.ctrl && !chord.meta && !chord.alt && !chord.shift;
}

export function matchesOpenSettingsShortcut(chord: ShortcutChord, isMac: boolean): boolean {
	if (chord.key !== ",") return false;
	return isMac
		? chord.meta && !chord.ctrl && !chord.alt && !chord.shift
		: chord.ctrl && !chord.meta && !chord.alt && !chord.shift;
}

export function matchesPreviousSessionShortcut(chord: ShortcutChord, isMac: boolean): boolean {
	if (isMac) {
		return (chord.key === "ArrowUp" || chord.key === "Up") && chord.meta && chord.alt && !chord.ctrl && !chord.shift;
	}
	return chord.key === "PageUp" && chord.ctrl && !chord.meta && !chord.alt && !chord.shift;
}

export function matchesNextSessionShortcut(chord: ShortcutChord, isMac: boolean): boolean {
	if (isMac) {
		return (
			(chord.key === "ArrowDown" || chord.key === "Down") && chord.meta && chord.alt && !chord.ctrl && !chord.shift
		);
	}
	return chord.key === "PageDown" && chord.ctrl && !chord.meta && !chord.alt && !chord.shift;
}

export function matchesFocusTerminalShortcut(chord: ShortcutChord, isMac: boolean): boolean {
	if (chord.key.toLowerCase() !== "t") return false;
	return isMac
		? chord.meta && chord.shift && !chord.ctrl && !chord.alt
		: chord.ctrl && chord.shift && !chord.meta && !chord.alt;
}
