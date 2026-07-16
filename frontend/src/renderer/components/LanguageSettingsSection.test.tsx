import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LocaleSnapshot } from "../../shared/locale";
import { i18n, initializeRendererI18n } from "../i18n";
import { LanguageSettingsSection } from "./LanguageSettingsSection";

const englishSnapshot: LocaleSnapshot = {
	preference: "en",
	effectiveLocale: "en",
	systemLocale: "en",
};

const chineseSnapshot: LocaleSnapshot = {
	preference: "zh-CN",
	effectiveLocale: "zh-CN",
	systemLocale: "en",
};

beforeEach(async () => {
	await initializeRendererI18n("en");
	document.documentElement.lang = "en";
	window.ao!.locale.get = vi.fn().mockResolvedValue(englishSnapshot);
	window.ao!.locale.set = vi.fn().mockResolvedValue(chineseSnapshot);
});

describe("LanguageSettingsSection", () => {
	it("offers System, English, and Simplified Chinese", async () => {
		render(<LanguageSettingsSection />);

		await userEvent.click(await screen.findByRole("combobox", { name: "Language" }));
		expect(screen.getByRole("option", { name: "System default" })).toBeInTheDocument();
		expect(screen.getByRole("option", { name: "English" })).toBeInTheDocument();
		expect(screen.getByRole("option", { name: "简体中文" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /save/i })).not.toBeInTheDocument();
	});

	it("persists the selection before applying it immediately", async () => {
		render(<LanguageSettingsSection />);

		await userEvent.click(await screen.findByRole("combobox", { name: "Language" }));
		await userEvent.click(screen.getByRole("option", { name: "简体中文" }));

		await waitFor(() => expect(window.ao!.locale.set).toHaveBeenCalledWith("zh-CN"));
		await waitFor(() => expect(i18n.resolvedLanguage).toBe("zh-CN"));
		expect(document.documentElement.lang).toBe("zh-CN");
	});

	it("disables the selector while saving and keeps the current language until persistence succeeds", async () => {
		let resolveSave: (snapshot: LocaleSnapshot) => void = () => undefined;
		window.ao!.locale.set = vi.fn(
			() =>
				new Promise<LocaleSnapshot>((resolve) => {
					resolveSave = resolve;
				}),
		);
		render(<LanguageSettingsSection />);
		const select = await screen.findByRole("combobox", { name: "Language" });

		await userEvent.click(select);
		await userEvent.click(screen.getByRole("option", { name: "简体中文" }));

		expect(select).toBeDisabled();
		expect(i18n.resolvedLanguage).toBe("en");
		await act(async () => resolveSave(chineseSnapshot));
		await waitFor(() => expect(select).toBeEnabled());
		expect(i18n.resolvedLanguage).toBe("zh-CN");
	});

	it("keeps the previous language when saving fails", async () => {
		window.ao!.locale.set = vi.fn().mockRejectedValue(new Error("disk"));
		render(<LanguageSettingsSection />);

		await userEvent.click(await screen.findByRole("combobox", { name: "Language" }));
		await userEvent.click(screen.getByRole("option", { name: "简体中文" }));

		expect(await screen.findByRole("alert")).toHaveTextContent("Could not save language");
		expect(screen.getByRole("alert")).not.toHaveTextContent("disk");
		expect(screen.getByRole("combobox", { name: "Language" })).toHaveTextContent("English");
		expect(i18n.resolvedLanguage).toBe("en");
	});

	it("shows the effective language when following the system", async () => {
		window.ao!.locale.get = vi.fn().mockResolvedValue({
			preference: "system",
			effectiveLocale: "zh-CN",
			systemLocale: "zh-CN",
		} satisfies LocaleSnapshot);

		render(<LanguageSettingsSection />);

		expect(await screen.findByText("Currently using 简体中文")).toBeInTheDocument();
	});
});
