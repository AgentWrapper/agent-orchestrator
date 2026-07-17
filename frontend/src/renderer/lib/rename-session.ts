import { apiClient, apiErrorMessage } from "./api-client";
import { i18n } from "../i18n";

/** Update a session's display name via the daemon (PATCH /sessions/{id}). The
 *  daemon enforces the same 20-character limit as the spawn `--name` flag. */
export async function renameSession(sessionId: string, displayName: string): Promise<void> {
	const { error, response } = await apiClient.PATCH("/api/v1/sessions/{sessionId}", {
		params: { path: { sessionId } },
		body: { displayName },
	});

	if (error) {
		throw new Error(apiErrorMessage(error, i18n.t("sessions.errors.renameFailed", { status: response.status })));
	}
}
