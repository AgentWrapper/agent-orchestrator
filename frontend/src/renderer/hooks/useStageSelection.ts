import { useCallback, useState } from "react";

// Shared stage-selection state for the visual editor area: the canvas (V2)
// selects a stage, the inspector (V3) binds to it. The stored value is the
// stage's canvas node id (see stageNodeId in lib/pipeline-graph: the array
// index), NOT the stage name: names can be empty or duplicated mid-edit and
// selection must still resolve so the inspector can open and fix them.
export interface StageSelection {
	selectedStage: string | null;
	selectStage: (nodeId: string | null) => void;
}

export function useStageSelection(): StageSelection {
	const [selectedStage, setSelectedStage] = useState<string | null>(null);
	const selectStage = useCallback((nodeId: string | null) => setSelectedStage(nodeId), []);
	return { selectedStage, selectStage };
}
