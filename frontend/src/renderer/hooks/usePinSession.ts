import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { WorkspaceSession } from "../types/workspace";
import { workspaceQueryKey } from "./useWorkspaceQuery";
import { apiClient, apiErrorMessage } from "../lib/api-client";

export const pinSessionMutationKey = ["pin-session"] as const;
export const unpinSessionMutationKey = ["unpin-session"] as const;

export function usePinSession() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationKey: pinSessionMutationKey,
		mutationFn: async (session: WorkspaceSession) => {
			const { error, response } = await apiClient.POST("/api/v1/sessions/{sessionId}/pin", {
				params: { path: { sessionId: session.id } },
			});
			if (error) {
				const fallback = response ? `Failed to pin session (${response.status})` : "Failed to pin session";
				throw new Error(apiErrorMessage(error, fallback));
			}
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
		},
		onError: (error) => {
			console.error("Failed to pin session:", error);
		},
	});
}

export function useUnpinSession() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationKey: unpinSessionMutationKey,
		mutationFn: async (session: WorkspaceSession) => {
			const { error, response } = await apiClient.DELETE("/api/v1/sessions/{sessionId}/pin", {
				params: { path: { sessionId: session.id } },
			});
			if (error) {
				const fallback = response ? `Failed to unpin session (${response.status})` : "Failed to unpin session";
				throw new Error(apiErrorMessage(error, fallback));
			}
		},
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
		},
		onError: (error) => {
			console.error("Failed to unpin session:", error);
		},
	});
}
