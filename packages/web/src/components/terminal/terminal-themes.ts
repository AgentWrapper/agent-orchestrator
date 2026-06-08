import type { ITheme } from "@xterm/xterm";

export type TerminalVariant = "agent" | "orchestrator";

export function buildTerminalThemes(_variant: TerminalVariant): { dark: ITheme; light: ITheme } {
  // Mission-control terminal theme — the frame & xterm theme are ours; the PTY
  // content is the agent's own ANSI. The 16-color palette is harmonized to the
  // design tokens (xterm needs concrete hex, so these mirror globals.css). The
  // cursor is orange — the "an agent is alive" signal — and selection is blue.
  const accent = {
    cursor: "#f59f4c",
    selDark: "rgba(77, 141, 255, 0.30)",
    selLight: "rgba(77, 141, 255, 0.25)",
  };

  const dark: ITheme = {
    background: "#0c0d10", // --term
    foreground: "#c5ccd3",
    cursor: accent.cursor,
    cursorAccent: "#0c0d10",
    selectionBackground: accent.selDark,
    selectionInactiveBackground: "rgba(128, 128, 128, 0.2)",
    // ANSI palette tied to the mission-control tokens
    black: "#15171b", // --card
    red: "#ef6b6b", // --red
    green: "#74b98a", // --green
    yellow: "#e8c14a", // --amber
    blue: "#4d8dff", // --blue
    magenta: "#a78bfa",
    cyan: "#6fb3c9",
    white: "#c5ccd3",
    brightBlack: "#444951", // --t4
    brightRed: "#ff8a8a",
    brightGreen: "#8fd6a6",
    brightYellow: "#f0d06b",
    brightBlue: "#7eaaff", // --blue-soft
    brightMagenta: "#c4b0fc",
    brightCyan: "#8fcfe0",
    brightWhite: "#f4f5f7", // --t1
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
