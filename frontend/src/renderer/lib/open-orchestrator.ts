import { findProjectOrchestrator, type WorkspaceSummary } from "../types/workspace";
import { spawnOrchestrator, type OrchestratorSpawnSource } from "./spawn-orchestrator";

export type OpenOrEnsureOrchestratorOptions = {
	/** Current workspace query snapshot (may be stale). */
	workspaces: WorkspaceSummary[];
	/**
	 * Refetch workspaces once when the cache has no live orchestrator.
	 * Must return the refreshed list used for the second lookup.
	 */
	refetchWorkspaces: () => Promise<WorkspaceSummary[]>;
};

export type OpenOrEnsureOrchestratorResult = {
	sessionId: string;
	/** True only when POST /orchestrators (clean=false) was called. */
	didSpawn: boolean;
};

/**
 * Open the project's live orchestrator, or ensure one exists.
 *
 * Never passes clean=true. Casual clicks must reuse a non-terminated
 * orchestrator when one exists — including when the client cache is briefly
 * empty and a single refetch would find it.
 */
export async function openOrEnsureOrchestrator(
	projectId: string,
	source: OrchestratorSpawnSource,
	options: OpenOrEnsureOrchestratorOptions,
): Promise<OpenOrEnsureOrchestratorResult> {
	let orch = findProjectOrchestrator(options.workspaces, projectId);
	if (orch) {
		return { sessionId: orch.id, didSpawn: false };
	}

	const refreshed = await options.refetchWorkspaces();
	orch = findProjectOrchestrator(refreshed, projectId);
	if (orch) {
		return { sessionId: orch.id, didSpawn: false };
	}

	const sessionId = await spawnOrchestrator(projectId, source, false);
	return { sessionId, didSpawn: true };
}
