import AsyncStorage from "@react-native-async-storage/async-storage";
import { DEFAULT_PREFERENCE, isThemePreference, THEME_KEY, type ThemePreference } from "./themePreference";

// Storage side of the theme preference. Split from themePreference.ts so the
// decision logic there stays free of React Native imports and unit-testable —
// the same split as onboarding.ts / onboardingStore.ts.
//
// The preference is not a secret, so AsyncStorage (plaintext app sandbox) is
// right; SecureStore is reserved for the connection password.

/** Never throws — a storage failure reads as the default. */
export async function loadThemePreference(): Promise<ThemePreference> {
	try {
		const raw = await AsyncStorage.getItem(THEME_KEY);
		return isThemePreference(raw) ? raw : DEFAULT_PREFERENCE;
	} catch {
		return DEFAULT_PREFERENCE;
	}
}

export async function saveThemePreference(preference: ThemePreference): Promise<void> {
	try {
		await AsyncStorage.setItem(THEME_KEY, preference);
	} catch {
		/* a lost preference only means the picker resets next launch */
	}
}
