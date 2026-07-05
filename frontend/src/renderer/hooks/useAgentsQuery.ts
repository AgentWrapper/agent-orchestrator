import { useQuery } from "@tanstack/react-query";
import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage } from "../lib/api-client";

export type AgentCatalog = components["schemas"]["ListAgentsResponse"];

export const agentsQueryKey = ["agents"] as const;

async function fetchAgents(): Promise<AgentCatalog> {
	const { data, error } = await apiClient.GET("/api/v1/agents");
	if (error) throw new Error(apiErrorMessage(error));
	return data as AgentCatalog;
}

export async function refreshAgents(): Promise<AgentCatalog> {
	const { data, error } = await apiClient.POST("/api/v1/agents/refresh");
	if (error) throw new Error(apiErrorMessage(error));
	return data as AgentCatalog;
}

export const agentsQueryOptions = {
	queryKey: agentsQueryKey,
	queryFn: fetchAgents,
	retry: 1,
	staleTime: 5 * 60 * 1000,
};

export function useAgentsQuery() {
	return useQuery(agentsQueryOptions);
}
