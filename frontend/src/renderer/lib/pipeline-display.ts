// Shared presentation helpers for the pipeline Runs UI: the fixed 5-column
// Kanban layout (grouped by loopState), plus status/severity → tone maps used by
// the workbench cards and the read-only run detail. Ported from the old
// PipelineWorkbench/PipelineRunCard information design, restyled to AO tokens.

export type LoopStateName = "running" | "awaiting_context" | "done" | "stalled" | "terminated";

export type KanbanColumn = {
	state: LoopStateName;
	title: string;
	description: string;
	// Tailwind class for the column's 2px left accent border.
	borderClass: string;
};

// Column order and copy are fixed; the board renders exactly these five in this
// order regardless of which states currently have runs.
export const KANBAN_COLUMNS: readonly KanbanColumn[] = [
	{ state: "running", title: "Running", description: "Stage executing", borderClass: "border-l-working" },
	{
		state: "awaiting_context",
		title: "Awaiting context",
		description: "Stage paused for input",
		borderClass: "border-l-warning",
	},
	{ state: "done", title: "Done", description: "All stages succeeded", borderClass: "border-l-success" },
	{ state: "stalled", title: "Stalled", description: "Failed stages — resume to retry", borderClass: "border-l-error" },
	{ state: "terminated", title: "Terminated", description: "Cancelled or superseded", borderClass: "border-l-border" },
] as const;

// A run's loopState → the dot/text tone used on its card header.
export function loopStateTone(state: string): string {
	switch (state) {
		case "running":
			return "text-working";
		case "awaiting_context":
			return "text-warning";
		case "done":
			return "text-success";
		case "stalled":
			return "text-error";
		case "terminated":
		default:
			return "text-passive";
	}
}

// Per-stage status → the small status dot's background tone.
export function stageStatusDotTone(status: string): string {
	switch (status) {
		case "succeeded":
			return "bg-success";
		case "running":
			return "bg-working";
		case "failed":
			return "bg-error";
		case "skipped":
			return "bg-passive";
		case "outdated":
			return "bg-muted-foreground";
		case "pending":
		default:
			return "bg-muted-foreground";
	}
}

// Finding severity → a Badge variant. Unknown/empty severities read as neutral.
export function severityBadgeVariant(severity: string | undefined): "error" | "warning" | "neutral" {
	switch ((severity ?? "").toLowerCase()) {
		case "critical":
		case "high":
			return "error";
		case "medium":
			return "warning";
		default:
			return "neutral";
	}
}

// A short commit reference for a run header.
export function shortSha(sha: string): string {
	return sha.length > 12 ? sha.slice(0, 12) : sha;
}
