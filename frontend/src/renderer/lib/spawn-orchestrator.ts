import { apiClient, apiErrorMessage } from "./api-client";
import type { OrchestratorSpawnSource } from "./orchestrator-spawn-sources";
import { captureRendererEvent } from "./telemetry";

// Every UI entry point that spawns an orchestrator: the board CTA, the topbar
// and sidebar launchers, the restore-unavailable dialog, and the auto-spawn
// right after a project is added. Emitting the triad from inside
// spawnOrchestrator (keyed by source) guarantees each path reports, instead of
// each call site remembering to instrument itself.
export type { OrchestratorSpawnSource };

/** Spawn the project's orchestrator session via the daemon API. When clean is
 *  true the daemon first tears down any active orchestrator for the project, then
 *  re-spawns one on the canonical branch (reattaching the existing branch). */
export async function spawnOrchestrator(
	projectId: string,
	source: OrchestratorSpawnSource,
	clean = false,
): Promise<string> {
	void captureRendererEvent("ao.renderer.orchestrator_spawn_requested", { project_id: projectId, source });
	try {
		const { data, error, response } = await apiClient.POST("/api/v1/orchestrators", {
			body: { projectId, clean },
		});

		if (error || !data?.orchestrator?.id) {
			const message = error
				? apiErrorMessage(error, `Failed to spawn orchestrator (${response.status})`)
				: `Failed to spawn orchestrator (${response.status})`;
			throw new Error(message);
		}

		void captureRendererEvent("ao.renderer.orchestrator_spawn_succeeded", { project_id: projectId, source });
		return data.orchestrator.id;
	} catch (err) {
		void captureRendererEvent("ao.renderer.orchestrator_spawn_failed", { project_id: projectId, source });
		throw err;
	}
}
