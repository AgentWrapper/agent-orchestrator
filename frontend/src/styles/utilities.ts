/**
 * Token-derived Tailwind @utility helpers.
 */

export type TailwindUtility = {
	name: string;
	rules: readonly string[];
};

function boundedDialogWidth(name: string, sizeCssVar: string): TailwindUtility {
	return {
		name,
		rules: [`width: min(var(--${sizeCssVar}), calc(100vw - var(--space-8)));`],
	};
}

function colorMixBackground(purpleOrSurface: "purple" | "surface"): TailwindUtility {
	const colorVar = purpleOrSurface === "purple" ? "--color-purple" : "--color-bg-primary";
	const mixVar = purpleOrSurface === "purple" ? "--color-mix-purple-subtle" : "--color-mix-surface-faint";
	return {
		name: purpleOrSurface === "purple" ? "bg-purple-subtle" : "bg-surface-faint",
		rules: [`background-color: color-mix(in srgb, var(${colorVar}) var(${mixVar}), transparent);`],
	};
}

export const tailwindUtilities: readonly TailwindUtility[] = [
	boundedDialogWidth("w-dialog-md", "size-dialog-md"),
	boundedDialogWidth("w-dialog-lg", "size-dialog-lg"),
	boundedDialogWidth("w-dialog-xl", "size-dialog-xl"),
	boundedDialogWidth("w-dialog-orchestrator", "size-dialog-orchestrator"),
	{
		name: "grid-cols-notification",
		rules: ["grid-template-columns: var(--size-notification-icon) minmax(0, 1fr) auto;"],
	},
	{ name: "max-w-inspector-status-chip", rules: ["max-width: var(--size-inspector-status-chip-max);"] },
	{ name: "w-font-size-label", rules: ["width: var(--size-font-size-label);"] },
	colorMixBackground("purple"),
	{ name: "text-purple-accent", rules: ["color: var(--color-purple);"] },
	{
		name: "shadow-timeline-dot",
		rules: ["box-shadow: 0 0 0 var(--size-timeline-dot-ring) var(--color-bg-primary);"],
	},
	{
		name: "shadow-timeline-dot-now",
		rules: [
			"box-shadow:",
			"0 0 0 var(--size-timeline-dot-ring) var(--color-bg-primary),",
			"0 0 var(--size-timeline-dot-glow) var(--color-working);",
		],
	},
	colorMixBackground("surface"),
];
