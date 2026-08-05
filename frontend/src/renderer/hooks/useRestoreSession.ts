import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { aoBridge } from "../lib/bridge";
import { workspaceQueryKey } from "./useWorkspaceQuery";

export type RestoreSessionResult =
	{ status: "success" } | { status: "not_resumable"; message: string } | { status: "error"; message: string };

export function useRestoreSession(): (sessionId: string) => Promise<RestoreSessionResult> {
	const queryClient = useQueryClient();

	return useCallback(
		async (sessionId: string) => {
			try {
				const { data, error } = await apiClient.POST("/api/v1/sessions/{sessionId}/restore", {
					params: { path: { sessionId } },
				});
				if (error) {
					const code = (error as { code?: string }).code;
					const message = apiErrorMessage(error, "Unable to restore session");
					if (code === "SESSION_NOT_RESUMABLE") {
						return { status: "not_resumable", message };
					}
					return { status: "error", message };
				}
				await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
				if (data?.restoreMode === "saved_prompt") {
					void aoBridge.notifications
						.show({
							id: `restore-fallback:${sessionId}:${Date.now()}`,
							title: "Started from saved prompt",
							body: "AO could not resume the native agent session, so it started a new conversation from the saved prompt.",
						})
						.catch((err) => {
							console.warn("Unable to show restore fallback notification", err);
						});
				}
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
