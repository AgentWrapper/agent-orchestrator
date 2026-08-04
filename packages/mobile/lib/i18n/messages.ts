import { de } from "./locales/de";
import { en, type MessageCatalog, type MessageKey } from "./locales/en";
import { es } from "./locales/es";
import { fr } from "./locales/fr";
import { ja } from "./locales/ja";
import { ko } from "./locales/ko";
import { ptBR } from "./locales/pt-BR";
import { zhCN } from "./locales/zh-CN";
import { APP_LOCALES, type AppLocale } from "./ui-locale";

export type { MessageCatalog, MessageKey };

export const catalogs: Record<AppLocale, MessageCatalog> = {
	en,
	"zh-CN": zhCN,
	ja,
	ko,
	es,
	fr,
	de,
	"pt-BR": ptBR,
};

/** Every supported locale has a full catalog with the same keys as English. */
export function assertCatalogCoverage(): void {
	const keys = Object.keys(en) as MessageKey[];
	for (const locale of APP_LOCALES) {
		const cat = catalogs[locale];
		for (const key of keys) {
			if (typeof cat[key] !== "string" || cat[key].length === 0) {
				throw new Error(`Missing ${locale}.${key}`);
			}
		}
	}
}
