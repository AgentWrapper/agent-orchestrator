import AsyncStorage from "@react-native-async-storage/async-storage";
import { coerceLocale, LOCALE_KEY, type AppLocale } from "./ui-locale";

/**
 * Load a user override. Returns `null` when nothing is stored so the caller can
 * fall back to the device locale — same split as themeStore / themePreference.
 */
export async function loadLocalePreference(): Promise<AppLocale | null> {
	try {
		const raw = await AsyncStorage.getItem(LOCALE_KEY);
		if (raw == null) return null;
		return coerceLocale(raw);
	} catch {
		return null;
	}
}

export async function saveLocalePreference(locale: AppLocale): Promise<void> {
	try {
		await AsyncStorage.setItem(LOCALE_KEY, locale);
	} catch {
		/* a lost preference only means the picker resets next launch */
	}
}
