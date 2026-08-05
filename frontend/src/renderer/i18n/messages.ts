import en from "./en.json";
import { DEFAULT_LOCALE, type AppLocale } from "./locales";

/** English is the source-of-truth catalog; keys are typed from it. */
export const enMessages = en;

export type MessageKey = keyof typeof enMessages;

type PluralCategory = "zero" | "one" | "two" | "few" | "many" | "other";
export type PluralMessageKey = MessageKey extends infer Key extends string
	? Key extends `${infer Base}_${PluralCategory}`
		? Base
		: never
	: never;

export type MessageCatalog = Record<MessageKey, string>;

export type LoadedMessageCatalog = Readonly<Record<string, string>>;
type DeferredLocale = Exclude<AppLocale, typeof DEFAULT_LOCALE>;
type CatalogLoader = () => Promise<LoadedMessageCatalog>;

const catalogLoaders = {
	"zh-CN": () => import("./zh-CN.json").then((module) => module.default),
	ja: () => import("./ja.json").then((module) => module.default),
	ko: () => import("./ko.json").then((module) => module.default),
	es: () => import("./es.json").then((module) => module.default),
	fr: () => import("./fr.json").then((module) => module.default),
	de: () => import("./de.json").then((module) => module.default),
	"pt-BR": () => import("./pt-BR.json").then((module) => module.default),
} satisfies Record<DeferredLocale, CatalogLoader>;

const pendingCatalogs: Partial<Record<DeferredLocale, Promise<LoadedMessageCatalog>>> = {};

/** Load one catalog on demand and share concurrent requests for the same locale. */
export function loadCatalog(locale: AppLocale): Promise<LoadedMessageCatalog> {
	if (locale === DEFAULT_LOCALE) return Promise.resolve(enMessages);
	const existing = pendingCatalogs[locale];
	if (existing) return existing;
	const loading = catalogLoaders[locale]().catch((error: unknown) => {
		delete pendingCatalogs[locale];
		throw error;
	});
	pendingCatalogs[locale] = loading;
	return loading;
}
