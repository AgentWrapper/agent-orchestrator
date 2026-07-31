import { describe, expect, it } from "vitest";
import type { PipelineDraft, StageDraft } from "./pipeline-draft";
import { issueStageNodeId, stageIssueMessages, stageYamlLine } from "./pipeline-problems";

function stage(id: string): StageDraft {
	return { id, executor: "agent", agent: "claude-code" };
}

const draft: PipelineDraft = { name: "review", stages: [stage("a"), stage("b")] };

describe("issueStageNodeId", () => {
	it("resolves a stage-scoped path to the stage's node id", () => {
		expect(issueStageNodeId(draft, { path: "stages[1].executor", message: "m" })).toBe("1");
		expect(issueStageNodeId(draft, { path: "stages[0]", message: "m" })).toBe("0");
	});

	it("resolves the v2 routing keys", () => {
		expect(issueStageNodeId(draft, { path: "stages[0].onSuccess", message: "m" })).toBe("0");
		expect(issueStageNodeId(draft, { path: "stages[1].onFailure", message: "m" })).toBe("1");
		expect(issueStageNodeId(draft, { path: "stages[1].needs[0]", message: "m" })).toBe("1");
		expect(issueStageNodeId(draft, { path: "stages[0].session.killOn", message: "m" })).toBe("0");
	});

	it("resolves paths for stages with an empty id (they need a Reveal target)", () => {
		const unnamed: PipelineDraft = { name: "review", stages: [stage("")] };
		expect(issueStageNodeId(unnamed, { path: "stages[0].id", message: "must not be empty" })).toBe("0");
	});

	it("returns null for document-level and dangling paths", () => {
		expect(issueStageNodeId(draft, { path: "name", message: "m" })).toBeNull();
		expect(issueStageNodeId(draft, { path: "defaults.onFailure", message: "m" })).toBeNull();
		expect(issueStageNodeId(draft, { path: "stages[9].id", message: "m" })).toBeNull();
	});
});

describe("stageIssueMessages", () => {
	it("groups messages by the node id they resolve to and drops the rest", () => {
		const grouped = stageIssueMessages(draft, [
			{ path: "stages[0].id", message: "first" },
			{ path: "stages[0].executor", message: "second" },
			{ path: "stages[1].onSuccess", message: "other" },
			{ path: "name", message: "document-level" },
		]);
		expect(grouped).toEqual({ "0": ["first", "second"], "1": ["other"] });
	});
});

describe("stageYamlLine", () => {
	const source = "name: fix\nstages:\n  - id: intake\n    executor: agent\n    agent: claude-code\n  - id: fix\n";

	it("finds the 1-based line of the stage's id entry", () => {
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
