import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { spawnOrchestrator, type OrchestratorSpawnSource } from "../lib/spawn-orchestrator";
import { newestActiveOrchestrator, type WorkspaceSession } from "../types/workspace";
import { workspaceQueryKey } from "./useWorkspaceQuery";

/**
 * Shared navigation helper for opening a project's orchestrator session.
 *
 * Both the topbar and the sidebar route through this hook so they agree on
 * which orchestrator to open. The live orchestrator is chosen by recency
 * (`newestActiveOrchestrator`), which fixes the lexicographic-targeting bug
 * reported in #1362.
 */
export function useOpenOrchestrator(projectId: string, sessions: WorkspaceSession[], source: OrchestratorSpawnSource) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [isSpawning, setIsSpawning] = useState(false);

	const orchestrator = newestActiveOrchestrator(sessions);

	const openOrchestrator = async () => {
		if (isSpawning) return;

		if (orchestrator) {
			void navigate({
				to: "/projects/$projectId/sessions/$sessionId",
				params: { projectId, sessionId: orchestrator.id },
			});
			return;
		}

		setIsSpawning(true);
		try {
			const sessionId = await spawnOrchestrator(projectId, source);
			await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
			void navigate({
				to: "/projects/$projectId/sessions/$sessionId",
				params: { projectId, sessionId },
			});
		} catch (err) {
			console.error("Failed to spawn orchestrator:", err);
			// Rethrow so surfaces that render spawn failures (e.g. board topbar) can show them.
			throw err;
		} finally {
			setIsSpawning(false);
		}
	};

	return { orchestrator, openOrchestrator, isSpawning };
}
