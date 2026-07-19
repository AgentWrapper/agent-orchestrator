// Pure graph helpers for the pipeline canvas (V2): draft -> nodes/edges
// mapping, dagre auto-layout, dependsOn mutations, and cycle detection.
//
// Convention (mockup 1a, the design source of truth): edges point in execution
// order, dependency -> dependent. Drawing an edge from A's source handle to B's
// target handle therefore adds A to B's dependsOn. All mutations return a new
// draft; the canvas pushes it through usePipelineDraft's setDraft so
// serialization/validation stays centralized.

import dagre from "dagre";
import type { PipelineDraft, StageDraft } from "./pipeline-draft";

// Fixed card footprint the layout assumes; the rendered card is w-52 with a
// content-dependent height this estimate stays close enough to for spacing.
export const STAGE_NODE_WIDTH = 208;
export const STAGE_NODE_HEIGHT = 96;

export interface StagePosition {
	x: number;
	y: number;
}

// Stage identity is the array index, not the name: it is unique even for
// empty or duplicate names (which the user must be able to select to fix) and
// deterministic across the debounced YAML re-parse, so selection and node
// positions survive typing. Names remain the config reference (dependsOn,
// routes, predicates); helpers below translate at the boundary.
export function stageNodeId(index: number): string {
	return String(index);
}

// stageIndexFromNodeId is the inverse of stageNodeId; -1 for null/garbage.
export function stageIndexFromNodeId(id: string | null | undefined): number {
	if (id == null || !/^\d+$/.test(id)) return -1;
	return Number(id);
}

export interface DraftEdge {
	id: string;
	// Node ids: the dep stage runs first (edge source), the dependent stage
	// declares `dependsOn: [dep]` (edge target).
	source: string;
	target: string;
	// The same endpoints as config references (stage names).
	dep: string;
	dependent: string;
}

export function edgeId(source: string, target: string): string {
	return `${source}->${target}`;
}

// draftEdges maps every dependsOn entry that references an existing stage to an
// edge. Dangling references have no node to attach to; the /validate endpoint
// reports them, so they are skipped here rather than guessed at. A dependsOn
// name resolves to its first occurrence when names are duplicated.
export function draftEdges(draft: PipelineDraft): DraftEdge[] {
	const indexByName = new Map<string, number>();
	draft.stages.forEach((s, i) => {
		if (s.name && !indexByName.has(s.name)) indexByName.set(s.name, i);
	});
	const edges: DraftEdge[] = [];
	draft.stages.forEach((stage, i) => {
		if (!stage.name) return;
		for (const dep of stage.dependsOn ?? []) {
			const depIndex = indexByName.get(dep);
			if (depIndex === undefined) continue;
			const source = stageNodeId(depIndex);
			const target = stageNodeId(i);
			edges.push({ id: edgeId(source, target), source, target, dep, dependent: stage.name });
		}
	});
	return edges;
}

// layoutPositions runs dagre left-to-right (mockup 1a flows dependency ->
// dependent) and returns top-left positions keyed by node id.
export function layoutPositions(draft: PipelineDraft): Record<string, StagePosition> {
	const g = new dagre.graphlib.Graph();
	g.setGraph({ rankdir: "LR", nodesep: 32, ranksep: 64 });
	g.setDefaultEdgeLabel(() => ({}));
	draft.stages.forEach((_stage, i) => {
		g.setNode(stageNodeId(i), { width: STAGE_NODE_WIDTH, height: STAGE_NODE_HEIGHT });
	});
	for (const edge of draftEdges(draft)) g.setEdge(edge.source, edge.target);
	dagre.layout(g);

	const positions: Record<string, StagePosition> = {};
	draft.stages.forEach((_stage, i) => {
		const id = stageNodeId(i);
		const node = g.node(id);
		if (node) positions[id] = { x: node.x - STAGE_NODE_WIDTH / 2, y: node.y - STAGE_NODE_HEIGHT / 2 };
	});
	return positions;
}

// findCycle returns the stage-name path of the cycle that adding
// `dependent.dependsOn += dep` would create ([dep, ..., dependent]), or null
// when the edge is safe. A self-edge is the one-node cycle [dep].
export function findCycle(draft: PipelineDraft, dependent: string, dep: string): string[] | null {
	if (dependent === dep) return [dep];
	const dependsOn = new Map(draft.stages.map((s) => [s.name, s.dependsOn ?? []]));
	// The new edge closes a loop iff dep already (transitively) depends on
	// dependent: dep -> ... -> dependent through dependsOn links.
	const path: string[] = [];
	const seen = new Set<string>();
	const dfs = (from: string): boolean => {
		if (from === dependent) return true;
		if (seen.has(from)) return false;
		seen.add(from);
		path.push(from);
		for (const next of dependsOn.get(from) ?? []) {
			if (dfs(next)) return true;
		}
		path.pop();
		return false;
	};
	return dfs(dep) ? [...path, dependent] : null;
}

// cycleMembers finds every stage already inside a dependency cycle in the
// draft (cycles can arrive through YAML-mode edits), so the canvas can render
// the persistent red highlight (mockup 1d). A stage is a member iff one of its
// dependencies transitively depends back on it.
// ponytail: O(n^2) reachability, Tarjan SCC if pipelines ever get huge.
export function cycleMembers(draft: PipelineDraft): Set<string> {
	const members = new Set<string>();
	for (const stage of draft.stages) {
		if (!stage.name) continue;
		if ((stage.dependsOn ?? []).some((dep) => findCycle(draft, stage.name, dep))) members.add(stage.name);
	}
	return members;
}

// isEdgeInCycle: the edge dep -> dependent lies on a cycle iff dep also
// transitively depends on dependent.
export function isEdgeInCycle(draft: PipelineDraft, edge: DraftEdge): boolean {
	return findCycle(draft, edge.dependent, edge.dep) !== null;
}

// removeDependency returns a new draft with `dep` dropped from the stage at
// dependentIndex (the exact stage, so duplicate names cannot misroute the
// edit); the empty dependsOn key is removed entirely. Out-of-range is a no-op.
export function removeDependency(draft: PipelineDraft, dependentIndex: number, dep: string): PipelineDraft {
	return mapStageAt(draft, dependentIndex, (stage) => {
		const next = (stage.dependsOn ?? []).filter((d) => d !== dep);
		const out = { ...stage };
		if (next.length > 0) out.dependsOn = next;
		else delete out.dependsOn;
		return out;
	});
}

function mapStageAt(draft: PipelineDraft, index: number, fn: (stage: StageDraft) => StageDraft): PipelineDraft {
	if (!draft.stages[index]) return draft;
	return { ...draft, stages: draft.stages.map((s, i) => (i === index ? fn(s) : s)) };
}

// removeStage returns a new draft without the stage at `index`, with the
// removed stage's name scrubbed from every other stage's dependsOn (dropping
// the key once empty). The scrub is skipped while another stage still carries
// the same name (a duplicate): its edges must survive. Out-of-range is a no-op.
export function removeStage(draft: PipelineDraft, index: number): PipelineDraft {
	const removed = draft.stages[index];
	if (!removed) return draft;
	const remaining = draft.stages.filter((_, i) => i !== index);
	const scrub = removed.name && !remaining.some((s) => s.name === removed.name);
	const stages = !scrub
		? remaining
		: remaining.map((s) => {
				if (!(s.dependsOn ?? []).includes(removed.name)) return s;
				const next = (s.dependsOn ?? []).filter((d) => d !== removed.name);
				const out = { ...s };
				if (next.length > 0) out.dependsOn = next;
				else delete out.dependsOn;
				return out;
			});
	return { ...draft, stages };
}

// applyConnection is the canvas' connect handler semantics as a pure function:
// drawing source -> target (node ids) makes the target stage depend on the
// source stage, unless the edge is a self-edge or would close a dependency
// cycle (blocked, with the offending path returned for the instant red
// highlight). Unnamed endpoints stay unconnectable: dependsOn refers by name.
export type ConnectionResult =
	{ kind: "added"; draft: PipelineDraft } | { kind: "cycle"; path: string[] } | { kind: "noop" };

export function applyConnection(draft: PipelineDraft, sourceId: string, targetId: string): ConnectionResult {
	const source = draft.stages[stageIndexFromNodeId(sourceId)]?.name;
	const targetIndex = stageIndexFromNodeId(targetId);
	const target = draft.stages[targetIndex]?.name;
	if (!source || !target) return { kind: "noop" };
	const cycle = findCycle(draft, target, source);
	if (cycle) return { kind: "cycle", path: cycle };
	if ((draft.stages[targetIndex].dependsOn ?? []).includes(source)) return { kind: "noop" };
	return {
		kind: "added",
		draft: mapStageAt(draft, targetIndex, (s) => ({ ...s, dependsOn: [...(s.dependsOn ?? []), source] })),
	};
}

// addStage appends a default agent stage under the first unused stage-N name
// and returns it so the canvas can select the new node.
export function addStage(draft: PipelineDraft): { draft: PipelineDraft; name: string } {
	const names = new Set(draft.stages.map((s) => s.name));
	let n = draft.stages.length + 1;
	while (names.has(`stage-${n}`)) n += 1;
	const name = `stage-${n}`;
	const stage: StageDraft = {
		name,
		trigger: { on: ["manual"] },
		executor: { kind: "agent", plugin: "claude-code", mode: "review" },
	};
	return { draft: { ...draft, stages: [...draft.stages, stage] }, name };
}
