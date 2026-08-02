import { beforeEach, describe, expect, it, vi } from "vitest";
import { t as translate } from "../i18n";

const getUiSettings = vi.fn();
const setUiSettings = vi.fn();

vi.mock("../lib/bridge", () => ({
	aoBridge: {
		uiSettings: {
			get: (...args: unknown[]) => getUiSettings(...args),
			set: (...args: unknown[]) => setUiSettings(...args),
		},
	},
}));

import { useLocaleStore } from "./locale-store";

describe("locale-store", () => {
	beforeEach(() => {
		getUiSettings.mockReset();
		setUiSettings.mockReset();
		getUiSettings.mockResolvedValue({ locale: "en" });
		setUiSettings.mockImplementation(async (settings: { locale: "en" | "zh-CN" }) => settings);
		useLocaleStore.setState({
			locale: "en",
			loaded: false,
			t: (key, vars) => translate("en", key, vars),
		});
		document.documentElement.lang = "en";
	});

	it("defaults to English before load", () => {
		expect(useLocaleStore.getState().locale).toBe("en");
		expect(useLocaleStore.getState().t("settings.general")).toBe("General");
		expect(document.documentElement.lang).toBe("en");
	});

	it("loads persisted locale from the main process", async () => {
		getUiSettings.mockResolvedValue({ locale: "zh-CN" });
		await useLocaleStore.getState().load();
		expect(useLocaleStore.getState().locale).toBe("zh-CN");
		expect(useLocaleStore.getState().t("settings.general")).toBe("通用");
		expect(document.documentElement.lang).toBe("zh-CN");
		expect(useLocaleStore.getState().loaded).toBe(true);
	});

	it("persists locale changes and updates document lang", async () => {
		await useLocaleStore.getState().setLocale("zh-CN");
		expect(setUiSettings).toHaveBeenCalledWith({ locale: "zh-CN" });
		expect(useLocaleStore.getState().locale).toBe("zh-CN");
		expect(document.documentElement.lang).toBe("zh-CN");
		expect(useLocaleStore.getState().t("settings.language")).toBe("语言");
	});

	it("does not reload after the first successful load", async () => {
		await useLocaleStore.getState().load();
		await useLocaleStore.getState().load();
		expect(getUiSettings).toHaveBeenCalledTimes(1);
	});
});
