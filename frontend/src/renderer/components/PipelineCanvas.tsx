import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	Background,
	Handle,
	MarkerType,
	Panel,
	Position,
	ReactFlow,
	ReactFlowProvider,
	useReactFlow,
	useViewport,
	type Connection,
	type Edge,
	type EdgeChange,
	type Node,
	type NodeChange,
	type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { AlertCircle, AlertTriangle, Clock, FileText, GitMerge, Maximize, Minus, Plus, Sparkles } from "lucide-react";
import type { ExecutorKind, PipelineDraft, StageDraft } from "../lib/pipeline-draft";
import {
	addStage,
	applyConnection,
	cycleStageIds,
	draftEdges,
	edgeAppearance,
	effectiveDeadline,
	isEdgeInCycle,
	layoutPositions,
	removeConnection,
	removeStage,
	STAGE_NODE_HEIGHT,
	STAGE_NODE_WIDTH,
	stageIndexFromNodeId,
	stageNodeId,
	type ConnectableEdgeKind,
	type EdgeKind,
	type StagePosition,
} from "../lib/pipeline-graph";
import type { StageSelection } from "../hooks/useStageSelection";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";

// The node-graph canvas (mockup 1a): one card per StageDraft, edges rendered
// in execution order (routing stage -> successor). Every edit routes through the
// draft via onDraftChange (usePipelineDraft.setDraft), so serialization and
// validation stay centralized. Selection flows through the editor shell's
// useStageSelection instance (V3's shared hook): node clicks call selectStage
// with the node id (the stage's index, see stageNodeId), and the inspector
// binds to the same id, so empty- and duplicate-named stages stay selectable.
//
// Cycle handling (mockup 1d): a connect attempt that would close a routing
// cycle is blocked and flashed as a red dashed edge; cycles already present in
// the draft (authored in YAML mode) render the same persistent red treatment.
//
// v2 routing is a state machine with two edge kinds, so every card carries two
// source handles: right = on_success, bottom = on_failure. Which handle the
// drag leaves picks the kind, so there is no modifier key to discover and the
// drawn edge reads the same as the rendered one.

export interface PipelineCanvasProps {
	draft: PipelineDraft;
	// Absent -> read-only canvas (no connecting, deleting, or adding stages).
	onDraftChange?: (next: PipelineDraft) => void;
	// The editor area's useStageSelection instance, shared with the inspector.
	selection?: StageSelection;
	// Validation issue messages keyed by node id (V6, mockup 1d): affected
	// nodes render an inline error badge plus the first message.
	stageIssues?: Record<string, string[]>;
}

const CYCLE_FLASH_MS = 1800;

type StageNodeData = {
	stage: StageDraft;
	inCycle: boolean;
	issues: string[];
	// The bound the engine will actually enforce, inherited or explicit (spec
	// §13.1: deadlines are defaulted, so the card is where they stay visible).
	deadline: string;
	// Spec §5.3: `workspace: session` under a `pr.*` trigger cannot be rejected
	// at edit time (the PR may or may not have a session) but fails the run at
	// plan time, so the card warns.
	sessionUnderPr: boolean;
};

type StageNodeType = Node<StageNodeData, "stage">;

// The source handle ids double as the edge kind a drag off them produces.
const SUCCESS_HANDLE: ConnectableEdgeKind = "success";
const FAILURE_HANDLE: ConnectableEdgeKind = "failure";

export function PipelineCanvas({ draft, onDraftChange, selection, stageIssues }: PipelineCanvasProps) {
	return (
		<ReactFlowProvider>
			<CanvasInner draft={draft} onDraftChange={onDraftChange} selection={selection} stageIssues={stageIssues} />
		</ReactFlowProvider>
	);
}

function CanvasInner({ draft, onDraftChange, selection, stageIssues }: PipelineCanvasProps) {
	const { fitView } = useReactFlow();
	const selected = selection?.selectedStage ?? null;
	const selectStage = selection?.selectStage;
	const [positions, setPositions] = useState<Record<string, StagePosition>>(() => layoutPositions(draft));
	const [selectedEdgeIds, setSelectedEdgeIds] = useState<ReadonlySet<string>>(new Set());
	// The blocked connect attempt currently flashing red, if any: the endpoint
	// node ids for the transient edge plus the cycle path as stage ids.
	const [flash, setFlash] = useState<{
		sourceId: string;
		targetId: string;
		kind: ConnectableEdgeKind;
		path: string[];
	} | null>(null);
	const flashTimer = useRef<number | undefined>(undefined);

	// The handlers read the latest draft through a ref so their identity stays
	// stable across draft edits.
	const draftRef = useRef(draft);
	draftRef.current = draft;

	// Stages that appear after mount (Add stage, YAML edits) get stacked below
	// the existing nodes instead of re-layouting the user's arrangement.
	const nodeIds = draft.stages.map((_, i) => stageNodeId(i)).join("\n");
	useEffect(() => {
		setPositions((prev) => {
			const ids = nodeIds ? nodeIds.split("\n") : [];
			const missing = ids.filter((id) => !(id in prev));
			if (missing.length === 0) return prev;
			const next = { ...prev };
			let y = Object.values(prev).reduce((max, p) => Math.max(max, p.y + STAGE_NODE_HEIGHT), 0) + 32;
			for (const id of missing) {
				next[id] = { x: 32, y };
				y += STAGE_NODE_HEIGHT + 32;
			}
			return next;
		});
	}, [nodeIds]);

	useEffect(() => () => window.clearTimeout(flashTimer.current), []);

	const nodes = useMemo<StageNodeType[]>(() => {
		const persistent = cycleStageIds(draft);
		const prTriggered = (draft.on?.pr?.length ?? 0) > 0;
		// Index-based ids are unique by construction, so every stage renders,
		// including duplicate-named ones (each independently selectable to fix).
		return draft.stages.map((stage, i): StageNodeType => {
			const id = stageNodeId(i);
			return {
				id,
				type: "stage",
				position: positions[id] ?? { x: 32, y: i * (STAGE_NODE_HEIGHT + 32) },
				width: STAGE_NODE_WIDTH,
				data: {
					stage,
					// Cycle membership is a config-level (stage id) property.
					inCycle: persistent.has(stage.id) || (flash?.path.includes(stage.id) ?? false),
					issues: stageIssues?.[id] ?? [],
					deadline: effectiveDeadline(draft, stage),
					sessionUnderPr: prTriggered && stage.workspace === "session",
				},
				selected: selected === id,
			};
		});
	}, [draft, positions, selected, flash, stageIssues]);

	const edges = useMemo<Edge[]>(() => {
		const out: Edge[] = draftEdges(draft).map((edge) => {
			const inCycle = isEdgeInCycle(draft, edge);
			const style = edgeAppearance(edge.kind, inCycle);
			return {
				id: edge.id,
				source: edge.source,
				target: edge.target,
				// The kind decides which source handle the edge leaves, so the drawn
				// gesture and the rendered edge use the same geometry.
				sourceHandle: edge.kind === "success" ? SUCCESS_HANDLE : FAILURE_HANDLE,
				data: { from: edge.from, to: edge.to, kind: edge.kind },
				selected: selectedEdgeIds.has(edge.id),
				ariaLabel: `${EDGE_KIND_LABEL[edge.kind]} edge from ${edge.from} to ${edge.to}`,
				style,
				markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: style.stroke },
				...(inCycle ? { animated: true } : {}),
			};
		});
		// The blocked attempt renders as a transient red dashed edge (mockup 1d);
		// a blocked self-edge shows only the node highlight.
		if (flash && flash.sourceId !== flash.targetId) {
			const style = edgeAppearance(flash.kind, true);
			out.push({
				id: "__cycle-flash",
				source: flash.sourceId,
				target: flash.targetId,
				sourceHandle: flash.kind === "success" ? SUCCESS_HANDLE : FAILURE_HANDLE,
				animated: true,
				selectable: false,
				deletable: false,
				ariaLabel: "Blocked cycle edge",
				style,
				markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: style.stroke },
			});
		}
		return out;
	}, [draft, selectedEdgeIds, flash]);

	const onNodesChange = useCallback(
		(changes: NodeChange[]) => {
			for (const change of changes) {
				if (change.type === "position" && change.position) {
					const position = change.position;
					setPositions((prev) => ({ ...prev, [change.id]: position }));
				} else if (change.type === "select") {
					selectStage?.(change.selected ? change.id : null);
				}
			}
			// Delete/Backspace on selected nodes arrives as `remove` changes; apply
			// them to the draft (react-flow only drops the node visually). Highest
			// index first so earlier removals do not shift later ones.
			const removedIndices = changes
				.filter((c) => c.type === "remove")
				.map((c) => stageIndexFromNodeId(c.id))
				.filter((i) => i >= 0)
				.sort((a, b) => b - a);
			if (removedIndices.length === 0 || !onDraftChange) return;
			const before = draftRef.current;
			let next = before;
			for (const i of removedIndices) next = removeStage(next, i);
			// Keep the ref in step so a same-tick edge-remove callback cannot
			// compute from the pre-delete draft and resurrect the stage.
			draftRef.current = next;
			onDraftChange(next);
			// The removed stage is gone; a stale index would point at its neighbor.
			selectStage?.(null);
			// Node ids above the removed indices shift down; move their saved
			// positions along so the surviving nodes stay where the user put them.
			const removedSet = new Set(removedIndices);
			setPositions((prev) => {
				const remapped: Record<string, StagePosition> = {};
				let j = 0;
				for (let i = 0; i < before.stages.length; i++) {
					if (removedSet.has(i)) continue;
					const p = prev[stageNodeId(i)];
					if (p) remapped[stageNodeId(j)] = p;
					j += 1;
				}
				return remapped;
			});
		},
		[selectStage, onDraftChange],
	);

	const onEdgesChange = useCallback(
		(changes: EdgeChange[]) => {
			let next = draftRef.current;
			let removed = false;
			for (const change of changes) {
				if (change.type === "select") {
					setSelectedEdgeIds((prev) => {
						const ids = new Set(prev);
						if (change.selected) ids.add(change.id);
						else ids.delete(change.id);
						return ids;
					});
				} else if (change.type === "remove" && onDraftChange) {
					const edge = draftEdges(next).find((e) => e.id === change.id);
					if (!edge) continue;
					// v2 routing keys live on the source stage, not the target.
					next = removeConnection(next, stageIndexFromNodeId(edge.source), edge.to, edge.kind);
					removed = true;
				}
			}
			if (removed && onDraftChange) {
				// Same-tick node-remove callbacks must see this edit (see the ref
				// note in onNodesChange).
				draftRef.current = next;
				onDraftChange(next);
			}
		},
		[onDraftChange],
	);

	const onConnect = useCallback(
		(connection: Connection) => {
			if (!onDraftChange || !connection.source || !connection.target) return;
			// The handle the drag left picks the edge kind: right = on_success,
			// bottom = on_failure.
			const kind: ConnectableEdgeKind = connection.sourceHandle === FAILURE_HANDLE ? "failure" : "success";
			const result = applyConnection(draftRef.current, connection.source, connection.target, kind);
			if (result.kind === "added") {
				draftRef.current = result.draft;
				onDraftChange(result.draft);
			} else if (result.kind === "cycle") {
				setFlash({ sourceId: connection.source, targetId: connection.target, kind, path: result.path });
				window.clearTimeout(flashTimer.current);
				flashTimer.current = window.setTimeout(() => setFlash(null), CYCLE_FLASH_MS);
			}
		},
		[onDraftChange],
	);

	const handleAddStage = useCallback(() => {
		if (!onDraftChange) return;
		const { draft: next } = addStage(draftRef.current);
		draftRef.current = next;
		onDraftChange(next);
		// The appended stage's node id is its index (the new last slot).
		selectStage?.(stageNodeId(next.stages.length - 1));
	}, [onDraftChange, selectStage]);

	const handleAutoLayout = useCallback(() => {
		setPositions(layoutPositions(draftRef.current));
		window.requestAnimationFrame(() => fitView({ padding: 0.2, duration: 200 }));
	}, [fitView]);

	return (
		<div className="relative h-full w-full" data-testid="pipeline-canvas">
			<ReactFlow
				nodes={nodes}
				edges={edges}
				nodeTypes={NODE_TYPES}
				onNodesChange={onNodesChange}
				onEdgesChange={onEdgesChange}
				onConnect={onConnect}
				onNodeClick={(_, node) => selectStage?.(node.id)}
				onPaneClick={() => selectStage?.(null)}
				nodesConnectable={!!onDraftChange}
				edgesFocusable={!!onDraftChange}
				deleteKeyCode={onDraftChange ? ["Backspace", "Delete"] : null}
				fitView
				minZoom={0.25}
				maxZoom={2}
				proOptions={{ hideAttribution: true }}
			>
				<Background gap={24} />
				<Panel position="top-left" className="flex items-center gap-2">
					<Button size="sm" variant="outline" onClick={handleAddStage} disabled={!onDraftChange}>
						<Plus className="size-icon-sm" aria-hidden="true" />
						Add stage
					</Button>
					<Button size="sm" variant="outline" onClick={handleAutoLayout}>
						<Sparkles className="size-icon-sm" aria-hidden="true" />
						Auto-layout
					</Button>
				</Panel>
				<Panel position="bottom-left">
					<ZoomBar />
				</Panel>
			</ReactFlow>
		</div>
	);
}

// ZoomBar is the bottom-left zoom cluster (mockup 1a): out / level / in / Fit.
// Its own component so viewport re-renders stay off the canvas shell.
function ZoomBar() {
	const { zoomIn, zoomOut, fitView } = useReactFlow();
	const { zoom } = useViewport();
	return (
		<div className="flex items-center gap-0.5 rounded-md border border-border bg-surface p-0.5">
			<Button size="icon-sm" variant="ghost" aria-label="Zoom out" onClick={() => zoomOut({ duration: 150 })}>
				<Minus className="size-icon-sm" aria-hidden="true" />
			</Button>
			<span className="w-10 text-center font-mono text-micro text-muted-foreground" aria-label="Zoom level">
				{Math.round(zoom * 100)}%
			</span>
			<Button size="icon-sm" variant="ghost" aria-label="Zoom in" onClick={() => zoomIn({ duration: 150 })}>
				<Plus className="size-icon-sm" aria-hidden="true" />
			</Button>
			<Button
				size="sm"
				variant="ghost"
				aria-label="Fit view"
				className="h-control-md px-2"
				onClick={() => fitView({ padding: 0.2, duration: 200 })}
			>
				<Maximize className="size-icon-sm" aria-hidden="true" />
				Fit
			</Button>
		</div>
	);
}

// --- edge treatments ---------------------------------------------------------

const EDGE_KIND_LABEL: Record<EdgeKind, string> = {
	success: "Success",
	failure: "Failure",
	"default-failure": "Default failure",
};

// --- stage node card ---------------------------------------------------------

// Executor-kind treatments (mockup 1a), restyled to the app tokens: agent =
// accent, command = warning. v2 has no builtin kind.
const KIND_BADGE: Record<ExecutorKind, { letter: string; className: string; label: string }> = {
	agent: { letter: "A", className: "bg-accent/15 text-accent", label: "Agent stage" },
	command: { letter: "$", className: "bg-warning/15 text-warning", label: "Command stage" },
};

function executorSubtitle(stage: StageDraft): string {
	if (stage.executor === "agent") return stage.agent || "agent";
	// The run script is a block scalar; the first line is what fits on a card.
	return stage.run?.split("\n")[0]?.trim() || "command";
}

// A join carries the `needs` set the graph lib maintains; below two inbound
// success edges there is no join and the key is dropped (spec §9.2).
function joinCount(stage: StageDraft): number {
	const n = stage.needs?.length ?? 0;
	return n > 1 ? n : 0;
}

function StageNode({ data, selected }: NodeProps<StageNodeType>) {
	const { stage, inCycle, issues, deadline, sessionUnderPr } = data;
	const badge = KIND_BADGE[stage.executor] ?? KIND_BADGE.agent;
	const needs = joinCount(stage);

	return (
		<div
			className={cn(
				"w-52 rounded-lg border bg-surface px-3 py-2.5 shadow-sm transition-colors",
				inCycle
					? "border-error ring-1 ring-error/40"
					: selected
						? "border-accent ring-1 ring-accent/40"
						: "border-border hover:border-border-strong",
			)}
			data-stage-id={stage.id}
			data-in-cycle={inCycle || undefined}
			data-issue-count={issues.length || undefined}
		>
			<Handle type="target" position={Position.Left} className="!size-2 !border-border-strong !bg-raised" />
			<div className="flex items-center gap-2">
				<span
					className={cn(
						"flex size-5 shrink-0 items-center justify-center rounded font-mono text-micro font-semibold",
						badge.className,
					)}
					aria-label={badge.label}
				>
					{badge.letter}
				</span>
				<span className="min-w-0 flex-1 truncate text-control font-semibold text-foreground">
					{stage.id || "(unnamed)"}
				</span>
				{sessionUnderPr && (
					<AlertTriangle
						className="size-icon-xs shrink-0 text-warning"
						aria-label="Warning: workspace session, a PR may have no session"
					/>
				)}
				{issues.length > 0 && (
					<span
						className="flex shrink-0 items-center gap-0.5 text-error"
						aria-label={`${issues.length} validation ${issues.length === 1 ? "problem" : "problems"}`}
					>
						<AlertCircle className="size-icon-xs" aria-hidden="true" />
						{issues.length > 1 && <span className="font-mono text-micro">{issues.length}</span>}
					</span>
				)}
			</div>
			<p className="mt-1 truncate font-mono text-micro text-muted-foreground">{executorSubtitle(stage)}</p>
			{issues.length > 0 && <p className="mt-1.5 truncate text-micro text-error">{issues[0]}</p>}
			{inCycle && <p className="mt-1.5 text-micro text-error">in routing cycle</p>}
			<div className="mt-1.5 flex flex-wrap items-center gap-1">
				{/* The effective deadline rides on every card: spec §13.1 defaults it
				    rather than requiring it, so visibility is what makes that safe. */}
				<Badge variant="neutral" title={`Deadline ${deadline}`}>
					<Clock className="size-icon-xs" aria-hidden="true" />
					{deadline}
				</Badge>
				{stage.produces && (
					<Badge variant="outline" className="max-w-full" title={`Produces ${stage.produces}`}>
						<FileText className="size-icon-xs shrink-0" aria-hidden="true" />
						<span className="truncate">{stage.produces}</span>
					</Badge>
				)}
				{/* Only an explicit workspace is shown; the inherited default is not a
				    property of this stage (spec §5.4). */}
				{stage.workspace && (
					<Badge variant={sessionUnderPr ? "warning" : "neutral"} title={`Workspace ${stage.workspace}`}>
						{stage.workspace}
					</Badge>
				)}
				{needs > 0 && (
					<Badge variant="neutral" title={`Joins ${stage.needs?.join(", ")}`}>
						<GitMerge className="size-icon-xs" aria-hidden="true" />
						needs {needs}
					</Badge>
				)}
			</div>
			{/* Two source handles, so the drag itself picks the routing key. */}
			<Handle
				id={SUCCESS_HANDLE}
				type="source"
				position={Position.Right}
				title="Route on success"
				className="!size-2 !border-accent-dim !bg-accent"
			/>
			<Handle
				id={FAILURE_HANDLE}
				type="source"
				position={Position.Bottom}
				title="Route on failure"
				className="!size-2 !border-destructive/60 !bg-destructive"
			/>
		</div>
	);
}

const NODE_TYPES = { stage: StageNode };
