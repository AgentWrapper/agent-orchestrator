import type { PredicateDraft } from "./pipeline-draft";

// Read-only human summary of a routes.when predicate for the stage inspector
// (mockup 1a: "Run this stage only when not( no_open_findings )"). This is NOT
// the predicate editor (V4) nor its compiled-DSL readout; it only compresses a
// PredicateDraft into one line of text. An unset predicate means the stage
// always runs.

export const ALWAYS_SUMMARY = "always";

export function summarizePredicate(predicate?: PredicateDraft): string {
	if (!predicate) return ALWAYS_SUMMARY;
	return render(predicate);
}

function render(p: PredicateDraft): string {
	switch (p.kind) {
		case "all_pass":
		case "any_pass":
		case "majority_pass":
			return `${p.kind}(${(p.stages ?? []).join(", ")})`;
		case "no_open_findings":
			return p.stage ? `no_open_findings(${p.stage})` : "no_open_findings";
		case "finding_count_below": {
			const scope = [p.stage, p.severity].filter(Boolean).join(", ");
			return `findings${scope ? `(${scope})` : ""} < ${p.max ?? "?"}`;
		}
		case "loop_rounds_at_least":
			return `rounds >= ${p.n ?? "?"}`;
		case "stage_retried_at_least":
			return `retries(${p.stage ?? "?"}) >= ${p.n ?? "?"}`;
		case "stage_verdict":
			return `verdict(${p.stage ?? "?"}) = ${p.verdict ?? "?"}`;
		case "and":
		case "or":
			return `${p.kind}( ${(p.predicates ?? []).map(render).join(", ")} )`;
		case "not":
			return `not( ${p.predicate ? render(p.predicate) : "?"} )`;
		default:
			return p.kind;
	}
}
