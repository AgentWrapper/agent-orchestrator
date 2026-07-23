import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { workspaceQueryKey } from "./useWorkspaceQuery";

export type CleanupSessionResult = { status: "success" } | { status: "error"; message: string };

// useCleanupSession triggers the per-session terminal-resource cleanup
// (POST /sessions/{id}/cleanup) and refreshes the workspace query so the updated
// cleanup facts re-render. Mirrors useRestoreSession: a useCallback returning a
// typed result union rather than throwing. Used to retry a preserved-dirty or
// failed cleanup from the UI.
export function useCleanupSession(): (sessionId: string) => Promise<CleanupSessionResult> {
	const queryClient = useQueryClient();

	return useCallback(
		async (sessionId: string) => {
			try {
				const { error } = await apiClient.POST("/api/v1/sessions/{sessionId}/cleanup", {
					params: { path: { sessionId } },
				});
				if (error) {
					return { status: "error", message: apiErrorMessage(error, "Unable to clean up session") };
				}
				await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
				return { status: "success" };
			} catch (err) {
				return {
					status: "error",
					message: err instanceof Error ? err.message : "Unable to clean up session",
				};
			}
		},
		[queryClient],
	);
}
