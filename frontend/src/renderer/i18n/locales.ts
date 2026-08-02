/** Supported UI locales. Default is always English unless the user chooses otherwise. */
export type AppLocale = "en" | "zh-CN";

export const DEFAULT_LOCALE: AppLocale = "en";

export const APP_LOCALES: readonly AppLocale[] = ["en", "zh-CN"] as const;

/** Coerce unknown stored values to a supported locale; corrupt/unknown → en. */
export function coerceLocale(raw: unknown): AppLocale {
	if (raw === "zh-CN") return "zh-CN";
	if (raw === "en") return "en";
	return DEFAULT_LOCALE;
}

/** Value for `document.documentElement.lang`. */
export function documentLang(locale: AppLocale): string {
	return locale;
}
