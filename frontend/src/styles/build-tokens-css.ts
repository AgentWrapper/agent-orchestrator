/**
 * Builds generated CSS from primitives, tailwind-bridge, and utilities.
 * Run directly via `npm run tokens` to write `design-system.generated.css`.
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";
import { kebab, layoutCssVarName } from "./css-utils";
import {
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
	themeMeta,
	zIndex,
} from "./primitives";
import { bridgeAlias, fontAlias, tailwindThemeSections } from "./tailwind-bridge";
import { tailwindUtilities } from "./utilities";

const stylesDir = dirname(fileURLToPath(import.meta.url));
const GENERATED_OUTPUT_CSS = resolve(stylesDir, "design-system.generated.css");

const GENERATED_HEADER = `/*
 * AUTO-GENERATED — do not edit.
 * Source: src/styles/primitives.ts, tailwind-bridge.ts, utilities.ts
 * Regenerate: npm run tokens
 */`;

function stripGeneratedHeader(css: string): string {
	return css.replace(/^\/\*[\s\S]*?\*\/\n*/, "");
}

export function semanticColorCssName(key: string): string {
	return `color-${kebab(key)}`;
}

export function terminalColorCssName(key: string): string {
	return `color-term-${kebab(key)}`;
}

function previewColorCssName(key: string): string {
	return `color-preview-${kebab(key)}`;
}

function projectAccentCssName(key: string): string {
	return `color-project-accent-${key}`;
}

function tokenVars(entries: Array<[cssName: string, value: string]>): string[] {
	return entries.map(([cssName, value]) => `\t--${cssName}: ${value};`);
}

function recordVars(record: Record<string, string>, nameForKey: (key: string) => string): string[] {
	return tokenVars(Object.entries(record).map(([key, value]) => [nameForKey(key), value]));
}

function semanticColorVars(record: Record<string, string>): string[] {
	return recordVars(record, semanticColorCssName);
}

function terminalVars(record: Record<string, string>): string[] {
	return recordVars(record, terminalColorCssName);
}

function previewColorVars(record: Record<string, string>): string[] {
	return recordVars(record, previewColorCssName);
}

function projectAccentVars(record: Record<string, string>): string[] {
	return recordVars(record, projectAccentCssName);
}

function layoutVars(record: Record<string, string>): string[] {
	return tokenVars(Object.entries(record).map(([key, value]) => [layoutCssVarName(key), value]));
}

function fontSizeVars(): string[] {
	return tokenVars(Object.entries(fontSize).map(([key, value]) => [`font-size-${kebab(key)}`, value]));
}

function letterSpacingVars(): string[] {
	return tokenVars(Object.entries(letterSpacing).map(([key, value]) => [`tracking-${kebab(key)}`, value]));
}

function lineHeightVars(): string[] {
	return tokenVars(Object.entries(lineHeight).map(([key, value]) => [`line-height-${kebab(key)}`, value]));
}

function spaceVars(): string[] {
	return tokenVars(Object.entries(space).map(([key, value]) => [`space-${key}`, value]));
}

function radiusVars(): string[] {
	return tokenVars(Object.entries(radius).map(([key, value]) => [`radius-${key}`, value]));
}

function bridgeVars(): string[] {
	return tokenVars(Object.entries(bridgeAlias).map(([key, target]) => [`bridge-${kebab(key)}`, `var(--${target})`]));
}

function fontAliasVars(): string[] {
	return tokenVars(Object.entries(fontAlias).map(([key, target]) => [`font-${key}`, `var(--${target})`]));
}

function elevationVars(record: Record<string, string>): string[] {
	return tokenVars(Object.entries(record).map(([key, value]) => [`elevation-${key}`, value]));
}

function recipeVars(): string[] {
	return [
		`\t--color-mix-purple-subtle: ${colorMix.purpleSubtle};`,
		`\t--color-mix-surface-faint: ${colorMix.surfaceFaint};`,
		`\t--animation-status-pulse-min-opacity: ${motionRecipe.statusPulseMinOpacity};`,
		`\t--animation-modal-in-scale-from: ${motionRecipe.modalInScaleFrom};`,
	];
}

/** Every `--*` name the dark `:root` block is expected to declare (drives parity tests). */
export function expectedDarkRootCustomProperties(): string[] {
	return [
		...Object.keys(darkColor).map((key) => `--${semanticColorCssName(key)}`),
		"--font-family-base",
		"--font-family-mono",
		...Object.keys(fontSize).map((key) => `--font-size-${kebab(key)}`),
		"--font-weight-medium",
		"--font-weight-semibold",
		...Object.keys(lineHeight).map((key) => `--line-height-${kebab(key)}`),
		...Object.keys(letterSpacing).map((key) => `--tracking-${kebab(key)}`),
		"--duration-fast",
		"--duration-normal",
		"--duration-inspector-split",
		"--color-mix-purple-subtle",
		"--color-mix-surface-faint",
		"--animation-status-pulse-min-opacity",
		"--animation-modal-in-scale-from",
		...Object.keys(space).map((key) => `--space-${key}`),
		"--z-chrome",
		"--z-titlebar",
		"--z-overlay",
		...Object.keys(radius).map((key) => `--radius-${key}`),
		"--breakpoint-layout-narrow",
		"--breakpoint-inspector-compact",
		...(Object.keys(layout) as (keyof typeof layout)[]).map((key) => `--${layoutCssVarName(key)}`),
		...Object.keys(previewColor).map((key) => `--color-preview-${kebab(key)}`),
		...Object.keys(projectAccentColor).map((key) => `--color-project-accent-${key}`),
		...Object.keys(terminalColor).map((key) => `--${terminalColorCssName(key)}`),
		...Object.keys(darkElevation).map((key) => `--elevation-${key}`),
		...Object.keys(bridgeAlias).map((key) => `--bridge-${kebab(key)}`),
		...Object.keys(fontAlias).map((key) => `--font-${key}`),
	];
}

/** Returns the `:root` custom property block for the design system bundle. */
export function buildTokensCss(): string {
	const darkBlock = [
		`${themeMeta.dark.selectors.join(",\n")} {`,
		"\t/* ── Color scheme hint for native form controls / scrollbars ── */",
		`\tcolor-scheme: ${themeMeta.dark.colorScheme};`,
		"",
		"\t/* ═══════════════════════════════════════════════════════════════",
		"\t   COLOR — semantic (swap these per theme; do not invent new roles",
		"\t   for one-off hex — map one-offs to the nearest existing role)",
		"\t   ═══════════════════════════════════════════════════════════════ */",
		"",
		...semanticColorVars(darkColor),
		"",
		"\t/* ═══════════════════════════════════════════════════════════════",
		"\t   TYPOGRAPHY",
		"\t   ═══════════════════════════════════════════════════════════════ */",
		"",
		`\t--font-family-base:`,
		`\t\t${fontFamily.base};`,
		`\t--font-family-mono:`,
		`\t\t${fontFamily.mono};`,
		"",
		"\t/* Scale — dense UI chrome uses half-steps between base sizes */",
		...fontSizeVars(),
		"",
		`\t--font-weight-medium: ${fontWeight.medium};`,
		`\t--font-weight-semibold: ${fontWeight.semibold};`,
		"",
		...lineHeightVars(),
		"",
		"\t/* Letter-spacing — uppercase meta, tight headings */",
		...letterSpacingVars(),
		"",
		"\t/* Motion */",
		`\t--duration-fast: ${duration.fast};`,
		`\t--duration-normal: ${duration.normal};`,
		`\t--duration-inspector-split: ${duration.inspectorSplit};`,
		...recipeVars(),
		"",
		"\t/* ═══════════════════════════════════════════════════════════════",
		"\t   SPACING — 4px base (audit: 4/6/8/10/12/14/16/18 most common)",
		"\t   Prefer even steps; map odd pixels (5/7/9/11/13/15) to nearest.",
		"\t   ═══════════════════════════════════════════════════════════════ */",
		"",
		...spaceVars(),
		"",
		"\t/* ═══════════════════════════════════════════════════════════════",
		"\t   Z-INDEX — stacking layers",
		"\t   ═══════════════════════════════════════════════════════════════ */",
		"",
		`\t--z-chrome: ${zIndex.chrome};`,
		`\t--z-titlebar: ${zIndex.titlebar};`,
		`\t--z-overlay: ${zIndex.overlay};`,
		"",
		"\t/* ═══════════════════════════════════════════════════════════════",
		"\t   RADIUS",
		"\t   ═══════════════════════════════════════════════════════════════ */",
		"",
		...radiusVars(),
		"",
		"\t/* ═══════════════════════════════════════════════════════════════",
		"\t   BREAKPOINTS — documented here; @media cannot use var()",
		"\t   ═══════════════════════════════════════════════════════════════ */",
		"",
		`\t--breakpoint-layout-narrow: ${breakpoint.layoutNarrow};`,
		`\t--breakpoint-inspector-compact: ${breakpoint.inspectorCompact};`,
		"",
		"\t/* ═══════════════════════════════════════════════════════════════",
		"\t   LAYOUT — fixed chrome dimensions (not spacing scale)",
		"\t   ═══════════════════════════════════════════════════════════════ */",
		"",
		...layoutVars(layout),
		"",
		"\t/* Browser static preview (light mock page inside dark app) */",
		...previewColorVars(previewColor),
		"",
		"\t/* Mock project accent swatches (sidebar dots) */",
		...projectAccentVars(projectAccentColor),
		"",
		"\t/* xterm extended palette (ANSI bright + selection) */",
		...terminalVars(terminalColor),
		"",
		"\t/* ═══════════════════════════════════════════════════════════════",
		"\t   SHADOWS",
		"\t   ═══════════════════════════════════════════════════════════════ */",
		"",
		...elevationVars(darkElevation),
		"",
		"\t/* @theme bridge — avoids Tailwind theme key / :root name collisions */",
		...bridgeVars(),
		"",
		...fontAliasVars(),
		"}",
	];

	const lightBlock = [
		"",
		"/* Light theme — set via data-theme (apply-initial-theme + Zustand toggle). */",
		"",
		`${themeMeta.light.selector} {`,
		`\tcolor-scheme: ${themeMeta.light.colorScheme};`,
		"",
		...semanticColorVars(lightColor),
		"",
		...elevationVars(lightElevation),
		"}",
		"",
	];

	return [GENERATED_HEADER, ...darkBlock, ...lightBlock].join("\n");
}

/** Returns the `@theme inline` block for the design system bundle. */
export function buildThemeCss(): string {
	const lines = [
		GENERATED_HEADER,
		`@custom-media --layout-narrow ${breakpointMedia.layoutNarrow}; /* --breakpoint-layout-narrow */`,
		`@custom-media --inspector-compact ${breakpointMedia.inspectorCompact}; /* --breakpoint-inspector-compact */`,
		"",
		"@theme inline {",
	];

	for (const section of tailwindThemeSections) {
		if (section.comment) {
			lines.push(`\t/* ${section.comment} */`);
		}
		for (const [key, value] of Object.entries(section.vars)) {
			lines.push(`\t--${key}: ${value};`);
		}
		lines.push("");
	}

	lines.push("}", "");

	return lines.join("\n");
}

/** Returns `@utility` and keyframes for the design system bundle. */
export function buildUtilitiesCss(): string {
	const lines = [GENERATED_HEADER, ""];

	for (const utility of tailwindUtilities) {
		lines.push(`@utility ${utility.name} {`);
		for (const rule of utility.rules) {
			lines.push(`\t${rule}`);
		}
		lines.push("}", "");
	}

	lines.push(
		"@keyframes status-pulse {",
		"\t0%,",
		"\t100% {",
		"\t\topacity: 1;",
		"\t}",
		"\t50% {",
		`\t\topacity: var(--animation-status-pulse-min-opacity);`,
		"\t}",
		"}",
		"",
		"@keyframes overlay-in {",
		"\tfrom {",
		"\t\topacity: 0;",
		"\t}",
		"\tto {",
		"\t\topacity: 1;",
		"\t}",
		"}",
		"",
		"@keyframes modal-in {",
		"\tfrom {",
		"\t\topacity: 0;",
		"\t\tscale: var(--animation-modal-in-scale-from);",
		"\t}",
		"\tto {",
		"\t\topacity: 1;",
		"\t\tscale: 1;",
		"\t}",
		"}",
		"",
	);

	return lines.join("\n");
}

/** Returns the raw CSS bundle before Prettier formatting. */
function buildDesignSystemCssRaw(): string {
	return [
		GENERATED_HEADER,
		stripGeneratedHeader(buildTokensCss()),
		stripGeneratedHeader(buildThemeCss()),
		stripGeneratedHeader(buildUtilitiesCss()),
	].join("\n");
}

/** Returns the full CSS bundle written to `design-system.generated.css`. */
export async function buildDesignSystemCss(): Promise<string> {
	const options = await prettier.resolveConfig(GENERATED_OUTPUT_CSS);
	return prettier.format(buildDesignSystemCssRaw(), {
		...options,
		filepath: GENERATED_OUTPUT_CSS,
	});
}

const __filename = fileURLToPath(import.meta.url);

if (resolve(process.argv[1] ?? "") === resolve(__filename)) {
	void (async () => {
		const output = await buildDesignSystemCss();
		writeFileSync(GENERATED_OUTPUT_CSS, output, "utf8");
	})().catch((error: unknown) => {
		console.error(error);
		process.exit(1);
	});
}
