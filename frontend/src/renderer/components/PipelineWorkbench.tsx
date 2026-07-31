import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { cn } from "../lib/utils";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { usePipelineDefinitionsQuery } from "../hooks/usePipelineDefinitions";
import { pipelineRunQueryKey, usePipelineRuns, type PipelineRunSummary } from "../hooks/usePipelineRuns";
import { useWorkspaceQuery } from "../hooks/useWorkspaceQuery";
import type { WorkspaceSession } from "../types/workspace";
import { DashboardSubhead } from "./DashboardSubhead";
import { EMPTY_RUN_FILTERS, filterRunRows, PipelineFilterBar, type RunFilters } from "./PipelineFilterBar";
import { PipelineRunRow, toRunRowModel } from "./PipelineRunRow";

// The runs list, shaped like GitHub Actions' "All workflows" screen: a left rail
// of pipeline definitions (workflows) beside a dense, reverse-chronological list
// of runs. Runs stay live through the CDC event transport (pipeline_* → query
// invalidation); the rail and the filter row narrow the same list.
export function PipelineWorkbench({ projectId }: { projectId?: string }) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const { runs, isError, error } = usePipelineRuns();
	const definitions = usePipelineDefinitionsQuery(projectId).data ?? [];
	const workspaces = useWorkspaceQuery().data;
	const [filters, setFilters] = useState<RunFilters>(EMPTY_RUN_FILTERS);
	const [actionError, setActionError] = useState<string | null>(null);

	// One pass over the workspace tree instead of one lookup per row: the list is
	// long and every row wants the same join.
	const sessionsById = useMemo(() => {
		const map = new Map<string, WorkspaceSession>();
		for (const workspace of workspaces ?? []) {
			for (const session of workspace.sessions) map.set(session.id, session);
		}
		return map;
	}, [workspaces]);

	const rows = useMemo(() => {
		return (
			runs
				.map((run) => toRunRowModel(run, run.sessionId ? sessionsById.get(run.sessionId) : undefined))
				// Newest first, the way a run list is read.
				.sort((a, b) => (a.run.createdAt < b.run.createdAt ? 1 : a.run.createdAt > b.run.createdAt ? -1 : 0))
		);
	}, [runs, sessionsById]);

	// The rail lists every pipeline the project defines, plus any pipeline that
	// has runs here, so a definition with no runs yet still has a row (and an
	// empty list) rather than being invisible.
	const railPipelines = useMemo(() => {
		const names = new Set(definitions.map((definition) => definition.name));
		for (const row of rows) names.add(row.run.pipelineName);
		return [...names].sort();
	}, [definitions, rows]);

	const visibleRows = useMemo(() => filterRunRows(rows, filters), [rows, filters]);

	const cancel = useMutation({
		mutationFn: async (run: PipelineRunSummary) => {
			const { error: apiError } = await apiClient.POST("/api/v1/pipelines/runs/{runId}/cancel", {
				params: { path: { runId: run.runId }, query: { project: run.projectId } },
			});
			if (apiError) throw new Error(apiErrorMessage(apiError));
			return run.runId;
		},
		onSuccess: (runId) => {
			setActionError(null);
			void queryClient.invalidateQueries({ queryKey: pipelineRunQueryKey(runId) });
			void queryClient.invalidateQueries({ queryKey: ["pipeline-runs"] });
		},
		onError: (e: unknown) => setActionError(e instanceof Error ? e.message : "Could not cancel the run"),
	});

	const selected = filters.pipeline;

	return (
		<div className="flex h-full min-h-0 bg-background text-foreground">
			<nav aria-label="Pipelines" className="w-56 shrink-0 overflow-y-auto border-r border-border p-3">
				<ul className="flex flex-col gap-0.5">
					<RailItem
						label="All pipelines"
						active={!selected}
						onSelect={() => setFilters({ ...filters, pipeline: undefined })}
					/>
					{railPipelines.map((name) => (
						<RailItem
							key={name}
							label={name}
							active={selected === name}
							onSelect={() => setFilters({ ...filters, pipeline: name })}
						/>
					))}
					{railPipelines.length === 0 && <li className="px-2.5 py-1.5 text-caption text-passive">No pipelines yet</li>}
				</ul>
			</nav>

			<div className="flex min-h-0 min-w-0 flex-1 flex-col">
				<DashboardSubhead
					title={selected ?? "All pipelines"}
					subtitle={selected ? `Showing runs from ${selected}` : "Showing runs from all pipelines"}
				/>

				{isError ? (
					<p className="py-10 text-center text-xs text-error">
						Could not load pipeline runs{error instanceof Error ? `: ${error.message}` : ""}.
					</p>
				) : (
					<div className="m-4.5 flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border">
						<div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-surface px-3 py-2">
							<span className="text-control font-semibold text-foreground">
								{visibleRows.length} pipeline run{visibleRows.length === 1 ? "" : "s"}
							</span>
							{actionError && <span className="text-caption text-error">{actionError}</span>}
							<div className="ml-auto">
								<PipelineFilterBar rows={rows} filters={filters} onChange={setFilters} />
							</div>
						</div>

						<ul aria-label="Pipeline runs" className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
							{visibleRows.map((row) => (
								<PipelineRunRow
									key={row.run.runId}
									row={row}
									cancelPending={cancel.isPending && cancel.variables?.runId === row.run.runId}
									onCancel={() => cancel.mutate(row.run)}
									onOpen={() =>
										void navigate({
											to: "/pipelines/runs/$runId",
											params: { runId: row.run.runId },
											search: { project: row.run.projectId },
										})
									}
								/>
							))}
							{visibleRows.length === 0 && (
								<li className="p-8 text-center text-caption text-passive">
									{rows.length === 0 ? "No pipeline runs yet." : "No runs match these filters."}
								</li>
							)}
						</ul>
					</div>
				)}
			</div>
		</div>
	);
}

function RailItem({ label, active, onSelect }: { label: string; active: boolean; onSelect: () => void }) {
	return (
		<li>
			<button
				type="button"
				onClick={onSelect}
				aria-current={active ? "true" : undefined}
				className={cn(
					"w-full truncate rounded-md border-l-2 px-2.5 py-1.5 text-left text-control transition-colors",
					active
						? "border-l-accent bg-raised font-medium text-foreground"
						: "border-l-transparent text-muted-foreground hover:bg-raised hover:text-foreground",
				)}
			>
				{label}
			</button>
		</li>
	);
}
