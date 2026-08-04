/** Canonical locale metadata shared across the Electron main, preload, and renderer boundaries. */
export const APP_LOCALE_LABEL_KEYS = {
	en: "settings.language.en",
	"zh-CN": "settings.language.zhCN",
	ja: "settings.language.ja",
	ko: "settings.language.ko",
	es: "settings.language.es",
	fr: "settings.language.fr",
	de: "settings.language.de",
	"pt-BR": "settings.language.ptBR",
} as const;

export type AppLocale = keyof typeof APP_LOCALE_LABEL_KEYS;

export const APP_LOCALES = Object.keys(APP_LOCALE_LABEL_KEYS) as readonly AppLocale[];

export const DEFAULT_LOCALE = "en" satisfies AppLocale;

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
