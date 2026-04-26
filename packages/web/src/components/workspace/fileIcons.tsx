"use client";

import type { ReactNode } from "react";

// Central file-type icon config. Add entries here to customize how a file
// extension renders in the tree. Colors reference CSS custom properties when
// possible so the dark theme stays consistent.

const ICON_SIZE = 13;

interface IconShape {
  node: ReactNode;
}

function labelBadge(label: string, bg: string, fg = "#0c0f14"): IconShape {
  return {
    node: (
      <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 16 16" aria-hidden="true">
        <rect x="1" y="2" width="14" height="12" rx="2" fill={bg} />
        <text
          x="8"
          y="11"
          textAnchor="middle"
          fontSize="7"
          fontWeight="800"
          fill={fg}
          fontFamily="ui-sans-serif, system-ui, sans-serif"
          letterSpacing="-0.02em"
        >
          {label}
        </text>
      </svg>
    ),
  };
}

const DEFAULT_FILE: IconShape = {
  node: (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="#6b7280"
        d="M4 1.5A1.5 1.5 0 0 1 5.5 0h4.379a1.5 1.5 0 0 1 1.06.44l2.121 2.12a1.5 1.5 0 0 1 .44 1.061V14.5A1.5 1.5 0 0 1 12 16H5.5A1.5 1.5 0 0 1 4 14.5v-13Z"
      />
      <path fill="#4b5563" d="M10 0.5v3a1 1 0 0 0 1 1h3L10 0.5Z" />
    </svg>
  ),
};

const FOLDER_CLOSED: IconShape = {
  node: (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="#dcb67a"
        d="M1.5 2A1.5 1.5 0 0 0 0 3.5v9A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5V5.5A1.5 1.5 0 0 0 14.5 4H8l-2-2H1.5Z"
      />
    </svg>
  ),
};

const FOLDER_OPEN: IconShape = {
  node: (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="#dcb67a"
        d="M1.5 2A1.5 1.5 0 0 0 0 3.5v9h1.5l2.6-7.2A1 1 0 0 1 5.05 4.8H16V5.5A1.5 1.5 0 0 0 14.5 4H8l-2-2H1.5Z"
      />
      <path fill="#b8935f" d="M4.05 6H16l-2.4 7a1 1 0 0 1-.94.67H1.5L4.05 6Z" />
    </svg>
  ),
};

// Keyed by lowercase extension (no leading dot). First match wins, so list
// more-specific extensions (e.g. tsx) before generic (ts).
const ICON_BY_EXT: Record<string, IconShape> = {
  // Markdown — VSCode uses a blue-ish note
  md: labelBadge("M↓", "#519aba"),
  mdx: labelBadge("M↓", "#519aba"),
  // TypeScript
  tsx: labelBadge("TS", "#3178c6"),
  ts: labelBadge("TS", "#3178c6"),
  // JavaScript
  jsx: labelBadge("JS", "#f1dd35"),
  js: labelBadge("JS", "#f1dd35"),
  mjs: labelBadge("JS", "#f1dd35"),
  cjs: labelBadge("JS", "#f1dd35"),
  // Kotlin
  kt: labelBadge("K", "#a97bff"),
  kts: labelBadge("K", "#a97bff"),
  // Java
  java: labelBadge("J", "#ea2d2e", "#ffffff"),
  // JSON
  json: labelBadge("{}", "#cbcb41"),
  jsonc: labelBadge("{}", "#cbcb41"),
  // YAML
  yaml: labelBadge("Y", "#cb4a4a", "#ffffff"),
  yml: labelBadge("Y", "#cb4a4a", "#ffffff"),
  // HTML / CSS
  html: labelBadge("◇", "#e44d26", "#ffffff"),
  css: labelBadge("◈", "#519aba", "#ffffff"),
  scss: labelBadge("◈", "#c6538c", "#ffffff"),
  // Python
  py: labelBadge("py", "#3572a5", "#ffffff"),
  // Rust
  rs: labelBadge("R", "#dea584"),
  // Go
  go: labelBadge("go", "#00add8", "#ffffff"),
  // Shell
  sh: labelBadge(">_", "#4eaa25", "#ffffff"),
  bash: labelBadge(">_", "#4eaa25", "#ffffff"),
  zsh: labelBadge(">_", "#4eaa25", "#ffffff"),
  // Docker
  dockerfile: labelBadge("D", "#0db7ed", "#ffffff"),
  // SQL
  sql: labelBadge("SQ", "#dad8d8"),
  // Lockfiles & config — dimmed
  lock: labelBadge("L", "#6b7280", "#ffffff"),
  toml: labelBadge("T", "#9c4221", "#ffffff"),
  // Images
  svg: labelBadge("◯", "#ffb13b"),
  png: labelBadge("img", "#8b5cf6", "#ffffff"),
  jpg: labelBadge("img", "#8b5cf6", "#ffffff"),
  jpeg: labelBadge("img", "#8b5cf6", "#ffffff"),
  gif: labelBadge("img", "#8b5cf6", "#ffffff"),
  webp: labelBadge("img", "#8b5cf6", "#ffffff"),
};

// Special full-filename matches (e.g. Dockerfile has no extension)
const ICON_BY_NAME: Record<string, IconShape> = {
  dockerfile: ICON_BY_EXT.dockerfile,
  makefile: labelBadge("M", "#427819", "#ffffff"),
  "package.json": labelBadge("pkg", "#cb3837", "#ffffff"),
  "tsconfig.json": labelBadge("TS", "#3178c6"),
  "pnpm-lock.yaml": ICON_BY_EXT.lock,
  ".gitignore": labelBadge("git", "#f14e32", "#ffffff"),
};

export function getFileIcon(fileName: string): ReactNode {
  const lower = fileName.toLowerCase();
  const named = ICON_BY_NAME[lower];
  if (named) return named.node;
  const dot = lower.lastIndexOf(".");
  if (dot > 0) {
    const ext = lower.slice(dot + 1);
    const byExt = ICON_BY_EXT[ext];
    if (byExt) return byExt.node;
  }
  return DEFAULT_FILE.node;
}

export function getFolderIcon(open: boolean): ReactNode {
  return open ? FOLDER_OPEN.node : FOLDER_CLOSED.node;
}
