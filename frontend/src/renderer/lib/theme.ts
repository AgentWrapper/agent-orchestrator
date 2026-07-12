export type Theme = "light" | "dark";

export const themeStorageKey = "ao.theme";

function getLocalStorage() {
	if (typeof window === "undefined" || !window.localStorage) return null;
	return window.localStorage;
}

export function systemTheme(): Theme {
	if (typeof window === "undefined") return "dark";
	return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function readStoredTheme(): Theme | null {
	try {
		const stored = getLocalStorage()?.getItem(themeStorageKey);
		return stored === "light" || stored === "dark" ? stored : null;
	} catch {
		return null;
	}
}

/** Stored preference, else OS appearance. */
export function resolveTheme(): Theme {
	return readStoredTheme() ?? systemTheme();
}

export function applyDocumentTheme(theme: Theme): void {
	if (typeof document === "undefined") return;
	document.documentElement.dataset.theme = theme;
	document.documentElement.style.colorScheme = theme;
}
