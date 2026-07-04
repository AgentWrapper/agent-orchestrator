import { captureRendererException } from "./telemetry";

export function captureOrchestratorReplacementFailure(error: unknown, projectId: string) {
	void captureRendererException(error, {
		source: "orchestrator-replace",
		operation: "replace_orchestrator",
		surface: "shell",
		project_id: projectId,
	});
}
