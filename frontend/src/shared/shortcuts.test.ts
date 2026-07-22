import { describe, expect, it } from "vitest";
import {
	APP_SHORTCUTS,
	matchesKeyboardShortcutsHelpShortcut,
	matchesNewSessionShortcut,
	matchesNewShellTerminalShortcut,
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
	// VS Code / Cursor / Codex "Create New Terminal", identical on every platform.
	// Matched on the physical `code`: Shift shifts the character (US delivers key
	// "~" for Ctrl+Shift+`), so the runtime chord carries code "Backquote".
	it("matches Ctrl+Shift+` even though the character arrives shifted", () => {
		expect(
			matchesNewShellTerminalShortcut(chord({ code: "Backquote", key: "~", ctrl: true, shift: true }), false),
		).toBe(true);
		expect(matchesNewShellTerminalShortcut(chord({ code: "Backquote", key: "~", ctrl: true, shift: true }), true)).toBe(
			true,
		);
	});

	it("also matches plain Ctrl+` (toggle) on both platforms", () => {
		expect(matchesNewShellTerminalShortcut(chord({ code: "Backquote", key: "`", ctrl: true }), false)).toBe(true);
		expect(matchesNewShellTerminalShortcut(chord({ code: "Backquote", key: "`", ctrl: true }), true)).toBe(true);
	});

	// Chords supplied without a code fall back to the key spelling.
	it("falls back to the key spelling when no code is present", () => {
		expect(matchesNewShellTerminalShortcut(chord({ key: "`", ctrl: true }), false)).toBe(true);
		expect(matchesNewShellTerminalShortcut(chord({ key: "Backquote", ctrl: true }), false)).toBe(true);
	});

	// The binding uses Ctrl on every platform, never ⌘ — ⌘` is the macOS
	// "cycle windows" binding and must stay with the OS.
	it("does not match Command+backtick on macOS", () => {
		expect(matchesNewShellTerminalShortcut(chord({ code: "Backquote", key: "`", meta: true }), true)).toBe(false);
		expect(matchesNewShellTerminalShortcut(chord({ code: "Backquote", key: "~", meta: true, shift: true }), true)).toBe(
			false,
		);
	});

	it("requires Ctrl and rejects Alt / Meta", () => {
		expect(matchesNewShellTerminalShortcut(chord({ code: "Backquote", key: "`" }), false)).toBe(false);
		expect(matchesNewShellTerminalShortcut(chord({ code: "Backquote", key: "`", ctrl: true, alt: true }), false)).toBe(
			false,
		);
		expect(matchesNewShellTerminalShortcut(chord({ code: "Backquote", key: "`", ctrl: true, meta: true }), false)).toBe(
			false,
		);
	});

	it("ignores other keys", () => {
		expect(matchesNewShellTerminalShortcut(chord({ code: "Digit1", key: "1", ctrl: true }), false)).toBe(false);
		expect(matchesNewShellTerminalShortcut(chord({ code: "KeyT", key: "t", ctrl: true, shift: true }), false)).toBe(
			false,
		);
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

describe("shortcut catalog", () => {
	it("provides platform labels for every shortcut", () => {
		for (const shortcut of APP_SHORTCUTS) {
			expect(shortcutKeys(shortcut, true).length).toBeGreaterThan(0);
			expect(shortcutKeys(shortcut, false).length).toBeGreaterThan(0);
		}
	});
});
