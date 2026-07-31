import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, FileText, Folder, LayoutList } from "lucide-react";
import { cn } from "../lib/utils";
import { formatTimeCompact } from "../lib/format-time";
import { apiClient, apiErrorCode, apiErrorMessage, getApiBaseUrl } from "../lib/api-client";
import {
	formatStageDuration,
	runStatusTone,
	shortSha,
	stageOutcomeDotTone,
	stageOutcomeLabel,
} from "../lib/pipeline-display";
import { parseYamlToDraft, type PipelineDraft, type RunStatus, type StageOutcome } from "../lib/pipeline-draft";
import { useKillSession } from "../hooks/useKillSession";
import { usePipelineDefinitionsQuery } from "../hooks/usePipelineDefinitions";
import { pipelineRunQueryKey, usePipelineRun } from "../hooks/usePipelineRuns";
import { useWorkspaceQuery } from "../hooks/useWorkspaceQuery";
import type { WorkspaceSession } from "../types/workspace";
import type { components } from "../../api/schema";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { PipelineRunGraph, RunStatusIcon, StageStatusIcon } from "./PipelineRunGraph";
import { runNumberLabel } from "./PipelineRunRow";

type PipelineStageView = components["schemas"]["PipelineStageView"];
type RunDetail = components["schemas"]["PipelineRunDetail"];

// How much of a stage log the viewer asks for. The log is the main debugging
// surface for a command stage that failed, and the interesting part of a failure
// is the end of it.
const LOG_TAIL_LINES = 200;

// The daemon's code for "this stage has no log file", which the viewer renders
// as an empty log rather than as a failure.
const LOG_NOT_FOUND_CODE = "PIPELINE_STAGE_LOG_NOT_FOUND";

// Read-only detail for one pipeline run, laid out like a GitHub Actions run page
// (workflow = pipeline definition, job = stage, workflow run = pipeline run):
// a status header with the live run's one destructive action, a job rail down
// the left, and a main column of summary, stage graph, and per-stage detail.
//
// The per-stage detail is where the outcome taxonomy (spec section 7) stays
// legible: which stage settled how, whether it was nudged, which failure routed
// into it, what it produced or failed to produce, and what its log says. There
// is no resume (spec section 14.1) and no findings panel: the findings subsystem
// is deleted (D10), and a stage's contract is its one declared artifact.
export function PipelineRunDetail({ runId, project }: { runId: string; project?: string }) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const { data: run, isLoading, isError, error } = usePipelineRun(runId);
	const [actionError, setActionError] = useState<string | null>(null);
	// Which stage the rail or the graph has focused. Null is the Summary entry:
	// no stage is singled out and the main column reads from the top.
	const [focusedStage, setFocusedStage] = useState<string | null>(null);
	const stageRefs = useRef<Record<string, HTMLElement | null>>({});
	const mainRef = useRef<HTMLDivElement | null>(null);

	// The run DTO names its pipeline but carries neither its routing nor its
	// triggers, so the graph reads both off the project's definitions, which the
	// definitions page has usually already cached. Without a project scope there
	// is no definitions endpoint to ask.
	const definitions = usePipelineDefinitionsQuery(project).data;
	const definition = useMemo<PipelineDraft | undefined>(() => {
		const source = definitions?.find((candidate) => candidate.id === run?.pipelineId)?.yamlSource;
		return source ? (parseYamlToDraft(source).draft ?? undefined) : undefined;
	}, [definitions, run?.pipelineId]);

	// Focusing a stage scrolls its card into view; Summary scrolls back to the
	// top, because that is what the entry means on GitHub's rail.
	const focusStage = useCallback((stageId: string | null) => {
		setFocusedStage(stageId);
		if (stageId) stageRefs.current[stageId]?.scrollIntoView({ behavior: "smooth", block: "start" });
		else mainRef.current?.scrollTo({ top: 0, behavior: "smooth" });
	}, []);

	const cancel = useMutation({
		mutationFn: async () => {
			if (!project) throw new Error("Project is unknown for this run");
			const { error: apiError } = await apiClient.POST("/api/v1/pipelines/runs/{runId}/cancel", {
				params: { path: { runId }, query: { project } },
			});
			if (apiError) throw new Error(apiErrorMessage(apiError));
		},
		onSuccess: () => {
			setActionError(null);
			void queryClient.invalidateQueries({ queryKey: pipelineRunQueryKey(runId) });
			void queryClient.invalidateQueries({ queryKey: ["pipeline-runs"] });
		},
		onError: (e: unknown) => setActionError(e instanceof Error ? e.message : "Action failed"),
	});

	if (isLoading) {
		return <p className="py-10 text-center text-xs text-passive">Loading run…</p>;
	}
	if (isError || !run) {
		return (
			<p className="py-10 text-center text-xs text-error">
				Could not load run{error instanceof Error ? `: ${error.message}` : ""}.
			</p>
		);
	}

	// Stages arrive in plan order from the API; only a live run can be cancelled.
	const stages = run.stages;
	const status = run.status as RunStatus;
	const canCancel = status === "pending" || status === "running";

	return (
		<div className="flex h-full min-h-0 flex-col bg-background text-foreground">
			<header className="shrink-0 border-b border-border px-6 pb-4 pt-4">
				<button
					type="button"
					onClick={() => void navigate({ to: "/pipelines/runs" })}
					className="flex items-center gap-1.5 rounded text-caption text-passive underline-offset-2 hover:text-foreground hover:underline"
				>
					<ArrowLeft className="size-icon-xs" aria-hidden="true" />
					Runs
				</button>
				<div className="mt-2 flex flex-wrap items-center gap-2">
					<RunStatusIcon status={status} className="size-icon-base" />
					{/* A settled run's header goes quiet: the screen is a record, not a
					    thing to act on, which is the difference the red Cancel marks. */}
					<h1
						className={cn(
							"truncate text-subtitle font-bold tracking-tight",
							canCancel ? "text-foreground" : "text-muted-foreground",
						)}
					>
						{run.pipelineName}
					</h1>
					{/* Where GitHub puts "#199": the per-pipeline run number, which is
					    what a human says out loud when they mean this run. */}
					<span className="text-subtitle font-normal text-passive">#{runNumberLabel(run)}</span>
					<span className="font-mono text-caption text-passive">{run.runId}</span>
					{run.cancelReason && <span className="text-caption text-passive">· {run.cancelReason}</span>}
					<div className="ml-auto flex items-center gap-2">
						{actionError && <span className="text-caption text-error">{actionError}</span>}
						{canCancel && (
							<Button
								size="sm"
								variant="outline"
								className="border-error/40 text-error hover:bg-error/10 hover:text-error"
								disabled={cancel.isPending || !project}
								title={project ? undefined : "Open this run from the board to cancel it"}
								onClick={() => cancel.mutate()}
							>
								{cancel.isPending ? "Cancelling…" : "Cancel workflow"}
							</Button>
						)}
					</div>
				</div>
			</header>

			<div className="flex min-h-0 flex-1">
				<RunRail
					run={run}
					focusedStage={focusedStage}
					onFocusStage={focusStage}
					onOpenDefinitions={() => void navigate({ to: "/pipelines" })}
				/>

				<div ref={mainRef} className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-4">
					<RunSummaryCard run={run} />

					<section aria-label="Stage graph" className="rounded-lg border border-border bg-card">
						<div className="border-b border-border px-5 py-3">
							<p className="truncate text-control font-semibold text-foreground">{run.pipelineName}</p>
							<p className="mt-0.5 font-mono text-micro text-passive">
								{definition
									? triggerSummary(definition)
									: "routing unavailable: this run's pipeline definition could not be loaded"}
							</p>
						</div>
						<div className="h-72">
							<PipelineRunGraph
								stages={stages}
								definition={definition}
								selectedStageId={focusedStage}
								onSelectStage={focusStage}
							/>
						</div>
					</section>

					<section aria-label="Stages" className="flex flex-col gap-3">
						{stages.map((stage) => (
							<StageCard
								key={stage.stageId}
								runId={run.runId}
								stage={stage}
								focused={focusedStage === stage.stageId}
								cardRef={(el) => {
									stageRefs.current[stage.stageId] = el;
								}}
							/>
						))}
						{stages.length === 0 && <p className="text-caption text-passive">No stages yet.</p>}
					</section>
				</div>
			</div>
		</div>
	);
}

// The left rail: Summary, every stage of the run with its status glyph, then the
// run-level details that are not stage facts. GitHub's `Usage` has no analogue
// here (the daemon bills nothing), so the group carries the two things a human
// actually goes looking for: the definition this run came from and the folder
// its artifacts and logs live in.
function RunRail({
	run,
	focusedStage,
	onFocusStage,
	onOpenDefinitions,
}: {
	run: RunDetail;
	focusedStage: string | null;
	onFocusStage: (stageId: string | null) => void;
	onOpenDefinitions: () => void;
}) {
	return (
		<nav aria-label="Run navigation" className="w-60 shrink-0 overflow-y-auto border-r border-border px-3 py-4">
			<RailItem
				icon={<LayoutList className="size-icon-sm text-muted-foreground" aria-hidden="true" />}
				label="Summary"
				active={focusedStage === null}
				onClick={() => onFocusStage(null)}
			/>

			<p className="mb-1 mt-4 px-2 font-mono text-2xs font-medium uppercase tracking-wide-sm text-passive">All jobs</p>
			{run.stages.map((stage) => (
				<RailItem
					key={stage.stageId}
					icon={<StageStatusIcon outcome={stage.outcome as StageOutcome} />}
					label={stage.stageId}
					active={focusedStage === stage.stageId}
					onClick={() => onFocusStage(stage.stageId)}
				/>
			))}
			{run.stages.length === 0 && <p className="px-2 text-micro text-passive">No stages yet.</p>}

			<p className="mb-1 mt-4 px-2 font-mono text-2xs font-medium uppercase tracking-wide-sm text-passive">Run details</p>
			<RailItem
				icon={<FileText className="size-icon-sm text-muted-foreground" aria-hidden="true" />}
				label="Pipeline definition"
				active={false}
				onClick={onOpenDefinitions}
			/>
			{run.runDir && (
				<div className="mt-1 flex items-start gap-2 px-2 py-1.5">
					<Folder className="mt-px size-icon-sm shrink-0 text-muted-foreground" aria-hidden="true" />
					<span className="min-w-0 flex-1 break-all font-mono text-micro text-passive" title={run.runDir}>
						{run.runDir}
					</span>
				</div>
			)}
		</nav>
	);
}

function RailItem({
	icon,
	label,
	active,
	onClick,
}: {
	icon: ReactNode;
	label: string;
	active: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-current={active ? "true" : undefined}
			className={cn(
				"flex w-full items-center gap-2 rounded-md border-l-2 px-2 py-1.5 text-left text-control transition-colors",
				active
					? "border-l-accent bg-raised text-foreground"
					: "border-l-transparent text-muted-foreground hover:bg-surface hover:text-foreground",
			)}
		>
			{icon}
			<span className="min-w-0 flex-1 truncate">{label}</span>
		</button>
	);
}

// The summary card: what triggered the run, how it settled, how long it took and
// what it left behind, in GitHub's four-field layout. Total duration is measured
// from the run's creation, which is the only clock the run DTO carries.
function RunSummaryCard({ run }: { run: RunDetail }) {
	const status = run.status as RunStatus;
	const duration = formatStageDuration(run.createdAt, run.settledAt);
	const artifacts = run.stages.filter((stage) => stage.producedArtifact?.exists).length;

	return (
		<section
			aria-label="Run summary"
			className="grid gap-x-8 gap-y-4 rounded-lg border border-border bg-card px-5 py-4 sm:grid-cols-[minmax(0,1fr)_repeat(3,minmax(6rem,auto))]"
		>
			<div className="min-w-0">
				<p className="text-caption text-muted-foreground">Triggered via {SUBJECT_LABEL[run.subjectKind]}</p>
				<div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-caption text-passive">
					<RunSubject run={run} />
				</div>
				<div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-micro text-passive">
					<span title={absoluteTime(run.createdAt)}>created {formatTimeCompact(run.createdAt)}</span>
					<span aria-hidden="true">·</span>
					{run.settledAt ? (
						<span title={absoluteTime(run.settledAt)}>settled {formatTimeCompact(run.settledAt)}</span>
					) : (
						<span>not settled</span>
					)}
				</div>
			</div>

			<SummaryField label="Status">
				<span className={runStatusTone(status)} data-run-status={status}>
					{status}
				</span>
			</SummaryField>
			<SummaryField label="Total duration">{duration || "0s"}</SummaryField>
			<SummaryField label="Artifacts">{artifacts > 0 ? String(artifacts) : "None"}</SummaryField>
		</section>
	);
}

function SummaryField({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div>
			<p className="text-micro text-passive">{label}</p>
			<p className="mt-2 text-control font-semibold text-foreground">{children}</p>
		</div>
	);
}

const SUBJECT_LABEL: Record<RunDetail["subjectKind"], string> = {
	session: "session",
	pr: "pull request",
	project: "project",
};

// `on: pr.created, pr.updated`, the pipeline's own trigger list, in the same
// place GitHub prints `on: pull_request`. A definition with no triggers only
// runs when someone asks it to.
function triggerSummary(definition: PipelineDraft): string {
	const events = [
		...(definition.on?.pr ?? []).map((event) => `pr.${event}`),
		...(definition.on?.session ?? []).map((event) => `session.${event}`),
	];
	return events.length > 0 ? `on: ${events.join(", ")}` : "on: manual";
}

// What the run is about. A PR subject only has a url when a local session tracks
// it (the run DTO carries the number, not the link), and a sessionless PR is
// first-class (spec section 4), so the number renders as plain text rather than
// as a link to a guessed url.
function RunSubject({ run }: { run: RunDetail }) {
	const session = useSessionFacts(run.sessionId);
	if (run.subjectKind === "pr" && run.prNumber) {
		const prUrl = session?.prs?.find((pr) => pr.number === run.prNumber)?.url;
		return (
			<span className="flex items-center gap-2">
				{prUrl ? (
					<a
						href={prUrl}
						target="_blank"
						rel="noopener noreferrer"
						className="rounded text-passive underline-offset-2 hover:text-foreground hover:underline"
					>
						PR #{run.prNumber}
					</a>
				) : (
					<span>PR #{run.prNumber}</span>
				)}
				{run.headSha && <span>{shortSha(run.headSha)}</span>}
				{run.sessionId && <SessionLink sessionId={run.sessionId} />}
			</span>
		);
	}
	if (run.sessionId) return <SessionLink sessionId={run.sessionId} />;
	// A project subject has neither a PR nor a session to point at: nothing but
	// a person asked for it, and the card's "Triggered via project" line has
	// already said the rest.
	return <span>{run.subjectKind === "project" ? "manual trigger" : run.subjectKind}</span>;
}

// One stage's detail card: how it settled, how long it took, why it was entered,
// what it produced, and the two things a human reaches for when it went wrong
// (the log and the session that is still alive).
function StageCard({
	runId,
	stage,
	focused,
	cardRef,
}: {
	runId: string;
	stage: PipelineStageView;
	focused: boolean;
	cardRef: (el: HTMLElement | null) => void;
}) {
	const [showLog, setShowLog] = useState(false);
	const outcome = stage.outcome as StageOutcome;
	const settled = Boolean(stage.settledAt);
	const duration = formatStageDuration(stage.startedAt, stage.settledAt);
	// A stage the plan never reached has no log file, so do not offer a button
	// that can only 404.
	const hasLog = Boolean(stage.startedAt);

	return (
		<div
			ref={cardRef}
			data-stage={stage.stageId}
			className={cn(
				"scroll-mt-4 rounded-lg border bg-card px-4 py-3 transition-colors",
				focused ? "border-accent ring-1 ring-accent/40" : "border-border",
			)}
		>
			<div className="flex flex-wrap items-center gap-2">
				<StageStatusIcon outcome={outcome} />
				<span className="font-mono text-control font-medium text-foreground">{stage.stageId}</span>
				<Badge variant="outline" className="gap-1.5">
					<span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", stageOutcomeDotTone(outcome))} />
					{stageOutcomeLabel(outcome)}
				</Badge>
				{stage.attempt > 1 && (
					<>
						<span className="font-mono text-micro text-passive">attempt {stage.attempt}</span>
						<Badge variant="warning" title="The engine nudged this stage once and it ran again (spec 7.1)">
							nudged
						</Badge>
					</>
				)}
				{stage.enteredVia === "failure" && stage.failedStage && (
					<Badge variant="outline">via {stage.failedStage} failing</Badge>
				)}
				<span className="ml-auto flex items-center gap-2 font-mono text-micro text-passive">
					{duration && <span>{settled ? duration : `running for ${duration}`}</span>}
					{hasLog && (
						<button
							type="button"
							onClick={() => setShowLog((v) => !v)}
							aria-expanded={showLog}
							className="rounded px-1 text-passive underline-offset-2 hover:text-foreground hover:underline"
						>
							{showLog ? "Hide log" : "Log"}
						</button>
					)}
				</span>
			</div>

			{stage.reason && <p className="mt-1.5 font-mono text-micro text-error">{stage.reason}</p>}

			{(stage.producedArtifact || stage.sessionId) && (
				<div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-micro text-passive">
					{stage.producedArtifact && (
						<StageArtifact runId={runId} artifact={stage.producedArtifact} outcome={outcome} />
					)}
					{stage.sessionId && <StageSession runId={runId} stageId={stage.stageId} sessionId={stage.sessionId} />}
				</div>
			)}

			{showLog && <StageLog runId={runId} stageId={stage.stageId} live={!settled} />}
		</div>
	);
}

// The declared artifact, verified against the run folder by the API. The three
// states are deliberately distinct: `no_output` is the agent saying done with
// nothing there (spec section 7), a settled stage missing its file means the run
// folder no longer has it, and a stage that has not run yet is simply not due.
function StageArtifact({
	runId,
	artifact,
	outcome,
}: {
	runId: string;
	artifact: components["schemas"]["PipelineProducedArtifact"];
	outcome: StageOutcome;
}) {
	if (artifact.exists) {
		return (
			<a
				href={`${getApiBaseUrl()}/api/v1/pipelines/runs/${encodeURIComponent(runId)}/outputs/${encodeURIComponent(artifact.name)}`}
				target="_blank"
				rel="noopener noreferrer"
				className="rounded text-accent underline-offset-2 hover:underline"
			>
				{artifact.name}
			</a>
		);
	}
	if (outcome === "no_output") {
		return (
			<span className="text-warning">
				{artifact.name} is missing: the agent signalled done and the file was not there.
			</span>
		);
	}
	if (outcome === "pending" || outcome === "running") {
		return <span>produces {artifact.name}</span>;
	}
	return <span className="text-warning">{artifact.name} is not in the run folder.</span>;
}

// A stage's session, plus the affordance for one the engine kept alive:
// `no_output`, `no_signal` and `timed_out` spare the session precisely so a
// human can look at it (spec section 7.2), and the bound on that is a visible
// marker and a kill button, not a silent reaper.
function StageSession({ runId, stageId, sessionId }: { runId: string; stageId: string; sessionId: string }) {
	const session = useSessionFacts(sessionId);
	const [killError, setKillError] = useState<string | null>(null);
	const orphan = session?.pipelineOrphan;
	// `pipelineOrphan` survives on the DTO after the session is killed, so the
	// terminated check is what makes the marker mean "still alive, go look at
	// it" rather than "was spared once". Without it the kill button stays after
	// it has done its job.
	const keptHere = orphan?.runId === runId && orphan?.stage === stageId && session?.status !== "terminated";

	// The shared kill mutation: one endpoint, one set of telemetry events, and a
	// workspace refetch that is also what refreshes the marker on this row.
	const kill = useKillSession(
		{ id: sessionId, workspaceId: session?.workspaceId ?? "" },
		{ onKilled: () => setKillError(null), onError: setKillError },
	);

	return (
		<span className="flex items-center gap-2">
			<span>session</span>
			<SessionLink sessionId={sessionId} />
			{keptHere && orphan && (
				<>
					<Badge
						variant="warning"
						title={`Kept alive after ${stageOutcomeLabel(orphan.outcome as StageOutcome)}, ${formatTimeCompact(orphan.keptAt)}, so you can see what the agent was doing.`}
					>
						kept
					</Badge>
					<Button size="sm" variant="outline" disabled={kill.isPending} onClick={() => kill.mutate()}>
						{kill.isPending ? "Killing…" : "Kill session"}
					</Button>
				</>
			)}
			{killError && <span className="text-error">{killError}</span>}
		</span>
	);
}

// The stage's captured stdout and stderr, fetched only once someone opens it and
// refetched while the stage is still running.
function StageLog({ runId, stageId, live }: { runId: string; stageId: string; live: boolean }) {
	const { data, isLoading, error } = useQuery({
		queryKey: ["pipeline-stage-log", runId, stageId],
		queryFn: async () => {
			const { data: body, error: apiError } = await apiClient.GET(
				"/api/v1/pipelines/runs/{runId}/stages/{stageId}/log",
				{ params: { path: { runId, stageId }, query: { tail: LOG_TAIL_LINES } } },
			);
			// A stage with no log file on disk is the empty case, not an error:
			// showing an error code for "nothing was written" reads as a bug in
			// the viewer rather than as the fact it is.
			if (apiErrorCode(apiError) === LOG_NOT_FOUND_CODE) return { content: "", truncated: false };
			if (apiError) throw new Error(apiErrorMessage(apiError, "Could not read the stage log"));
			return body;
		},
		retry: 1,
		refetchInterval: live ? 5_000 : false,
	});

	if (isLoading) return <p className="mt-1.5 font-mono text-micro text-passive">Loading log…</p>;
	if (error) {
		return (
			<p className="mt-1.5 font-mono text-micro text-error">{apiErrorMessage(error, "Could not read the stage log")}</p>
		);
	}
	if (!data?.content)
		return <p className="mt-1.5 font-mono text-micro text-passive">No log was captured for this stage.</p>;

	return (
		<div className="mt-1.5">
			{data.truncated && <p className="mb-1 font-mono text-micro text-passive">Showing the last 200 lines.</p>}
			<pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-background px-2 py-1.5 font-mono text-micro text-muted-foreground">
				{data.content}
			</pre>
		</div>
	);
}

// SessionLink navigates to a session's page (from the routes shell), reused for
// both the run-level session and any stage that ran an agent (command stages
// leave stage.sessionId empty and stay plain text).
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

// The two things run detail reads off a session: the orphan marker
// (`pipelineOrphan`) and the PR url a PR-subject run needs and does not carry
// itself. Both ride the workspace query the shell has already loaded, so this
// screen adds no request of its own and sees the same session facts as the
// board.
function useSessionFacts(sessionId: string | undefined): WorkspaceSession | undefined {
	const workspaces = useWorkspaceQuery().data;
	if (!sessionId) return undefined;
	for (const workspace of workspaces ?? []) {
		const found = workspace.sessions.find((session) => session.id === sessionId);
		if (found) return found;
	}
	return undefined;
}

function absoluteTime(iso: string): string {
	const ts = new Date(iso);
	return Number.isFinite(ts.getTime()) ? ts.toLocaleString() : iso;
}
