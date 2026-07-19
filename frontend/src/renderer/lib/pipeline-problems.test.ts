import { describe, expect, it } from "vitest";
import type { PipelineDraft, StageDraft } from "./pipeline-draft";
import { issueStageNodeId, stageIssueMessages, stageYamlLine } from "./pipeline-problems";

function stage(name: string): StageDraft {
	return { name, trigger: { on: ["manual"] }, executor: { kind: "agent" } };
}

const draft: PipelineDraft = { name: "review", stages: [stage("a"), stage("b")] };

describe("issueStageNodeId", () => {
	it("resolves a stage-scoped path to the stage's node id", () => {
		expect(issueStageNodeId(draft, { path: "stages[1].executor.kind", message: "m" })).toBe("1");
		expect(issueStageNodeId(draft, { path: "stages[0]", message: "m" })).toBe("0");
	});

	it("resolves paths for unnamed stages (they need a Reveal target)", () => {
		const unnamed: PipelineDraft = { name: "review", stages: [stage("")] };
		expect(issueStageNodeId(unnamed, { path: "stages[0].name", message: "must not be empty" })).toBe("0");
	});

	it("returns null for document-level and dangling paths", () => {
		expect(issueStageNodeId(draft, { path: "name", message: "m" })).toBeNull();
		expect(issueStageNodeId(draft, { path: "exitPredicates.done", message: "m" })).toBeNull();
		expect(issueStageNodeId(draft, { path: "stages[9].name", message: "m" })).toBeNull();
	});
});

describe("stageIssueMessages", () => {
	it("groups messages by the node id they resolve to and drops the rest", () => {
		const grouped = stageIssueMessages(draft, [
			{ path: "stages[0].name", message: "first" },
			{ path: "stages[0].executor", message: "second" },
			{ path: "stages[1].trigger", message: "other" },
			{ path: "name", message: "document-level" },
		]);
		expect(grouped).toEqual({ "0": ["first", "second"], "1": ["other"] });
	});
});

describe("stageYamlLine", () => {
	const source = "name: fix\nstages:\n  - name: intake\n    executor:\n      kind: agent\n  - name: fix\n";

	it("finds the 1-based line of the stage's name entry", () => {
		expect(stageYamlLine(source, "intake")).toBe(3);
	});

	it("matches inside the stages block only, never the pipeline-level name", () => {
		// The pipeline is also called "fix" (line 1); the stage is on line 6.
		expect(stageYamlLine(source, "fix")).toBe(6);
	});

	it("returns null when the stage cannot be located", () => {
		expect(stageYamlLine(source, "missing")).toBeNull();
		expect(stageYamlLine(source, "")).toBeNull();
	});
});
