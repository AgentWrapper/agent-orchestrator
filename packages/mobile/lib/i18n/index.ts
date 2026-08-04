export {
	APP_LOCALES,
	DEFAULT_LOCALE,
	LOCALE_KEY,
	LOCALE_NATIVE_LABELS,
	coerceLocale,
	deviceLocaleTag,
	matchDeviceLocale,
	type AppLocale,
} from "./ui-locale";
export { catalogs, assertCatalogCoverage, type MessageCatalog, type MessageKey } from "./messages";
export {
	createT,
	enT,
	interpolate,
	resolvePluralKey,
	translate,
	type PluralMessageKey,
	type TFunction,
	type TranslateKey,
	type TranslateParams,
} from "./translate";
export { loadLocalePreference, saveLocalePreference } from "./localeStore";
export { LocaleProvider, useLocale, useT } from "./LocaleProvider";
