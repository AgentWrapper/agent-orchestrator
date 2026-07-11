import { useQuery } from "@tanstack/react-query";
import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage } from "../lib/api-client";

export type AgentModelAvailabilityResponse = components["schemas"]["AgentModelAvailabilityResponse"];
export type AgentHarnessModels = components["schemas"]["AgentHarnessModels"];
export type AgentModelAvailability = components["schemas"]["AgentModelAvailability"];

export const modelAvailabilityQueryKey = ["agents", "models"] as const;

export async function fetchModelAvailability(
	options: { force?: boolean } = {},
): Promise<AgentModelAvailabilityResponse> {
	const { data, error } = await apiClient.GET("/api/v1/agents/models", {
		params: options.force ? { query: { force: true } } : undefined,
	});
	if (error) throw new Error(apiErrorMessage(error));
	return data as AgentModelAvailabilityResponse;
}

export const modelAvailabilityQueryOptions = {
	queryKey: modelAvailabilityQueryKey,
	queryFn: () => fetchModelAvailability(),
	retry: 1,
	staleTime: 5 * 60 * 1000,
};

export function useModelAvailabilityQuery(enabled = true) {
	return useQuery({ ...modelAvailabilityQueryOptions, enabled });
}
