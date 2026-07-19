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

// stageNodeId gives every stage a stable non-empty node id. Unnamed stages
// (mid-edit drafts) get a placeholder id that dependsOn can never reference,
// so they render but stay unconnectable.
export function stageNodeId(stage: StageDraft, index: number): string {
	return stage.name || `__stage-${index}`;
}

export interface DraftEdge {
	id: string;
	// dep runs first (edge source), dependent declares `dependsOn: [dep]`.
	dep: string;
	dependent: string;
}

export function edgeId(dep: string, dependent: string): string {
	return `${dep}->${dependent}`;
}

// draftEdges maps every dependsOn entry that references an existing stage to an
// edge. Dangling references have no node to attach to; the /validate endpoint
// reports them, so they are skipped here rather than guessed at.
export function draftEdges(draft: PipelineDraft): DraftEdge[] {
	const names = new Set(draft.stages.map((s) => s.name).filter(Boolean));
	const edges: DraftEdge[] = [];
	for (const stage of draft.stages) {
		if (!stage.name) continue;
		for (const dep of stage.dependsOn ?? []) {
			if (!names.has(dep)) continue;
			edges.push({ id: edgeId(dep, stage.name), dep, dependent: stage.name });
		}
	}
	return edges;
}

// layoutPositions runs dagre left-to-right (mockup 1a flows dependency ->
// dependent) and returns top-left positions keyed by node id.
export function layoutPositions(draft: PipelineDraft): Record<string, StagePosition> {
	const g = new dagre.graphlib.Graph();
	g.setGraph({ rankdir: "LR", nodesep: 32, ranksep: 64 });
	g.setDefaultEdgeLabel(() => ({}));
	draft.stages.forEach((stage, i) => {
		g.setNode(stageNodeId(stage, i), { width: STAGE_NODE_WIDTH, height: STAGE_NODE_HEIGHT });
	});
	for (const edge of draftEdges(draft)) g.setEdge(edge.dep, edge.dependent);
	dagre.layout(g);

	const positions: Record<string, StagePosition> = {};
	draft.stages.forEach((stage, i) => {
		const id = stageNodeId(stage, i);
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

// addDependency / removeDependency return a new draft with the dependsOn edit
// applied; unknown stage names are a no-op.
export function addDependency(draft: PipelineDraft, dependent: string, dep: string): PipelineDraft {
	return mapStage(draft, dependent, (stage) => {
		if ((stage.dependsOn ?? []).includes(dep)) return stage;
		return { ...stage, dependsOn: [...(stage.dependsOn ?? []), dep] };
	});
}

export function removeDependency(draft: PipelineDraft, dependent: string, dep: string): PipelineDraft {
	return mapStage(draft, dependent, (stage) => {
		const next = (stage.dependsOn ?? []).filter((d) => d !== dep);
		const out = { ...stage };
		if (next.length > 0) out.dependsOn = next;
		else delete out.dependsOn;
		return out;
	});
}

function mapStage(draft: PipelineDraft, name: string, fn: (stage: StageDraft) => StageDraft): PipelineDraft {
	return { ...draft, stages: draft.stages.map((s) => (s.name === name ? fn(s) : s)) };
}

// applyConnection is the canvas' connect handler semantics as a pure function:
// drawing source -> target makes target depend on source, unless the edge is a
// self-edge or would close a dependency cycle (blocked, with the offending
// path returned for the instant red highlight).
export type ConnectionResult =
	{ kind: "added"; draft: PipelineDraft } | { kind: "cycle"; path: string[] } | { kind: "noop" };

export function applyConnection(draft: PipelineDraft, source: string, target: string): ConnectionResult {
	const names = new Set(draft.stages.map((s) => s.name).filter(Boolean));
	if (!names.has(source) || !names.has(target)) return { kind: "noop" };
	const cycle = findCycle(draft, target, source);
	if (cycle) return { kind: "cycle", path: cycle };
	const stage = draft.stages.find((s) => s.name === target);
	if ((stage?.dependsOn ?? []).includes(source)) return { kind: "noop" };
	return { kind: "added", draft: addDependency(draft, target, source) };
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
