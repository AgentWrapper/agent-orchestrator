import { catalogs } from "./messages";
import { DEFAULT_LOCALE, type AppLocale } from "./ui-locale";
import type { MessageKey } from "./locales/en";

export type TranslateParams = Record<string, string | number>;

/** Lookup + simple `{{param}}` interpolation. Falls back to English, then the key. */
export type TFunction = (key: MessageKey, params?: TranslateParams) => string;

export function interpolate(template: string, params?: TranslateParams): string {
	if (!params) return template;
	return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
		const v = params[name];
		return v === undefined || v === null ? "" : String(v);
	});
}

export function translate(locale: AppLocale, key: MessageKey, params?: TranslateParams): string {
	const primary = catalogs[locale]?.[key];
	const fallback = catalogs[DEFAULT_LOCALE]?.[key];
	const raw = primary ?? fallback ?? key;
	return interpolate(raw, params);
}

export function createT(locale: AppLocale): TFunction {
	return (key, params) => translate(locale, key, params);
}

/** Default English translator for pure helpers and unit tests. */
export const enT: TFunction = createT(DEFAULT_LOCALE);
