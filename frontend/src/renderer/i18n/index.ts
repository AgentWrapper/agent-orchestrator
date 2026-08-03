export type { AppLocale } from "./locales";
export { APP_LOCALES, DEFAULT_LOCALE, coerceLocale, documentLang } from "./locales";
export type { MessageKey, MessageCatalog, PluralMessageKey } from "./messages";
export { enMessages, zhCNMessages, catalogFor } from "./messages";
export type { TranslationCatalogs } from "./instance";
export { appCatalogs, appI18n, createAppI18n } from "./instance";
