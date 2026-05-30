import localFont from "next/font/local";

/**
 * Self-hosted fonts for the mission-control design language.
 * No external font CDN — the .woff2 files live in this directory and are
 * served from our own origin via next/font/local.
 *
 *  - Schibsted Grotesk = the UI / product voice (chrome, never machine data).
 *  - JetBrains Mono     = the machine voice (branches, IDs, PR numbers, costs,
 *                         timestamps, terminal). Numbers use tabular-nums.
 *
 * Both are variable fonts (single file spanning the weight axis).
 */

export const schibstedGrotesk = localFont({
  src: "./SchibstedGrotesk.woff2",
  variable: "--font-schibsted-grotesk",
  weight: "400 700",
  display: "swap",
  fallback: ["SF Pro Text", "-apple-system", "system-ui", "sans-serif"],
});

export const jetbrainsMono = localFont({
  src: "./JetBrainsMono.woff2",
  variable: "--font-jetbrains-mono",
  weight: "400 600",
  display: "swap",
  fallback: ["SF Mono", "Menlo", "Consolas", "monospace"],
});
