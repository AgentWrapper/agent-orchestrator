import { useMutation, useMutationState, useQueryClient } from "@tanstack/react-query";
import type { WorkspaceSession } from "../types/workspace";
import { workspaceQueryKey } from "./useWorkspaceQuery";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { captureRendererEvent } from "../lib/telemetry";

type TerminateSessionOptions = {
	onSuccess?: (session: WorkspaceSession) => void;
};

export const terminateSessionMutationKey = ["terminate-session"] as const;

export function useTerminateSession(options: TerminateSessionOptions = {}) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationKey: terminateSessionMutationKey,
		mutationFn: async (session: WorkspaceSession) => {
			void captureRendererEvent("ao.renderer.session_kill_requested", { project_id: session.workspaceId });
			const { error, response } = await apiClient.POST("/api/v1/sessions/{sessionId}/kill", {
				params: { path: { sessionId: session.id } },
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

export function useTerminateSessionState(sessionId: string) {
	const mutations = useMutationState({
		filters: { mutationKey: terminateSessionMutationKey },
		select: (mutation) => ({
			error: mutation.state.error,
			sessionId: (mutation.state.variables as WorkspaceSession | undefined)?.id,
			status: mutation.state.status,
			submittedAt: mutation.state.submittedAt,
		}),
	});
	const matching = mutations.filter((mutation) => mutation.sessionId === sessionId);
	const latest = matching.reduce<(typeof matching)[number] | undefined>(
		(current, mutation) => (!current || mutation.submittedAt >= current.submittedAt ? mutation : current),
		undefined,
	);
	const isPending = matching.some((mutation) => mutation.status === "pending");

	return {
		error: !isPending && latest?.status === "error" && latest.error instanceof Error ? latest.error.message : null,
		isPending,
	};
}
