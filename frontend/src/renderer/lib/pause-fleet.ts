import { apiClient, apiErrorMessage } from "./api-client";

// Fleet pause/resume + per-project pause/resume, mirroring the daemon endpoints
// added in the backend PR. Pause stops dispatching new work (config untouched);
// --hard terminates live workers immediately instead of draining.

export async function pauseProject(projectId: string, hard = false): Promise<void> {
	const { error, response } = await apiClient.POST("/api/v1/projects/{id}/pause", {
		params: { path: { id: projectId }, query: { hard } },
	});
	if (error) throw new Error(apiErrorMessage(error, `Failed to pause project (${response.status})`));
}

export async function resumeProject(projectId: string): Promise<void> {
	const { error, response } = await apiClient.POST("/api/v1/projects/{id}/resume", {
		params: { path: { id: projectId } },
	});
	if (error) throw new Error(apiErrorMessage(error, `Failed to resume project (${response.status})`));
}

export async function getFleetPaused(): Promise<boolean> {
	const { data, error, response } = await apiClient.GET("/api/v1/fleet");
	if (error || !data) throw new Error(apiErrorMessage(error, `Failed to read fleet status (${response.status})`));
	return data.paused;
}

export async function pauseFleet(hard = false): Promise<boolean> {
	const { data, error, response } = await apiClient.POST("/api/v1/fleet/pause", {
		params: { query: { hard } },
	});
	if (error || !data) throw new Error(apiErrorMessage(error, `Failed to pause fleet (${response.status})`));
	return data.paused;
}

export async function resumeFleet(): Promise<boolean> {
	const { data, error, response } = await apiClient.POST("/api/v1/fleet/resume", {});
	if (error || !data) throw new Error(apiErrorMessage(error, `Failed to resume fleet (${response.status})`));
	return data.paused;
}
