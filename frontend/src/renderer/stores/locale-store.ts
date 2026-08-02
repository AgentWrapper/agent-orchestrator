import { create } from "zustand";
import { aoBridge } from "../lib/bridge";
import {
	DEFAULT_LOCALE,
	documentLang,
	t as translate,
	type AppLocale,
	type MessageKey,
	type TVars,
} from "../i18n";

type LocaleState = {
	locale: AppLocale;
	loaded: boolean;
	load: () => Promise<void>;
	setLocale: (locale: AppLocale) => Promise<void>;
	/** Bound translator for the current locale (re-renders when locale changes). */
	t: (key: MessageKey, vars?: TVars) => string;
};

function applyDocumentLang(locale: AppLocale): void {
	if (typeof document === "undefined") return;
	document.documentElement.lang = documentLang(locale);
}

function boundT(locale: AppLocale): LocaleState["t"] {
	return (key, vars) => translate(locale, key, vars);
}

// Apply default lang early so the document attribute is correct before hydrate.
applyDocumentLang(DEFAULT_LOCALE);

export const useLocaleStore = create<LocaleState>((set, get) => ({
	locale: DEFAULT_LOCALE,
	loaded: false,
	t: boundT(DEFAULT_LOCALE),
	load: async () => {
		if (get().loaded) return;
		const settings = await aoBridge.uiSettings.get();
		const locale = settings.locale === "zh-CN" ? "zh-CN" : "en";
		applyDocumentLang(locale);
		set({ locale, loaded: true, t: boundT(locale) });
	},
	setLocale: async (candidate) => {
		const locale = candidate === "zh-CN" ? "zh-CN" : "en";
		await aoBridge.uiSettings.set({ locale });
		applyDocumentLang(locale);
		set({ locale, loaded: true, t: boundT(locale) });
	},
}));

/** Hook: re-render when locale changes and get a stable-enough t for JSX. */
export function useT(): LocaleState["t"] {
	return useLocaleStore((state) => state.t);
}

export function useLocale(): AppLocale {
	return useLocaleStore((state) => state.locale);
}

/** Non-React access for pure presentation helpers; defaults to en before hydrate. */
export function activeLocale(): AppLocale {
	return useLocaleStore.getState().locale;
}
