import { createInstance } from "i18next";
import { initReactI18next } from "react-i18next";

import { resources } from "../shared/i18n/resources";
import {
	resolveLocaleSnapshot,
	type LocaleSnapshot,
	type SupportedLocale,
} from "../shared/locale";

export const i18n = createInstance().use(initReactI18next);

export async function initializeRendererI18n(locale: SupportedLocale): Promise<void> {
	if (!i18n.isInitialized) {
		await i18n.init({
			resources,
			lng: locale,
			fallbackLng: "en",
			supportedLngs: ["en", "zh-CN"],
			interpolation: { escapeValue: false },
			returnNull: false,
			initAsync: false,
		});
		return;
	}

	await i18n.changeLanguage(locale);
}

export async function applyLocaleSnapshot(snapshot: LocaleSnapshot): Promise<void> {
	await initializeRendererI18n(snapshot.effectiveLocale);
	document.documentElement.lang = snapshot.effectiveLocale;
}

export function resolveNavigatorLocaleSnapshot(locale = navigator.language): LocaleSnapshot {
	return resolveLocaleSnapshot("system", locale);
}
