import { describe, expect, it } from "vitest";
import { assertCatalogCoverage, catalogs } from "./messages";
import { createT, enT, interpolate, translate } from "./translate";
import {
	APP_LOCALES,
	coerceLocale,
	DEFAULT_LOCALE,
	LOCALE_NATIVE_LABELS,
	matchDeviceLocale,
} from "./ui-locale";

describe("APP_LOCALES", () => {
	it("matches the desktop locale set and order", () => {
		expect(APP_LOCALES).toEqual(["en", "zh-CN", "ja", "ko", "es", "fr", "de", "pt-BR"]);
		expect(DEFAULT_LOCALE).toBe("en");
	});

	it("has a native label for every locale", () => {
		for (const locale of APP_LOCALES) {
			expect(LOCALE_NATIVE_LABELS[locale].length).toBeGreaterThan(0);
		}
		expect(LOCALE_NATIVE_LABELS["zh-CN"]).toBe("简体中文");
		expect(LOCALE_NATIVE_LABELS.ja).toBe("日本語");
		expect(LOCALE_NATIVE_LABELS["pt-BR"]).toBe("Português (Brasil)");
	});
});

describe("coerceLocale", () => {
	it("accepts exact supported codes only", () => {
		expect(coerceLocale("en")).toBe("en");
		expect(coerceLocale("zh-CN")).toBe("zh-CN");
		expect(coerceLocale("pt-BR")).toBe("pt-BR");
		expect(coerceLocale("zh")).toBe(DEFAULT_LOCALE);
		expect(coerceLocale("pt")).toBe(DEFAULT_LOCALE);
		expect(coerceLocale(null)).toBe(DEFAULT_LOCALE);
	});
});

describe("matchDeviceLocale", () => {
	it("maps language prefixes onto the supported set", () => {
		expect(matchDeviceLocale("zh-Hans-CN")).toBe("zh-CN");
		expect(matchDeviceLocale("zh_TW")).toBe("zh-CN");
		expect(matchDeviceLocale("ja-JP")).toBe("ja");
		expect(matchDeviceLocale("ko_KR")).toBe("ko");
		expect(matchDeviceLocale("es-MX")).toBe("es");
		expect(matchDeviceLocale("fr-CA")).toBe("fr");
		expect(matchDeviceLocale("de-AT")).toBe("de");
		expect(matchDeviceLocale("pt-PT")).toBe("pt-BR");
		expect(matchDeviceLocale("pt_BR")).toBe("pt-BR");
		expect(matchDeviceLocale("en-GB")).toBe("en");
	});

	it("falls back to English for unknown tags", () => {
		expect(matchDeviceLocale("sv-SE")).toBe("en");
		expect(matchDeviceLocale("")).toBe("en");
		expect(matchDeviceLocale(undefined)).toBe("en");
	});
});

describe("translate", () => {
	it("interpolates params and falls back to English", () => {
		expect(interpolate("Hi {{name}}", { name: "AO" })).toBe("Hi AO");
		expect(enT("common.retry")).toBe("Retry");
		expect(translate("zh-CN", "common.retry")).toBe("重试");
		expect(createT("ja")("tabs.settings")).toBe("設定");
	});

	it("covers every locale catalog with English keys", () => {
		assertCatalogCoverage();
		const keyCount = Object.keys(catalogs.en).length;
		for (const locale of APP_LOCALES) {
			expect(Object.keys(catalogs[locale]).length).toBe(keyCount);
		}
	});
});
