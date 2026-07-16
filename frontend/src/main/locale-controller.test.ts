// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import type { LocalePreference } from "../shared/locale";
import { mainI18n, mainT } from "./i18n";
import { LocaleController, type LocaleControllerDeps } from "./locale-controller";

function deps(overrides: Partial<LocaleControllerDeps> = {}): LocaleControllerDeps {
	return {
		userDataDir: "/tmp/ao-locale-controller",
		systemLocale: () => "en-US",
		readPreference: async () => "system",
		writePreference: async () => undefined,
		changeLanguage: async () => undefined,
		rebuildMenus: () => undefined,
		...overrides,
	};
}

describe("main i18n", () => {
	it("initializes a dedicated synchronous instance with local resources", () => {
		expect(mainI18n.isInitialized).toBe(true);
		expect(mainI18n.options.initAsync).toBe(false);
		expect(mainI18n.options.fallbackLng).toContain("en");
		expect(mainI18n.options.supportedLngs).toEqual(expect.arrayContaining(["en", "zh-CN"]));
		expect(mainI18n.options.interpolation?.escapeValue).toBe(false);
		expect(mainT("settings.language.title")).toBe("Language");
	});
});

describe("LocaleController", () => {
	it("initializes from the persisted preference and system locale", async () => {
		const changeLanguage = vi.fn(async () => undefined);
		const controller = new LocaleController(
			deps({
				systemLocale: () => "zh-Hans",
				readPreference: async () => "system",
				changeLanguage,
			}),
		);

		await expect(controller.initialize()).resolves.toEqual({
			preference: "system",
			effectiveLocale: "zh-CN",
			systemLocale: "zh-CN",
		});
		expect(controller.get()).toEqual({
			preference: "system",
			effectiveLocale: "zh-CN",
			systemLocale: "zh-CN",
		});
		expect(changeLanguage).toHaveBeenCalledOnce();
		expect(changeLanguage).toHaveBeenCalledWith("zh-CN");
	});

	it("writes before changing language and rebuilding menus", async () => {
		const calls: string[] = [];
		const controller = new LocaleController(
			deps({
				writePreference: async () => {
					calls.push("write");
				},
				changeLanguage: async () => {
					calls.push("language");
				},
				rebuildMenus: () => {
					calls.push("menu");
				},
			}),
		);
		await controller.initialize();

		await expect(controller.set("zh-CN")).resolves.toEqual({
			preference: "zh-CN",
			effectiveLocale: "zh-CN",
			systemLocale: "en",
		});
		expect(calls.slice(-3)).toEqual(["write", "language", "menu"]);
	});

	it("keeps the previous snapshot when persistence fails", async () => {
		const changeLanguage = vi.fn(async () => undefined);
		const rebuildMenus = vi.fn();
		const controller = new LocaleController(
			deps({
				writePreference: async () => {
					throw new Error("disk");
				},
				changeLanguage,
				rebuildMenus,
			}),
		);
		const before = await controller.initialize();
		changeLanguage.mockClear();

		await expect(controller.set("zh-CN")).rejects.toThrow("disk");
		expect(controller.get()).toEqual(before);
		expect(changeLanguage).not.toHaveBeenCalled();
		expect(rebuildMenus).not.toHaveBeenCalled();
	});

	it("keeps the previous snapshot and menu when changing language fails", async () => {
		const writePreference = vi.fn(async () => undefined);
		const changeLanguage = vi.fn(async () => undefined);
		const rebuildMenus = vi.fn();
		const controller = new LocaleController(
			deps({ writePreference, changeLanguage, rebuildMenus }),
		);
		const before = await controller.initialize();
		changeLanguage.mockRejectedValueOnce(new Error("i18n"));

		await expect(controller.set("zh-CN")).rejects.toThrow("i18n");
		expect(controller.get()).toEqual(before);
		expect(writePreference).toHaveBeenCalledWith("/tmp/ao-locale-controller", "zh-CN");
		expect(rebuildMenus).not.toHaveBeenCalled();
	});

	it("rejects unknown preferences before mutating state", async () => {
		const writePreference = vi.fn(async () => undefined);
		const changeLanguage = vi.fn(async () => undefined);
		const rebuildMenus = vi.fn();
		const controller = new LocaleController(
			deps({ writePreference, changeLanguage, rebuildMenus }),
		);
		const before = await controller.initialize();
		changeLanguage.mockClear();

		await expect(controller.set("bad" as LocalePreference)).rejects.toThrow("Invalid locale preference");
		expect(controller.get()).toEqual(before);
		expect(writePreference).not.toHaveBeenCalled();
		expect(changeLanguage).not.toHaveBeenCalled();
		expect(rebuildMenus).not.toHaveBeenCalled();
	});
});
