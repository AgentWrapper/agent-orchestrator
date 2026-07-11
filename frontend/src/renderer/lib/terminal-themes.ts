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
		black: cssVar("--color-bg-terminal"),
		red: cssVar("--color-danger"),
		green: cssVar("--color-success"),
		yellow: cssVar("--color-warning"),
		blue: cssVar("--color-accent"),
		magenta: cssVar("--color-purple"),
		cyan: cssVar("--color-term-cyan"),
		white: cssVar("--color-text-terminal"),
		brightBlack: cssVar("--color-text-terminal-dim"),
		brightRed: cssVar("--color-term-bright-red"),
		brightGreen: cssVar("--color-term-bright-green"),
		brightYellow: cssVar("--color-term-bright-yellow"),
		brightBlue: cssVar("--color-term-bright-blue"),
		brightMagenta: cssVar("--color-term-bright-magenta"),
		brightCyan: cssVar("--color-term-bright-cyan"),
		brightWhite: cssVar("--color-text-primary"),
	};

	const light: ITheme = {
		background: cssVar("--color-bg-terminal"),
		foreground: cssVar("--color-text-terminal"),
		cursor: cssVar("--color-working"),
		cursorAccent: cssVar("--color-bg-terminal"),
		selectionBackground: cssVar("--color-term-selection-light"),
		selectionInactiveBackground: cssVar("--color-term-selection-inactive-light"),
		black: cssVar("--color-text-terminal"),
		red: cssVar("--color-term-red-light"),
		green: cssVar("--color-success"),
		yellow: cssVar("--color-warning"),
		blue: cssVar("--color-accent"),
		magenta: cssVar("--color-term-magenta-light"),
		cyan: cssVar("--color-term-cyan-light"),
		white: cssVar("--color-term-white-light"),
		brightBlack: cssVar("--color-term-bright-black-light"),
		brightRed: cssVar("--color-term-bright-red-light"),
		brightGreen: cssVar("--color-term-bright-green-light"),
		brightYellow: cssVar("--color-term-bright-yellow-light"),
		brightBlue: cssVar("--color-term-bright-blue-light"),
		brightMagenta: cssVar("--color-term-bright-magenta-light"),
		brightCyan: cssVar("--color-term-bright-cyan-light"),
		brightWhite: cssVar("--color-term-bright-black-light"),
	};

	return { dark, light };
}
