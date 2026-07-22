import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../lib/api-client";

export const pipelinesSettingQueryKey = ["settings-pipelines"] as const;

// The persisted pipelines feature flag (backend `settings/pipelines`, T12).
// Unlike usePipelinesEnabled's one-shot capability probe, this reads/writes the
// actual setting the daemon boots with, so it must stay fresh across saves.
export function usePipelinesSetting() {
	const query = useQuery({
		queryKey: pipelinesSettingQueryKey,
		queryFn: async () => {
			const { data } = await apiClient.GET("/api/v1/settings/pipelines", {});
			return data?.enabled ?? false;
		},
	});

	return { enabled: query.data, isLoading: query.isLoading };
}

export function useSetPipelinesSetting() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (enabled: boolean) => {
			await apiClient.PUT("/api/v1/settings/pipelines", { body: { enabled } });
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: pipelinesSettingQueryKey });
		},
	});
}
