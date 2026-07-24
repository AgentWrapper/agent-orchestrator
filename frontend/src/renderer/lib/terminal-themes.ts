import type { ITheme } from "@xterm/xterm";

/** Read a CSS custom property from :root (tokens.css). */
function cssVar(name: string): string {
	if (typeof document === "undefined") return "";
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** xterm palettes harmonized to tokens.css (--color-term-* / semantic colors). */
export function buildTerminalThemes(): { dark: ITheme; light: ITheme } {
	const dark: ITheme = {
		background: cssVar("--color-bg-terminal"),
		foreground: cssVar("--color-text-terminal"),
		cursor: cssVar("--color-working"),
		cursorAccent: cssVar("--color-bg-terminal"),
		selectionBackground: cssVar("--color-term-selection-dark"),
		selectionInactiveBackground: cssVar("--color-term-selection-inactive"),
		black: cssVar("--color-term-black"),
		red: cssVar("--color-term-red"),
		green: cssVar("--color-term-green"),
		yellow: cssVar("--color-term-yellow"),
		blue: cssVar("--color-term-blue"),
		magenta: cssVar("--color-term-magenta"),
		cyan: cssVar("--color-term-cyan"),
		white: cssVar("--color-term-white"),
		brightBlack: cssVar("--color-term-bright-black"),
		brightRed: cssVar("--color-term-bright-red"),
		brightGreen: cssVar("--color-term-bright-green"),
		brightYellow: cssVar("--color-term-bright-yellow"),
		brightBlue: cssVar("--color-term-bright-blue"),
		brightMagenta: cssVar("--color-term-bright-magenta"),
		brightCyan: cssVar("--color-term-bright-cyan"),
		brightWhite: cssVar("--color-term-bright-white"),
	};

	const light: ITheme = {
		background: cssVar("--color-bg-terminal"),
		foreground: cssVar("--color-text-terminal"),
		cursor: cssVar("--color-working"),
		cursorAccent: cssVar("--color-bg-terminal"),
		selectionBackground: cssVar("--color-term-selection-light"),
		selectionInactiveBackground: cssVar("--color-term-selection-inactive-light"),
		black: cssVar("--color-term-black"),
		red: cssVar("--color-term-red"),
		green: cssVar("--color-term-green"),
		yellow: cssVar("--color-term-yellow"),
		blue: cssVar("--color-term-blue"),
		magenta: cssVar("--color-term-magenta"),
		cyan: cssVar("--color-term-cyan"),
		white: cssVar("--color-term-white"),
		brightBlack: cssVar("--color-term-bright-black"),
		brightRed: cssVar("--color-term-bright-red"),
		brightGreen: cssVar("--color-term-bright-green"),
		brightYellow: cssVar("--color-term-bright-yellow"),
		brightBlue: cssVar("--color-term-bright-blue"),
		brightMagenta: cssVar("--color-term-bright-magenta"),
		brightCyan: cssVar("--color-term-bright-cyan"),
		brightWhite: cssVar("--color-term-bright-white"),
	};

	return { dark, light };
}
