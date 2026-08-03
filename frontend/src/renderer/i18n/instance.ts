import { createInstance, type i18n } from "i18next";
import { initReactI18next } from "react-i18next";
import { APP_LOCALES, DEFAULT_LOCALE, type AppLocale } from "./locales";
import { enMessages, zhCNMessages } from "./messages";

export type TranslationCatalogs = Record<AppLocale, Readonly<Record<string, string>>>;

export const appCatalogs: TranslationCatalogs = {
	en: enMessages,
	"zh-CN": zhCNMessages,
};

/** Create an isolated, synchronously initialized instance for app startup and unit tests. */
export function createAppI18n(locale: AppLocale = DEFAULT_LOCALE, catalogs: TranslationCatalogs = appCatalogs): i18n {
	return initializeI18n(createInstance(), locale, catalogs);
}

function initializeI18n(instance: i18n, locale: AppLocale, catalogs: TranslationCatalogs): i18n {
	void instance.init({
		lng: locale,
		fallbackLng: DEFAULT_LOCALE,
		supportedLngs: [...APP_LOCALES],
		load: "currentOnly",
		resources: {
			en: { translation: catalogs.en },
			"zh-CN": { translation: catalogs["zh-CN"] },
		},
		defaultNS: "translation",
		keySeparator: false,
		nsSeparator: false,
		returnNull: false,
		initAsync: false,
		interpolation: { escapeValue: false },
	});
	return instance;
}

export const appI18n = initializeI18n(createInstance().use(initReactI18next), DEFAULT_LOCALE, appCatalogs);
