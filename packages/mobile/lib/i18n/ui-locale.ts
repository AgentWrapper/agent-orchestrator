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
 *
 * Note: all `zh*` tags currently map to Simplified Chinese (zh-CN). Traditional
 * Chinese (zh-Hant / zh-TW / zh-HK) is not a separate catalog yet; falling back
 * to Simplified is a deliberate product choice until a zh-Hant catalog ships.
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

type LocaleTagReader = () => Array<{ languageTag?: string | null }> | undefined;

/** Default reader: expo-localization getLocales (lazy require for pure tests). */
function readExpoLocales(): Array<{ languageTag?: string | null }> | undefined {
	// Lazy require so vitest / pure unit tests can run without the native module.
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const Localization = require("expo-localization") as {
		getLocales?: () => Array<{ languageTag?: string | null }>;
	};
	return Localization.getLocales?.();
}

/**
 * Read the device language tag.
 *
 * Prefer `expo-localization` getLocales (preferredLanguages / device order) over
 * bare `Intl`. On iOS, Hermes' Intl is resolved against the app bundle's declared
 * localizations, so without CFBundleLocalizations it always returns en-US even
 * when the phone is set to Chinese. getLocales reads preferredLanguages directly.
 *
 * `readLocales` is injectable for unit tests; production call sites omit it.
 */
export function deviceLocaleTag(readLocales: LocaleTagReader = readExpoLocales): string {
	try {
		const tag = readLocales()?.[0]?.languageTag;
		if (tag) return tag;
	} catch {
		// Native module missing (tests, web without the polyfill) — fall through.
	}
	try {
		return Intl.DateTimeFormat().resolvedOptions().locale || "en";
	} catch {
		return "en";
	}
}
