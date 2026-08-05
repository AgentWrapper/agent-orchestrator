/** UI locales supported across the Electron main, preload, and renderer boundaries. */
export const APP_LOCALES = ["en", "zh-CN", "ja", "ko", "es", "fr", "de", "pt-BR"] as const;

export type AppLocale = (typeof APP_LOCALES)[number];

export const DEFAULT_LOCALE: AppLocale = "en";

export interface UiSettings {
	locale: AppLocale;
}

export const DEFAULT_UI_SETTINGS: UiSettings = { locale: DEFAULT_LOCALE };

/** Normalize an unknown value to a supported UI locale. */
export function coerceLocale(raw: unknown): AppLocale {
	if (typeof raw === "string" && (APP_LOCALES as readonly string[]).includes(raw)) {
		return raw as AppLocale;
	}
	return DEFAULT_LOCALE;
}

/** Normalize unknown persisted or IPC data to the supported UI-settings schema. */
export function coerceUiSettings(raw: unknown): UiSettings {
	const locale =
		typeof raw === "object" && raw !== null ? coerceLocale((raw as Record<string, unknown>).locale) : DEFAULT_LOCALE;
	return { locale };
}
