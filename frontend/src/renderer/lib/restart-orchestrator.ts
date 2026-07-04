import type { QueryClient } from "@tanstack/react-query";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { spawnOrchestrator } from "./spawn-orchestrator";

type NavigateToSession = (options: {
	to: "/projects/$projectId/sessions/$sessionId";
	params: { projectId: string; sessionId: string };
}) => unknown;

type RestartProjectOrchestratorOptions = {
	projectId: string;
	queryClient: QueryClient;
	navigate: NavigateToSession;
	setProjectRestarting: (projectId: string, restarting: boolean) => void;
	setOrchestratorReplacementError: (projectId: string, message: string | null) => void;
	onError?: (error: unknown) => void;
};

async function refreshWorkspaceState(queryClient: QueryClient) {
	try {
		await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
	} catch {
		// The restart outcome is more important than cache refresh bookkeeping:
		// callers still need navigation/error state even if refetching fails.
	}
}

export async function restartProjectOrchestrator({
	projectId,
	queryClient,
	navigate,
	setProjectRestarting,
	setOrchestratorReplacementError,
	onError,
}: RestartProjectOrchestratorOptions) {
	setProjectRestarting(projectId, true);
	setOrchestratorReplacementError(projectId, null);
	try {
		const sessionId = await spawnOrchestrator(projectId, true);
		await refreshWorkspaceState(queryClient);
		void navigate({
			to: "/projects/$projectId/sessions/$sessionId",
			params: { projectId, sessionId },
		});
	} catch (error) {
		await refreshWorkspaceState(queryClient);
		setOrchestratorReplacementError(projectId, error instanceof Error ? error.message : "Could not replace orchestrator");
		onError?.(error);
	} finally {
		setProjectRestarting(projectId, false);
	}
}
