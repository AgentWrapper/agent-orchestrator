import en from "./en.json";
import zhCN from "./zh-CN.json";
import type { AppLocale } from "./locales";

/** English is the source-of-truth catalog; keys are typed from it. */
export const enMessages = en;
export const zhCNMessages = zhCN;

export type MessageKey = keyof typeof enMessages;

type PluralCategory = "zero" | "one" | "two" | "few" | "many" | "other";
export type PluralMessageKey = MessageKey extends infer Key extends string
	? Key extends `${infer Base}_${PluralCategory}`
		? Base
		: never
	: never;

export type MessageCatalog = Record<MessageKey, string>;

const catalogs: Record<AppLocale, Readonly<Record<string, string>>> = {
	en: enMessages,
	"zh-CN": zhCNMessages,
};

export function catalogFor(locale: AppLocale): Readonly<Record<string, string>> {
	return catalogs[locale] ?? catalogs.en;
}
