import { useQuery } from "@tanstack/react-query";
import type { components } from "../../api/schema";
import { apiClient } from "../lib/api-client";
import { sessionUsageRefreshIntervalMs } from "./useSessionUsageSummaries";

export type SessionUsage = components["schemas"]["SessionUsageResponse"];

export const sessionUsageDetailQueryKey = (sessionId: string) => ["session-usage-detail", sessionId] as const;

export async function fetchSessionUsage(sessionId: string): Promise<SessionUsage> {
	const { data, error } = await apiClient.GET("/api/v1/usage/sessions/{sessionId}", {
		params: { path: { sessionId } },
	});
	if (error) throw error;
	return data;
}

export function useSessionUsage(sessionId: string) {
	return useQuery({
		queryKey: sessionUsageDetailQueryKey(sessionId),
		queryFn: () => fetchSessionUsage(sessionId),
		retry: 1,
		refetchInterval: sessionUsageRefreshIntervalMs,
	});
}
