import { describe, expect, it } from "vitest";

import {
	coerceLocalePreference,
	resolveLocaleSnapshot,
	resolveSupportedLocale,
} from "./locale";

describe("coerceLocalePreference", () => {
	it.each([
		["system", "system"],
		["en", "en"],
		["zh-CN", "zh-CN"],
	] as const)("keeps %s", (input, expected) => {
		expect(coerceLocalePreference(input)).toBe(expected);
	});

	it.each([undefined, null, "", "broken", { preference: "en" }])(
		"falls back %s to system",
		(input) => {
			expect(coerceLocalePreference(input)).toBe("system");
		},
	);
});

describe("resolveSupportedLocale", () => {
	it.each([
		["zh-CN", "zh-CN"],
		["zh-Hans", "zh-CN"],
		["zh_TW", "zh-CN"],
		["zhHans", "zh-CN"],
		["zhCN", "zh-CN"],
		["ZHfoo", "zh-CN"],
		["ZH-hant", "zh-CN"],
		["en-US", "en"],
		["fr-FR", "en"],
		[undefined, "en"],
	] as const)("resolves %s to %s", (input, expected) => {
		expect(resolveSupportedLocale(input)).toBe(expected);
	});
});

describe("resolveLocaleSnapshot", () => {
	it("uses the resolved system locale for the system preference", () => {
		expect(resolveLocaleSnapshot("system", "zh-Hans")).toEqual({
			preference: "system",
			effectiveLocale: "zh-CN",
			systemLocale: "zh-CN",
		});
	});

	it("uses an explicit preference independently of the system locale", () => {
		expect(resolveLocaleSnapshot("en", "zh-CN")).toEqual({
			preference: "en",
			effectiveLocale: "en",
			systemLocale: "zh-CN",
		});
	});

	it("falls back invalid preferences to system", () => {
		expect(resolveLocaleSnapshot("broken", "zh-CN")).toEqual({
			preference: "system",
			effectiveLocale: "zh-CN",
			systemLocale: "zh-CN",
		});
	});
});
