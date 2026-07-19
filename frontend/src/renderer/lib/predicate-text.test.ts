import { describe, expect, it } from "vitest";
import { compilePredicateToText } from "./predicate-text";
import type { PredicateDraft } from "./pipeline-draft";

describe("compilePredicateToText", () => {
	it("compiles no condition to always", () => {
		expect(compilePredicateToText(undefined)).toBe("always");
	});

	it.each<[PredicateDraft, string]>([
		[{ kind: "all_pass", stages: ["security-review", "style-review"] }, "all_pass[security-review, style-review]"],
		[{ kind: "any_pass", stages: ["lint"] }, "any_pass[lint]"],
		[{ kind: "majority_pass", stages: [] }, "majority_pass[]"],
		[{ kind: "no_open_findings" }, "no_open_findings"],
		[{ kind: "no_open_findings", stage: "verify" }, "no_open_findings(verify)"],
		[{ kind: "finding_count_below", max: 2 }, "finding_count_below(2)"],
		[{ kind: "finding_count_below", max: 2, stage: "verify" }, "finding_count_below(2, verify)"],
		[
			{ kind: "finding_count_below", max: 2, stage: "verify", severity: "error" },
			"finding_count_below(2, verify, error)",
		],
		[{ kind: "finding_count_below", max: 2, severity: "warning" }, "finding_count_below(2, *, warning)"],
		[{ kind: "finding_count_below" }, "finding_count_below(?)"],
		[{ kind: "loop_rounds_at_least", n: 2 }, "loop_rounds_at_least(2)"],
		[{ kind: "loop_rounds_at_least" }, "loop_rounds_at_least(?)"],
		[{ kind: "stage_retried_at_least", stage: "fix", n: 3 }, "stage_retried_at_least(fix, 3)"],
		[{ kind: "stage_retried_at_least" }, "stage_retried_at_least(?, ?)"],
		[{ kind: "stage_verdict", stage: "verify", verdict: "pass" }, "stage_verdict(verify, pass)"],
		[{ kind: "stage_verdict" }, "stage_verdict(?, ?)"],
	])("compiles leaf %j", (draft, expected) => {
		expect(compilePredicateToText(draft)).toBe(expected);
	});

	it("compiles composites inline", () => {
		const draft: PredicateDraft = {
			kind: "and",
			predicates: [
				{ kind: "no_open_findings" },
				{ kind: "stage_verdict", stage: "verify", verdict: "pass" },
				{
					kind: "or",
					predicates: [
						{ kind: "loop_rounds_at_least", n: 2 },
						{ kind: "all_pass", stages: ["security-review", "style-review"] },
					],
				},
			],
		};
		expect(compilePredicateToText(draft)).toBe(
			"and( no_open_findings, stage_verdict(verify, pass), or( loop_rounds_at_least(2), all_pass[security-review, style-review] ) )",
		);
	});

	it("compiles not and empty groups", () => {
		expect(compilePredicateToText({ kind: "not", predicate: { kind: "no_open_findings" } })).toBe(
			"not( no_open_findings )",
		);
		expect(compilePredicateToText({ kind: "not" })).toBe("not( ? )");
		expect(compilePredicateToText({ kind: "or", predicates: [] })).toBe("or( )");
	});

	it("pretty-prints a root and/or one child per line, nested composites inline", () => {
		const draft: PredicateDraft = {
			kind: "and",
			predicates: [
				{ kind: "no_open_findings" },
				{ kind: "stage_verdict", stage: "verify", verdict: "pass" },
				{
					kind: "or",
					predicates: [
						{ kind: "loop_rounds_at_least", n: 2 },
						{ kind: "all_pass", stages: ["security-review", "style-review"] },
					],
				},
			],
		};
		expect(compilePredicateToText(draft, { pretty: true })).toBe(
			[
				"and(",
				"  no_open_findings,",
				"  stage_verdict(verify, pass),",
				"  or( loop_rounds_at_least(2), all_pass[security-review, style-review] )",
				")",
			].join("\n"),
		);
	});

	it("pretty falls back to inline for leaves, not-roots, and empty groups", () => {
		expect(compilePredicateToText({ kind: "no_open_findings" }, { pretty: true })).toBe("no_open_findings");
		expect(compilePredicateToText({ kind: "not", predicate: { kind: "no_open_findings" } }, { pretty: true })).toBe(
			"not( no_open_findings )",
		);
		expect(compilePredicateToText({ kind: "and", predicates: [] }, { pretty: true })).toBe("and( )");
	});
});
