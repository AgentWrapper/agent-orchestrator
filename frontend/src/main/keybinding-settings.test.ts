import { describe, expect, it } from "vitest";
import { coerceKeybindingOverrides } from "./keybinding-settings";

describe("coerceKeybindingOverrides", () => {
	it("keeps valid application bindings and ignores unknown commands", () => {
		expect(
			coerceKeybindingOverrides({
				"focus-terminal": [{ key: "j", ctrl: true }],
				"unknown-command": [{ key: "q", ctrl: true }],
			}),
		).toEqual({
			"focus-terminal": [
				{ key: "j", ctrl: true, meta: false, shift: false, alt: false },
			],
		});
	});

	it("falls back to defaults for corrupt non-empty arrays but preserves an intentional unassignment", () => {
		expect(
			coerceKeybindingOverrides({
				"open-settings": [{ key: "s" }],
				"command-palette": [],
			}),
		).toEqual({
			"command-palette": [],
		});
	});

	it("rejects standalone function keys and terminal-critical chords", () => {
		expect(
			coerceKeybindingOverrides({
				"focus-terminal": [{ key: "F6" }],
				"open-settings": [{ key: "c", ctrl: true }],
			}),
		).toEqual({});
	});

	it("does not accept overrides for the fixed indexed project shortcut", () => {
		expect(
			coerceKeybindingOverrides({
				"open-project": [{ key: "p", ctrl: true }],
			}),
		).toEqual({});
	});

	it("applies platform-aware reserved shortcut validation", () => {
		expect(coerceKeybindingOverrides({ "focus-terminal": [{ key: "q", meta: true }] }, true)).toEqual({});
		expect(coerceKeybindingOverrides({ "focus-terminal": [{ key: "q", meta: true }] }, false)).toEqual({
			"focus-terminal": [{ key: "q", ctrl: false, meta: true, shift: false, alt: false }],
		});
	});
});
