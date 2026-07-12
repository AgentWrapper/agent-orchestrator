/**
 * Design tokens — public barrel export.
 * Author values in primitives.ts, tailwind-bridge.ts, and utilities.ts.
 * Regenerate CSS via `npm run tokens` → `design-system.generated.css`.
 */

export type { ThemeName } from "./primitives";

export {
	TERMINAL_FONT_SIZE_DEFAULT,
	TERMINAL_FONT_SIZE_MAX,
	TERMINAL_FONT_SIZE_MIN,
	animation,
	breakpoint,
	breakpointMedia,
	colorMix,
	darkColor,
	darkElevation,
	duration,
	fontFamily,
	fontSize,
	fontWeight,
	layout,
	layoutCssName,
	layoutIconKeys,
	layoutSpacingKeys,
	letterSpacing,
	lightColor,
	lightElevation,
	lineHeight,
	motionRecipe,
	previewColor,
	projectAccentColor,
	radius,
	space,
	terminalColor,
	terminalFontSize,
	terminalFontSizePx,
	themeMeta,
	zIndex,
} from "./primitives";

export { bridgeAlias, fontAlias, tailwindThemeSections } from "./tailwind-bridge";
export type { TailwindThemeSection } from "./tailwind-bridge";

export { tailwindUtilities } from "./utilities";
export type { TailwindUtility } from "./utilities";

export { isLayoutIconKey, kebab, layoutCssVarName, parsePx } from "./css-utils";
