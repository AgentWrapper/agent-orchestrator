/**
 * Design token primitives — values only (colors, type, space, layout, motion).
 * Regenerate CSS via `npm run tokens` → `design-system.generated.css`.
 *
 * Theme switching:
 *   - Default `:root`              → dark
 *   - `:root[data-theme="light"]`  → light (renderer Zustand toggle)
 *   - `:root.dark` / `.dark`       → alias for landing/docs (Fumadocs)
 */

import { isLayoutIconKey, layoutCssVarName, parsePx } from "./css-utils";

/** Stored / resolved app theme name. */
export type ThemeName = "dark" | "light";

// ---------------------------------------------------------------------------
// Typography — theme-independent
// ---------------------------------------------------------------------------

export const fontFamily = {
	base: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Fira Sans", "Helvetica Neue", sans-serif',
	mono: '"JetBrainsMono Nerd Font Mono", "JetBrainsMono Nerd Font", "FiraCode Nerd Font Mono", "FiraCode Nerd Font", "MesloLGS NF", "CaskaydiaCove Nerd Font Mono", "CaskaydiaCove Nerd Font", "Hack Nerd Font Mono", "Hack Nerd Font", "Symbols Nerd Font Mono", "Symbols Nerd Font", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
} as const;

/**
 * Dense UI chrome uses half-steps between base sizes.
 * Order is monotonic: `2xs` (10px) < `xs` (10.5px) < `caption` < … < `headingLg`.
 * `text-micro` / `text-2xs` class mapping lives in `tailwind-bridge.ts`.
 */
export const fontSize = {
	"2xs": "10px",
	xs: "10.5px",
	caption: "11px",
	smMd: "11.5px",
	sm: "12px",
	mdSm: "12.5px",
	base: "13px",
	md: "14px",
	brand: "14.5px",
	subtitle: "15px",
	terminalMax: "20px",
	headingSm: "17px",
	heading: "21px",
	headingLg: "22px",
} as const;

export const fontWeight = {
	medium: "500",
	semibold: "600",
} as const;

export const lineHeight = {
	normal: "1.5",
	snug: "1.42",
	row: "1.25rem",
	bodyMd: "1.55",
	relaxed: "1.6",
	loose: "1.7",
} as const;

export const letterSpacing = {
	tightXl: "-0.025em",
	tightLg: "-0.015em",
	tight: "-0.01em",
	wideXs: "0.04em",
	wideSm: "0.05em",
	wide: "0.06em",
	wideMd: "0.08em",
	wideLg: "0.09em",
	wideXl: "0.12em",
} as const;

// ---------------------------------------------------------------------------
// Motion — theme-independent
// ---------------------------------------------------------------------------

export const duration = {
	fast: "120ms",
	normal: "150ms",
	inspectorSplit: "0.2s",
} as const;

export const motionRecipe = {
	statusPulseDuration: "1.8s",
	statusPulseMinOpacity: "0.35",
	modalInScaleFrom: "0.95",
} as const;

export const animation = {
	statusPulse: `status-pulse ${motionRecipe.statusPulseDuration} ease-in-out infinite`,
	overlayIn: `overlay-in ${duration.normal} ease-out`,
	modalIn: `modal-in ${duration.normal} ease-out`,
} as const;

export const colorMix = {
	purpleSubtle: "12%",
	surfaceFaint: "35%",
} as const;

// ---------------------------------------------------------------------------
// Spacing — 4px base, theme-independent
// ---------------------------------------------------------------------------

export const space = {
	"0_5": "2px",
	"0_75": "3px",
	"1": "4px",
	"1_25": "5px",
	"1_5": "6px",
	"1_75": "7px",
	"2": "8px",
	"2_25": "9px",
	"2_5": "10px",
	"2_75": "11px",
	"3": "12px",
	"3_25": "13px",
	"3_5": "14px",
	"3_75": "15px",
	"4": "16px",
	"4_5": "18px",
	"5": "20px",
	"5_5": "22px",
	"6": "24px",
	"8": "32px",
	"10": "40px",
} as const;

// ---------------------------------------------------------------------------
// Z-index — stacking layers
// ---------------------------------------------------------------------------

export const zIndex = {
	chrome: "10",
	titlebar: "20",
	overlay: "50",
} as const;

// ---------------------------------------------------------------------------
// Radius
// ---------------------------------------------------------------------------

export const radius = {
	xs: "3px",
	sm: "4px",
	md: "6px",
	lg: "8px",
	panel: "13px",
	full: "999px",
} as const;

// ---------------------------------------------------------------------------
// Breakpoints — single source; @media / @custom-media cannot use var()
// ---------------------------------------------------------------------------

export const breakpoint = {
	layoutNarrow: "680px",
	inspectorCompact: "300px",
} as const;

/** Emitted as `@custom-media` in `design-system.generated.css` (not runtime-overridable). */
export const breakpointMedia = {
	layoutNarrow: `(width <= ${breakpoint.layoutNarrow})`,
	inspectorCompact: `(width <= ${breakpoint.inspectorCompact})`,
} as const;

// ---------------------------------------------------------------------------
// Layout — fixed chrome dimensions (not the spacing scale)
// ---------------------------------------------------------------------------

export const layout = {
	ringWidthFocus: "3px",
	hairline: "1px",
	icon2xs: "12px",
	iconXs: "9px",
	iconSm: "13px",
	iconMd: "14px",
	iconBase: "16px",
	iconLg: "15px",
	iconXl: "18px",
	dotSm: "7px",
	controlForm: "32px",
	controlXs: "20px",
	controlSm: "24px",
	controlMd: "28px",
	controlLg: "34px",
	controlXl: "38px",
	controlBoardSm: "30px",
	controlBoard: "36px",
	tableHead: "var(--space-10)",
	toolbar: "56px",
	inspectorTabs: "47px",
	rowMd: "52px",
	browserUrl: "29px",
	browserMin: "320px",
	sidebarIcon: "48px",
	sidebarDefault: "240px",
	sidebarMobile: "288px",
	titlebarClusterLeft: "79px",
	titlebarContentOffset: "180px",
	resizeHandle: "7px",
	resizeHandleOffset: "3px",
	kanbanGlow: "130px",
	kvLabel: "74px",
	notificationWidth: "380px",
	notificationMaxHeight: "420px",
	selectMenuMax: "320px",
	notificationIcon: "26px",
	fontSizeLabel: "44px",
	inspectorStatusChipMax: "58%",
	boardEmpty: "460px",
	previewMax: "760px",
	previewContent: "400px",
	prTableActions: "220px",
	prColNumber: "64px",
	prColState: "96px",
	contentMax: "320px",
	dialogMd: "420px",
	dialogLg: "440px",
	dialogOrchestrator: "460px",
	dialogXl: "560px",
	branchChip: "13rem",
	inspectorMin: "280px",
	textareaMin: "112px",
	sidebarProjectActions: "84px",
	emptyOffsetY: "5vh",
	timelineDotRing: "3px",
	timelineDotGlow: "8px",
} as const;

/** Derived from `layout` via `layoutCssVarName` — do not hand-edit. */
export const layoutCssName = Object.fromEntries(
	(Object.keys(layout) as (keyof typeof layout)[]).map((key) => [key, layoutCssVarName(key)]),
) as { [K in keyof typeof layout]: string };

// ---------------------------------------------------------------------------
// Semantic colors — dark (default :root)
// ---------------------------------------------------------------------------

export const darkColor = {
	bgPrimary: "#0a0b0d",
	bgSecondary: "#15171b",
	bgTertiary: "#1b1d22",
	bgElevated: "#212329",
	bgSidebar: "#08090b",
	bgTerminal: "#15171b",
	textPrimary: "#f4f5f7",
	textMuted: "#9ba1aa",
	textPassive: "#646a73",
	textTerminal: "#d7d7d2",
	textTerminalDim: "#7c7c7c",
	border: "rgb(255 255 255 / 0.06)",
	borderStrong: "rgb(255 255 255 / 0.1)",
	accent: "#4d8dff",
	accentForeground: "#ffffff",
	accentWeak: "rgb(77 141 255 / 0.16)",
	accentDim: "#24406e",
	working: "#f59f4c",
	warning: "#e8c14a",
	success: "#74b98a",
	successBright: "#8bdc75",
	danger: "#ef6b6b",
	purple: "#a78bfa",
	interactiveHover: "rgb(255 255 255 / 0.04)",
	interactiveActive: "rgb(255 255 255 / 0.07)",
	overlaySubtle: "rgb(255 255 255 / 0.018)",
	overlayFaint: "rgb(255 255 255 / 0.02)",
	scrollbar: "rgb(255 255 255 / 0.12)",
	scrollbarHover: "rgb(255 255 255 / 0.2)",
	scrim: "rgb(0 0 0 / 0.55)",
} as const;

// ---------------------------------------------------------------------------
// Semantic colors — light overrides (`:root[data-theme="light"]` only)
// ---------------------------------------------------------------------------

export const lightColor = {
	bgPrimary: "#fcfcfc",
	bgSecondary: "#ffffff",
	bgTertiary: "#ededee",
	bgElevated: "#e4e4e6",
	bgSidebar: "#fcfcfc",
	bgTerminal: "#fafafa",
	textPrimary: "#1a1a1a",
	textMuted: "#666666",
	textPassive: "#9a9a9a",
	textTerminal: "#24292f",
	textTerminalDim: "#6b7280",
	border: "#e3e3e5",
	borderStrong: "#d4d4d6",
	accent: "#2563eb",
	accentForeground: "#ffffff",
	accentWeak: "rgb(37 99 235 / 0.12)",
	accentDim: "#bcd2f7",
	working: "#c2410c",
	warning: "#9a6b00",
	success: "#1a7f37",
	successBright: "#176639",
	danger: "#c0392b",
	purple: "#7c3aed",
	interactiveHover: "rgb(0 0 0 / 0.04)",
	interactiveActive: "rgb(0 0 0 / 0.07)",
	overlaySubtle: "rgb(0 0 0 / 0.02)",
	overlayFaint: "rgb(0 0 0 / 0.03)",
	scrollbar: "rgb(0 0 0 / 0.12)",
	scrollbarHover: "rgb(0 0 0 / 0.2)",
	scrim: "rgb(0 0 0 / 0.45)",
} as const;

// ---------------------------------------------------------------------------
// Browser static preview (light mock page inside the dark app)
// ---------------------------------------------------------------------------

export const previewColor = {
	bg: "#f7f8fb",
	fg: "#17202a",
	border: "#dfe4ea",
	muted: "#687384",
	link: "#2f5b9d",
	cardBorder: "#d7dee8",
	heading: "#111827",
	body: "#526070",
	successBg: "#e7f8ed",
	tileBorder: "#e1e7ef",
	tileBg: "#fbfcfe",
	terminalBorder: "#dce4ef",
	terminalBg: "#0f172a",
	terminalFg: "#cbd5e1",
} as const;

// ---------------------------------------------------------------------------
// Mock project accent swatches (sidebar dots)
// ---------------------------------------------------------------------------

export const projectAccentColor = {
	mint: "#6ee7b7",
	sky: "#93c5fd",
} as const;

// ---------------------------------------------------------------------------
// xterm extended palette (ANSI bright + selection)
// ---------------------------------------------------------------------------

export const terminalColor = {
	cyan: "#6fb3c9",
	selectionDark: "rgb(77 141 255 / 0.3)",
	selectionLight: "rgb(37 99 235 / 0.25)",
	selectionInactive: "rgb(128 128 128 / 0.2)",
	selectionInactiveLight: "rgb(128 128 128 / 0.15)",
	brightRed: "#ff8a8a",
	brightGreen: "#8fd6a6",
	brightYellow: "#f0d06b",
	brightBlue: "#7eaaff",
	brightMagenta: "#c4b0fc",
	brightCyan: "#8fcfe0",
	redLight: "#b42318",
	magentaLight: "#8e24aa",
	cyanLight: "#0b7285",
	whiteLight: "#4b5563",
	brightBlackLight: "#374151",
	brightRedLight: "#912018",
	brightGreenLight: "#176639",
	brightYellowLight: "#6f4a00",
	brightBlueLight: "#1d4ed8",
	brightMagentaLight: "#7b1fa2",
	brightCyanLight: "#155e75",
} as const;

// ---------------------------------------------------------------------------
// Elevation / shadows
// ---------------------------------------------------------------------------

export const darkElevation = {
	sm: "0 1px 0 rgb(0 0 0 / 0.35)",
	md: "0 1px 0 rgb(0 0 0 / 0.4), 0 12px 32px rgb(0 0 0 / 0.5)",
	lg: "0 8px 40px rgb(0 0 0 / 0.55)",
	xl: "0 1px 0 rgb(0 0 0 / 0.4), 0 20px 50px rgb(0 0 0 / 0.55)",
} as const;

export const lightElevation = {
	sm: "0 1px 0 rgb(0 0 0 / 0.06)",
	md: "0 1px 0 rgb(0 0 0 / 0.03), 0 12px 30px rgb(20 30 50 / 0.1)",
	lg: "0 16px 48px rgb(20 30 50 / 0.16)",
	xl: "0 1px 0 rgb(0 0 0 / 0.03), 0 20px 50px rgb(20 30 50 / 0.14)",
} as const;

// ---------------------------------------------------------------------------
// Theme metadata — browser hints (not color values)
// ---------------------------------------------------------------------------

export const themeMeta = {
	dark: {
		colorScheme: "dark",
		selectors: [":root", ":root.dark", ".dark"],
	},
	light: {
		colorScheme: "light",
		selector: ':root[data-theme="light"]',
	},
} as const;

// ---------------------------------------------------------------------------
// Layout keys exposed as Tailwind spacing-* utilities (h-control-xs, etc.)
// ---------------------------------------------------------------------------

/** Curated subset of `layout` — add a key here to enable `spacing-*` / `h-*` utilities. */
export const layoutSpacingKeys = [
	"toolbar",
	"titlebarContentOffset",
	"titlebarClusterLeft",
	"controlXs",
	"controlSm",
	"controlForm",
	"controlMd",
	"controlLg",
	"controlXl",
	"controlBoardSm",
	"controlBoard",
	"tableHead",
	"inspectorTabs",
	"browserUrl",
	"browserMin",
	"dotSm",
	"contentMax",
	"boardEmpty",
	"previewContent",
	"previewMax",
	"notificationWidth",
	"notificationMaxHeight",
	"selectMenuMax",
	"notificationIcon",
	"fontSizeLabel",
	"prTableActions",
	"prColNumber",
	"prColState",
	"inspectorMin",
	"textareaMin",
	"sidebarProjectActions",
	"rowMd",
	"emptyOffsetY",
	"kvLabel",
	"branchChip",
] as const satisfies readonly (keyof typeof layout)[];

/** Icon layout keys in `layout` definition order (`icon2xs` … `iconXl`). */
export const layoutIconKeys = (Object.keys(layout) as (keyof typeof layout)[]).filter((key) =>
	isLayoutIconKey(key),
) as readonly (keyof typeof layout)[];

// ---------------------------------------------------------------------------
// Terminal font-size control (xterm) — tied to the typography scale
// ---------------------------------------------------------------------------

export const terminalFontSize = {
	min: fontSize["2xs"],
	default: fontSize.sm,
	max: fontSize.terminalMax,
} as const;

/** Parsed xterm bounds for JS consumers (CenterPane, XtermTerminal). */
export const terminalFontSizePx = {
	min: parsePx(terminalFontSize.min),
	default: parsePx(terminalFontSize.default),
	max: parsePx(terminalFontSize.max),
} as const;

export const TERMINAL_FONT_SIZE_MIN = terminalFontSizePx.min;
export const TERMINAL_FONT_SIZE_DEFAULT = terminalFontSizePx.default;
export const TERMINAL_FONT_SIZE_MAX = terminalFontSizePx.max;
