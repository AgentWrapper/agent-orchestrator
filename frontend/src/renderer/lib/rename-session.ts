import { apiErrorMessage } from "./api-client";
import { sessionApi } from "./session-api";

/** Update a session's display name via the daemon (PATCH /sessions/{id}). The
 *  daemon enforces the same 20-character limit as the spawn `--name` flag.
 *  Routed via sessionApi so a cloud session hits its own sandbox daemon. */
export async function renameSession(sessionId: string, displayName: string): Promise<void> {
	const { client, sessionId: routedId } = sessionApi(sessionId);
	const { error, response } = await client.PATCH("/api/v1/sessions/{sessionId}", {
		params: { path: { sessionId: routedId } },
		body: { displayName },
	});

	if (error) {
		throw new Error(apiErrorMessage(error, `Failed to rename session (${response.status})`));
	}
}
