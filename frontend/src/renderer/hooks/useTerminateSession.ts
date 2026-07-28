import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { WorkspaceSession } from "../types/workspace";
import { workspaceQueryKey } from "./useWorkspaceQuery";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { sessionApi } from "../lib/session-api";
import { refreshCloudSessions, sandboxIdFromBoardId } from "../lib/cloud-sessions";
import { captureRendererEvent } from "../lib/telemetry";

type TerminateSessionOptions = {
	onSuccess?: (session: WorkspaceSession) => void;
};

export function useTerminateSession(options: TerminateSessionOptions = {}) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (session: WorkspaceSession) => {
			void captureRendererEvent("ao.renderer.session_kill_requested", { project_id: session.workspaceId });
			// Cloud (owned) session: killing tears down the whole Daytona sandbox
			// (stops billing, destroys the worker) — the daemon marks it terminated
			// and keeps a card, so it lingers like a local killed session.
			const sandboxId = session.cloudPreviewUrl ? sandboxIdFromBoardId(session.id) : null;
			if (sandboxId) {
				const { error, response } = await apiClient.DELETE("/api/v1/cloud/sessions/{sandboxId}", {
					params: { path: { sandboxId } },
				});
				if (error) {
					const fallback = response ? `Failed to terminate session (${response.status})` : "Failed to terminate session";
					throw new Error(apiErrorMessage(error, fallback));
				}
				await refreshCloudSessions();
				return;
			}
			const { client, sessionId: routedId } = sessionApi(session.id);
			const { error, response } = await client.POST("/api/v1/sessions/{sessionId}/kill", {
				params: { path: { sessionId: routedId } },
			});
			if (error) {
				const fallback = response ? `Failed to terminate session (${response.status})` : "Failed to terminate session";
				throw new Error(apiErrorMessage(error, fallback));
			}
		},
		onSuccess: async (_data, session) => {
			void captureRendererEvent("ao.renderer.session_kill_succeeded", { project_id: session.workspaceId });
			await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
			options.onSuccess?.(session);
		},
		onError: (_error, session) => {
			void captureRendererEvent("ao.renderer.session_kill_failed", { project_id: session.workspaceId });
		},
	});
}
