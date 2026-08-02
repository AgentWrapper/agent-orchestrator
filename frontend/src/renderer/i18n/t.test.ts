import { describe, expect, it } from "vitest";
import { coerceLocale, DEFAULT_LOCALE } from "./locales";
import { enMessages, zhCNMessages } from "./messages";
import { resolveMessage, t, tEn } from "./t";

describe("coerceLocale", () => {
	it("accepts en and zh-CN", () => {
		expect(coerceLocale("en")).toBe("en");
		expect(coerceLocale("zh-CN")).toBe("zh-CN");
	});

	it("defaults unknown values to en", () => {
		expect(coerceLocale(undefined)).toBe(DEFAULT_LOCALE);
		expect(coerceLocale(null)).toBe("en");
		expect(coerceLocale("fr")).toBe("en");
		expect(coerceLocale({ locale: "zh-CN" })).toBe("en");
	});
});

describe("t / resolveMessage", () => {
	it("returns English for default locale", () => {
		expect(t("en", "settings.general")).toBe("General");
		expect(t("en", "settings.theme")).toBe("Theme");
		expect(tEn("settings.language")).toBe("Language");
	});

	it("returns Chinese when key exists in zh-CN", () => {
		expect(t("zh-CN", "settings.general")).toBe("通用");
		expect(t("zh-CN", "settings.theme")).toBe("主题");
		expect(t("zh-CN", "settings.connectMobile")).toBe("连接手机");
		expect(t("zh-CN", "settings.language.zhCN")).toBe("简体中文");
	});

	it("falls back to English when zh-CN key is missing", () => {
		const catalogs = {
			en: { "proof.onlyEn": "English only", "settings.general": "General" },
			"zh-CN": { "settings.general": "通用" },
		};
		expect(resolveMessage("zh-CN", "proof.onlyEn", catalogs)).toBe("English only");
		expect(resolveMessage("zh-CN", "settings.general", catalogs)).toBe("通用");
	});

	it("falls back to key id when missing from both catalogs", () => {
		const catalogs = { en: {}, "zh-CN": {} };
		expect(resolveMessage("zh-CN", "totally.missing", catalogs)).toBe("totally.missing");
		expect(resolveMessage("en", "totally.missing", catalogs)).toBe("totally.missing");
	});

	it("interpolates {var} placeholders", () => {
		const catalogs = {
			en: { "proof.hello": "Hello, {name}!", "proof.count": "{count} items" },
			"zh-CN": { "proof.hello": "你好，{name}！" },
		};
		expect(resolveMessage("en", "proof.hello", catalogs, { name: "AO" })).toBe("Hello, AO!");
		expect(resolveMessage("zh-CN", "proof.hello", catalogs, { name: "AO" })).toBe("你好，AO！");
		expect(resolveMessage("en", "proof.count", catalogs, { count: 3 })).toBe("3 items");
		// Missing zh key uses en template + vars.
		expect(resolveMessage("zh-CN", "proof.count", catalogs, { count: 2 })).toBe("2 items");
	});

	it("leaves unknown placeholders intact", () => {
		const catalogs = { en: { "proof.x": "keep {missing}" }, "zh-CN": {} };
		expect(resolveMessage("en", "proof.x", catalogs, {})).toBe("keep {missing}");
		expect(resolveMessage("en", "proof.x", catalogs)).toBe("keep {missing}");
	});

	it("proof catalogs cover all English keys used by settings", () => {
		for (const key of Object.keys(enMessages)) {
			expect(typeof enMessages[key as keyof typeof enMessages]).toBe("string");
		}
		// Partial zh is OK; every present zh key should be a non-empty string.
		for (const [key, value] of Object.entries(zhCNMessages)) {
			expect(key in enMessages).toBe(true);
			expect(typeof value).toBe("string");
			expect(value.length).toBeGreaterThan(0);
		}
	});
});
