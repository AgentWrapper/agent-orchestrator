import { describe, expect, it } from "vitest";
import type { PipelineDraft, StageDraft } from "./pipeline-draft";
import {
	addDependency,
	addStage,
	applyConnection,
	cycleMembers,
	draftEdges,
	findCycle,
	isEdgeInCycle,
	layoutPositions,
	removeDependency,
	stageNodeId,
} from "./pipeline-graph";

function stage(name: string, dependsOn?: string[]): StageDraft {
	const s: StageDraft = {
		name,
		trigger: { on: ["manual"] },
		executor: { kind: "agent", plugin: "claude-code", mode: "review" },
	};
	if (dependsOn) s.dependsOn = dependsOn;
	return s;
}

function draftOf(...stages: StageDraft[]): PipelineDraft {
	return { name: "p", stages };
}

describe("stageNodeId", () => {
	it("uses the stage name and falls back to a placeholder for unnamed stages", () => {
		expect(stageNodeId(stage("build"), 0)).toBe("build");
		expect(stageNodeId(stage(""), 3)).toBe("__stage-3");
	});
});

describe("draftEdges", () => {
	it("maps every dependsOn entry to a dependency -> dependent edge", () => {
		const draft = draftOf(stage("a"), stage("b", ["a"]), stage("c", ["a", "b"]));
		expect(draftEdges(draft)).toEqual([
			{ id: "a->b", dep: "a", dependent: "b" },
			{ id: "a->c", dep: "a", dependent: "c" },
			{ id: "b->c", dep: "b", dependent: "c" },
		]);
	});

	it("skips dependsOn references to stages that do not exist", () => {
		const draft = draftOf(stage("a"), stage("b", ["a", "ghost"]));
		expect(draftEdges(draft)).toEqual([{ id: "a->b", dep: "a", dependent: "b" }]);
	});
});

describe("addDependency / removeDependency", () => {
	it("adds a dependency without duplicating and without mutating the input", () => {
		const draft = draftOf(stage("a"), stage("b"));
		const next = addDependency(draft, "b", "a");
		expect(next.stages[1].dependsOn).toEqual(["a"]);
		expect(draft.stages[1].dependsOn).toBeUndefined();
		expect(addDependency(next, "b", "a").stages[1].dependsOn).toEqual(["a"]);
	});

	it("removes a dependency and drops the empty dependsOn key", () => {
		const draft = draftOf(stage("a"), stage("b", ["a"]));
		const next = removeDependency(draft, "b", "a");
		expect(next.stages[1].dependsOn).toBeUndefined();
	});
});

describe("findCycle", () => {
	it("flags a self-edge as a one-node cycle", () => {
		expect(findCycle(draftOf(stage("a")), "a", "a")).toEqual(["a"]);
	});

	it("flags a direct two-stage cycle with its path", () => {
		const draft = draftOf(stage("a", ["b"]), stage("b"));
		// b already depends on nothing; a depends on b. Adding a to b's dependsOn
		// closes b -> a -> b.
		expect(findCycle(draft, "b", "a")).toEqual(["a", "b"]);
	});

	it("flags a transitive cycle through intermediate stages", () => {
		const draft = draftOf(stage("a"), stage("b", ["a"]), stage("c", ["b"]));
		expect(findCycle(draft, "a", "c")).toEqual(["c", "b", "a"]);
	});

	it("returns null for an edge that keeps the graph acyclic", () => {
		const draft = draftOf(stage("a"), stage("b", ["a"]));
		expect(findCycle(draft, "c", "b")).toBeNull();
	});
});

describe("applyConnection", () => {
	it("adds source to target's dependsOn (drawing dep -> dependent)", () => {
		const result = applyConnection(draftOf(stage("a"), stage("b")), "a", "b");
		expect(result.kind).toBe("added");
		if (result.kind === "added") expect(result.draft.stages[1].dependsOn).toEqual(["a"]);
	});

	it("blocks a self-edge as a cycle", () => {
		const result = applyConnection(draftOf(stage("a")), "a", "a");
		expect(result).toEqual({ kind: "cycle", path: ["a"] });
	});

	it("blocks an edge that would close a dependency cycle", () => {
		const draft = draftOf(stage("a"), stage("b", ["a"]), stage("c", ["b"]));
		const result = applyConnection(draft, "c", "a");
		expect(result).toEqual({ kind: "cycle", path: ["c", "b", "a"] });
	});

	it("is a noop for an existing dependency or unknown endpoints", () => {
		const draft = draftOf(stage("a"), stage("b", ["a"]));
		expect(applyConnection(draft, "a", "b")).toEqual({ kind: "noop" });
		expect(applyConnection(draft, "ghost", "b")).toEqual({ kind: "noop" });
	});
});

describe("cycleMembers / isEdgeInCycle", () => {
	it("marks the stages and edges on a cycle already present in the draft", () => {
		const draft = draftOf(stage("intake"), stage("fix", ["verify", "intake"]), stage("verify", ["fix"]));
		expect(cycleMembers(draft)).toEqual(new Set(["fix", "verify"]));
		expect(isEdgeInCycle(draft, { id: "verify->fix", dep: "verify", dependent: "fix" })).toBe(true);
		expect(isEdgeInCycle(draft, { id: "intake->fix", dep: "intake", dependent: "fix" })).toBe(false);
	});

	it("is empty for an acyclic draft", () => {
		expect(cycleMembers(draftOf(stage("a"), stage("b", ["a"])))).toEqual(new Set());
	});
});

describe("layoutPositions", () => {
	it("assigns every stage a position with dependencies left of dependents", () => {
		const draft = draftOf(stage("a"), stage("b", ["a"]), stage("c", ["b"]));
		const positions = layoutPositions(draft);
		expect(Object.keys(positions).sort()).toEqual(["a", "b", "c"]);
		expect(positions.a.x).toBeLessThan(positions.b.x);
		expect(positions.b.x).toBeLessThan(positions.c.x);
	});

	it("separates independent stages instead of stacking them at one point", () => {
		const positions = layoutPositions(draftOf(stage("a"), stage("b")));
		expect(positions.a).not.toEqual(positions.b);
	});
});

describe("addStage", () => {
	it("appends a default agent stage under the first unused stage-N name", () => {
		const { draft, name } = addStage(draftOf(stage("a")));
		expect(name).toBe("stage-2");
		expect(draft.stages).toHaveLength(2);
		expect(draft.stages[1]).toEqual({
			name: "stage-2",
			trigger: { on: ["manual"] },
			executor: { kind: "agent", plugin: "claude-code", mode: "review" },
		});
	});

	it("skips names already taken", () => {
		const { name } = addStage(draftOf(stage("stage-2")));
		expect(name).toBe("stage-3");
	});
});
