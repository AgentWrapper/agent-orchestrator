import { describe, expect, it } from "vitest";
import type { PipelineDraft, StageDraft } from "./pipeline-draft";
import {
	addStage,
	applyConnection,
	cycleMembers,
	draftEdges,
	findCycle,
	isEdgeInCycle,
	layoutPositions,
	removeDependency,
	removeStage,
	stageIndexFromNodeId,
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

describe("stageNodeId / stageIndexFromNodeId", () => {
	it("round-trips the array index, independent of the stage name", () => {
		expect(stageNodeId(0)).toBe("0");
		expect(stageNodeId(3)).toBe("3");
		expect(stageIndexFromNodeId(stageNodeId(3))).toBe(3);
	});

	it("rejects null and non-index ids", () => {
		expect(stageIndexFromNodeId(null)).toBe(-1);
		expect(stageIndexFromNodeId(undefined)).toBe(-1);
		expect(stageIndexFromNodeId("build")).toBe(-1);
		expect(stageIndexFromNodeId("-1")).toBe(-1);
		expect(stageIndexFromNodeId("")).toBe(-1);
	});
});

describe("draftEdges", () => {
	it("maps every dependsOn entry to a dependency -> dependent edge", () => {
		const draft = draftOf(stage("a"), stage("b", ["a"]), stage("c", ["a", "b"]));
		expect(draftEdges(draft)).toEqual([
			{ id: "0->1", source: "0", target: "1", dep: "a", dependent: "b" },
			{ id: "0->2", source: "0", target: "2", dep: "a", dependent: "c" },
			{ id: "1->2", source: "1", target: "2", dep: "b", dependent: "c" },
		]);
	});

	it("skips dependsOn references to stages that do not exist", () => {
		const draft = draftOf(stage("a"), stage("b", ["a", "ghost"]));
		expect(draftEdges(draft)).toEqual([{ id: "0->1", source: "0", target: "1", dep: "a", dependent: "b" }]);
	});

	it("keeps edges to duplicate-named dependents distinct", () => {
		const draft = draftOf(stage("a"), stage("dup", ["a"]), stage("dup", ["a"]));
		expect(draftEdges(draft).map((e) => e.id)).toEqual(["0->1", "0->2"]);
	});
});

describe("removeDependency", () => {
	it("removes a dependency from the exact stage index and drops the empty key", () => {
		const draft = draftOf(stage("a"), stage("b", ["a"]));
		const next = removeDependency(draft, 1, "a");
		expect(next.stages[1].dependsOn).toBeUndefined();
		expect(draft.stages[1].dependsOn).toEqual(["a"]);
	});

	it("is a no-op for an out-of-range index", () => {
		const draft = draftOf(stage("a"), stage("b", ["a"]));
		expect(removeDependency(draft, 9, "a")).toBe(draft);
	});
});

describe("removeStage", () => {
	it("removes the stage and scrubs it from other stages' dependsOn without mutating", () => {
		const draft = draftOf(stage("a"), stage("b", ["a"]), stage("c", ["a", "b"]));
		const next = removeStage(draft, 0);
		expect(next.stages.map((s) => s.name)).toEqual(["b", "c"]);
		expect(next.stages[0].dependsOn).toBeUndefined();
		expect(next.stages[1].dependsOn).toEqual(["b"]);
		// Input untouched.
		expect(draft.stages.map((s) => s.name)).toEqual(["a", "b", "c"]);
		expect(draft.stages[1].dependsOn).toEqual(["a"]);
		expect(draft.stages[2].dependsOn).toEqual(["a", "b"]);
	});

	it("removes an unnamed stage without touching other dependsOn lists", () => {
		const draft = draftOf(stage("a"), stage(""), stage("b", ["a"]));
		const next = removeStage(draft, 1);
		expect(next.stages.map((s) => s.name)).toEqual(["a", "b"]);
		expect(next.stages[1].dependsOn).toEqual(["a"]);
	});

	it("keeps dependsOn intact when a duplicate of the removed name survives", () => {
		const draft = draftOf(stage("dup"), stage("dup"), stage("c", ["dup"]));
		const next = removeStage(draft, 0);
		expect(next.stages.map((s) => s.name)).toEqual(["dup", "c"]);
		expect(next.stages[1].dependsOn).toEqual(["dup"]);
	});

	it("is a no-op for an out-of-range index", () => {
		const draft = draftOf(stage("a"));
		expect(removeStage(draft, 5)).toBe(draft);
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
	it("adds source to target's dependsOn (drawing dep -> dependent, by node id)", () => {
		const result = applyConnection(draftOf(stage("a"), stage("b")), "0", "1");
		expect(result.kind).toBe("added");
		if (result.kind === "added") expect(result.draft.stages[1].dependsOn).toEqual(["a"]);
	});

	it("blocks a self-edge as a cycle", () => {
		const result = applyConnection(draftOf(stage("a")), "0", "0");
		expect(result).toEqual({ kind: "cycle", path: ["a"] });
	});

	it("blocks an edge that would close a dependency cycle", () => {
		const draft = draftOf(stage("a"), stage("b", ["a"]), stage("c", ["b"]));
		const result = applyConnection(draft, "2", "0");
		expect(result).toEqual({ kind: "cycle", path: ["c", "b", "a"] });
	});

	it("is a noop for an existing dependency, unknown endpoints, or unnamed stages", () => {
		const draft = draftOf(stage("a"), stage("b", ["a"]));
		expect(applyConnection(draft, "0", "1")).toEqual({ kind: "noop" });
		expect(applyConnection(draft, "9", "1")).toEqual({ kind: "noop" });
		expect(applyConnection(draftOf(stage(""), stage("b")), "0", "1")).toEqual({ kind: "noop" });
	});
});

describe("cycleMembers / isEdgeInCycle", () => {
	it("marks the stages and edges on a cycle already present in the draft", () => {
		const draft = draftOf(stage("intake"), stage("fix", ["verify", "intake"]), stage("verify", ["fix"]));
		expect(cycleMembers(draft)).toEqual(new Set(["fix", "verify"]));
		expect(isEdgeInCycle(draft, { id: "2->1", source: "2", target: "1", dep: "verify", dependent: "fix" })).toBe(true);
		expect(isEdgeInCycle(draft, { id: "0->1", source: "0", target: "1", dep: "intake", dependent: "fix" })).toBe(false);
	});

	it("is empty for an acyclic draft", () => {
		expect(cycleMembers(draftOf(stage("a"), stage("b", ["a"])))).toEqual(new Set());
	});
});

describe("layoutPositions", () => {
	it("assigns every stage a position with dependencies left of dependents", () => {
		const draft = draftOf(stage("a"), stage("b", ["a"]), stage("c", ["b"]));
		const positions = layoutPositions(draft);
		expect(Object.keys(positions).sort()).toEqual(["0", "1", "2"]);
		expect(positions["0"].x).toBeLessThan(positions["1"].x);
		expect(positions["1"].x).toBeLessThan(positions["2"].x);
	});

	it("separates independent stages instead of stacking them at one point", () => {
		const positions = layoutPositions(draftOf(stage("a"), stage("b")));
		expect(positions["0"]).not.toEqual(positions["1"]);
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
