import type { ITheme } from "@xterm/xterm";

export type TerminalVariant = "agent" | "orchestrator";

export function buildTerminalThemes(_variant: TerminalVariant): { dark: ITheme; light: ITheme } {
  // Orchestrator and agent currently share the design-system accent; the
  // variant parameter is preserved for API compatibility and future divergence.
  const accent = {
    cursor: "#5b7ef8",
    selDark: "rgba(91, 126, 248, 0.30)",
    selLight: "rgba(91, 126, 248, 0.25)",
  };

  const dark: ITheme = {
    background: "#0a0a0f",
    foreground: "#d4d4d8",
    cursor: accent.cursor,
    cursorAccent: "#0a0a0f",
    selectionBackground: accent.selDark,
    selectionInactiveBackground: "rgba(128, 128, 128, 0.2)",
    // ANSI colors — slightly warmer than pure defaults
    black: "#1a1a24",
    red: "#ef4444",
    green: "#22c55e",
    yellow: "#f59e0b",
    blue: "#5b7ef8",
    magenta: "#a371f7",
    cyan: "#22d3ee",
    white: "#d4d4d8",
    brightBlack: "#50506a",
    brightRed: "#f87171",
    brightGreen: "#4ade80",
    brightYellow: "#fbbf24",
    brightBlue: "#7b9cfb",
    brightMagenta: "#c084fc",
    brightCyan: "#67e8f9",
    brightWhite: "#eeeef5",
  };

  const light: ITheme = {
    background: "#fafafa",
    foreground: "#24292f",
    cursor: accent.cursor,
    cursorAccent: "#fafafa",
    selectionBackground: accent.selLight,
    selectionInactiveBackground: "rgba(128, 128, 128, 0.15)",
    // ANSI colors — darkened for legibility on #fafafa terminal background
    black: "#24292f",
    red: "#b42318",
    green: "#1f7a3d",
    yellow: "#8a5a00",
    blue: "#175cd3",
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
