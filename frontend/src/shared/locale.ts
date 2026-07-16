export const localePreferences = ["system", "en", "zh-CN"] as const;

export type LocalePreference = (typeof localePreferences)[number];
export type SupportedLocale = "en" | "zh-CN";
export type LocaleSnapshot = {
	preference: LocalePreference;
	effectiveLocale: SupportedLocale;
	systemLocale: SupportedLocale;
};

export function coerceLocalePreference(raw: unknown): LocalePreference {
	return localePreferences.includes(raw as LocalePreference) ? (raw as LocalePreference) : "system";
}

export function resolveSupportedLocale(raw: string | undefined): SupportedLocale {
	return (raw ?? "").toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export function resolveLocaleSnapshot(raw: unknown, osLocale: string): LocaleSnapshot {
	const preference = coerceLocalePreference(raw);
	const systemLocale = resolveSupportedLocale(osLocale);
	return {
		preference,
		systemLocale,
		effectiveLocale: preference === "system" ? systemLocale : preference,
	};
}
