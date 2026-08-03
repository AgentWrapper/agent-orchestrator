import { describe, expect, it } from "vitest";
import {
	APP_LOCALES,
	DEFAULT_LOCALE,
	DEFAULT_UI_SETTINGS,
	coerceLocale,
	coerceUiSettings,
} from "./ui-locale";

describe("shared UI locale schema", () => {
	it("accepts only supported locale identifiers", () => {
		expect(APP_LOCALES).toEqual(["en", "zh-CN"]);
		expect(coerceLocale("en")).toBe("en");
		expect(coerceLocale("zh-CN")).toBe("zh-CN");
		expect(coerceLocale("zh")).toBe(DEFAULT_LOCALE);
		expect(coerceLocale({ locale: "zh-CN" })).toBe(DEFAULT_LOCALE);
	});

	it("normalizes persisted settings through the shared locale validator", () => {
		expect(coerceUiSettings({ locale: "zh-CN" })).toEqual({ locale: "zh-CN" });
		expect(coerceUiSettings({ locale: "fr" })).toEqual(DEFAULT_UI_SETTINGS);
		expect(coerceUiSettings(null)).toEqual(DEFAULT_UI_SETTINGS);
	});
});
