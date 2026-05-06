/**
 * Brand logo component for docs pages.
 *
 * Renders real brand assets from /public/docs/logos/ when available, with
 * name-aliasing. Mono brand SVGs are pre-processed to use white fill for the
 * dark theme. Falls back to a monogram badge for anything not in the set.
 */
import type { CSSProperties } from "react";

/** Aliases: request name -> filename under /docs/logos/. */
const ALIASES: Record<string, string> = {
  claude: "claude-code",
  chatgpt: "openai",
};

/** Extension for each logo file. Defaults to svg; override for raster assets. */
const LOGO_EXT: Record<string, string> = {
  aider: "png",
};

/** Brands with a real asset file under /public/docs/logos/. */
const FILE_LOGOS = new Set([
  "aider",
  "anthropic",
  "apple",
  "claude-code",
  "codex",
  "composio",
  "cursor",
  "discord",
  "docker",
  "github",
  "gitlab",
  "iterm2",
  "linear",
  "linux",
  "microsoft",
  "openai",
  "openclaw",
  "opencode",
  "slack",
  "tmux",
  "web",
  "webhook",
  "windows",
]);

export interface LogoProps {
  /** Brand name (case-insensitive). */
  name: string;
  /** Size in pixels. Default 20. */
  size?: number;
  className?: string;
  /** Accepted for backwards compat with existing MDX; no-op. */
  color?: boolean;
}

export function Logo({ name, size = 20, className }: LogoProps) {
  const key = name.toLowerCase();
  const resolved = ALIASES[key] ?? key;
  const baseStyle: CSSProperties = { flexShrink: 0, width: size, height: size };

  if (FILE_LOGOS.has(resolved)) {
    const ext = LOGO_EXT[resolved] ?? "svg";
    return (
      <img
        src={`/docs/logos/${resolved}.${ext}`}
        alt=""
        aria-hidden="true"
        className={className}
        style={baseStyle}
        width={size}
        height={size}
      />
    );
  }

  const initial = name.charAt(0).toUpperCase();
  return (
    <span
      className={className}
      style={{
        ...baseStyle,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: size * 0.22,
        backgroundColor: "var(--color-bg-elevated, #2a2827)",
        color: "#ffffff",
        fontSize: size * 0.55,
        fontWeight: 700,
        lineHeight: 1,
        fontFamily: "var(--font-geist-sans), ui-sans-serif, system-ui",
      }}
      aria-hidden="true"
    >
      {initial}
    </span>
  );
}
