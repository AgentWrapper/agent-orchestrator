import { describe, expect, it } from "vitest";

import type { LocaleSnapshot } from "../shared/locale";
import {
	applyLocaleSnapshot,
	i18n,
	initializeRendererI18n,
	resolveNavigatorLocaleSnapshot,
} from "./i18n";

describe("renderer i18n", () => {
	it("initializes a dedicated synchronous instance with local resources", async () => {
		await initializeRendererI18n("en");

		expect(i18n.isInitialized).toBe(true);
		expect(i18n.options.initAsync).toBe(false);
		expect(i18n.options.fallbackLng).toContain("en");
		expect(i18n.options.supportedLngs).toEqual(expect.arrayContaining(["en", "zh-CN"]));
		expect(i18n.t("settings.language.title")).toBe("Language");
	});

	it("changes the language and document metadata from a locale snapshot", async () => {
		const snapshot: LocaleSnapshot = {
			preference: "zh-CN",
			effectiveLocale: "zh-CN",
			systemLocale: "en",
		};

		await applyLocaleSnapshot(snapshot);

		expect(i18n.resolvedLanguage).toBe("zh-CN");
		expect(document.documentElement.lang).toBe("zh-CN");
		expect(i18n.t("settings.language.title")).toBe("语言");
	});

	it("resets locale state between renderer tests", () => {
		expect(i18n.resolvedLanguage).toBe("en");
		expect(document.documentElement.lang).toBe("en");
	});

	it("derives a system snapshot from the browser locale", () => {
		expect(resolveNavigatorLocaleSnapshot("zh-Hans-CN")).toEqual({
			preference: "system",
			effectiveLocale: "zh-CN",
			systemLocale: "zh-CN",
		});
	});
});
