import { describe, expect, it } from "vitest";
import { assertCatalogCoverage, catalogs } from "./messages";
import {
	createT,
	enT,
	interpolate,
	resolvePluralKey,
	translate,
} from "./translate";
import type { MessageKey } from "./locales/en";
import {
	APP_LOCALES,
	coerceLocale,
	DEFAULT_LOCALE,
	deviceLocaleTag,
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

describe("deviceLocaleTag", () => {
	it("prefers expo-localization getLocales languageTag", () => {
		expect(deviceLocaleTag(() => [{ languageTag: "zh-Hans-CN" }])).toBe("zh-Hans-CN");
		expect(matchDeviceLocale(deviceLocaleTag(() => [{ languageTag: "zh-Hans-CN" }]))).toBe(
			"zh-CN",
		);
	});

	it("falls back to Intl when getLocales is empty or throws", () => {
		const viaEmpty = deviceLocaleTag(() => []);
		expect(typeof viaEmpty).toBe("string");
		expect(viaEmpty.length).toBeGreaterThan(0);

		const viaThrow = deviceLocaleTag(() => {
			throw new Error("native module missing");
		});
		expect(typeof viaThrow).toBe("string");
		expect(viaThrow.length).toBeGreaterThan(0);
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

	it("keeps the same {{params}} as English in every catalog", () => {
		const params = (s: string) =>
			[...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort().join(",");
		for (const locale of APP_LOCALES) {
			for (const key of Object.keys(catalogs.en) as MessageKey[]) {
				expect(`${locale}.${key}:${params(catalogs[locale][key])}`).toBe(
					`${locale}.${key}:${params(catalogs.en[key])}`,
				);
			}
		}
	});
});

describe("plural selection", () => {
	it("uses Intl.PluralRules so fr/pt-BR put 0 in one", () => {
		expect(resolvePluralKey("en", "common.files", 0)).toBe("common.files_other");
		expect(resolvePluralKey("en", "common.files", 1)).toBe("common.files_one");
		expect(resolvePluralKey("en", "common.files", 2)).toBe("common.files_other");

		expect(resolvePluralKey("fr", "common.files", 0)).toBe("common.files_one");
		expect(resolvePluralKey("fr", "common.files", 1)).toBe("common.files_one");
		expect(resolvePluralKey("fr", "common.files", 2)).toBe("common.files_other");

		expect(resolvePluralKey("pt-BR", "common.files", 0)).toBe("common.files_one");
		expect(resolvePluralKey("pt-BR", "common.files", 1)).toBe("common.files_one");
		expect(resolvePluralKey("pt-BR", "common.files", 2)).toBe("common.files_other");
	});

	it("selects from a base key or an already-suffixed key", () => {
		expect(translate("fr", "common.files", { count: 0 })).toBe("0 fichier");
		expect(translate("fr", "common.files_other", { count: 0 })).toBe("0 fichier");
		expect(translate("en", "common.workers", { count: 2 })).toBe("2 workers");
		expect(translate("en", "common.archiveCount", { count: 1 })).toBe("Archive, 1 session");
		expect(translate("en", "common.archiveCount", { count: 3 })).toBe("Archive, 3 sessions");
		expect(translate("fr", "common.archiveCount", { count: 0 })).toBe("Archiver, 0 session");
	});

	it("CJK locales use the other form for any count", () => {
		expect(resolvePluralKey("zh-CN", "common.sessions", 1)).toBe("common.sessions_other");
		expect(resolvePluralKey("ja", "common.sessions", 1)).toBe("common.sessions_other");
		expect(resolvePluralKey("ko", "common.sessions", 1)).toBe("common.sessions_other");
	});
});
