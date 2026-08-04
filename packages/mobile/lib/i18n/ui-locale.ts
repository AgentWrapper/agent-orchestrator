/** UI locales — same codes as desktop `frontend/src/shared/ui-locale.ts`. */
export const APP_LOCALES = ["en", "zh-CN", "ja", "ko", "es", "fr", "de", "pt-BR"] as const;

export type AppLocale = (typeof APP_LOCALES)[number];

export const DEFAULT_LOCALE: AppLocale = "en";

/** Native-script labels for the language picker (fixed; not translated). */
export const LOCALE_NATIVE_LABELS: Record<AppLocale, string> = {
	en: "English",
	"zh-CN": "简体中文",
	ja: "日本語",
	ko: "한국어",
	es: "Español",
	fr: "Français",
	de: "Deutsch",
	"pt-BR": "Português (Brasil)",
};

export const LOCALE_KEY = "ao.locale";

/** Normalize an unknown value to a supported UI locale. Exact codes only. */
export function coerceLocale(raw: unknown): AppLocale {
	if (typeof raw === "string" && (APP_LOCALES as readonly string[]).includes(raw)) {
		return raw as AppLocale;
	}
	return DEFAULT_LOCALE;
}

/**
 * Best-effort map from a BCP-47 / OS tag onto a supported app locale.
 * `zh*` → zh-CN, `pt*` → pt-BR, exact and primary-language matches for the rest.
 */
export function matchDeviceLocale(tag: string | null | undefined): AppLocale {
	if (!tag || typeof tag !== "string") return DEFAULT_LOCALE;
	const normalized = tag.trim().replace(/_/g, "-");
	if (!normalized) return DEFAULT_LOCALE;

	// Exact supported code (case-sensitive for region, e.g. zh-CN / pt-BR).
	if ((APP_LOCALES as readonly string[]).includes(normalized)) {
		return normalized as AppLocale;
	}

	// Case-insensitive exact (zh-cn → zh-CN).
	const lower = normalized.toLowerCase();
	for (const locale of APP_LOCALES) {
		if (locale.toLowerCase() === lower) return locale;
	}

	const primary = lower.split("-")[0] ?? "";
	switch (primary) {
		case "zh":
			return "zh-CN";
		case "ja":
			return "ja";
		case "ko":
			return "ko";
		case "es":
			return "es";
		case "fr":
			return "fr";
		case "de":
			return "de";
		case "pt":
			return "pt-BR";
		case "en":
			return "en";
		default:
			return DEFAULT_LOCALE;
	}
}

/** Read the device language tag without RN-specific APIs (Hermes/Intl). */
export function deviceLocaleTag(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().locale || "en";
	} catch {
		return "en";
	}
}
