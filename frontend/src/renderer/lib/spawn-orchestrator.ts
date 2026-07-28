import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage } from "./api-client";
import { cloudBoardId, refreshCloudSessions } from "./cloud-sessions";
import type { OrchestratorSpawnSource } from "./orchestrator-spawn-sources";
import { captureRendererEvent } from "./telemetry";

// Every UI entry point that spawns an orchestrator: the board CTA, the topbar
// and sidebar launchers, the restore-unavailable dialog, and the auto-spawn
// right after a project is added. Emitting the triad from inside
// spawnOrchestrator (keyed by source) guarantees each path reports, instead of
// each call site remembering to instrument itself.
export type { OrchestratorSpawnSource };

/** Spawn the project's orchestrator session. Local by default (daemon API); pass
 *  `cloud: true` to run it in a per-session cloud sandbox (kind=orchestrator),
 *  returning that cloud session's board id. `clean` (local only) first tears
 *  down any active orchestrator, then re-spawns on the canonical branch. */
export async function spawnOrchestrator(
	projectId: string,
	source: OrchestratorSpawnSource,
	clean = false,
	cloud = false,
): Promise<string> {
	void captureRendererEvent("ao.renderer.orchestrator_spawn_requested", { project_id: projectId, source });
	try {
		if (cloud) {
			const boardId = await spawnOrchestratorInCloud(projectId);
			void captureRendererEvent("ao.renderer.orchestrator_spawn_succeeded", { project_id: projectId, source });
			return boardId;
		}

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

// Provision the orchestrator in its own cloud sandbox. Mirrors the cloud-worker
// path (NewTaskDialog) but with kind=orchestrator; the board renders it as a
// cloud card and its terminal streams from the sandbox. Returns the cloud board
// id to navigate to.
async function spawnOrchestratorInCloud(projectId: string): Promise<string> {
	const { data: projectData, error: projErr } = await apiClient.GET("/api/v1/projects/{id}", {
		params: { path: { id: projectId } },
	});
	if (projErr || projectData?.status !== "ok" || !projectData.project) {
		throw new Error(apiErrorMessage(projErr, "Could not load the project to start a cloud orchestrator"));
	}
	// data.project is a union (full | degraded); cast to the full type like
	// ProjectSettingsForm does — a degraded project has no config, caught below.
	const project = projectData.project as components["schemas"]["Project"];
	const harness = project.config?.orchestrator?.agent;
	if (!harness) {
		throw new Error("Set this project's orchestrator agent before running it in the cloud.");
	}

	const { data, error, response } = await apiClient.POST("/api/v1/cloud/sessions", {
		body: {
			harness,
			localProjectId: projectId,
			projectPath: project.path ?? "",
			// The control plane can't read our local path — send the git remote so
			// the sandbox clones real code (empty repo otherwise).
			remoteUrl: project.repo ?? "",
			kind: "orchestrator",
			displayName: "Orchestrator (cloud)",
		},
	});
	if (error || !data?.sandboxId) {
		throw new Error(apiErrorMessage(error, `Failed to start cloud orchestrator (${response.status})`));
	}

	await refreshCloudSessions();
	return cloudBoardId(data.sandboxId);
}
