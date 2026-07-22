// Compiles a PredicateDraft tree into the textual predicate DSL shown in the
// builder's "Compiled predicate · matches the DSL" readout (mockup 1b). Display
// only: the YAML codec in pipeline-draft.ts remains the persisted form.
//
// Grammar (matches backend/internal/pipeline/predicate.go kinds exactly):
//   all_pass[a, b]  any_pass[...]  majority_pass[...]
//   no_open_findings              no_open_findings(stage)
//   finding_count_below(max)      finding_count_below(max, stage)
//   finding_count_below(max, stage, severity)
//   finding_count_below(max, *, severity)   ("*" = any stage)
//   loop_rounds_at_least(n)
//   stage_retried_at_least(stage, n)
//   stage_verdict(stage, verdict)
//   and( p, q )   or( p, q )   not( p )
// A missing required scalar renders as "?" so incomplete rows stay legible.
// With { pretty: true } an and/or ROOT breaks its children one per line
// (nested composites stay inline), matching the mockup readout. An undefined
// predicate compiles to "always" (no condition).

import type { PredicateDraft } from "./pipeline-draft";

export function compilePredicateToText(value: PredicateDraft | undefined, opts: { pretty?: boolean } = {}): string {
	if (!value) return "always";
	const children = value.predicates ?? [];
	if (opts.pretty && (value.kind === "and" || value.kind === "or") && children.length > 0) {
		return `${value.kind}(\n${children
			.map((c) => `  ${compile(c)},`)
			.join("\n")
			.replace(/,$/, "")}\n)`;
	}
	return compile(value);
}

function compile(p: PredicateDraft): string {
	switch (p.kind) {
		case "all_pass":
		case "any_pass":
		case "majority_pass":
			return `${p.kind}[${(p.stages ?? []).join(", ")}]`;
		case "no_open_findings":
			return p.stage ? `no_open_findings(${p.stage})` : "no_open_findings";
		case "finding_count_below": {
			const args = [p.max ?? "?"];
			if (p.stage) args.push(p.stage);
			else if (p.severity) args.push("*");
			if (p.severity) args.push(p.severity);
			return `finding_count_below(${args.join(", ")})`;
		}
		case "loop_rounds_at_least":
			return `loop_rounds_at_least(${p.n ?? "?"})`;
		case "stage_retried_at_least":
			return `stage_retried_at_least(${p.stage || "?"}, ${p.n ?? "?"})`;
		case "stage_verdict":
			return `stage_verdict(${p.stage || "?"}, ${p.verdict || "?"})`;
		case "and":
		case "or": {
			const children = p.predicates ?? [];
			return children.length > 0 ? `${p.kind}( ${children.map(compile).join(", ")} )` : `${p.kind}( )`;
		}
		case "not":
			return `not( ${p.predicate ? compile(p.predicate) : "?"} )`;
	}
}
