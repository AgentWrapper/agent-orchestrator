import { cn } from "../lib/utils";
import { formatTimeCompact } from "../lib/format-time";
import { loopStateTone, shortSha, stageStatusDotTone } from "../lib/pipeline-display";
import type { PipelineRunSummary } from "../hooks/usePipelineRuns";
import { Badge } from "./ui/badge";

// Card view of a single pipeline run in a Kanban column: pipeline name, run id,
// session, loop rounds, per-stage status dots, artifact/findings hint, and a
// relative timestamp. The whole card opens the read-only run detail.
export function PipelineRunCard({ run, onOpen }: { run: PipelineRunSummary; onOpen: () => void }) {
	const stageNames = Object.keys(run.stageStatuses ?? {}).sort();
	return (
		<button
			type="button"
			onClick={onOpen}
			data-run-id={run.runId}
			className={cn(
				"flex w-full flex-col gap-1.5 rounded-md border bg-card p-2.5 text-left shadow-sm transition-colors hover:border-border-strong",
				run.hasOpenFindings ? "border-warning/40" : "border-border",
			)}
		>
			<div className="flex items-baseline gap-2">
				<span className="truncate font-mono text-caption font-semibold text-foreground">{run.pipelineName}</span>
				{run.blocksMerge && (
					<Badge variant="error" className="shrink-0">
						Blocks merge
					</Badge>
				)}
				<span className={cn("ml-auto text-micro font-medium", loopStateTone(run.loopState))}>
					rounds {run.loopRounds}
				</span>
			</div>
			<div className="flex items-center gap-2 font-mono text-micro text-passive">
				<span className="truncate">{run.sessionId || run.runId}</span>
				{run.headSha && <span className="shrink-0">· {shortSha(run.headSha)}</span>}
			</div>
			{stageNames.length > 0 && (
				<ul className="flex flex-wrap items-center gap-1.5" aria-label="stage statuses">
					{stageNames.map((name) => (
						<li
							key={name}
							className="inline-flex items-center gap-1 font-mono text-micro text-muted-foreground"
							title={`${name}: ${run.stageStatuses?.[name] ?? "pending"}`}
						>
							<span
								className={cn("h-1.5 w-1.5 rounded-full", stageStatusDotTone(run.stageStatuses?.[name] ?? "pending"))}
							/>
							<span className="truncate">{name}</span>
						</li>
					))}
				</ul>
			)}
			<div className="flex items-center gap-2 text-micro text-passive">
				<span>
					{run.stageCount} stage{run.stageCount === 1 ? "" : "s"}
				</span>
				{run.hasOpenFindings && <span className="text-warning">· open findings</span>}
				<span className="ml-auto">{formatTimeCompact(run.updatedAt)}</span>
			</div>
		</button>
	);
}
