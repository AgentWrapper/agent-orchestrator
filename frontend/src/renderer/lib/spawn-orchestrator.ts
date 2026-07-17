import { apiClient, apiErrorMessage, safeExternalErrorMessage } from "./api-client";
import { i18n } from "../i18n";
import { captureRendererEvent } from "./telemetry";

// Every UI entry point that spawns an orchestrator: the board CTA, the topbar
// and sidebar launchers, the restore-unavailable dialog, and the auto-spawn
// right after a project is added. Emitting the triad from inside
// spawnOrchestrator (keyed by source) guarantees each path reports, instead of
// each call site remembering to instrument itself. Keep in sync with the
// allowed-source list in telemetry.ts.
export type OrchestratorSpawnSource =
	| "board"
	| "restore_dialog"
	| "topbar"
	| "sidebar"
	| "project_add"
	| "settings"
	| "restart";

export type OrchestratorErrorDescriptor =
	| { kind: "detail"; detail: string }
	| { kind: "spawn"; error: OrchestratorSpawnError }
	| { kind: "fallback" };

export class OrchestratorSpawnError extends Error {
	constructor(
		readonly apiError: unknown,
		readonly status: number,
	) {
		super(spawnErrorMessage(apiError, status));
		this.name = "OrchestratorSpawnError";
	}
}

function spawnErrorMessage(apiError: unknown, status: number): string {
	const fallback = i18n.t("sessions.errors.spawnFailed", { status });
	return apiError ? apiErrorMessage(apiError, fallback) : fallback;
}

export function orchestratorErrorDescriptor(error: unknown): OrchestratorErrorDescriptor {
	if (error instanceof OrchestratorSpawnError) return { kind: "spawn", error };
	const detail = safeExternalErrorMessage(error);
	if (detail) return { kind: "detail", detail };
	return { kind: "fallback" };
}

export function orchestratorErrorMessage(error: OrchestratorErrorDescriptor, fallback: string): string {
	if (error.kind === "detail") return error.detail;
	if (error.kind === "spawn") return spawnErrorMessage(error.error.apiError, error.error.status);
	return fallback;
}

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
			throw new OrchestratorSpawnError(error, response.status);
		}

		void captureRendererEvent("ao.renderer.orchestrator_spawn_succeeded", { project_id: projectId, source });
		return data.orchestrator.id;
	} catch (err) {
		void captureRendererEvent("ao.renderer.orchestrator_spawn_failed", { project_id: projectId, source });
		throw err;
	}
}
