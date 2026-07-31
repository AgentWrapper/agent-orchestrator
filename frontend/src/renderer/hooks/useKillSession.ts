import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { captureRendererEvent } from "../lib/telemetry";
import type { WorkspaceSession } from "../types/workspace";
import { workspaceQueryKey } from "./useWorkspaceQuery";

/**
 * The one session-kill mutation: POST /sessions/{id}/kill with telemetry around
 * it, then a workspace refetch so the session drops into the board's terminated
 * group. Shared by the session topbar's kill button and the board's
 * pipeline-orphan card action, so there is a single place that knows the
 * endpoint and the event names.
 */
export function useKillSession(
	session: Pick<WorkspaceSession, "id" | "workspaceId">,
	callbacks: { onKilled?: () => void; onError?: (message: string) => void } = {},
) {
	const queryClient = useQueryClient();
	const { onKilled, onError } = callbacks;

	return useMutation({
		mutationFn: async () => {
			void captureRendererEvent("ao.renderer.session_kill_requested", { project_id: session.workspaceId });
			const { error: apiError } = await apiClient.POST("/api/v1/sessions/{sessionId}/kill", {
				params: { path: { sessionId: session.id } },
			});
			if (apiError) throw new Error(apiErrorMessage(apiError, "Could not kill session"));
		},
		onSuccess: () => {
			void captureRendererEvent("ao.renderer.session_kill_succeeded", { project_id: session.workspaceId });
			void queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
			onKilled?.();
		},
		onError: (e) => {
			void captureRendererEvent("ao.renderer.session_kill_failed", { project_id: session.workspaceId });
			onError?.(e instanceof Error ? e.message : "Kill failed");
		},
	});
}
