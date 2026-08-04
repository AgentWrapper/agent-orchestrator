import { createInstance, type i18n } from "i18next";
import { initReactI18next } from "react-i18next";
import { APP_LOCALES, DEFAULT_LOCALE, type AppLocale } from "./locales";
import { enMessages, loadCatalog, type LoadedMessageCatalog } from "./messages";

export type TranslationCatalogs = Partial<Record<AppLocale, LoadedMessageCatalog>>;

const initialCatalogs: TranslationCatalogs = { en: enMessages };

/** Create an isolated, synchronously initialized instance for app startup and unit tests. */
export function createAppI18n(locale: AppLocale = DEFAULT_LOCALE, catalogs: TranslationCatalogs = initialCatalogs): i18n {
	return initializeI18n(createInstance(), locale, catalogs);
}

function initializeI18n(instance: i18n, locale: AppLocale, catalogs: TranslationCatalogs): i18n {
	const resources = Object.fromEntries(
		Object.entries(catalogs).map(([lng, catalog]) => [lng, { translation: catalog }]),
	);
	void instance.init({
		lng: locale,
		fallbackLng: DEFAULT_LOCALE,
		supportedLngs: [...APP_LOCALES],
		load: "currentOnly",
		resources,
		defaultNS: "translation",
		keySeparator: false,
		nsSeparator: false,
		returnNull: false,
		initAsync: false,
		interpolation: { escapeValue: false },
	});
	return instance;
}

export const appI18n = initializeI18n(createInstance().use(initReactI18next), DEFAULT_LOCALE, initialCatalogs);

/** Ensure the selected locale is registered before asking i18next to activate it. */
export async function prepareAppLocale(locale: AppLocale): Promise<void> {
	if (appI18n.hasResourceBundle(locale, "translation")) return;
	const catalog = await loadCatalog(locale);
	appI18n.addResourceBundle(locale, "translation", catalog, true, true);
}

/** Activate a locale through the catalog-loading boundary. */
export async function changeAppLocale(locale: AppLocale): Promise<void> {
	await prepareAppLocale(locale);
	await appI18n.changeLanguage(locale);
}
