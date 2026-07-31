import { useMemo } from "react";
import {
	Handle,
	MarkerType,
	Panel,
	Position,
	ReactFlow,
	ReactFlowProvider,
	useReactFlow,
	type Edge,
	type Node,
	type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
	AlertCircle,
	CheckCircle2,
	Circle,
	CircleDashed,
	CircleDot,
	Maximize,
	Minus,
	MinusCircle,
	Plus,
	XCircle,
} from "lucide-react";
import { draftEdges, edgeAppearance, layoutPositions, stageNodeId } from "../lib/pipeline-graph";
import { formatStageDuration } from "../lib/pipeline-display";
import type { PipelineDraft, RunStatus, StageOutcome } from "../lib/pipeline-draft";
import type { components } from "../../api/schema";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";

type PipelineStageView = components["schemas"]["PipelineStageView"];

// The run graph's node is a compact row (icon, stage id, duration), not the
// editor's tall config card, so it reserves its own footprint in the dagre pass.
const RUN_NODE_WIDTH = 224;
const RUN_NODE_HEIGHT = 44;

// The read-only stage graph for one run: a node per stage of the run, carrying
// the outcome the stage settled on and how long it took, wired by the edges the
// pipeline definition declares. It is the same react-flow plus dagre setup the
// editor canvas uses (lib/pipeline-graph), with every editing affordance off:
// no connect handles, no dragging, no delete key, no add-stage panel.
//
// Nodes come from the run and edges from the definition, which is the only pair
// that stays honest when the definition has been edited since: a stage the run
// does not have cannot appear, and a route to a stage that is not in the run is
// dropped by draftEdges rather than drawn into nothing.
export function PipelineRunGraph({
	stages,
	definition,
	selectedStageId,
	onSelectStage,
}: {
	stages: PipelineStageView[];
	// The parsed pipeline definition, when it could be loaded. Without it the
	// graph still renders every stage; it just has no routing to draw.
	definition?: PipelineDraft;
	selectedStageId: string | null;
	onSelectStage: (stageId: string) => void;
}) {
	return (
		<ReactFlowProvider>
			<RunGraphInner
				stages={stages}
				definition={definition}
				selectedStageId={selectedStageId}
				onSelectStage={onSelectStage}
			/>
		</ReactFlowProvider>
	);
}

function RunGraphInner({
	stages,
	definition,
	selectedStageId,
	onSelectStage,
}: {
	stages: PipelineStageView[];
	definition?: PipelineDraft;
	selectedStageId: string | null;
	onSelectStage: (stageId: string) => void;
}) {
	// A draft whose stage list is the run's, so the graph lib's index-keyed node
	// ids address run stages directly. A stage the definition no longer declares
	// still gets a node (as a routeless placeholder) rather than disappearing.
	const graphDraft = useMemo<PipelineDraft>(
		() => ({
			name: definition?.name ?? "",
			defaults: definition?.defaults,
			stages: stages.map(
				(stage) =>
					definition?.stages.find((candidate) => candidate.id === stage.stageId) ?? {
						id: stage.stageId,
						executor: "command" as const,
					},
			),
		}),
		[stages, definition],
	);

	const nodes = useMemo<Node[]>(() => {
		const positions = layoutPositions(graphDraft, { width: RUN_NODE_WIDTH, height: RUN_NODE_HEIGHT });
		return stages.map((stage, i) => {
			const id = stageNodeId(i);
			return {
				id,
				type: "runStage",
				position: positions[id] ?? { x: 0, y: i * (RUN_NODE_HEIGHT + 16) },
				width: RUN_NODE_WIDTH,
				draggable: false,
				connectable: false,
				data: { stage, focused: stage.stageId === selectedStageId },
			};
		});
	}, [graphDraft, stages, selectedStageId]);

	const edges = useMemo<Edge[]>(
		() =>
			draftEdges(graphDraft).map((edge) => {
				const style = edgeAppearance(edge.kind, false);
				return {
					id: edge.id,
					source: edge.source,
					target: edge.target,
					focusable: false,
					selectable: false,
					deletable: false,
					ariaLabel: `${edge.kind === "success" ? "Success" : "Failure"} edge from ${edge.from} to ${edge.to}`,
					style,
					markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: style.stroke },
				};
			}),
		[graphDraft],
	);

	return (
		<div className="h-full w-full" data-testid="pipeline-run-graph">
			<ReactFlow
				nodes={nodes}
				edges={edges}
				nodeTypes={NODE_TYPES}
				onNodeClick={(_, node) => {
					const stage = stages[Number(node.id)];
					if (stage) onSelectStage(stage.stageId);
				}}
				nodesConnectable={false}
				nodesDraggable={false}
				edgesFocusable={false}
				elementsSelectable={false}
				deleteKeyCode={null}
				fitView
				fitViewOptions={{ padding: 0.25 }}
				minZoom={0.25}
				maxZoom={2}
				proOptions={{ hideAttribution: true }}
			>
				<Panel position="bottom-right">
					<GraphZoomBar />
				</Panel>
			</ReactFlow>
		</div>
	);
}

// The corner zoom cluster: fit, out, in. GitHub's run graph puts exactly these
// three in the bottom-right, and a read-only graph has no use for the editor's
// zoom-percentage readout.
function GraphZoomBar() {
	const { zoomIn, zoomOut, fitView } = useReactFlow();
	return (
		<div className="flex items-center gap-0.5 rounded-md border border-border bg-surface p-0.5">
			<Button
				size="icon-sm"
				variant="ghost"
				aria-label="Fit graph"
				onClick={() => void fitView({ padding: 0.25, duration: 200 })}
			>
				<Maximize className="size-icon-sm" aria-hidden="true" />
			</Button>
			<Button size="icon-sm" variant="ghost" aria-label="Zoom out" onClick={() => zoomOut({ duration: 150 })}>
				<Minus className="size-icon-sm" aria-hidden="true" />
			</Button>
			<Button size="icon-sm" variant="ghost" aria-label="Zoom in" onClick={() => zoomIn({ duration: 150 })}>
				<Plus className="size-icon-sm" aria-hidden="true" />
			</Button>
		</div>
	);
}

type RunStageNodeType = Node<{ stage: PipelineStageView; focused: boolean }, "runStage">;

function RunStageNode({ data }: NodeProps<RunStageNodeType>) {
	const { stage, focused } = data;
	const duration = formatStageDuration(stage.startedAt, stage.settledAt);
	return (
		<div
			data-graph-stage={stage.stageId}
			className={cn(
				"flex w-56 items-center gap-2 rounded-md border bg-surface px-3 py-2 transition-colors",
				focused ? "border-accent ring-1 ring-accent/40" : "border-border hover:border-border-strong",
			)}
		>
			{/* Hidden handles: edges need an anchor, but this graph is not connectable. */}
			<Handle type="target" position={Position.Left} isConnectable={false} className="!invisible" />
			<StageStatusIcon outcome={stage.outcome as StageOutcome} />
			<span className="min-w-0 flex-1 truncate text-control text-foreground">{stage.stageId}</span>
			{duration && <span className="shrink-0 font-mono text-micro text-passive">{duration}</span>}
			<Handle type="source" position={Position.Right} isConnectable={false} className="!invisible" />
		</div>
	);
}

const NODE_TYPES = { runStage: RunStageNode };

// --- status icons ------------------------------------------------------------

// The icon vocabulary for the eight settled outcomes plus the two live ones,
// tone-matched to stageOutcomeDotTone so the graph, the job rail and the board
// say the same thing about the same stage. The shapes carry the pairs the tones
// already collapse: failed and timed_out are both a cross, no_output and
// no_signal are both a warning, cancelled and skipped are both "nothing ran".
// succeeded_unverified is the dashed ring: the success hue, not a closed circle.
const OUTCOME_ICON: Record<StageOutcome, { Icon: typeof Circle; className: string }> = {
	succeeded: { Icon: CheckCircle2, className: "text-success" },
	succeeded_unverified: { Icon: CircleDashed, className: "text-success" },
	failed: { Icon: XCircle, className: "text-error" },
	timed_out: { Icon: XCircle, className: "text-error" },
	no_output: { Icon: AlertCircle, className: "text-warning" },
	no_signal: { Icon: AlertCircle, className: "text-warning" },
	cancelled: { Icon: MinusCircle, className: "text-passive" },
	skipped: { Icon: MinusCircle, className: "text-passive" },
	running: { Icon: CircleDot, className: "text-accent animate-pulse" },
	pending: { Icon: Circle, className: "text-muted-foreground" },
};

// StageStatusIcon is the one status glyph the run screen uses everywhere a
// stage is named without room for its full outcome wording.
export function StageStatusIcon({ outcome, className }: { outcome: StageOutcome; className?: string }) {
	const { Icon, className: tone } = OUTCOME_ICON[outcome] ?? OUTCOME_ICON.pending;
	return <Icon className={cn("size-icon-sm shrink-0", tone, className)} aria-hidden="true" />;
}

// A run status is the rollup of its stages, and its five values are a subset of
// the outcome vocabulary, so the header reuses the same glyphs rather than
// inventing a second set.
export function RunStatusIcon({ status, className }: { status: RunStatus; className?: string }) {
	return <StageStatusIcon outcome={status as StageOutcome} className={className} />;
}
