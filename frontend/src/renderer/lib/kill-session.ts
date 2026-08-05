import { apiClient, apiErrorMessage } from "./api-client";

/** Terminate a session and tear down its runtime/workspace resources (POST /sessions/{id}/kill). */
export async function killSession(sessionId: string): Promise<void> {
	const { error, response } = await apiClient.POST("/api/v1/sessions/{sessionId}/kill", {
		params: { path: { sessionId } },
	});

	if (error) {
		throw new Error(apiErrorMessage(error, `Failed to kill session (${response.status})`));
	}
}
