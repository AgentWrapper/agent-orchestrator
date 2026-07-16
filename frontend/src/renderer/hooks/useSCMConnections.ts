import { useQuery } from "@tanstack/react-query";
import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage } from "../lib/api-client";

export type SCMConnection = components["schemas"]["SCMConnection"];

export const scmConnectionsQueryKey = ["scm-connections"] as const;

export async function fetchSCMConnections(): Promise<SCMConnection[]> {
	const { data, error } = await apiClient.GET("/api/v1/scm/connections");
	if (error) throw new Error(apiErrorMessage(error));
	return data?.connections ?? [];
}

export function useSCMConnections(enabled = true) {
	return useQuery({
		queryKey: scmConnectionsQueryKey,
		queryFn: fetchSCMConnections,
		enabled,
		retry: 1,
	});
}
