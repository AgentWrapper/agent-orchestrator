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
import { AlertCircle, Maximize, Minus, Plus, Sparkles } from "lucide-react";
import type { ExecutorKind, PipelineDraft, StageDraft } from "../lib/pipeline-draft";
import {
	addStage,
	applyConnection,
	cycleMembers,
	draftEdges,
	isEdgeInCycle,
	layoutPositions,
	removeDependency,
	STAGE_NODE_HEIGHT,
	STAGE_NODE_WIDTH,
	stageNodeId,
	type StagePosition,
} from "../lib/pipeline-graph";
import { summarizePredicate } from "../lib/predicate-summary";
import type { StageSelection } from "../hooks/useStageSelection";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";

// The node-graph canvas (mockup 1a): one card per StageDraft, edges rendered
// dependency -> dependent (execution order). Every edit routes through the
// draft via onDraftChange (usePipelineDraft.setDraft), so serialization and
// validation stay centralized. Selection flows through the editor shell's
// useStageSelection instance (V3's shared hook): node clicks call selectStage,
// and the inspector binds to the same selectedStage name.
//
// Cycle handling (mockup 1d): a connect attempt that would close a dependency
// cycle is blocked and flashed as a red dashed edge; cycles already present in
// the draft (authored in YAML mode) render the same persistent red treatment.

export interface PipelineCanvasProps {
	draft: PipelineDraft;
	// Absent -> read-only canvas (no connecting, deleting, or adding stages).
	onDraftChange?: (next: PipelineDraft) => void;
	// The editor area's useStageSelection instance, shared with the inspector.
	selection?: StageSelection;
	// Validation issue messages keyed by stage name (V6, mockup 1d): affected
	// nodes render an inline error badge plus the first message.
	stageIssues?: Record<string, string[]>;
}

const CYCLE_FLASH_MS = 1800;

type StageNodeType = Node<{ stage: StageDraft; inCycle: boolean; issues: string[] }, "stage">;

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
	// The blocked connect attempt currently flashing red, if any.
	const [flash, setFlash] = useState<{ dep: string; dependent: string; path: string[] } | null>(null);
	const flashTimer = useRef<number | undefined>(undefined);

	// The handlers read the latest draft through a ref so their identity stays
	// stable across draft edits.
	const draftRef = useRef(draft);
	draftRef.current = draft;

	// Stages that appear after mount (Add stage, YAML edits) get stacked below
	// the existing nodes instead of re-layouting the user's arrangement.
	const nodeIds = draft.stages.map(stageNodeId).join("\n");
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
		const persistent = cycleMembers(draft);
		const seen = new Set<string>();
		const out: StageNodeType[] = [];
		draft.stages.forEach((stage, i) => {
			const id = stageNodeId(stage, i);
			// Duplicate names are invalid config (the daemon reports them); render
			// the first occurrence only so node ids stay unique.
			if (seen.has(id)) return;
			seen.add(id);
			out.push({
				id,
				type: "stage",
				position: positions[id] ?? { x: 32, y: i * (STAGE_NODE_HEIGHT + 32) },
				width: STAGE_NODE_WIDTH,
				data: {
					stage,
					inCycle: persistent.has(id) || (flash?.path.includes(id) ?? false),
					issues: stageIssues?.[id] ?? [],
				},
				selected: selected === id,
			});
		});
		return out;
	}, [draft, positions, selected, flash, stageIssues]);

	const edges = useMemo<Edge[]>(() => {
		const out: Edge[] = draftEdges(draft).map((edge) => {
			const inCycle = isEdgeInCycle(draft, edge);
			const stroke = inCycle ? "var(--color-error)" : "var(--color-border-strong)";
			return {
				id: edge.id,
				source: edge.dep,
				target: edge.dependent,
				data: { dep: edge.dep, dependent: edge.dependent },
				selected: selectedEdgeIds.has(edge.id),
				style: { stroke, strokeWidth: 1.5, ...(inCycle ? { strokeDasharray: "6 4" } : {}) },
				markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: stroke },
				...(inCycle ? { animated: true, ariaLabel: `Dependency cycle edge ${edge.id}` } : {}),
			};
		});
		// The blocked attempt renders as a transient red dashed edge (mockup 1d);
		// a blocked self-edge shows only the node highlight.
		if (flash && flash.dep !== flash.dependent) {
			out.push({
				id: "__cycle-flash",
				source: flash.dep,
				target: flash.dependent,
				animated: true,
				selectable: false,
				deletable: false,
				ariaLabel: "Blocked cycle edge",
				style: { stroke: "var(--color-error)", strokeWidth: 1.5, strokeDasharray: "6 4" },
				markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: "var(--color-error)" },
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
		},
		[selectStage],
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
					next = removeDependency(next, edge.dependent, edge.dep);
					removed = true;
				}
			}
			if (removed && onDraftChange) onDraftChange(next);
		},
		[onDraftChange],
	);

	const onConnect = useCallback(
		(connection: Connection) => {
			if (!onDraftChange || !connection.source || !connection.target) return;
			const result = applyConnection(draftRef.current, connection.source, connection.target);
			if (result.kind === "added") {
				onDraftChange(result.draft);
			} else if (result.kind === "cycle") {
				setFlash({ dep: connection.source, dependent: connection.target, path: result.path });
				window.clearTimeout(flashTimer.current);
				flashTimer.current = window.setTimeout(() => setFlash(null), CYCLE_FLASH_MS);
			}
		},
		[onDraftChange],
	);

	const handleAddStage = useCallback(() => {
		if (!onDraftChange) return;
		const { draft: next, name } = addStage(draftRef.current);
		onDraftChange(next);
		selectStage?.(name);
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

// --- stage node card ---------------------------------------------------------

// Executor-kind treatments (mockup 1a: agent/command/builtin visually
// distinct), restyled to the app tokens: agent = accent, command = warning,
// builtin = purple.
const KIND_BADGE: Record<ExecutorKind, { letter: string; className: string; label: string }> = {
	agent: { letter: "A", className: "bg-accent/15 text-accent", label: "Agent stage" },
	command: { letter: "$", className: "bg-warning/15 text-warning", label: "Command stage" },
	builtin: { letter: "f", className: "bg-purple-subtle text-purple-accent", label: "Builtin stage" },
};

function executorSubtitle(stage: StageDraft): string {
	const ex = stage.executor;
	switch (ex.kind) {
		case "agent":
			return [ex.plugin, ex.mode].filter(Boolean).join(" · ") || "agent";
		case "command":
			return [ex.command, ...(ex.args ?? [])].filter(Boolean).join(" ") || "command";
		case "builtin":
			return ex.name ?? "builtin";
		default:
			return "";
	}
}

function StageNode({ data, selected }: NodeProps<StageNodeType>) {
	const { stage, inCycle, issues } = data;
	const badge = KIND_BADGE[stage.executor.kind] ?? KIND_BADGE.agent;
	const footer = [stage.workspace, stage.maxLoopRounds != null ? `${stage.maxLoopRounds} rounds` : null]
		.filter(Boolean)
		.join(" · ");

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
			data-stage-name={stage.name}
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
					{stage.name || "(unnamed)"}
				</span>
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
			{stage.routes?.when && (
				<p className="mt-1.5">
					<span className="inline-block max-w-full truncate rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 font-mono text-micro text-warning">
						when: {summarizePredicate(stage.routes.when)}
					</span>
				</p>
			)}
			{inCycle && <p className="mt-1.5 text-micro text-error">in dependency cycle</p>}
			{footer && <p className="mt-1.5 truncate text-micro text-passive">{footer}</p>}
			<Handle type="source" position={Position.Right} className="!size-2 !border-border-strong !bg-raised" />
		</div>
	);
}

const NODE_TYPES = { stage: StageNode };
