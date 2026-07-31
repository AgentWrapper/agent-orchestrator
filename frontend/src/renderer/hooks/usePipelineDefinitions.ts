import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { components } from "../../api/schema";
import { apiClient } from "../lib/api-client";

export type PipelineDefinitionSummary = components["schemas"]["PipelineDefinitionSummary"];

export const pipelineDefinitionsQueryKey = (projectId?: string) =>
	projectId ? (["pipeline-definitions", projectId] as const) : (["pipeline-definitions"] as const);

async function fetchPipelineDefinitions(projectId: string): Promise<PipelineDefinitionSummary[]> {
	const { data, error } = await apiClient.GET("/api/v1/pipelines", {
		params: { query: { project: projectId } },
	});
	if (error) throw error;
	return data?.definitions ?? [];
}

// Definitions for one project, keyed by project id so switching the project
// picker swaps the cache entry instead of refetching into the same key.
export function usePipelineDefinitionsQuery(projectId?: string) {
	return useQuery({
		queryKey: pipelineDefinitionsQueryKey(projectId),
		enabled: Boolean(projectId),
		queryFn: () => fetchPipelineDefinitions(projectId!),
		retry: 1,
	});
}

// Create / update / delete share one invalidation of the project's list. The
// mutations throw the raw openapi-fetch `error` body so callers can pull the
// validation issue list out of it (parsePipelineValidationIssues) unchanged.
export function usePipelineDefinitionMutations(projectId?: string) {
	const queryClient = useQueryClient();
	const invalidate = () => queryClient.invalidateQueries({ queryKey: pipelineDefinitionsQueryKey(projectId) });

	const create = useMutation({
		mutationFn: async (yamlSource: string) => {
			if (!projectId) throw new Error("No project selected");
			const { data, error } = await apiClient.POST("/api/v1/pipelines", {
				params: { query: { project: projectId } },
				body: { yamlSource },
			});
			if (error) throw error;
			return data!.definition;
		},
		onSuccess: invalidate,
	});

	const update = useMutation({
		mutationFn: async ({ id, yamlSource }: { id: string; yamlSource: string }) => {
			const { data, error } = await apiClient.PUT("/api/v1/pipelines/{id}", {
				params: { path: { id } },
				body: { yamlSource },
			});
			if (error) throw error;
			return data!.definition;
		},
		onSuccess: invalidate,
	});

	const remove = useMutation({
		mutationFn: async (id: string) => {
			const { error } = await apiClient.DELETE("/api/v1/pipelines/{id}", {
				params: { path: { id } },
			});
			if (error) throw error;
		},
		onSuccess: invalidate,
	});

	return { create, update, remove };
}
