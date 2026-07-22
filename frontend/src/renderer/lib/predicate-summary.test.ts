import { describe, expect, it } from "vitest";
import type { PredicateDraft } from "./pipeline-draft";
import { summarizePredicate } from "./predicate-summary";

describe("summarizePredicate", () => {
	it("summarizes an unset predicate as always", () => {
		expect(summarizePredicate(undefined)).toBe("always");
	});

	it.each<[PredicateDraft, string]>([
		[{ kind: "all_pass", stages: ["tests", "review"] }, "all_pass(tests, review)"],
		[{ kind: "any_pass", stages: ["a"] }, "any_pass(a)"],
		[{ kind: "majority_pass", stages: ["a", "b", "c"] }, "majority_pass(a, b, c)"],
		[{ kind: "no_open_findings" }, "no_open_findings"],
		[{ kind: "no_open_findings", stage: "triage" }, "no_open_findings(triage)"],
		[{ kind: "finding_count_below", max: 3 }, "findings < 3"],
		[{ kind: "finding_count_below", max: 1, stage: "triage", severity: "error" }, "findings(triage, error) < 1"],
		[{ kind: "loop_rounds_at_least", n: 5 }, "rounds >= 5"],
		[{ kind: "stage_retried_at_least", stage: "fix", n: 2 }, "retries(fix) >= 2"],
		[{ kind: "stage_verdict", stage: "tests", verdict: "pass" }, "verdict(tests) = pass"],
	])("summarizes each leaf kind", (predicate, expected) => {
		expect(summarizePredicate(predicate)).toBe(expected);
	});

	it("summarizes nested combinators", () => {
		const predicate: PredicateDraft = {
			kind: "and",
			predicates: [
				{ kind: "not", predicate: { kind: "no_open_findings" } },
				{ kind: "or", predicates: [{ kind: "loop_rounds_at_least", n: 2 }] },
			],
		};
		expect(summarizePredicate(predicate)).toBe("and( not( no_open_findings ), or( rounds >= 2 ) )");
	});
});
