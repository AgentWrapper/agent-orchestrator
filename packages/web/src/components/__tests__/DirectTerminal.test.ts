import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { buildTerminalThemes, resolveMonoFontFamily } from "@/components/DirectTerminal";

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const ANSI_KEYS = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;

function hexToRgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function toLinear(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : Math.pow((normalized + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrastRatio(a: string, b: string): number {
  const lighter = Math.max(relativeLuminance(a), relativeLuminance(b));
  const darker = Math.min(relativeLuminance(a), relativeLuminance(b));
  return (lighter + 0.05) / (darker + 0.05);
}

describe("buildTerminalThemes", () => {
  it("dark theme has valid hex colors for bg, fg, and all ANSI slots", () => {
    const { dark } = buildTerminalThemes("agent");
    expect(dark.background).toMatch(HEX_RE);
    expect(dark.foreground).toMatch(HEX_RE);
    for (const key of ANSI_KEYS) {
      expect(dark[key]).toMatch(HEX_RE);
    }
  });

  it("light theme has valid hex colors for bg, fg, and all ANSI slots", () => {
    const { light } = buildTerminalThemes("agent");
    expect(light.background).toBe("#fafafa");
    expect(light.foreground).toBe("#24292f");
    for (const key of ANSI_KEYS) {
      expect(light[key]).toMatch(HEX_RE);
    }
  });

  it("light theme ANSI colors maintain readable contrast on the terminal background", () => {
    const { light } = buildTerminalThemes("agent");
    for (const key of ANSI_KEYS) {
      expect(contrastRatio(light.background!, light[key]!)).toBeGreaterThanOrEqual(4);
    }
  });

  it("dark theme background is #0a0a0f", () => {
    const { dark } = buildTerminalThemes("agent");
    expect(dark.background).toBe("#0a0a0f");
  });

  it("orchestrator variant reuses the shared design-system accent", () => {
    const agent = buildTerminalThemes("agent");
    const orch = buildTerminalThemes("orchestrator");
    expect(agent.dark.cursor).toBe(orch.dark.cursor);
    expect(agent.light.cursor).toBe(orch.light.cursor);
    expect(agent.dark.selectionBackground).toBe(orch.dark.selectionBackground);
    expect(agent.light.selectionBackground).toBe(orch.light.selectionBackground);
  });

  it("keeps ANSI magenta distinct from ANSI blue", () => {
    const { dark, light } = buildTerminalThemes("agent");
    expect(dark.magenta).not.toBe(dark.blue);
    expect(dark.brightMagenta).not.toBe(dark.brightBlue);
    expect(light.magenta).not.toBe(light.blue);
    expect(light.brightMagenta).not.toBe(light.brightBlue);
  });

  it("selection colors differ between dark and light themes", () => {
    const { dark, light } = buildTerminalThemes("agent");
    expect(dark.selectionBackground).not.toBe(light.selectionBackground);
  });
});

describe("resolveMonoFontFamily", () => {
  const FALLBACK =
    '"JetBrains Mono", "SF Mono", Menlo, Monaco, "Courier New", monospace';

  beforeEach(() => {
    document.documentElement.style.removeProperty("--font-jetbrains-mono");
  });

  afterEach(() => {
    document.documentElement.style.removeProperty("--font-jetbrains-mono");
  });

  it("prepends the resolved CSS variable to the fallback stack", () => {
    document.documentElement.style.setProperty(
      "--font-jetbrains-mono",
      "__JetBrains_Mono_abc123",
    );
    const result = resolveMonoFontFamily();
    expect(result).toBe(`__JetBrains_Mono_abc123, ${FALLBACK}`);
  });

  it("returns the fallback stack when the CSS variable is not set", () => {
    expect(resolveMonoFontFamily()).toBe(FALLBACK);
  });

  it("never emits `var(...)` (would reintroduce the canvas-parse bug)", () => {
    document.documentElement.style.setProperty(
      "--font-jetbrains-mono",
      "__JetBrains_Mono_abc123",
    );
    expect(resolveMonoFontFamily()).not.toMatch(/var\(/);
  });
});
