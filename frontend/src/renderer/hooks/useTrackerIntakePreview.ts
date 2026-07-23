import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage } from "../lib/api-client";

type PreviewResponse = components["schemas"]["TrackerIntakePreviewResponse"];

export function useTrackerIntakePreview(projectId: string, labels: string[], enabled: boolean) {
	const labelsKey = labels.join("\u0000");
	const [debouncedLabels, setDebouncedLabels] = useState(labels);
	const debouncedKey = debouncedLabels.join("\u0000");
	useEffect(() => {
		const timer = window.setTimeout(() => setDebouncedLabels(labels), 300);
		return () => window.clearTimeout(timer);
	}, [labelsKey, labels]);

	const query = useQuery({
		queryKey: ["tracker-intake", "github", "preview", projectId, debouncedKey],
		queryFn: async (): Promise<PreviewResponse> => {
			const { data, error } = await apiClient.POST("/api/v1/projects/{id}/tracker-intake/github/preview", {
				params: { path: { id: projectId } },
				body: { labels: debouncedLabels },
			});
			if (error) throw new Error(apiErrorMessage(error));
			return data as PreviewResponse;
		},
		enabled: enabled && projectId !== "",
		retry: 1,
	});
	return { ...query, isDebouncing: labelsKey !== debouncedKey };
}
