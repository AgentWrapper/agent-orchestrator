// Pure graph helpers for the pipeline canvas: draft -> nodes/edges mapping,
// dagre auto-layout, edge mutations, and cycle detection.
//
// v2's graph is a state machine, not a DAG of dependencies: every stage names
// its own successors, so edges point in execution order and come in two kinds.
// `on_success` produces success edges, `on_failure` produces failure edges, and
// a stage that declares no `on_failure` inherits `defaults.on_failure` as a
// synthetic edge (spec §9.4) the canvas draws faintly. The one carve-out is
// that the default target does not inherit the default, which would be a
// self-edge and therefore a cycle.
//
// All mutations return a new draft; the canvas pushes it through
// usePipelineDraft's setDraft so serialization/validation stays centralized.

import dagre from "dagre";
import { DEFAULT_STAGE_DEADLINE, type PipelineDraft, type StageDraft } from "./pipeline-draft";

// Fixed card footprint the layout assumes; the rendered card is w-52 with a
// content-dependent height this estimate stays close enough to for spacing. The
// height covers a card with a wrapped chip row (deadline, produces, workspace,
// needs), which is the tallest ordinary case.
export const STAGE_NODE_WIDTH = 208;
export const STAGE_NODE_HEIGHT = 124;

export interface StagePosition {
	x: number;
	y: number;
}

// Stage identity is the array index, not the stage id: it is unique even for
// empty or duplicate ids (which the user must be able to select to fix) and
// deterministic across the debounced YAML re-parse, so selection and node
// positions survive typing. Stage ids remain the config reference (on_success,
// on_failure, needs); helpers below translate at the boundary.
export function stageNodeId(index: number): string {
	return String(index);
}

// stageIndexFromNodeId is the inverse of stageNodeId; -1 for null/garbage.
export function stageIndexFromNodeId(id: string | null | undefined): number {
	if (id == null || !/^\d+$/.test(id)) return -1;
	return Number(id);
}

// "default-failure" is the synthetic edge a stage gets from
// `defaults.on_failure`; it is a failure edge for routing and cycle purposes
// but is not written on the stage, so it cannot be deleted from the canvas.
export type EdgeKind = "success" | "failure" | "default-failure";

// The kinds a user can actually draw. Synthetic default-failure edges come from
// the pipeline-level `defaults` block, edited in the settings modal.
export type ConnectableEdgeKind = "success" | "failure";

export interface DraftEdge {
	id: string;
	// Node ids: the stage that routes (edge source) and the stage it routes to
	// (edge target). Execution order, same direction as the arrow.
	source: string;
	target: string;
	kind: EdgeKind;
	// The same endpoints as config references (stage ids).
	from: string;
	to: string;
}

export function edgeId(source: string, target: string, kind: EdgeKind): string {
	return `${source}-${kind}->${target}`;
}

// indexById maps a stage id to its first occurrence, which is how a duplicated
// id resolves everywhere in the editor.
function indexById(draft: PipelineDraft): Map<string, number> {
	const out = new Map<string, number>();
	draft.stages.forEach((stage, i) => {
		if (stage.id && !out.has(stage.id)) out.set(stage.id, i);
	});
	return out;
}

// draftEdges maps every routing key that references an existing stage to an
// edge. Dangling references have no node to attach to; the /validate endpoint
// reports them, so they are skipped here rather than guessed at.
export function draftEdges(draft: PipelineDraft): DraftEdge[] {
	const byId = indexById(draft);
	const defaultFailure = draft.defaults?.onFailure;
	const edges: DraftEdge[] = [];

	const push = (fromIndex: number, from: string, to: string, kind: EdgeKind) => {
		const toIndex = byId.get(to);
		if (toIndex === undefined) return;
		const source = stageNodeId(fromIndex);
		const target = stageNodeId(toIndex);
		edges.push({ id: edgeId(source, target, kind), source, target, kind, from, to });
	};

	draft.stages.forEach((stage, i) => {
		if (!stage.id) return;
		for (const to of stage.onSuccess ?? []) push(i, stage.id, to, "success");
		if (stage.onFailure) {
			push(i, stage.id, stage.onFailure, "failure");
			return;
		}
		// §9.4: every stage without an explicit on_failure inherits the pipeline
		// default, except the default target itself (whose own failure ends the
		// branch rather than looping back into itself).
		if (defaultFailure && defaultFailure !== stage.id) push(i, stage.id, defaultFailure, "default-failure");
	});

	return edges;
}

// layoutPositions runs dagre left-to-right (execution order flows rightwards)
// and returns top-left positions keyed by node id. `size` is the node footprint
// the layout reserves; it defaults to the editor's card so callers that render
// a different node (the read-only run graph's compact row) can space their own
// nodes correctly without a second dagre setup.
export function layoutPositions(
	draft: PipelineDraft,
	size: { width: number; height: number } = { width: STAGE_NODE_WIDTH, height: STAGE_NODE_HEIGHT },
): Record<string, StagePosition> {
	const g = new dagre.graphlib.Graph();
	g.setGraph({ rankdir: "LR", nodesep: 32, ranksep: 64 });
	g.setDefaultEdgeLabel(() => ({}));
	draft.stages.forEach((_stage, i) => {
		g.setNode(stageNodeId(i), { width: size.width, height: size.height });
	});
	for (const edge of draftEdges(draft)) g.setEdge(edge.source, edge.target);
	dagre.layout(g);

	const positions: Record<string, StagePosition> = {};
	draft.stages.forEach((_stage, i) => {
		const id = stageNodeId(i);
		const node = g.node(id);
		if (node) positions[id] = { x: node.x - size.width / 2, y: node.y - size.height / 2 };
	});
	return positions;
}

// --- edge treatments ---------------------------------------------------------

// edgeAppearance is the three-way visual split the graph's edge kinds need:
// on_success solid in the accent, on_failure dashed in the destructive tone,
// and the synthetic defaults.on_failure edge dashed in a faded version of the
// same tone (it is inherited boilerplate, so it must not compete with the
// routes the author actually wrote). A cycle overrides all three: the edge is
// already invalid, so what kind it was stops mattering.
//
// The synthetic edge fades through its color rather than through `opacity` so
// that its arrowhead marker, which does not inherit path opacity, fades with
// the line instead of staying solid.
//
// It lives here rather than on the editor canvas because the read-only run
// graph draws the same edge kinds and must not diverge from the editor.
export function edgeAppearance(
	kind: EdgeKind,
	inCycle: boolean,
): { stroke: string; strokeWidth: number; strokeDasharray?: string } {
	if (inCycle) return { stroke: "var(--color-error)", strokeWidth: 2, strokeDasharray: "6 4" };
	if (kind === "success") return { stroke: "var(--color-accent)", strokeWidth: 2 };
	if (kind === "failure") return { stroke: "var(--color-destructive)", strokeWidth: 1.75, strokeDasharray: "6 4" };
	return {
		stroke: "color-mix(in oklab, var(--color-destructive) 45%, transparent)",
		strokeWidth: 1.5,
		strokeDasharray: "3 5",
	};
}

// --- cycles -----------------------------------------------------------------

// adjacency collapses the edge list to stage-id successors. Cycle detection
// runs over success and failure edges alike (including the synthetic default
// ones), a client-side mirror of the server's validation rule: with named
// successors, `a --fail--> b --fail--> a` is an expressible infinite loop.
function adjacency(draft: PipelineDraft): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const edge of draftEdges(draft)) {
		const next = out.get(edge.from);
		if (next) next.push(edge.to);
		else out.set(edge.from, [edge.to]);
	}
	return out;
}

// pathTo walks `adj` from `start` looking for `goal`, returning the id path
// [start, ..., goal] or null. `start === goal` returns [start].
function pathTo(adj: Map<string, string[]>, start: string, goal: string): string[] | null {
	const path: string[] = [];
	const seen = new Set<string>();
	const walk = (from: string): boolean => {
		if (seen.has(from)) return false;
		seen.add(from);
		path.push(from);
		if (from === goal) return true;
		for (const next of adj.get(from) ?? []) {
			if (walk(next)) return true;
		}
		path.pop();
		return false;
	};
	return walk(start) ? [...path] : null;
}

// findCycle returns the closed stage-id path of the cycle that routing `from`
// to `to` would create ([to, ..., from, to]), or null when the edge is safe. A
// self-edge is the one-node cycle [from].
export function findCycle(draft: PipelineDraft, from: string, to: string): string[] | null {
	if (from === to) return [from];
	// The new edge from -> to closes a loop iff `to` already reaches `from`.
	const path = pathTo(adjacency(draft), to, from);
	return path ? [...path, to] : null;
}

// cycleStageIds returns every stage already sitting on a cycle in the draft
// (cycles arrive through YAML-mode edits), so the canvas can render the
// persistent red highlight.
// ponytail: O(n * (n + e)) reachability, Tarjan SCC if pipelines ever get huge.
export function cycleStageIds(draft: PipelineDraft): Set<string> {
	const adj = adjacency(draft);
	const members = new Set<string>();
	for (const stage of draft.stages) {
		if (!stage.id || members.has(stage.id)) continue;
		for (const next of adj.get(stage.id) ?? []) {
			const path = pathTo(adj, next, stage.id);
			if (path) {
				for (const id of path) members.add(id);
				break;
			}
		}
	}
	return members;
}

// isEdgeInCycle: the edge from -> to lies on a cycle iff `to` reaches `from`.
export function isEdgeInCycle(draft: PipelineDraft, edge: DraftEdge): boolean {
	return pathTo(adjacency(draft), edge.to, edge.from) !== null;
}

// --- mutations --------------------------------------------------------------

function mapStageAt(draft: PipelineDraft, index: number, fn: (stage: StageDraft) => StageDraft): PipelineDraft {
	if (!draft.stages[index]) return draft;
	return { ...draft, stages: draft.stages.map((s, i) => (i === index ? fn(s) : s)) };
}

// reconcileNeeds rewrites every stage's `needs` to exactly its inbound success
// edge set, in document order, and drops the key when there is one inbound edge
// or none. That is the server's rule (spec §9.2: required above one inbound
// success edge, and validated to match the set exactly), so running it after
// every graph mutation is what makes the editor produce valid YAML by
// construction. Failure edges are never counted.
export function reconcileNeeds(draft: PipelineDraft): PipelineDraft {
	const inbound = new Map<string, string[]>();
	draft.stages.forEach((stage) => {
		if (!stage.id) return;
		for (const to of stage.onSuccess ?? []) {
			const list = inbound.get(to);
			if (list) {
				if (!list.includes(stage.id)) list.push(stage.id);
			} else {
				inbound.set(to, [stage.id]);
			}
		}
	});

	let changed = false;
	const stages = draft.stages.map((stage) => {
		const want = inbound.get(stage.id) ?? [];
		const have = stage.needs;
		if (want.length > 1) {
			if (have && have.length === want.length && have.every((id, i) => id === want[i])) return stage;
			changed = true;
			return { ...stage, needs: want };
		}
		if (!have) return stage;
		changed = true;
		const next = { ...stage };
		delete next.needs;
		return next;
	});

	return changed ? { ...draft, stages } : draft;
}

// applyConnection is the canvas' connect handler semantics as a pure function:
// drawing source -> target (node ids) routes the source stage to the target on
// the given edge kind, unless the edge is a self-edge or would close a cycle
// (blocked, with the offending path returned for the instant red highlight).
// A stage carries at most one failure edge, so connecting one replaces it.
// Stages with an empty id stay unconnectable: routing refers to stages by id.
export type ConnectionResult =
	{ kind: "added"; draft: PipelineDraft } | { kind: "cycle"; path: string[] } | { kind: "noop" };

export function applyConnection(
	draft: PipelineDraft,
	sourceId: string,
	targetId: string,
	edgeKind: ConnectableEdgeKind,
): ConnectionResult {
	const sourceIndex = stageIndexFromNodeId(sourceId);
	const targetIndex = stageIndexFromNodeId(targetId);
	const from = draft.stages[sourceIndex]?.id;
	const to = draft.stages[targetIndex]?.id;
	if (!from || !to) return { kind: "noop" };

	const stage = draft.stages[sourceIndex];
	const exists = edgeKind === "success" ? (stage.onSuccess ?? []).includes(to) : stage.onFailure === to;
	if (exists) return { kind: "noop" };

	const cycle = findCycle(draft, from, to);
	if (cycle) return { kind: "cycle", path: cycle };

	const next = mapStageAt(draft, sourceIndex, (s) =>
		edgeKind === "success" ? { ...s, onSuccess: [...(s.onSuccess ?? []), to] } : { ...s, onFailure: to },
	);
	return { kind: "added", draft: reconcileNeeds(next) };
}

// removeConnection drops the edge leaving the stage at sourceIndex (the exact
// stage, so duplicate ids cannot misroute the edit). Synthetic default-failure
// edges are not written on the stage and are a no-op here: they are removed by
// clearing `defaults.on_failure` in the settings modal.
export function removeConnection(
	draft: PipelineDraft,
	sourceIndex: number,
	to: string,
	edgeKind: EdgeKind,
): PipelineDraft {
	if (edgeKind === "default-failure") return draft;
	const next = mapStageAt(draft, sourceIndex, (stage) => {
		const out = { ...stage };
		if (edgeKind === "success") {
			const kept = (stage.onSuccess ?? []).filter((id) => id !== to);
			if (kept.length > 0) out.onSuccess = kept;
			else delete out.onSuccess;
		} else if (stage.onFailure === to) {
			delete out.onFailure;
		}
		return out;
	});
	return reconcileNeeds(next);
}

// removeStage returns a new draft without the stage at `index`, with the
// removed stage's id scrubbed from every routing key that named it (including
// `defaults.on_failure`), so deleting a node cannot leave a dangling reference.
// The scrub is skipped while another stage still carries the same id (a
// duplicate): its edges must survive. Out-of-range is a no-op.
export function removeStage(draft: PipelineDraft, index: number): PipelineDraft {
	const removed = draft.stages[index];
	if (!removed) return draft;
	const remaining = draft.stages.filter((_, i) => i !== index);
	const scrub = removed.id !== "" && !remaining.some((s) => s.id === removed.id);
	if (!scrub) return reconcileNeeds({ ...draft, stages: remaining });

	const stages = remaining.map((stage) => {
		const out = { ...stage };
		const onSuccess = (stage.onSuccess ?? []).filter((id) => id !== removed.id);
		if (onSuccess.length > 0) out.onSuccess = onSuccess;
		else delete out.onSuccess;
		if (stage.onFailure === removed.id) delete out.onFailure;
		return out;
	});
	const next: PipelineDraft = { ...draft, stages };
	if (draft.defaults?.onFailure === removed.id) {
		const defaults = { ...draft.defaults };
		delete defaults.onFailure;
		if (Object.keys(defaults).length > 0) next.defaults = defaults;
		else delete next.defaults;
	}
	return reconcileNeeds(next);
}

// addStage appends a default agent stage under the first unused stage-N id and
// returns it so the canvas can select the new node.
export function addStage(draft: PipelineDraft): { draft: PipelineDraft; id: string } {
	const ids = new Set(draft.stages.map((s) => s.id));
	let n = draft.stages.length + 1;
	while (ids.has(`stage-${n}`)) n += 1;
	const id = `stage-${n}`;
	const stage: StageDraft = { id, executor: "agent", agent: "claude-code" };
	return { draft: { ...draft, stages: [...draft.stages, stage] }, id };
}

// effectiveDeadline is what the engine will actually enforce: the stage's own
// deadline, else the pipeline default, else the engine's 30m fallback. Spec
// §13.1 makes this visible on every card, which is the whole reason deadlines
// are defaulted rather than required.
export function effectiveDeadline(draft: PipelineDraft, stage: StageDraft): string {
	return stage.deadline || draft.defaults?.deadline || DEFAULT_STAGE_DEADLINE;
}
