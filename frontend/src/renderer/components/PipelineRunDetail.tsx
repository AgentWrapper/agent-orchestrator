import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { cn } from "../lib/utils";
import { formatTimeCompact } from "../lib/format-time";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { loopStateTone, severityBadgeVariant, shortSha, stageStatusDotTone } from "../lib/pipeline-display";
import { pipelineRunQueryKey, usePipelineRun, type PipelineArtifact } from "../hooks/usePipelineRuns";
import type { components } from "../../api/schema";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Switch } from "./ui/switch";

type PipelineStageView = components["schemas"]["PipelineStageView"];

// Read-only detail for one pipeline run: per-stage state, materialized findings,
// and cancel/resume actions. No followup thread, no artifact editing — v1 detail
// is observe-only beyond the two lifecycle buttons.
export function PipelineRunDetail({ runId, project }: { runId: string; project?: string }) {
	const queryClient = useQueryClient();
	const { data: run, isLoading, isError, error } = usePipelineRun(runId);
	const [showDismissed, setShowDismissed] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);

	const refresh = () => {
		void queryClient.invalidateQueries({ queryKey: pipelineRunQueryKey(runId) });
		void queryClient.invalidateQueries({ queryKey: ["pipeline-runs"] });
	};

	const lifecycleMutation = (
		path: "/api/v1/pipelines/runs/{runId}/cancel" | "/api/v1/pipelines/runs/{runId}/resume",
	) => ({
		mutationFn: async () => {
			if (!project) throw new Error("Project is unknown for this run");
			const { error: apiError } = await apiClient.POST(path, {
				params: { path: { runId }, query: { project } },
			});
			if (apiError) throw new Error(apiErrorMessage(apiError));
		},
		onSuccess: () => {
			setActionError(null);
			refresh();
		},
		onError: (e: unknown) => setActionError(e instanceof Error ? e.message : "Action failed"),
	});

	const cancel = useMutation(lifecycleMutation("/api/v1/pipelines/runs/{runId}/cancel"));
	const resume = useMutation(lifecycleMutation("/api/v1/pipelines/runs/{runId}/resume"));

	const stages = useMemo(() => [...(run?.stages ?? [])].sort((a, b) => a.stageName.localeCompare(b.stageName)), [run]);
	const findings = useMemo(() => {
		const list = run?.findings ?? [];
		return showDismissed ? list : list.filter((f) => f.status !== "dismissed");
	}, [run, showDismissed]);
	const dismissedCount = (run?.findings ?? []).filter((f) => f.status === "dismissed").length;

	if (isLoading) {
		return <p className="p-6 text-caption text-passive">Loading run…</p>;
	}
	if (isError || !run) {
		return (
			<p className="p-6 text-caption text-error">
				Could not load run{error instanceof Error ? `: ${error.message}` : ""}.
			</p>
		);
	}

	const canCancel = run.loopState === "running" || run.loopState === "awaiting_context";
	const canResume = run.loopState === "stalled";

	return (
		<div className="flex h-full min-h-0 flex-col overflow-y-auto bg-background text-foreground">
			<header className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-5">
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<h1 className="truncate text-subtitle font-bold tracking-tight text-foreground">{run.pipelineName}</h1>
						<span className={cn("text-caption font-semibold", loopStateTone(run.loopState))}>{run.loopState}</span>
						{run.terminationReason && <span className="text-caption text-passive">· {run.terminationReason}</span>}
						{run.blocksMerge && <Badge variant="error">Blocks merge</Badge>}
					</div>
					<p className="mt-0.5 truncate font-mono text-micro text-passive">
						{run.runId} · session {run.sessionId ? <SessionLink sessionId={run.sessionId} /> : "—"} ·{" "}
						{shortSha(run.headSha)} · {run.loopRounds} round
						{run.loopRounds === 1 ? "" : "s"} · updated {formatTimeCompact(run.updatedAt)}
					</p>
				</div>
				<div className="ml-auto flex items-center gap-2">
					{actionError && <span className="text-caption text-error">{actionError}</span>}
					{canCancel && (
						<Button
							size="sm"
							variant="outline"
							disabled={cancel.isPending || !project}
							title={project ? undefined : "Open this run from the board to cancel it"}
							onClick={() => cancel.mutate()}
						>
							{cancel.isPending ? "Cancelling…" : "Cancel"}
						</Button>
					)}
					{canResume && (
						<Button
							size="sm"
							variant="primary"
							disabled={resume.isPending || !project}
							title={project ? undefined : "Open this run from the board to resume it"}
							onClick={() => resume.mutate()}
						>
							{resume.isPending ? "Resuming…" : "Resume"}
						</Button>
					)}
				</div>
			</header>

			<section aria-label="Stages" className="border-b border-border px-6 py-4">
				<h2 className="mb-2 text-micro font-semibold uppercase tracking-wide text-passive">Stages</h2>
				<div className="flex flex-col gap-2">
					{stages.map((stage) => (
						<StageRow key={stage.stageRunId || stage.stageName} stage={stage} />
					))}
					{stages.length === 0 && <p className="text-caption text-passive">No stages yet.</p>}
				</div>
			</section>

			<section aria-label="Findings" className="px-6 py-4">
				<div className="mb-2 flex items-center gap-3">
					<h2 className="text-micro font-semibold uppercase tracking-wide text-passive">
						Findings <span className="font-mono text-passive">{findings.length}</span>
					</h2>
					{dismissedCount > 0 && (
						<label className="ml-auto flex items-center gap-2 text-caption text-muted-foreground">
							<Switch checked={showDismissed} onCheckedChange={setShowDismissed} />
							Show dismissed ({dismissedCount})
						</label>
					)}
				</div>
				<div className="flex flex-col gap-2">
					{findings.map((finding) => (
						<FindingRow
							key={finding.artifactId}
							finding={finding}
							runId={runId}
							project={project}
							onChanged={refresh}
						/>
					))}
					{findings.length === 0 && <p className="text-caption text-passive">No findings.</p>}
				</div>
			</section>
		</div>
	);
}

// One stage row: status/verdict summary plus a collapsible block for the
// captured command output (last 64 KiB of combined stdout+stderr), when present.
function StageRow({ stage }: { stage: PipelineStageView }) {
	const [showOutput, setShowOutput] = useState(false);
	return (
		<div
			data-stage={stage.stageName}
			className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2"
		>
			<span className={cn("h-2 w-2 shrink-0 rounded-full", stageStatusDotTone(stage.status))} />
			<span className="font-mono text-caption font-medium text-foreground">{stage.stageName}</span>
			<span className="font-mono text-micro text-passive">{stage.status}</span>
			{stage.sessionId && (
				<span className="font-mono text-micro text-passive">
					· session <SessionLink sessionId={stage.sessionId} />
				</span>
			)}
			{stage.verdict && <Badge variant="outline">{stage.verdict}</Badge>}
			<span className="ml-auto flex items-center gap-2 font-mono text-micro text-passive">
				{stage.output && (
					<button
						type="button"
						onClick={() => setShowOutput((v) => !v)}
						className="rounded px-1 text-passive underline-offset-2 hover:text-foreground hover:underline"
						aria-expanded={showOutput}
					>
						{showOutput ? "Hide output" : "Output"}
					</button>
				)}
				<span>
					attempt {stage.attempt}
					{stage.artifactIds.length > 0 &&
						` · ${stage.artifactIds.length} artifact${stage.artifactIds.length === 1 ? "" : "s"}`}
				</span>
			</span>
			{stage.errorMessage && <p className="w-full font-mono text-micro text-error">{stage.errorMessage}</p>}
			{stage.notes?.map((note, i) => (
				<p key={i} className="w-full font-mono text-micro text-warning">
					{note}
				</p>
			))}
			{stage.output && showOutput && (
				<pre className="max-h-80 w-full overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-background px-2 py-1.5 font-mono text-micro text-muted-foreground">
					{stage.output}
				</pre>
			)}
		</div>
	);
}

// SessionLink navigates to a session's page (from the routes shell), reused for
// both the run-level session and any stage that ran an agent (command/builtin
// stages leave stage.sessionId empty and stay plain text).
function SessionLink({ sessionId }: { sessionId: string }) {
	const navigate = useNavigate();
	return (
		<button
			type="button"
			onClick={() => void navigate({ to: "/sessions/$sessionId", params: { sessionId } })}
			className="rounded px-0.5 text-passive underline-offset-2 hover:text-foreground hover:underline"
		>
			{sessionId}
		</button>
	);
}

function FindingRow({
	finding,
	runId,
	project,
	onChanged,
}: {
	finding: PipelineArtifact;
	runId: string;
	project?: string;
	onChanged: () => void;
}) {
	const [error, setError] = useState<string | null>(null);
	const location = finding.filePath
		? `${finding.filePath}${finding.startLine ? `:${finding.startLine}` : ""}`
		: undefined;
	const isDismissed = finding.status === "dismissed";

	// Dismiss hides a false-positive finding so it stops blocking no_open_findings
	// gates; Undo reopens it. Both POST the new status, then invalidate on success.
	const setStatus = useMutation({
		mutationFn: async (status: "open" | "dismissed") => {
			if (!project) throw new Error("Project is unknown for this run");
			const { error: apiError } = await apiClient.POST("/api/v1/pipelines/runs/{runId}/artifacts/{artifactId}/status", {
				params: { path: { runId, artifactId: finding.artifactId }, query: { project } },
				body: { status },
			});
			if (apiError) throw new Error(apiErrorMessage(apiError));
		},
		onSuccess: () => {
			setError(null);
			onChanged();
		},
		onError: (e: unknown) => setError(e instanceof Error ? e.message : "Action failed"),
	});

	return (
		<div
			data-finding={finding.artifactId}
			className={cn("rounded-md border border-border bg-card px-3 py-2", isDismissed && "opacity-60")}
		>
			<div className="flex flex-wrap items-center gap-2">
				<span className="truncate text-caption font-medium text-foreground">{finding.title || "(untitled)"}</span>
				{finding.severity && <Badge variant={severityBadgeVariant(finding.severity)}>{finding.severity}</Badge>}
				<span className="font-mono text-micro text-passive">{finding.status}</span>
				{typeof finding.confidence === "number" && (
					<span className="font-mono text-micro text-passive">· {Math.round(finding.confidence * 100)}%</span>
				)}
				<span className="ml-auto font-mono text-micro text-passive">{finding.stageName}</span>
				{finding.kind === "finding" && (
					<Button
						size="sm"
						variant="ghost"
						className="h-6 px-2 text-micro"
						disabled={setStatus.isPending || !project}
						title={project ? undefined : "Open this run from the board to change findings"}
						onClick={() => setStatus.mutate(isDismissed ? "open" : "dismissed")}
					>
						{setStatus.isPending ? "…" : isDismissed ? "Undo" : "Dismiss"}
					</Button>
				)}
			</div>
			{location && <p className="mt-0.5 font-mono text-micro text-passive">{location}</p>}
			{finding.description && <p className="mt-1 text-micro text-muted-foreground">{finding.description}</p>}
			{error && <p className="mt-1 font-mono text-micro text-error">{error}</p>}
		</div>
	);
}
