import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage } from "../lib/api-client";

export type TrackerLabel = components["schemas"]["TrackerLabel"];
type LabelsResponse = components["schemas"]["TrackerIntakeLabelsResponse"];

export const trackerIntakeLabelsQueryKey = (projectId: string) =>
	["tracker-intake", "github", "labels", projectId] as const;

async function fetchLabels(projectId: string, refresh: boolean): Promise<LabelsResponse> {
	const { data, error } = await apiClient.GET("/api/v1/projects/{id}/tracker-intake/github/labels", {
		params: { path: { id: projectId }, query: { refresh } },
	});
	if (error) throw new Error(apiErrorMessage(error));
	return data as LabelsResponse;
}

export function useTrackerIntakeLabels(projectId: string, enabled: boolean) {
	const queryClient = useQueryClient();
	const queryKey = trackerIntakeLabelsQueryKey(projectId);
	const query = useQuery({
		queryKey,
		queryFn: () => fetchLabels(projectId, false),
		enabled: enabled && projectId !== "",
		staleTime: 5 * 60 * 1000,
		retry: 1,
	});
	const refresh = useMutation({
		mutationFn: () => fetchLabels(projectId, true),
		onSuccess: (data) => queryClient.setQueryData(queryKey, data),
	});
	return { ...query, refresh };
}
