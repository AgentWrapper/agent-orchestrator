import { useQuery } from "@tanstack/react-query";
import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage } from "../lib/api-client";

export type WorkerCapacity = components["schemas"]["WorkerCapacity"];
export type WorkerCapacityBucket = components["schemas"]["WorkerCapacityBucket"];
export type WorkerCapacityHarness = components["schemas"]["WorkerCapacityHarness"];

export type WorkerCapacityResult = { kind: "ready"; data: WorkerCapacity } | { kind: "unavailable" };

export const workerCapacityQueryKey = (projectId: string) => ["projects", projectId, "worker-capacity"] as const;

async function fetchWorkerCapacity(projectId: string): Promise<WorkerCapacityResult> {
	const { data, error, response } = await apiClient.GET("/api/v1/projects/{id}/worker-capacity", {
		params: { path: { id: projectId } },
	});
	if (response.status === 501) return { kind: "unavailable" };
	if (error) throw new Error(apiErrorMessage(error));
	if (!data?.capacity) throw new Error("Worker capacity response was empty.");
	return { kind: "ready", data: data.capacity };
}

export function workerCapacityQueryOptions(projectId: string) {
	return {
		queryKey: workerCapacityQueryKey(projectId),
		queryFn: () => fetchWorkerCapacity(projectId),
		retry: 1,
		staleTime: 10_000,
		refetchInterval: 15_000,
	};
}

export function useWorkerCapacityQuery(projectId: string) {
	return useQuery(workerCapacityQueryOptions(projectId));
}
