// Mission Control palette — mirrors AO's DESIGN.md exactly so the phone app reads
// as the same product. Dark-only. Color = meaning; most states get none.
//   blue   = the conductor (you / orchestrator / primary action)
//   orange = a working agent (alive, running)
//   amber  = needs your input / attention
//   red    = failing / stuck / crashed
//   green  = mergeable / passed / done
export const theme = {
	// Surfaces (no box-in-box; the card is the only bordered surface)
	bgBase: "#0a0b0d",
	bgSide: "#08090b",
	bgColumn: "#0e0f12",
	bgSurface: "#121317", // headers, tab bar, key bar — flush chrome
	bgElevated: "#15171b", // cards & inputs
	bgElevatedHover: "#191b20",
	bgSubtle: "rgba(255,255,255,0.04)",
	term: "#0c0d10",

	textPrimary: "#f4f5f7",
	textSecondary: "#9ba1aa",
	textTertiary: "#646a73",
	textFaint: "#444951",

	borderSubtle: "rgba(255,255,255,0.06)",
	borderDefault: "rgba(255,255,255,0.10)",
	borderStrong: "rgba(255,255,255,0.16)",

	// Semantic — rationed
	blue: "#4d8dff",
	orange: "#f59f4c",
	amber: "#e8c14a",
	red: "#ef6b6b",
	green: "#74b98a",

	// Faint tints for chip / glow backgrounds
	tintBlue: "rgba(77,141,255,0.14)",
	tintOrange: "rgba(245,159,76,0.14)",
	tintAmber: "rgba(232,193,74,0.14)",
	tintRed: "rgba(239,107,107,0.14)",
	tintGreen: "rgba(116,185,138,0.14)",

	// Back-compat aliases (older screens referenced these names)
	accent: "#4d8dff",
	accentHover: "#6ba0ff",
	accentTint: "rgba(77,141,255,0.14)",
	attention: "#e8c14a",
	cyan: "#f59f4c",

	fontMono: "JetBrains Mono, Menlo, ui-monospace, monospace",
} as const;

// AO's attention levels, in urgency order. Drives the board sections.
export type AttentionLevel = "merge" | "action" | "respond" | "review" | "pending" | "working" | "done";

export const attentionMeta: Record<string, { label: string; color: string; tint: string; order: number }> = {
	merge: { label: "Ready to merge", color: theme.green, tint: theme.tintGreen, order: 0 },
	action: { label: "Needs you", color: theme.amber, tint: theme.tintAmber, order: 1 },
	respond: { label: "Needs you", color: theme.amber, tint: theme.tintAmber, order: 1 },
	review: { label: "Review", color: theme.red, tint: theme.tintRed, order: 2 },
	pending: { label: "In review", color: theme.textTertiary, tint: theme.bgSubtle, order: 3 },
	working: { label: "Working", color: theme.orange, tint: theme.tintOrange, order: 4 },
	done: { label: "Done", color: theme.textTertiary, tint: theme.bgSubtle, order: 5 },
};

export type StatusVisual = { color: string; label: string; breathing?: boolean };

// One status → one dot color + short label. Mirrors AO's getStatusSpec so the
// phone speaks the same visual language as the dashboard.
export function statusVisual(status?: string | null): StatusVisual {
	switch (status) {
		case "spawning":
			return { color: theme.blue, label: "Starting" };
		case "working":
			return { color: theme.orange, label: "Working", breathing: true };
		case "detecting":
			return { color: theme.orange, label: "Detecting", breathing: true };
		case "needs_input":
			return { color: theme.amber, label: "Needs input" };
		case "changes_requested":
			return { color: theme.amber, label: "Changes req." };
		case "stuck":
			return { color: theme.red, label: "Stuck" };
		case "errored":
			return { color: theme.red, label: "Crashed" };
		case "ci_failed":
			return { color: theme.red, label: "CI failed" };
		case "pr_open":
			return { color: theme.textSecondary, label: "PR open" };
		case "review_pending":
			return { color: theme.textSecondary, label: "In review" };
		case "approved":
			return { color: theme.green, label: "Approved" };
		case "mergeable":
			return { color: theme.green, label: "Mergeable" };
		case "merged":
			return { color: theme.green, label: "Merged" };
		case "done":
			return { color: theme.green, label: "Done" };
		case "idle":
			return { color: theme.textTertiary, label: "Idle" };
		case "cleanup":
			return { color: theme.textTertiary, label: "Cleanup" };
		case "killed":
		case "terminated":
			return { color: theme.textFaint, label: "Terminated" };
		default:
			return { color: theme.textTertiary, label: status ?? "unknown" };
	}
}

// Back-compat: older screens import statusColor.
export function statusColor(status?: string | null): string {
	return statusVisual(status).color;
}

// Single source of truth for CI status → color (used by the PR chip border and
// the PRs list). Keeps the SessionCard and PRs screen from forking the mapping.
export function ciColor(ci?: string | null): string {
	if (ci === "failing") return theme.red;
	if (ci === "passing") return theme.green;
	return theme.textTertiary;
}

export type CiVisual = {
	color: string;
	tint: string;
	icon: "check-circle" | "x-circle" | "clock";
	label: string;
};

export function ciVisual(ci?: string | null): CiVisual {
	if (ci === "passing") return { color: theme.green, tint: theme.tintGreen, icon: "check-circle", label: "CI passing" };
	if (ci === "failing") return { color: theme.red, tint: theme.tintRed, icon: "x-circle", label: "CI failing" };
	return { color: theme.textSecondary, tint: theme.bgSubtle, icon: "clock", label: `CI ${ci}` };
}
