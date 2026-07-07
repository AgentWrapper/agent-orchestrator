import { useQuery } from "@tanstack/react-query";
import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage } from "../lib/api-client";

export type AgentHealthResponse = components["schemas"]["AgentHealthResponse"];
export type AgentHarnessHealth = components["schemas"]["AgentHarnessHealth"];

// The daemon returns 501 when the periodic health monitor isn't wired into this
// build. That's an expected, non-error state — surface it as "unavailable" so
// the UI can explain the panel is dormant rather than flashing a hard failure.
export type AgentHealthResult = { kind: "ready"; data: AgentHealthResponse } | { kind: "unavailable" };

export const agentHealthQueryKey = ["agents", "health"] as const;

async function fetchAgentHealth(): Promise<AgentHealthResult> {
	const { data, error, response } = await apiClient.GET("/api/v1/agents/health");
	if (response.status === 501) return { kind: "unavailable" };
	if (error) throw new Error(apiErrorMessage(error));
	return { kind: "ready", data: data as AgentHealthResponse };
}

export const agentHealthQueryOptions = {
	queryKey: agentHealthQueryKey,
	queryFn: fetchAgentHealth,
	retry: 1,
	staleTime: 60 * 1000,
	// Auth can expire mid-session; a slow poll keeps the indicator honest without
	// hammering the daemon (the backend snapshot is itself only periodic).
	refetchInterval: 60 * 1000,
};

export function useAgentHealthQuery() {
	return useQuery(agentHealthQueryOptions);
}
