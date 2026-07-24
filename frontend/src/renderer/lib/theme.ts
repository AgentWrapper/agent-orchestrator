export type Theme = "light" | "dark";
export type ThemePreference = Theme | "system";

export const themeStorageKey = "ao.theme";

function getLocalStorage() {
	if (typeof window === "undefined" || !window.localStorage) return null;
	return window.localStorage;
}

export function systemTheme(): Theme {
	if (typeof window === "undefined") return "dark";
	return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function readStoredThemePreference(): ThemePreference {
	try {
		const stored = getLocalStorage()?.getItem(themeStorageKey);
		if (stored === "light" || stored === "dark" || stored === "system") return stored;
	} catch {
		// ignore
	}
	return "system";
}

/** Resolve the active light/dark appearance from a stored preference. */
export function resolveTheme(preference: ThemePreference = readStoredThemePreference()): Theme {
	if (preference === "system") return systemTheme();
	return preference;
}

export function applyDocumentTheme(theme: Theme): void {
	if (typeof document === "undefined") return;
	document.documentElement.dataset.theme = theme;
	document.documentElement.style.colorScheme = theme;
}
