import { describe, expect, it } from "vitest";
import { isCommandPaletteEnabled, isNightlyBuild } from "./build-channel";

describe("isNightlyBuild", () => {
	it("detects -nightly. stamps and rejects everything else", () => {
		expect(isNightlyBuild("0.10.4-nightly.202607071200+abc123")).toBe(true);
		expect(isNightlyBuild("0.10.3")).toBe(false);
		expect(isNightlyBuild(undefined)).toBe(false);
		expect(isNightlyBuild("0.0.0-preview")).toBe(false);
		expect(isNightlyBuild("0.0.0-test")).toBe(false);
	});
});

describe("isCommandPaletteEnabled", () => {
	it("is on in dev or nightly, off otherwise", () => {
		expect(isCommandPaletteEnabled("0.10.3", true)).toBe(true);
		expect(isCommandPaletteEnabled(undefined, true)).toBe(true);
		expect(isCommandPaletteEnabled("0.10.4-nightly.202607071200+abc123", false)).toBe(true);
		expect(isCommandPaletteEnabled("0.10.3", false)).toBe(false);
		expect(isCommandPaletteEnabled(undefined, false)).toBe(false);
	});
});
