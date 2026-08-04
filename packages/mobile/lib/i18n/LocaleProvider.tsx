import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { loadLocalePreference, saveLocalePreference } from "./localeStore";
import { createT, type TFunction } from "./translate";
import { deviceLocaleTag, matchDeviceLocale, type AppLocale } from "./ui-locale";

type LocaleState = {
	locale: AppLocale;
	setLocale: (locale: AppLocale) => void;
	t: TFunction;
};

const LocaleContext = createContext<LocaleState | null>(null);

export function useLocale(): LocaleState {
	const ctx = useContext(LocaleContext);
	if (!ctx) throw new Error("useLocale must be used within <LocaleProvider>");
	return ctx;
}

/** Shorthand for the active translator; re-renders when the locale changes. */
export function useT(): TFunction {
	return useLocale().t;
}

function initialLocale(): AppLocale {
	return matchDeviceLocale(deviceLocaleTag());
}

export function LocaleProvider({ children }: { children: ReactNode }) {
	const [locale, setLocaleState] = useState<AppLocale>(initialLocale);

	// Stored override arrives a tick after mount. Until then we use the device
	// match so a Chinese phone already shows zh-CN without a flash of English.
	useEffect(() => {
		let active = true;
		loadLocalePreference().then((stored) => {
			if (active && stored) setLocaleState(stored);
		});
		return () => {
			active = false;
		};
	}, []);

	const setLocale = useCallback((next: AppLocale) => {
		setLocaleState(next);
		void saveLocalePreference(next);
	}, []);

	const t = useMemo(() => createT(locale), [locale]);

	const value = useMemo<LocaleState>(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

	return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}
