export const FONT_SIZE_KEY = "ao-terminal-font-size";
export const FONT_SIZE_MIN = 9;
export const FONT_SIZE_MAX = 18;
export const FONT_SIZE_DEFAULT = 13;

// Fallback mono stack used when the CSS custom property isn't resolvable yet.
const MONO_FONT_FALLBACK =
  '"JetBrains Mono", "SF Mono", Menlo, Monaco, "Courier New", monospace';

/**
 * Resolve the app's configured mono font token to a concrete font-family string.
 *
 * xterm's internal char-size measurement ultimately hits canvas ctx.font, which
 * cannot evaluate `var(...)`. Reading `--font-jetbrains-mono` with
 * getComputedStyle gives us the generated next/font family name (e.g.
 * `__JetBrains_Mono_abc123`), which we can safely feed into xterm while still
 * honouring the app's font configuration.
 *
 * NOTE: we deliberately read `--font-jetbrains-mono` and NOT `--font-mono`.
 * `--font-mono` in globals.css is itself a composed stack that contains
 * `var(--font-jetbrains-mono)` — if we forwarded that to xterm, the raw
 * `var(...)` token would end up back in canvas ctx.font and reintroduce the
 * original measurement bug this helper exists to fix.
 */
export function resolveMonoFontFamily(): string {
  if (typeof window === "undefined") return MONO_FONT_FALLBACK;
  try {
    const resolved = getComputedStyle(document.documentElement)
      .getPropertyValue("--font-jetbrains-mono")
      .trim();
    return resolved ? `${resolved}, ${MONO_FONT_FALLBACK}` : MONO_FONT_FALLBACK;
  } catch {
    return MONO_FONT_FALLBACK;
  }
}

export function getStoredFontSize(): number {
  if (typeof window === "undefined") return FONT_SIZE_DEFAULT;
  try {
    const stored = localStorage.getItem(FONT_SIZE_KEY);
    if (stored) {
      const size = parseInt(stored, 10);
      if (!Number.isNaN(size)) {
        return Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, size));
      }
    }
  } catch {
    // localStorage might be unavailable
  }
  return FONT_SIZE_DEFAULT;
}
