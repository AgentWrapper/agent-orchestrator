import type { AppLocale } from "./locales";
import { DEFAULT_LOCALE } from "./locales";
import { enMessages, zhCNMessages, type MessageKey } from "./messages";

export type TVars = Record<string, string | number>;

type CatalogPair = {
	en: Readonly<Record<string, string>>;
	"zh-CN": Readonly<Record<string, string>>;
};

const appCatalogs: CatalogPair = {
	en: enMessages,
	"zh-CN": zhCNMessages,
};

function interpolate(message: string, vars?: TVars): string {
	if (!vars) return message;
	return message.replace(/\{(\w+)\}/g, (match, name: string) => {
		const value = vars[name];
		return value === undefined ? match : String(value);
	});
}

/**
 * Resolve a message against an explicit catalog pair (exported for unit tests).
 * Missing zh-CN → English → key id.
 */
export function resolveMessage(
	locale: AppLocale,
	key: string,
	catalogs: CatalogPair = appCatalogs,
	vars?: TVars,
): string {
	const primary = catalogs[locale]?.[key];
	const fallback = catalogs.en[key];
	return interpolate(primary ?? fallback ?? key, vars);
}

/**
 * Resolve a message for the active locale.
 * Missing zh-CN entries fall back to English; missing English falls back to the key id.
 * Simple `{name}` interpolation only — no ICU/plurals in this layer.
 */
export function t(locale: AppLocale, key: MessageKey, vars?: TVars): string {
	return resolveMessage(locale, key, appCatalogs, vars);
}

/** Convenience when locale is not yet loaded (always English). */
export function tEn(key: MessageKey, vars?: TVars): string {
	return t(DEFAULT_LOCALE, key, vars);
}
