import { useQuery } from "@tanstack/react-query";
import type { components } from "../../api/schema";
import { apiClient, hasTrustedApiBaseUrl } from "../lib/api-client";

export type OperatorAttentionItem = components["schemas"]["OperatorAttentionItem"];

export const operatorAttentionQueryKey = ["operator-attention"] as const;

export async function fetchOperatorAttention(): Promise<OperatorAttentionItem[]> {
	if (!hasTrustedApiBaseUrl()) return [];
	const { data, error } = await apiClient.GET("/api/v1/attention/operator");
	if (error) throw error;
	return data?.items ?? [];
}

export const operatorAttentionQueryOptions = {
	queryKey: operatorAttentionQueryKey,
	queryFn: fetchOperatorAttention,
	retry: 1,
	refetchInterval: 15_000,
};

export function useOperatorAttentionQuery() {
	return useQuery(operatorAttentionQueryOptions);
}
