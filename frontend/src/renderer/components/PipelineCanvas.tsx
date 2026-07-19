import { Background, Controls, ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { PipelineDraft } from "../lib/pipeline-draft";

// The node-graph canvas surface. V1 mounts React Flow as an empty, pannable
// placeholder so the view shell + layout are in place; V2 renders one node per
// stage (dependsOn -> edges) and wires selection into the inspector. The draft
// is threaded now so V2 only has to fill in the node/edge mapping.
export function PipelineCanvas({ draft }: { draft: PipelineDraft }) {
	const stageCount = draft.stages.length;
	return (
		<div className="relative h-full w-full" data-testid="pipeline-canvas">
			<ReactFlow nodes={[]} edges={[]} fitView proOptions={{ hideAttribution: true }}>
				<Background />
				<Controls showInteractive={false} />
			</ReactFlow>
			<div className="pointer-events-none absolute inset-0 flex items-center justify-center">
				<p className="rounded-md bg-surface/80 px-3 py-2 text-caption text-passive">
					Visual canvas arrives in V2 · {stageCount} {stageCount === 1 ? "stage" : "stages"} in this draft
				</p>
			</div>
		</div>
	);
}
