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

	it("rejects plain typing keys but preserves an explicitly unassigned command", () => {
		expect(
			coerceKeybindingOverrides({
				"open-settings": [{ key: "s" }],
				"command-palette": [],
			}),
		).toEqual({
			"open-settings": [],
			"command-palette": [],
		});
	});

	it("allows safe standalone function keys", () => {
		expect(
			coerceKeybindingOverrides({
				"focus-terminal": [{ key: "F6" }],
			}),
		).toEqual({
			"focus-terminal": [
				{ key: "F6", ctrl: false, meta: false, shift: false, alt: false },
			],
		});
	});

	it("does not accept overrides for the fixed indexed project shortcut", () => {
		expect(
			coerceKeybindingOverrides({
				"open-project": [{ key: "p", ctrl: true }],
			}),
		).toEqual({});
	});
});
