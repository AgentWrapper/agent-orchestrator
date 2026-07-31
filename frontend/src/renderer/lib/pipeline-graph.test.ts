import { describe, expect, it } from "vitest";
import type { PipelineDraft, StageDraft } from "./pipeline-draft";
import {
	addStage,
	applyConnection,
	cycleStageIds,
	draftEdges,
	effectiveDeadline,
	findCycle,
	isEdgeInCycle,
	layoutPositions,
	reconcileNeeds,
	removeConnection,
	removeStage,
	stageIndexFromNodeId,
	stageNodeId,
} from "./pipeline-graph";

function stage(id: string, extra: Partial<StageDraft> = {}): StageDraft {
	return { id, executor: "command", run: "true", ...extra };
}

function draftOf(stages: StageDraft[], rest: Partial<PipelineDraft> = {}): PipelineDraft {
	return { name: "p", stages, ...rest };
}

// A fan-out into a join, plus a failure route and a pipeline-level default:
// the shape every v2 canvas feature has to handle.
//
//   a --success--> b --success--> d
//     --success--> c --success--> d
//   b --failure--> diag
//   a, c, d, diag --default-failure--> notify
function fanOutDraft(): PipelineDraft {
	return draftOf(
		[
			stage("a", { onSuccess: ["b", "c"] }),
			stage("b", { onSuccess: ["d"], onFailure: "diag" }),
			stage("c", { onSuccess: ["d"] }),
			stage("d", { needs: ["b", "c"] }),
			stage("diag"),
			stage("notify"),
		],
		{ defaults: { onFailure: "notify" } },
	);
}

describe("stage node identity", () => {
	it("round-trips index <-> node id and rejects garbage", () => {
		expect(stageNodeId(3)).toBe("3");
		expect(stageIndexFromNodeId("3")).toBe(3);
		expect(stageIndexFromNodeId("x")).toBe(-1);
		expect(stageIndexFromNodeId(null)).toBe(-1);
	});
});

describe("draftEdges", () => {
	const edges = draftEdges(fanOutDraft());

	it("derives success edges from onSuccess", () => {
		const success = edges.filter((e) => e.kind === "success").map((e) => `${e.from}->${e.to}`);
		expect(success).toEqual(["a->b", "a->c", "b->d", "c->d"]);
	});

	it("derives failure edges from onFailure", () => {
		const failure = edges.filter((e) => e.kind === "failure").map((e) => `${e.from}->${e.to}`);
		expect(failure).toEqual(["b->diag"]);
	});

	it("synthesizes a default-failure edge for every stage inheriting defaults.onFailure", () => {
		const synthetic = edges.filter((e) => e.kind === "default-failure").map((e) => `${e.from}->${e.to}`);
		// b routes explicitly so it is excluded, and notify (the default target)
		// does not inherit the default: that self-edge would be a cycle (§9.4).
		expect(synthetic).toEqual(["a->notify", "c->notify", "d->notify", "diag->notify"]);
	});

	it("carries node ids alongside stage ids", () => {
		const edge = edges.find((e) => e.from === "a" && e.to === "c" && e.kind === "success");
		expect(edge).toMatchObject({ source: "0", target: "2", id: "0-success->2" });
	});

	it("skips dangling references rather than guessing", () => {
		expect(draftEdges(draftOf([stage("a", { onSuccess: ["ghost"], onFailure: "phantom" })]))).toEqual([]);
	});

	it("gives dagre every stage a position", () => {
		const positions = layoutPositions(fanOutDraft());
		expect(Object.keys(positions).sort()).toEqual(["0", "1", "2", "3", "4", "5"]);
	});
});

describe("cycle detection", () => {
	// A --fail--> B --fail--> A is expressible in a state machine and is an
	// infinite loop; the server rejects it, and the canvas mirrors that.
	const failureLoop = draftOf([stage("a", { onFailure: "b" }), stage("b", { onFailure: "a" })]);

	it("flags both stages on a failure loop", () => {
		expect(cycleStageIds(failureLoop)).toEqual(new Set(["a", "b"]));
	});

	it("flags the edges of a failure loop", () => {
		for (const edge of draftEdges(failureLoop)) expect(isEdgeInCycle(failureLoop, edge)).toBe(true);
	});

	it("mixes success and failure edges in one cycle", () => {
		const mixed = draftOf([stage("a", { onSuccess: ["b"] }), stage("b", { onFailure: "a" })]);
		expect(cycleStageIds(mixed)).toEqual(new Set(["a", "b"]));
	});

	it("counts synthetic default-failure edges", () => {
		// notify routes back into a, and a inherits notify as its failure target:
		// the loop only exists because of the synthetic edge.
		const looped = draftOf([stage("a"), stage("notify", { onSuccess: ["a"] })], {
			defaults: { onFailure: "notify" },
		});
		expect(cycleStageIds(looped)).toEqual(new Set(["a", "notify"]));
	});

	it("leaves an acyclic draft clean", () => {
		const draft = fanOutDraft();
		expect(cycleStageIds(draft)).toEqual(new Set());
		for (const edge of draftEdges(draft)) expect(isEdgeInCycle(draft, edge)).toBe(false);
	});

	it("reports the path a proposed edge would close", () => {
		const draft = fanOutDraft();
		expect(findCycle(draft, "d", "a")).toEqual(["a", "b", "d", "a"]);
		expect(findCycle(draft, "a", "a")).toEqual(["a"]);
		expect(findCycle(draft, "diag", "d")).toBeNull();
	});
});

describe("needs auto-maintenance", () => {
	it("adds needs when a second inbound success edge arrives", () => {
		const before = draftOf([stage("a", { onSuccess: ["d"] }), stage("b"), stage("d")]);
		expect(before.stages[2].needs).toBeUndefined();

		const result = applyConnection(before, "1", "2", "success");
		expect(result.kind).toBe("added");
		if (result.kind !== "added") return;
		expect(result.draft.stages[1].onSuccess).toEqual(["d"]);
		expect(result.draft.stages[2].needs).toEqual(["a", "b"]);
	});

	it("drops needs when the count falls back to one", () => {
		const joined = fanOutDraft();
		expect(joined.stages[3].needs).toEqual(["b", "c"]);

		const after = removeConnection(joined, 2, "d", "success");
		expect(after.stages[2].onSuccess).toBeUndefined();
		expect(after.stages[3].needs).toBeUndefined();
	});

	it("keeps needs in document order and never counts failure edges", () => {
		const draft = draftOf([
			stage("first", { onSuccess: ["join"] }),
			stage("second", { onSuccess: ["join"] }),
			stage("third", { onFailure: "join" }),
			stage("join"),
		]);
		expect(reconcileNeeds(draft).stages[3].needs).toEqual(["first", "second"]);
	});

	it("rewrites a hand-authored needs that no longer matches the edges", () => {
		const drifted = draftOf([
			stage("a", { onSuccess: ["j"] }),
			stage("b", { onSuccess: ["j"] }),
			stage("j", { needs: ["a", "ghost"] }),
		]);
		expect(reconcileNeeds(drifted).stages[2].needs).toEqual(["a", "b"]);
	});

	it("returns the same draft when nothing needs changing", () => {
		const draft = fanOutDraft();
		expect(reconcileNeeds(draft)).toBe(draft);
	});
});

describe("applyConnection", () => {
	it("appends a success successor", () => {
		const draft = draftOf([stage("a", { onSuccess: ["b"] }), stage("b"), stage("c")]);
		const result = applyConnection(draft, "0", "2", "success");
		expect(result.kind === "added" && result.draft.stages[0].onSuccess).toEqual(["b", "c"]);
	});

	it("replaces the single failure successor", () => {
		const draft = draftOf([stage("a", { onFailure: "b" }), stage("b"), stage("c")]);
		const result = applyConnection(draft, "0", "2", "failure");
		expect(result.kind === "added" && result.draft.stages[0].onFailure).toBe("c");
	});

	it("blocks a self-edge and a closing edge, returning the path", () => {
		const draft = draftOf([stage("a", { onSuccess: ["b"] }), stage("b")]);
		expect(applyConnection(draft, "0", "0", "success")).toEqual({ kind: "cycle", path: ["a"] });
		expect(applyConnection(draft, "1", "0", "failure")).toEqual({ kind: "cycle", path: ["a", "b", "a"] });
	});

	it("is a no-op for an existing edge or an unnamed endpoint", () => {
		const draft = draftOf([stage("a", { onSuccess: ["b"] }), stage("b"), stage("")]);
		expect(applyConnection(draft, "0", "1", "success")).toEqual({ kind: "noop" });
		expect(applyConnection(draft, "0", "2", "success")).toEqual({ kind: "noop" });
		expect(applyConnection(draft, "0", "9", "success")).toEqual({ kind: "noop" });
	});
});

describe("removeConnection", () => {
	it("clears the failure successor", () => {
		const after = removeConnection(draftOf([stage("a", { onFailure: "b" }), stage("b")]), 0, "b", "failure");
		expect(after.stages[0].onFailure).toBeUndefined();
	});

	it("leaves a synthetic default-failure edge alone", () => {
		const draft = draftOf([stage("a"), stage("notify")], { defaults: { onFailure: "notify" } });
		expect(removeConnection(draft, 0, "notify", "default-failure")).toBe(draft);
	});
});

describe("removeStage", () => {
	it("scrubs every reference to the removed stage", () => {
		const after = removeStage(fanOutDraft(), 1); // b
		expect(after.stages.map((s) => s.id)).toEqual(["a", "c", "d", "diag", "notify"]);
		expect(after.stages[0].onSuccess).toEqual(["c"]);
		// d is down to one inbound success edge, so its needs key goes away.
		expect(after.stages[2].needs).toBeUndefined();
	});

	it("clears defaults.onFailure when its target is removed", () => {
		const after = removeStage(fanOutDraft(), 5); // notify
		expect(after.defaults).toBeUndefined();
	});

	it("keeps edges alive when a duplicate id remains", () => {
		const draft = draftOf([stage("a", { onSuccess: ["dup"] }), stage("dup"), stage("dup")]);
		expect(removeStage(draft, 2).stages[0].onSuccess).toEqual(["dup"]);
	});

	it("is a no-op out of range", () => {
		const draft = fanOutDraft();
		expect(removeStage(draft, 99)).toBe(draft);
	});
});

describe("addStage", () => {
	it("appends an agent stage under the first unused id", () => {
		const { draft, id } = addStage(draftOf([stage("stage-2")]));
		expect(id).toBe("stage-3");
		expect(draft.stages[1]).toMatchObject({ id: "stage-3", executor: "agent" });
	});
});

describe("effectiveDeadline", () => {
	it("prefers the stage, then the pipeline default, then the engine fallback", () => {
		const draft = draftOf([stage("a", { deadline: "40m" }), stage("b")], { defaults: { deadline: "45m" } });
		expect(effectiveDeadline(draft, draft.stages[0])).toBe("40m");
		expect(effectiveDeadline(draft, draft.stages[1])).toBe("45m");
		expect(effectiveDeadline(draftOf([stage("b")]), stage("b"))).toBe("30m");
	});
});
