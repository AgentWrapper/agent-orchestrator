import { describe, expect, it } from "vitest";
import {
	APP_SHORTCUTS,
	matchesFocusTerminalShortcut,
	matchesKeyboardShortcutsHelpShortcut,
	matchesNextSessionShortcut,
	matchesNewSessionShortcut,
	matchesNewShellTerminalShortcut,
	matchesOpenSettingsShortcut,
	matchesPreviousSessionShortcut,
	shortcutKeys,
	type ShortcutChord,
} from "./shortcuts";

function chord(overrides: Partial<ShortcutChord> & { key: string }): ShortcutChord {
	return { ctrl: false, meta: false, shift: false, alt: false, ...overrides };
}

describe("matchesNewSessionShortcut", () => {
	it("matches ⌘N on macOS (either key case)", () => {
		expect(matchesNewSessionShortcut(chord({ key: "n", meta: true }), true)).toBe(true);
		expect(matchesNewSessionShortcut(chord({ key: "N", meta: true }), true)).toBe(true);
	});

	it("does not match plain Ctrl+N on macOS", () => {
		expect(matchesNewSessionShortcut(chord({ key: "n", ctrl: true }), true)).toBe(false);
	});

	it("matches Ctrl+Shift+N on Windows/Linux", () => {
		expect(matchesNewSessionShortcut(chord({ key: "N", ctrl: true, shift: true }), false)).toBe(true);
	});

	it("does not match plain Ctrl+N on Windows/Linux (reserved for the terminal)", () => {
		expect(matchesNewSessionShortcut(chord({ key: "n", ctrl: true }), false)).toBe(false);
	});

	it("does not match ⌘N on Windows/Linux", () => {
		expect(matchesNewSessionShortcut(chord({ key: "n", meta: true }), false)).toBe(false);
	});

	it("ignores other keys and extra modifiers", () => {
		expect(matchesNewSessionShortcut(chord({ key: "m", meta: true }), true)).toBe(false);
		expect(matchesNewSessionShortcut(chord({ key: "n", meta: true, alt: true }), true)).toBe(false);
		expect(matchesNewSessionShortcut(chord({ key: "n", ctrl: true, shift: true, alt: true }), false)).toBe(false);
		expect(matchesNewSessionShortcut(chord({ key: "n", ctrl: true, shift: true, meta: true }), false)).toBe(false);
	});
});

describe("matchesNewShellTerminalShortcut", () => {
	it("matches Ctrl+` on both platforms", () => {
		expect(matchesNewShellTerminalShortcut(chord({ key: "`", ctrl: true }), false)).toBe(true);
		expect(matchesNewShellTerminalShortcut(chord({ key: "`", ctrl: true }), true)).toBe(true);
	});

	// Layouts that need a modifier for the backtick report the physical key.
	it("matches the Backquote key name", () => {
		expect(matchesNewShellTerminalShortcut(chord({ key: "Backquote", ctrl: true }), false)).toBe(true);
	});

	// ⌘` is the macOS "cycle windows" binding and must stay with the OS.
	it("does not match Command+backtick on macOS", () => {
		expect(matchesNewShellTerminalShortcut(chord({ key: "`", meta: true }), true)).toBe(false);
	});

	// Shift is optional: Ctrl+Shift+` is the advertised "Create New Terminal" chord.
	it("matches Ctrl+Shift+` on both platforms", () => {
		expect(matchesNewShellTerminalShortcut(chord({ key: "`", ctrl: true, shift: true }), false)).toBe(true);
		expect(matchesNewShellTerminalShortcut(chord({ key: "`", ctrl: true, shift: true }), true)).toBe(true);
	});

	// With Shift held the character shifts (US "~"), but the physical code is
	// stable — matching on code is what makes Ctrl+Shift+` actually fire.
	it("matches on the physical Backquote code even when the character is shifted", () => {
		expect(
			matchesNewShellTerminalShortcut(chord({ key: "~", code: "Backquote", ctrl: true, shift: true }), false),
		).toBe(true);
	});

	it("requires Ctrl and rejects ⌘/Alt", () => {
		expect(matchesNewShellTerminalShortcut(chord({ key: "`" }), false)).toBe(false);
		expect(matchesNewShellTerminalShortcut(chord({ key: "`", ctrl: true, alt: true }), false)).toBe(false);
		expect(matchesNewShellTerminalShortcut(chord({ key: "`", ctrl: true, meta: true }), false)).toBe(false);
	});

	it("ignores other keys", () => {
		expect(matchesNewShellTerminalShortcut(chord({ key: "1", ctrl: true }), false)).toBe(false);
		expect(matchesNewShellTerminalShortcut(chord({ key: "~", ctrl: true }), false)).toBe(false);
	});
});

describe("matchesKeyboardShortcutsHelpShortcut", () => {
	it("matches Ctrl+/ on Windows/Linux and Command+/ on macOS", () => {
		expect(matchesKeyboardShortcutsHelpShortcut(chord({ key: "/", ctrl: true }), false)).toBe(true);
		expect(matchesKeyboardShortcutsHelpShortcut(chord({ key: "/", meta: true }), true)).toBe(true);
	});

	it("rejects the wrong platform modifier and extra modifiers", () => {
		expect(matchesKeyboardShortcutsHelpShortcut(chord({ key: "/", meta: true }), false)).toBe(false);
		expect(matchesKeyboardShortcutsHelpShortcut(chord({ key: "/", ctrl: true }), true)).toBe(false);
		expect(matchesKeyboardShortcutsHelpShortcut(chord({ key: "/", ctrl: true, shift: true }), false)).toBe(false);
		expect(matchesKeyboardShortcutsHelpShortcut(chord({ key: "?", ctrl: true }), false)).toBe(false);
	});
});

describe("additional application shortcuts", () => {
	it("matches settings on each platform and rejects extra modifiers", () => {
		expect(matchesOpenSettingsShortcut(chord({ key: ",", meta: true }), true)).toBe(true);
		expect(matchesOpenSettingsShortcut(chord({ key: ",", ctrl: true }), false)).toBe(true);
		expect(matchesOpenSettingsShortcut(chord({ key: ",", ctrl: true, shift: true }), false)).toBe(false);
	});

	it("matches previous and next session on each platform", () => {
		expect(matchesPreviousSessionShortcut(chord({ key: "ArrowUp", meta: true, alt: true }), true)).toBe(true);
		expect(matchesPreviousSessionShortcut(chord({ key: "PageUp", ctrl: true }), false)).toBe(true);
		expect(matchesNextSessionShortcut(chord({ key: "ArrowDown", meta: true, alt: true }), true)).toBe(true);
		expect(matchesNextSessionShortcut(chord({ key: "PageDown", ctrl: true }), false)).toBe(true);
		expect(matchesNextSessionShortcut(chord({ key: "Down", ctrl: true, alt: true }), false)).toBe(false);
		expect(matchesNextSessionShortcut(chord({ key: "Down", ctrl: true }), false)).toBe(false);
	});

	it("matches focus terminal on each platform and rejects extra modifiers", () => {
		expect(matchesFocusTerminalShortcut(chord({ key: "T", meta: true, shift: true }), true)).toBe(true);
		expect(matchesFocusTerminalShortcut(chord({ key: "t", ctrl: true, shift: true }), false)).toBe(true);
		expect(matchesFocusTerminalShortcut(chord({ key: "t", ctrl: true, shift: true, alt: true }), false)).toBe(false);
	});
});

describe("shortcut catalog", () => {
	it("provides platform labels for every shortcut", () => {
		for (const shortcut of APP_SHORTCUTS) {
			expect(shortcutKeys(shortcut, true).length).toBeGreaterThan(0);
			expect(shortcutKeys(shortcut, false).length).toBeGreaterThan(0);
		}
	});
});
