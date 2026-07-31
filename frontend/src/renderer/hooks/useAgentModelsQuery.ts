import { queryOptions } from "@tanstack/react-query";
import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage } from "../lib/api-client";

export type AgentModelCatalog = components["schemas"]["AgentModelsResponse"];

export const agentModelsQueryKey = (agentId: string, projectId: string) =>
	["agent-models", agentId, projectId] as const;

async function requestAgentModels(agentId: string, projectId: string, refresh: boolean): Promise<AgentModelCatalog> {
	const params = {
		path: { agent: agentId },
		query: { projectId: projectId || undefined },
	};
	const result = refresh
		? await apiClient.POST("/api/v1/agents/{agent}/models/refresh", { params })
		: await apiClient.GET("/api/v1/agents/{agent}/models", { params });
	if (result.error) throw new Error(apiErrorMessage(result.error));
	return result.data as AgentModelCatalog;
}

export function agentModelsQueryOptions(agentId: string, projectId: string) {
	return queryOptions({
		queryKey: agentModelsQueryKey(agentId, projectId),
		queryFn: () => requestAgentModels(agentId, projectId, false),
		enabled: agentId !== "",
		staleTime: Number.POSITIVE_INFINITY,
	});
}

export function refreshAgentModels(agentId: string, projectId: string) {
	return requestAgentModels(agentId, projectId, true);
}
