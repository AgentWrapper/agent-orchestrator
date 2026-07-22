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

export type AppShortcutId =
	"new-session" | "new-shell-terminal" | "keyboard-shortcuts" | "toggle-sidebar" | "open-project" | "toggle-inspector";

export type ShortcutCategory = "General" | "Navigation" | "Session";

export type ShortcutDefinition = {
	id: AppShortcutId;
	label: string;
	category: ShortcutCategory;
	mac: readonly string[];
	windowsLinux: readonly string[];
	context?: string;
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
		mac: ["Ctrl", "`"],
		windowsLinux: ["Ctrl", "`"],
	},
	{
		id: "keyboard-shortcuts",
		label: "Show keyboard shortcuts",
		category: "General",
		mac: ["⌘", "/"],
		windowsLinux: ["Ctrl", "/"],
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
		context: "When that project exists",
	},
	{
		id: "toggle-inspector",
		label: "Toggle inspector",
		category: "Session",
		mac: ["⌘", "Shift", "B"],
		windowsLinux: ["Ctrl", "Shift", "B"],
		context: "Session view",
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

// New standalone terminal: Ctrl+` on every platform, matching VS Code and most
// IDEs. Ctrl (not ⌘) on macOS too — that is the conventional binding there, and
// ⌘` is already taken by the OS for cycling an app's windows.
//
// Like the other app shortcuts this is handled in the main process, so it fires
// even while focus is inside xterm. The tradeoff is deliberate: no shell or TUI
// running in a pane can receive Ctrl+` while AO owns it. Almost nothing binds
// that chord, and VS Code makes the same trade.
export function matchesNewShellTerminalShortcut(chord: ShortcutChord, _isMac: boolean): boolean {
	// Keyboards that need a modifier for the backtick can report the physical
	// key instead of the character, so accept either spelling.
	if (chord.key !== "`" && chord.key !== "Backquote") return false;
	return chord.ctrl && !chord.meta && !chord.alt && !chord.shift;
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
