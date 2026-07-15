import { useQueries, useQuery } from "@tanstack/react-query";
import type { components } from "../../api/schema";
import { apiClient, hasTrustedApiBaseUrl } from "../lib/api-client";
import { useWorkspaceQuery } from "./useWorkspaceQuery";

// A run summary tagged with the project it belongs to. The pipelines runs API is
// project-scoped (`?project=ID`), but the Runs section aggregates across every
// project (like the PR board), so each row carries its projectId for the
// cancel/resume calls, which are also project-scoped.
export type PipelineRunSummary = components["schemas"]["PipelineRunSummary"] & { projectId: string };
export type PipelineRunDetail = components["schemas"]["PipelineRunDetail"];
export type PipelineArtifact = components["schemas"]["PipelineArtifact"];

// Query keys. Every pipeline key is prefixed "pipeline-" so the event transport
// can invalidate the whole family with one predicate on a pipeline_* CDC event.
export function pipelineRunsQueryKey(projectId: string) {
	return ["pipeline-runs", projectId] as const;
}
export function pipelineRunQueryKey(runId: string) {
	return ["pipeline-run", runId] as const;
}

function runsQueryOptions(projectId: string) {
	return {
		queryKey: pipelineRunsQueryKey(projectId),
		queryFn: async (): Promise<PipelineRunSummary[]> => {
			if (!hasTrustedApiBaseUrl()) return [];
			const { data, error } = await apiClient.GET("/api/v1/pipelines/runs", {
				params: { query: { project: projectId } },
			});
			if (error) throw error;
			return (data?.runs ?? []).map((run) => ({ ...run, projectId }));
		},
		retry: 1,
		refetchInterval: 15_000,
	};
}

// Aggregated runs across all projects. Fans one runs query out per project and
// flattens; live invalidation comes from the CDC event transport, the interval
// is only a backstop.
export function usePipelineRuns() {
	const workspaceQuery = useWorkspaceQuery();
	const projects = workspaceQuery.data ?? [];
	const runQueries = useQueries({ queries: projects.map((project) => runsQueryOptions(project.id)) });
	const runs = runQueries.flatMap((query) => query.data ?? []);
	return {
		runs,
		isLoading: workspaceQuery.isLoading || runQueries.some((query) => query.isLoading),
		isError: workspaceQuery.isError || runQueries.some((query) => query.isError),
		error: workspaceQuery.error ?? runQueries.find((query) => query.error)?.error ?? null,
	};
}

// One run's full detail (stages + findings). GET run detail is not project-scoped.
export function usePipelineRun(runId: string) {
	return useQuery({
		queryKey: pipelineRunQueryKey(runId),
		queryFn: async (): Promise<PipelineRunDetail> => {
			const { data, error } = await apiClient.GET("/api/v1/pipelines/runs/{runId}", {
				params: { path: { runId } },
			});
			if (error) throw error;
			if (!data?.run) throw new Error("Run not found");
			return data.run;
		},
		retry: 1,
		refetchInterval: 10_000,
	});
}
