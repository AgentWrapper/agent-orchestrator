import { describe, expect, it } from "vitest";
import { countStagesFromYaml, parsePipelineValidationIssues } from "./pipeline-yaml";

describe("countStagesFromYaml", () => {
	it("counts block-style stage entries", () => {
		const yaml = `name: review
stages:
  - name: review
    trigger:
      on: [manual]
    executor:
      kind: agent
  - name: guard
    trigger:
      on: [manual]
`;
		expect(countStagesFromYaml(yaml)).toBe(2);
	});

	it("handles a single stage", () => {
		const yaml = `name: review
stages:
  - name: review
    executor:
      kind: agent
`;
		expect(countStagesFromYaml(yaml)).toBe(1);
	});

	it("reads an inline empty sequence as zero", () => {
		expect(countStagesFromYaml("name: x\nstages: []\n")).toBe(0);
	});

	it("reads an inline flow sequence", () => {
		expect(countStagesFromYaml("stages: [a, b, c]")).toBe(3);
	});

	it("returns null when there is no stages key", () => {
		expect(countStagesFromYaml("name: x\n")).toBeNull();
	});

	it("stops counting at a dedent to a sibling key", () => {
		const yaml = `stages:
  - name: one
  - name: two
maxConcurrentStages: 4
`;
		expect(countStagesFromYaml(yaml)).toBe(2);
	});
});

describe("parsePipelineValidationIssues", () => {
	it("extracts the issue list from a validation error body", () => {
		const error = {
			code: "PIPELINE_VALIDATION_FAILED",
			message: "pipeline definition is invalid",
			details: {
				issues: [
					{ path: "stages[0].name", message: "is required" },
					{ path: "name", message: "must not be empty" },
				],
			},
		};
		expect(parsePipelineValidationIssues(error)).toEqual([
			{ path: "stages[0].name", message: "is required" },
			{ path: "name", message: "must not be empty" },
		]);
	});

	it("returns an empty array when the code matches but issues are absent", () => {
		expect(parsePipelineValidationIssues({ code: "PIPELINE_VALIDATION_FAILED", details: {} })).toEqual([]);
	});

	it("returns null for a non-validation error", () => {
		expect(parsePipelineValidationIssues({ code: "NOT_FOUND", message: "missing" })).toBeNull();
		expect(parsePipelineValidationIssues(new Error("boom"))).toBeNull();
		expect(parsePipelineValidationIssues(null)).toBeNull();
	});
});
