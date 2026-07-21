import { describe, expect, it } from "vitest";
import {
	APP_SHORTCUTS,
	matchesKeyboardShortcutsHelpShortcut,
	matchesNewSessionShortcut,
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
