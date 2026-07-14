import { describe, expect, it } from "vitest";
import { isEditableTarget, isNewSessionShortcut } from "./shortcuts";

type Combo = { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean };

function combo(overrides: Combo) {
	return { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...overrides };
}

describe("isNewSessionShortcut", () => {
	it("matches ⌘N on macOS", () => {
		expect(isNewSessionShortcut(combo({ key: "n", metaKey: true }), true)).toBe(true);
		expect(isNewSessionShortcut(combo({ key: "N", metaKey: true }), true)).toBe(true);
	});

	it("does not match plain Ctrl+N on macOS", () => {
		expect(isNewSessionShortcut(combo({ key: "n", ctrlKey: true }), true)).toBe(false);
	});

	it("matches Ctrl+Shift+N on Windows/Linux", () => {
		expect(isNewSessionShortcut(combo({ key: "n", ctrlKey: true, shiftKey: true }), false)).toBe(true);
	});

	it("does not match plain Ctrl+N on Windows/Linux (reserved for the terminal)", () => {
		expect(isNewSessionShortcut(combo({ key: "n", ctrlKey: true }), false)).toBe(false);
	});

	it("does not match ⌘N on Windows/Linux", () => {
		expect(isNewSessionShortcut(combo({ key: "n", metaKey: true }), false)).toBe(false);
	});

	it("ignores other keys and modifier-laden combos", () => {
		expect(isNewSessionShortcut(combo({ key: "m", metaKey: true }), true)).toBe(false);
		expect(isNewSessionShortcut(combo({ key: "n", metaKey: true, altKey: true }), true)).toBe(false);
		expect(isNewSessionShortcut(combo({ key: "n", ctrlKey: true, shiftKey: true, altKey: true }), false)).toBe(false);
	});
});

describe("isEditableTarget", () => {
	it("is true for inputs and textareas", () => {
		expect(isEditableTarget(document.createElement("input"))).toBe(true);
		expect(isEditableTarget(document.createElement("textarea"))).toBe(true);
	});

	it("is false for non-editable elements and null", () => {
		expect(isEditableTarget(document.createElement("button"))).toBe(false);
		expect(isEditableTarget(null)).toBe(false);
	});
});
