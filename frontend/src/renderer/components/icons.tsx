import type { SVGProps } from "react";

// Codex mark: a rounded terminal tile holding a `<` prompt and a caret bar,
// drawn monochrome in lucide's 24x24 stroke style so it inherits color/size
// from the slot it sits in (unlike the full-color brand logo, which carries a
// white background chip and a gradient that won't theme against our surfaces).
export function CodexIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="24"
			height="24"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}
			{...props}
		>
			<rect x="3" y="3" width="18" height="18" rx="5" />
			<path d="M10.5 9.5 8 12l2.5 2.5" />
			<path d="M13.5 14.5H16" />
		</svg>
	);
}

// Orchestrator mark: a parent node fanning out to three child nodes, drawn in
// lucide's 24x24 stroke style so it drops into the same slots as the lucide
// icons (size comes from `className`/the parent's `[&_svg]:size-*`). Lucide has
// no 1-parent / 3-child hierarchy glyph, so we author this one to match the
// org-chart icon called for in the design.
export function OrchestratorIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="24"
			height="24"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}
			{...props}
		>
			<circle cx="12" cy="4" r="2" />
			<circle cx="5" cy="20" r="2" />
			<circle cx="12" cy="20" r="2" />
			<circle cx="19" cy="20" r="2" />
			<path d="M12 6v12" />
			<path d="M5 11h14" />
			<path d="M5 11v7" />
			<path d="M19 11v7" />
		</svg>
	);
}
