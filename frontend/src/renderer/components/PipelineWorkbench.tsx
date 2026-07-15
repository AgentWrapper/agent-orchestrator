import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { cn } from "../lib/utils";
import { KANBAN_COLUMNS, type LoopStateName } from "../lib/pipeline-display";
import { usePipelineRuns, type PipelineRunSummary } from "../hooks/usePipelineRuns";
import { DashboardSubhead } from "./DashboardSubhead";
import { PipelineFilterBar } from "./PipelineFilterBar";
import { PipelineRunCard } from "./PipelineRunCard";

// Runs workbench: a 5-column Kanban grouped by loopState across all projects.
// Runs stay live through the CDC event transport (pipeline_* → query
// invalidation); the filter bar narrows to a subset of pipeline names.
export function PipelineWorkbench() {
	const navigate = useNavigate();
	const { runs, isError, error } = usePipelineRuns();
	const [selectedPipelines, setSelectedPipelines] = useState<string[]>([]);

	const pipelineNames = useMemo(() => {
		const set = new Set<string>();
		for (const run of runs) set.add(run.pipelineName);
		return [...set].sort();
	}, [runs]);

	const filteredRuns = useMemo(() => {
		if (selectedPipelines.length === 0) return runs;
		const allowed = new Set(selectedPipelines);
		return runs.filter((run) => allowed.has(run.pipelineName));
	}, [runs, selectedPipelines]);

	const columns = useMemo(() => {
		const grouped = new Map<LoopStateName, PipelineRunSummary[]>();
		for (const col of KANBAN_COLUMNS) grouped.set(col.state, []);
		for (const run of filteredRuns) grouped.get(run.loopState as LoopStateName)?.push(run);
		// Newest first within a column.
		for (const list of grouped.values()) {
			list.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
		}
		return KANBAN_COLUMNS.map((col) => ({ ...col, runs: grouped.get(col.state) ?? [] }));
	}, [filteredRuns]);

	return (
		<div className="flex h-full min-h-0 flex-col bg-background text-foreground">
			<DashboardSubhead
				title="Pipeline runs"
				subtitle="Live pipeline runs grouped by loop state across every project."
				count={filteredRuns.length}
			/>

			<PipelineFilterBar
				availablePipelines={pipelineNames}
				selected={selectedPipelines}
				onChange={setSelectedPipelines}
			/>

			{isError ? (
				<p className="py-10 text-center text-caption text-error">
					Could not load pipeline runs{error instanceof Error ? `: ${error.message}` : ""}.
				</p>
			) : (
				<div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-auto p-4.5 md:grid-cols-5">
					{columns.map((col) => (
						<section
							key={col.state}
							aria-label={`${col.title} column`}
							data-loop-state={col.state}
							className={cn("flex min-h-40 flex-col rounded-md border-l-2 bg-surface p-2", col.borderClass)}
						>
							<header className="px-1 pb-2">
								<h2 className="flex items-center gap-1.5 text-micro font-semibold uppercase tracking-wide text-muted-foreground">
									{col.title}
									<span className="rounded-full bg-raised px-1.5 font-mono text-2xs text-passive">
										{col.runs.length}
									</span>
								</h2>
								<p className="mt-0.5 text-2xs text-passive">{col.description}</p>
							</header>
							<div className="flex flex-1 flex-col gap-2">
								{col.runs.map((run) => (
									<PipelineRunCard
										key={run.runId}
										run={run}
										onOpen={() =>
											void navigate({
												to: "/pipelines/runs/$runId",
												params: { runId: run.runId },
												search: { project: run.projectId },
											})
										}
									/>
								))}
								{col.runs.length === 0 && (
									<div className="rounded border border-dashed border-border p-3 text-center text-2xs text-passive">
										Empty
									</div>
								)}
							</div>
						</section>
					))}
				</div>
			)}
		</div>
	);
}
