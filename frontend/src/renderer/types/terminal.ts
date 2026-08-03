export type ReviewerTerminalInteraction = "interactive" | "output-only";

export function reviewerTerminalInteraction(harness: string): ReviewerTerminalInteraction {
	return harness === "greptile" ? "output-only" : "interactive";
}

export type ReviewerTerminalTarget = {
	kind: "reviewer";
	handleId: string;
	harness: string;
	interaction: ReviewerTerminalInteraction;
};

export type TerminalTarget =
	| { kind: "worker" }
	| ReviewerTerminalTarget
	// A standalone shell the user opened by hand — no agent session behind it,
	// so unlike "worker" and "reviewer" it carries its own handle and never
	// reads from the selected session.
	| {
			kind: "shell";
			handleId: string;
			title: string;
	  };
