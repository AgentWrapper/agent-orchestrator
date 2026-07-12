/**
 * Tailwind v4 @theme bridge — maps utility keys to token CSS variables.
 */

import { kebab, layoutCssVarName } from "./css-utils";
import { animation, breakpoint, layoutIconKeys, layoutSpacingKeys, letterSpacing, radius, space } from "./primitives";

// ---------------------------------------------------------------------------
// @theme bridge — short names → semantic vars (avoids Tailwind :root collisions)
// ---------------------------------------------------------------------------

export const bridgeAlias = {
	border: "color-border",
	borderStrong: "color-border-strong",
	accent: "color-accent",
	accentFg: "color-accent-foreground",
	accentWeak: "color-accent-weak",
	accentDim: "color-accent-dim",
	working: "color-working",
	success: "color-success",
	warning: "color-warning",
	danger: "color-danger",
	interactiveHover: "color-interactive-hover",
	interactiveActive: "color-interactive-active",
	scrim: "color-scrim",
	previewMuted: "color-preview-muted",
	previewLink: "color-preview-link",
	previewHeading: "color-preview-heading",
	previewBody: "color-preview-body",
	previewCard: "color-preview-card-border",
	previewSuccess: "color-preview-success-bg",
	previewTile: "color-preview-tile-bg",
	previewTileBorder: "color-preview-tile-border",
	previewTerminal: "color-preview-terminal-bg",
	previewTerminalBorder: "color-preview-terminal-border",
	previewTerminalFg: "color-preview-terminal-fg",
} as const;

// ---------------------------------------------------------------------------
// Font aliases — convenience var() indirection for Tailwind @theme
// ---------------------------------------------------------------------------

export const fontAlias = {
	sans: "font-family-base",
	mono: "font-family-mono",
} as const;

// ---------------------------------------------------------------------------
// Theme var builders — derived from primitives (single source of truth)
// ---------------------------------------------------------------------------

function varRef(cssName: string): string {
	return `var(--${cssName})`;
}

function bridgeRef(bridgeKey: keyof typeof bridgeAlias): string {
	return varRef(`bridge-${kebab(bridgeKey)}`);
}

function tokenScaleThemeVars(prefix: string, cssPrefix: string, keys: readonly string[]): Record<string, string> {
	return Object.fromEntries(keys.map((key) => [`${prefix}-${kebab(key)}`, varRef(`${cssPrefix}-${kebab(key)}`)]));
}

function layoutSpacingThemeVars(): Record<string, string> {
	return Object.fromEntries(layoutSpacingKeys.map((key) => [`spacing-${kebab(key)}`, varRef(layoutCssVarName(key))]));
}

function layoutIconThemeVars(): Record<string, string> {
	return Object.fromEntries(
		layoutIconKeys.map((key) => {
			const cssName = layoutCssVarName(key);
			return [cssName, varRef(cssName)];
		}),
	);
}

/**
 * Tailwind class names that intentionally differ from `fontSize` keys.
 * - `text-micro` is the smallest UI label (maps to token `2xs`).
 * - `text-2xs` is one step up (maps to token `xs`).
 */
const DENSE_FONT_SIZE_CLASS_VARS = {
	"text-micro": "font-size-2xs",
	"text-2xs": "font-size-xs",
	"text-caption": "font-size-caption",
	"text-sm-md": "font-size-sm-md",
	"text-md-sm": "font-size-md-sm",
	"text-control": "font-size-base",
	"text-brand": "font-size-brand",
	"text-subtitle": "font-size-subtitle",
	"text-heading-sm": "font-size-heading-sm",
	"text-heading": "font-size-heading",
	"text-heading-lg": "font-size-heading-lg",
} as const;

/** Remap default Tailwind `text-*` steps onto the dense UI scale. */
const TAILWIND_FONT_SIZE_ALIGN_VARS = {
	"text-xs": "font-size-sm",
	"text-sm": "font-size-md",
	"text-base": "font-size-md",
} as const;

function fontSizeClassVars(map: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.entries(map).map(([className, cssName]) => [className, varRef(cssName)]));
}

/** shadcn / Tailwind semantic colors wired through `bridgeAlias`. */
const shadcnBridgeColorKeys = {
	"color-primary": "accent",
	"color-primary-foreground": "accentFg",
	"color-accent": "accent",
	"color-accent-foreground": "accentFg",
	"color-accent-weak": "accentWeak",
	"color-accent-dim": "accentDim",
	"color-ring": "accent",
	"color-border": "border",
	"color-border-strong": "borderStrong",
	"color-working": "working",
	"color-success": "success",
	"color-warning": "warning",
	"color-error": "danger",
	"color-destructive": "danger",
	"color-interactive-hover": "interactiveHover",
	"color-interactive-active": "interactiveActive",
	"color-input": "border",
	"color-scrim": "scrim",
} as const satisfies Record<string, keyof typeof bridgeAlias>;

/** Browser preview pane colors wired through `bridgeAlias`. */
const previewBridgeColorKeys = {
	"color-preview-muted": "previewMuted",
	"color-preview-link": "previewLink",
	"color-preview-heading": "previewHeading",
	"color-preview-body": "previewBody",
	"color-preview-card": "previewCard",
	"color-preview-success": "previewSuccess",
	"color-preview-tile": "previewTile",
	"color-preview-tile-border": "previewTileBorder",
	"color-preview-terminal": "previewTerminal",
	"color-preview-terminal-border": "previewTerminalBorder",
	"color-preview-terminal-foreground": "previewTerminalFg",
} as const satisfies Record<string, keyof typeof bridgeAlias>;

function bridgeColorThemeVars(map: Record<string, keyof typeof bridgeAlias>): Record<string, string> {
	return Object.fromEntries(Object.entries(map).map(([themeKey, bridgeKey]) => [themeKey, bridgeRef(bridgeKey)]));
}

// ---------------------------------------------------------------------------
// Tailwind @theme inline — maps utility keys to token var() references
// ---------------------------------------------------------------------------

export type TailwindThemeSection = {
	comment?: string;
	vars: Record<string, string>;
};

export const tailwindThemeSections: readonly TailwindThemeSection[] = [
	{
		vars: {
			"font-sans": varRef("font-family-base"),
			"font-mono": varRef("font-family-mono"),
		},
	},
	{
		comment: "Typography — align Tailwind text-* with token scale",
		vars: fontSizeClassVars(TAILWIND_FONT_SIZE_ALIGN_VARS),
	},
	{
		comment: "Typography — token-named half-steps (text-control = dense 13px chrome)",
		vars: fontSizeClassVars(DENSE_FONT_SIZE_CLASS_VARS),
	},
	{
		comment: "Radius — align Tailwind rounded-* with token scale",
		vars: tokenScaleThemeVars("radius", "radius", Object.keys(radius)),
	},
	{
		comment: "Breakpoints — for Tailwind max-* variants",
		vars: {
			"breakpoint-layout-narrow": breakpoint.layoutNarrow,
			"breakpoint-inspector-compact": breakpoint.inspectorCompact,
		},
	},
	{
		comment: "Spacing — align Tailwind p-*, gap-*, etc. with token scale",
		vars: Object.fromEntries(Object.keys(space).map((key) => [`spacing-${key}`, varRef(`space-${key}`)])),
	},
	{
		comment: "Z-index — z-chrome, z-titlebar, z-overlay",
		vars: {
			"z-index-chrome": varRef("z-chrome"),
			"z-index-titlebar": varRef("z-titlebar"),
			"z-index-overlay": varRef("z-overlay"),
		},
	},
	{
		comment: "Ring width — ring-focus for dense control focus rings",
		vars: {
			"ring-width-focus": varRef("ring-width-focus"),
		},
	},
	{
		comment: "Elevation — align Tailwind shadow-* with token scale",
		vars: tokenScaleThemeVars("shadow", "elevation", ["sm", "md", "lg", "xl"]),
	},
	{
		comment: "Surfaces",
		vars: {
			"color-background": varRef("color-bg-primary"),
			"color-foreground": varRef("color-text-primary"),
			"color-surface": varRef("color-bg-secondary"),
			"color-card": varRef("color-bg-secondary"),
			"color-card-foreground": varRef("color-text-primary"),
			"color-raised": varRef("color-bg-tertiary"),
			"color-overlay": varRef("color-bg-elevated"),
			"color-popover": varRef("color-bg-secondary"),
			"color-popover-foreground": varRef("color-text-primary"),
			"color-sidebar": varRef("color-bg-sidebar"),
			"color-sidebar-foreground": varRef("color-text-muted"),
			"color-sidebar-primary": bridgeRef("accent"),
			"color-sidebar-primary-foreground": bridgeRef("accentFg"),
			"color-sidebar-accent": varRef("color-bg-tertiary"),
			"color-sidebar-accent-foreground": varRef("color-text-primary"),
			"color-sidebar-border": bridgeRef("border"),
			"color-sidebar-ring": bridgeRef("accent"),
			"color-terminal": varRef("color-bg-terminal"),
			"color-terminal-foreground": varRef("color-text-terminal"),
			"color-terminal-dim": varRef("color-text-terminal-dim"),
		},
	},
	{
		comment: "Browser static preview (light mock inside dark app)",
		vars: {
			"color-preview": varRef("color-preview-bg"),
			"color-preview-foreground": varRef("color-preview-fg"),
			...bridgeColorThemeVars(previewBridgeColorKeys),
		},
	},
	{
		comment: "Icon chrome — size-icon-* utilities",
		vars: layoutIconThemeVars(),
	},
	{
		comment: "Typography — tracking & leading",
		vars: {
			...tokenScaleThemeVars("tracking", "tracking", Object.keys(letterSpacing)),
			"leading-snug": varRef("line-height-snug"),
			"leading-body": varRef("line-height-normal"),
			"leading-row": varRef("line-height-row"),
			"leading-body-md": varRef("line-height-body-md"),
			"leading-relaxed": varRef("line-height-relaxed"),
			"leading-loose": varRef("line-height-loose"),
			"font-weight-medium": varRef("font-weight-medium"),
			"font-weight-semibold": varRef("font-weight-semibold"),
			"duration-fast": varRef("duration-fast"),
			"duration-normal": varRef("duration-normal"),
		},
	},
	{
		comment: "Layout — toolbar offset for fixed sidebar below topbar",
		vars: layoutSpacingThemeVars(),
	},
	{
		vars: {
			"color-muted": varRef("color-bg-tertiary"),
			"color-muted-foreground": varRef("color-text-muted"),
			"color-passive": varRef("color-text-passive"),
			"color-secondary": varRef("color-bg-tertiary"),
			"color-secondary-foreground": varRef("color-text-muted"),
			"color-success-bright": varRef("color-success-bright"),
			"color-destructive-foreground": varRef("color-accent-foreground"),
			...bridgeColorThemeVars(shadcnBridgeColorKeys),
			"animate-status-pulse": animation.statusPulse,
			"animate-overlay-in": animation.overlayIn,
			"animate-modal-in": animation.modalIn,
		},
	},
];
