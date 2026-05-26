import type { ITheme } from "@xterm/xterm";

export type TerminalVariant = "agent" | "orchestrator";

export function buildTerminalThemes(_variant: TerminalVariant): { dark: ITheme; light: ITheme } {
  // Orchestrator and agent currently share the design-system accent; the
  // variant parameter is preserved for API compatibility and future divergence.
  const accent = {
    cursorDark: "#818cf8",
    cursorLight: "#6366f1",
    selDark: "rgba(129, 140, 248, 0.30)",
    selLight: "rgba(99, 102, 241, 0.22)",
  };

  const dark: ITheme = {
    background: "#0a0a0b",
    foreground: "#e4e4e7",
    cursor: accent.cursorDark,
    cursorAccent: "#0a0a0b",
    selectionBackground: accent.selDark,
    selectionInactiveBackground: "rgba(255, 255, 255, 0.12)",
    // Full ANSI palette (program output stays conventionally colored); only
    // neutrals + blue are aligned to the app's neutral/indigo system.
    black: "#18181b",
    red: "#ef4444",
    green: "#22c55e",
    yellow: "#f59e0b",
    blue: "#818cf8",
    magenta: "#a371f7",
    cyan: "#22d3ee",
    white: "#d4d4d8",
    brightBlack: "#52525b",
    brightRed: "#f87171",
    brightGreen: "#4ade80",
    brightYellow: "#fbbf24",
    brightBlue: "#a5b4fc",
    brightMagenta: "#c084fc",
    brightCyan: "#67e8f9",
    brightWhite: "#f4f4f5",
  };

  const light: ITheme = {
    background: "#fafafa",
    foreground: "#24292f",
    cursor: accent.cursorLight,
    cursorAccent: "#fafafa",
    selectionBackground: accent.selLight,
    selectionInactiveBackground: "rgba(128, 128, 128, 0.15)",
    // ANSI colors — darkened for legibility on #fafafa terminal background
    black: "#24292f",
    red: "#b42318",
    green: "#1f7a3d",
    yellow: "#8a5a00",
    blue: "#4f46e5",
    magenta: "#8e24aa",
    cyan: "#0b7285",
    white: "#4b5563",
    brightBlack: "#374151",
    brightRed: "#912018",
    brightGreen: "#176639",
    brightYellow: "#6f4a00",
    brightBlue: "#1d4ed8",
    brightMagenta: "#7b1fa2",
    brightCyan: "#155e75",
    brightWhite: "#374151",
  };

  return { dark, light };
}
