import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { workspaceQueryKey } from "./useWorkspaceQuery";

export type RestoreSessionResult =
	{ status: "success" } | { status: "not_resumable" } | { status: "error"; message: string };

export function useRestoreSession(): (sessionId: string) => Promise<RestoreSessionResult> {
	const queryClient = useQueryClient();

	return useCallback(
		async (sessionId: string) => {
			try {
				const { error } = await apiClient.POST("/api/v1/sessions/{sessionId}/restore", {
					params: { path: { sessionId } },
				});
				if (error) {
					const code = (error as { code?: string }).code;
					if (code === "SESSION_NOT_RESUMABLE") {
						return { status: "not_resumable" };
					}
					return { status: "error", message: apiErrorMessage(error, "Unable to restore session") };
				}
				await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
				return { status: "success" };
			} catch (err) {
				return {
					status: "error",
					message: err instanceof Error ? err.message : "Unable to restore session",
				};
			}
		},
		[queryClient],
	);
}
