import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	bridgeAlias,
	breakpoint,
	breakpointMedia,
	colorMix,
	darkColor,
	darkElevation,
	duration,
	fontAlias,
	fontFamily,
	fontSize,
	layout,
	layoutCssName,
	layoutIconKeys,
	layoutSpacingKeys,
	lightColor,
	lightElevation,
	motionRecipe,
	previewColor,
	projectAccentColor,
	radius,
	space,
	tailwindThemeSections,
	tailwindUtilities,
	terminalColor,
	terminalFontSize,
	terminalFontSizePx,
	TERMINAL_FONT_SIZE_DEFAULT,
	TERMINAL_FONT_SIZE_MAX,
	TERMINAL_FONT_SIZE_MIN,
	themeMeta,
	zIndex,
} from "./tokens";
import { buildDesignSystemCss, expectedDarkRootCustomProperties, semanticColorCssName } from "./build-tokens-css";
import { isLayoutIconKey, kebab, layoutCssVarName, parsePx } from "./css-utils";

const GENERATED_CSS = join(__dirname, "design-system.generated.css");
const STYLES_CSS = join(__dirname, "../renderer/styles.css");

/** Parse `--name: value;` declarations (supports multi-line values). */
function parseCssCustomProperties(css: string): Map<string, string> {
	const properties = new Map<string, string>();
	const re = /--([\w-]+):\s*((?:[^;]|(?:\n\s+[^;]))+);/g;
	for (const match of css.matchAll(re)) {
		const value = match[2].replace(/\n\s+/g, " ").trim();
		properties.set(`--${match[1]}`, value);
	}
	return properties;
}

/** `brightRed` → `--color-term-bright-red` */
function terminalColorVar(key: string): string {
	return `--color-term-${kebab(key)}`;
}

function parseRootTokenVars(css: string): { dark: Map<string, string>; light: Map<string, string> } {
	const lightIndex = css.indexOf(themeMeta.light.selector);
	const darkSection = lightIndex === -1 ? css : css.slice(0, lightIndex);
	const tail = lightIndex === -1 ? "" : css.slice(lightIndex);
	const lightEnd = tail.indexOf("@custom-media");
	const lightSection = lightEnd === -1 ? tail : tail.slice(0, lightEnd);

	return {
		dark: parseCssCustomProperties(darkSection),
		light: parseCssCustomProperties(lightSection),
	};
}

function splitThemeBlocks(css: string): { dark: string; light: string } {
	const marker = themeMeta.light.selector;
	const index = css.indexOf(marker);
	if (index === -1) {
		return { dark: css, light: "" };
	}
	const lightEnd = css.indexOf("@custom-media", index);
	return {
		dark: css.slice(0, index),
		light: lightEnd === -1 ? css.slice(index) : css.slice(index, lightEnd),
	};
}

function parseThemeBlock(css: string): Map<string, string> {
	const start = css.indexOf("@theme inline {");
	const end = css.lastIndexOf("}");
	if (start === -1 || end === -1) {
		return new Map();
	}
	return parseCssCustomProperties(css.slice(start, end));
}

describe("design-system.generated.css", () => {
	const css = readFileSync(GENERATED_CSS, "utf8");
	const { dark: darkVars, light: lightVars } = parseRootTokenVars(css);
	const { dark: darkCss, light: lightCss } = splitThemeBlocks(css);
	const themeVars = parseThemeBlock(css);

	it("matches the generator output", () => {
		expect(css).toBe(buildDesignSystemCss());
	});

	it("declares every expected dark :root custom property", () => {
		const expected = expectedDarkRootCustomProperties();
		expect(expected.length).toBe(new Set(expected).size);
		for (const name of expected) {
			expect(darkVars.has(name)).toBe(true);
		}
	});

	it("emits dark semantic colors from primitives", () => {
		for (const [key, value] of Object.entries(darkColor)) {
			expect(darkVars.get(`--${semanticColorCssName(key)}`)).toBe(value);
		}
	});

	it("emits light theme overrides from primitives", () => {
		for (const [key, value] of Object.entries(lightColor)) {
			expect(lightVars.get(`--${semanticColorCssName(key)}`)).toBe(value);
		}
	});

	it("emits shared scales and layout from primitives", () => {
		expect(darkVars.get("--font-family-base")).toBe(fontFamily.base);
		expect(darkVars.get("--font-size-sm")).toBe(fontSize.sm);
		expect(darkVars.get("--space-2")).toBe(space["2"]);
		expect(darkVars.get("--radius-md")).toBe(radius.md);
		expect(darkVars.get("--z-overlay")).toBe(zIndex.overlay);
		expect(darkVars.get("--size-toolbar")).toBe(layout.toolbar);
		expect(darkVars.get("--size-table-head")).toBe(layout.tableHead);
	});

	it("emits preview, project accent, and terminal palettes", () => {
		expect(darkVars.get("--color-preview-bg")).toBe(previewColor.bg);
		expect(darkVars.get("--color-project-accent-mint")).toBe(projectAccentColor.mint);
		expect(darkVars.get("--color-term-cyan")).toBe(terminalColor.cyan);
		expect(darkVars.get(terminalColorVar("brightRed"))).toBe(terminalColor.brightRed);
	});

	it("emits layout css names from layoutCssName", () => {
		for (const [key, cssName] of Object.entries(layoutCssName)) {
			expect(cssName).toBe(layoutCssVarName(key));
			expect(darkVars.get(`--${cssName}`)).toBe(layout[key as keyof typeof layout]);
		}
	});

	it("keeps the UI pixel font-size scale monotonic", () => {
		const orderedKeys = [
			"2xs",
			"xs",
			"caption",
			"smMd",
			"sm",
			"mdSm",
			"base",
			"md",
			"brand",
			"subtitle",
			"headingSm",
			"heading",
			"headingLg",
		] as const;
		for (let index = 1; index < orderedKeys.length; index++) {
			const prev = parsePx(fontSize[orderedKeys[index - 1]!]);
			const next = parsePx(fontSize[orderedKeys[index]!]);
			expect(next).toBeGreaterThan(prev);
		}
	});

	it("emits layout spacing keys as @theme spacing utilities", () => {
		for (const key of layoutSpacingKeys) {
			expect(themeVars.get(`--spacing-${kebab(key)}`)).toBe(`var(--${layoutCssVarName(key)})`);
		}
	});

	it("emits elevation shadows for both themes", () => {
		for (const [key, value] of Object.entries(darkElevation)) {
			expect(darkVars.get(`--elevation-${key}`)).toBe(value);
		}
		for (const [key, value] of Object.entries(lightElevation)) {
			expect(lightVars.get(`--elevation-${key}`)).toBe(value);
		}
	});

	it("emits @theme bridge aliases and font aliases from tailwind-bridge", () => {
		for (const [key, target] of Object.entries(bridgeAlias)) {
			expect(darkVars.get(`--bridge-${kebab(key)}`)).toBe(`var(--${target})`);
		}
		for (const [key, target] of Object.entries(fontAlias)) {
			expect(darkVars.get(`--font-${key}`)).toBe(`var(--${target})`);
		}
	});

	it("emits color-scheme from themeMeta", () => {
		expect(darkCss).toContain(`color-scheme: ${themeMeta.dark.colorScheme};`);
		expect(lightCss).toContain(`color-scheme: ${themeMeta.light.colorScheme};`);
	});

	it("emits motion and color-mix recipe tokens", () => {
		expect(darkVars.get("--color-mix-purple-subtle")).toBe(colorMix.purpleSubtle);
		expect(darkVars.get("--color-mix-surface-faint")).toBe(colorMix.surfaceFaint);
		expect(darkVars.get("--animation-status-pulse-min-opacity")).toBe(motionRecipe.statusPulseMinOpacity);
		expect(darkVars.get("--animation-modal-in-scale-from")).toBe(motionRecipe.modalInScaleFrom);
		expect(darkVars.get("--duration-inspector-split")).toBe(duration.inspectorSplit);
		expect(darkVars.get("--size-timeline-dot-ring")).toBe(layout.timelineDotRing);
		expect(darkVars.get("--size-timeline-dot-glow")).toBe(layout.timelineDotGlow);
	});

	it("declares @custom-media from breakpointMedia", () => {
		expect(css).toContain(`@custom-media --layout-narrow ${breakpointMedia.layoutNarrow};`);
		expect(css).toContain(`@custom-media --inspector-compact ${breakpointMedia.inspectorCompact};`);
		expect(css).toContain(`--breakpoint-layout-narrow: ${breakpoint.layoutNarrow};`);
	});

	it("emits every tailwindThemeSections entry", () => {
		for (const section of tailwindThemeSections) {
			for (const [key, value] of Object.entries(section.vars)) {
				expect(themeVars.get(`--${key}`)).toBe(value);
			}
		}
	});

	it("emits every tailwind utility and keyframe", () => {
		for (const utility of tailwindUtilities) {
			expect(css).toContain(`@utility ${utility.name} {`);
			for (const rule of utility.rules) {
				expect(css).toContain(rule);
			}
		}
		expect(css).toContain("opacity: var(--animation-status-pulse-min-opacity);");
		expect(css).toContain("scale: var(--animation-modal-in-scale-from);");
	});

	it("derives xterm font-size constants from terminalFontSizePx", () => {
		expect(TERMINAL_FONT_SIZE_MIN).toBe(terminalFontSizePx.min);
		expect(TERMINAL_FONT_SIZE_DEFAULT).toBe(terminalFontSizePx.default);
		expect(TERMINAL_FONT_SIZE_MAX).toBe(terminalFontSizePx.max);
		expect(TERMINAL_FONT_SIZE_MAX).toBe(parsePx(fontSize.terminalMax));
	});

	it("derives layout icon keys from layout in definition order", () => {
		const iconKeysFromLayout = (Object.keys(layout) as (keyof typeof layout)[]).filter((key) =>
			isLayoutIconKey(key),
		);
		expect(layoutIconKeys).toEqual(iconKeysFromLayout);
	});
});

describe("renderer/styles.css chrome behavior", () => {
	const css = readFileSync(STYLES_CSS, "utf8");

	it("owns sidebar and inspector transition rules", () => {
		expect(css).toContain(".sidebar-expanded-chrome {");
		expect(css).toContain("transition: opacity var(--duration-normal) ease-out;");
		expect(css).toContain(".session-split #inspector[data-panel] {");
		expect(css).toContain("transition: flex-grow var(--duration-inspector-split) linear;");
	});

	it("uses :root typography vars for the body baseline", () => {
		expect(css).toContain("font-family: var(--font-family-base);");
		expect(css).toContain("font-size: var(--font-size-md);");
		expect(css).toContain("line-height: var(--line-height-normal);");
	});
});
