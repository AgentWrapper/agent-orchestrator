import { catalogs } from "./messages";
import { DEFAULT_LOCALE, type AppLocale } from "./ui-locale";
import type { MessageKey } from "./locales/en";

export type TranslateParams = Record<string, string | number>;

/**
 * Plural base keys. Catalogs store `${base}_one` / `${base}_other` (and later
 * `_few` / `_many` for locales that need them). Call sites pass the base +
 * `{ count }` and `translate` picks the CLDR category via Intl.PluralRules.
 */
export type PluralMessageKey =
	| "common.archiveCount"
	| "common.workers"
	| "common.files"
	| "common.sessions"
	| "common.connectedSessions";

/** Lookup key: a concrete message, or a plural base resolved via `count`. */
export type TranslateKey = MessageKey | PluralMessageKey;

/** Lookup + simple `{{param}}` interpolation. Falls back to English, then the key. */
export type TFunction = (key: TranslateKey, params?: TranslateParams) => string;

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

const pluralRulesCache = new Map<string, Intl.PluralRules>();

function pluralRulesFor(locale: AppLocale): Intl.PluralRules {
	let rules = pluralRulesCache.get(locale);
	if (!rules) {
		// App locale codes (zh-CN, pt-BR) are valid BCP-47 tags for PluralRules.
		rules = new Intl.PluralRules(locale);
		pluralRulesCache.set(locale, rules);
	}
	return rules;
}

/** Resolve a plural base (or already-suffixed key) to the right catalog key. */
export function resolvePluralKey(locale: AppLocale, key: string, count: number): string {
	const base = key.replace(PLURAL_SUFFIX, "");
	const category = pluralRulesFor(locale).select(count);
	const preferred = `${base}_${category}`;
	const other = `${base}_other`;
	const primary = catalogs[locale];
	const fallback = catalogs[DEFAULT_LOCALE];
	if (hasMessage(primary, preferred) || hasMessage(fallback, preferred)) return preferred;
	if (hasMessage(primary, other) || hasMessage(fallback, other)) return other;
	return key;
}

function hasMessage(cat: Record<string, string> | undefined, key: string): boolean {
	return typeof cat?.[key] === "string" && cat[key].length > 0;
}

export function interpolate(template: string, params?: TranslateParams): string {
	if (!params) return template;
	return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
		const v = params[name];
		return v === undefined || v === null ? "" : String(v);
	});
}

export function translate(locale: AppLocale, key: TranslateKey, params?: TranslateParams): string {
	let lookup: string = key;
	if (params && typeof params.count === "number" && Number.isFinite(params.count)) {
		lookup = resolvePluralKey(locale, key, params.count);
	}
	const primary = catalogs[locale]?.[lookup as MessageKey];
	const fallback = catalogs[DEFAULT_LOCALE]?.[lookup as MessageKey];
	const raw = primary ?? fallback ?? lookup;
	return interpolate(raw, params);
}

export function createT(locale: AppLocale): TFunction {
	return (key, params) => translate(locale, key, params);
}

/** Default English translator for pure helpers and unit tests. */
export const enT: TFunction = createT(DEFAULT_LOCALE);
