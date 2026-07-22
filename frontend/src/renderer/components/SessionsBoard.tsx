import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle, Plus, RotateCcw, RotateCw } from "lucide-react";
import {
	type WorkspaceSession,
	canonicalTrackerIssueId,
	newestActiveOrchestrator,
	orchestratorHealth,
	workerSessions,
} from "../types/workspace";
import {
	attentionZone,
	boardAttentionZoneOrder,
	getAttentionZoneViewForZone,
	getSessionStatusView,
	isSessionIdle,
	type AttentionZone,
	type AttentionZoneView,
} from "../lib/session-presentation";
import { useSessionScmSummary, type SessionPRSummary } from "../hooks/useSessionScmSummary";
import { useRestoreSession } from "../hooks/useRestoreSession";
import { useWorkspaceQuery, workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { NotificationCenter } from "./NotificationCenter";
import { BoardWelcome, ProjectBoardEmpty } from "./BoardEmptyStates";
import { OrchestratorIcon } from "./icons";
import { TopbarButton, TopbarKillError } from "./TopbarButton";
import { spawnOrchestrator } from "../lib/spawn-orchestrator";
import { restartProjectOrchestrator } from "../lib/restart-orchestrator";
import { prBrowserUrl, sessionPRDisplaySummaries } from "../lib/pr-display";
import { formatTimeCompact } from "../lib/format-time";
import { cn } from "../lib/utils";
import { isLinuxPlatform, usesBoardActionsInFramedTopbar } from "../lib/platform";
import { useUiStore } from "../stores/ui-store";
import { RestoreUnavailableDialog } from "./RestoreUnavailableDialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

const isLinux = isLinuxPlatform();
const boardActionsInFramedTopbar = usesBoardActionsInFramedTopbar();
type SessionsBoardProps = {
	/** When set, the board shows only this project's sessions. */
	projectId?: string;
};

// Live merged sessions remain in-flow. A terminated runtime is archived even
// when its SCM outcome remains `merged`.
type Column = AttentionZoneView;
const COLUMNS: Column[] = boardAttentionZoneOrder.map((zone) => getAttentionZoneViewForZone(zone));

function isArchivedSession(session: WorkspaceSession): boolean {
	return session.isTerminated === true || session.status === "terminated";
}

export function SessionsBoard({ projectId }: SessionsBoardProps) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const restoreSessionById = useRestoreSession();
	const workspaceQuery = useWorkspaceQuery();
	const all = workspaceQuery.data ?? [];
	const workspaces = projectId ? all.filter((w) => w.id === projectId) : all;
	const workspace = projectId ? workspaces[0] : undefined;
	const sessions = workspaces.flatMap((w) => workerSessions(w.sessions));
	const orchestrator = projectId ? newestActiveOrchestrator(workspaces[0]?.sessions ?? []) : undefined;
	const [isSpawning, setIsSpawning] = useState(false);
	const [spawnError, setSpawnError] = useState<string | null>(null);
	const restartingProjectIds = useUiStore((state) => state.restartingProjectIds);
	const orchestratorStartupError = useUiStore((state) =>
		projectId ? (state.orchestratorStartupErrors[projectId] ?? null) : null,
	);
	const setProjectRestarting = useUiStore((state) => state.setProjectRestarting);
	const setOrchestratorReplacementError = useUiStore((state) => state.setOrchestratorReplacementError);
	const setOrchestratorStartupError = useUiStore((state) => state.setOrchestratorStartupError);
	const requestNewTask = useUiStore((state) => state.requestNewTask);
	const isProjectRestarting = projectId ? restartingProjectIds.has(projectId) : false;
	const health = workspace ? orchestratorHealth(workspace, isProjectRestarting) : { state: "ok" as const };
	const visibleSpawnError = spawnError ?? orchestratorStartupError;
	// The board instance survives project-to-project navigation (same route,
	// new param), so a spawn failure must not follow the user to another board.
	useEffect(() => setSpawnError(null), [projectId]);
	const previousProjectIdRef = useRef(projectId);
	useEffect(() => {
		const previousProjectId = previousProjectIdRef.current;
		if (previousProjectId && previousProjectId !== projectId) {
			setOrchestratorStartupError(previousProjectId, null);
		}
		previousProjectIdRef.current = projectId;
	}, [projectId, setOrchestratorStartupError]);
	useEffect(() => {
		if (projectId && orchestrator && orchestratorStartupError) {
			setOrchestratorStartupError(projectId, null);
		}
	}, [orchestrator, orchestratorStartupError, projectId, setOrchestratorStartupError]);

	const archived = sessions
		.filter(isArchivedSession)
		.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
	const byZone = new Map<AttentionZone, WorkspaceSession[]>();
	for (const session of sessions.filter((candidate) => !isArchivedSession(candidate))) {
		const zone = attentionZone(session);
		(byZone.get(zone) ?? byZone.set(zone, []).get(zone)!).push(session);
	}
	// First-run orientation replaces the empty column shells (only once the
	// query has resolved, so the welcome never flashes over real data): the
	// global board teaches the app before any project exists, and a fresh
	// project board invites the first task instead of showing four zeros.
	const isLoaded = workspaceQuery.isSuccess;
	const showWelcome = !projectId && isLoaded && all.length === 0;
	const showProjectEmpty = projectId !== undefined && isLoaded && workspaces.length > 0 && sessions.length === 0;
	// Archived sessions cost one quiet line under the board until expanded.
	const [archiveExpanded, setArchiveExpanded] = useState(false);
	const [restoringSessionId, setRestoringSessionId] = useState<string | undefined>();
	const [restoreErrors, setRestoreErrors] = useState<Record<string, string>>({});
	const [restoreUnavailableSession, setRestoreUnavailableSession] = useState<WorkspaceSession | undefined>();
	const activeProjectIdRef = useRef(projectId);
	activeProjectIdRef.current = projectId;
	useEffect(() => {
		setRestoringSessionId(undefined);
		setRestoreErrors({});
		setRestoreUnavailableSession(undefined);
	}, [projectId]);

	const openSession = (session: WorkspaceSession) =>
		void navigate({
			to: "/projects/$projectId/sessions/$sessionId",
			params: { projectId: session.workspaceId, sessionId: session.id },
		});

	const restoreArchivedSession = async (event: MouseEvent<HTMLButtonElement>, session: WorkspaceSession) => {
		event.stopPropagation();
		if (restoringSessionId) return;
		const restoreProjectId = projectId;
		const isStillActiveProject = () => !restoreProjectId || activeProjectIdRef.current === restoreProjectId;
		setRestoringSessionId(session.id);
		setRestoreErrors((current) => {
			const next = { ...current };
			delete next[session.id];
			return next;
		});
		try {
			const result = await restoreSessionById(session.id);
			if (!isStillActiveProject()) return;
			if (result.status === "success") {
				void navigate({
					to: "/projects/$projectId/sessions/$sessionId",
					params: { projectId: session.workspaceId, sessionId: session.id },
				});
				return;
			}
			if (result.status === "not_resumable") {
				setRestoreUnavailableSession(session);
				return;
			}
			setRestoreErrors((current) => ({ ...current, [session.id]: result.message }));
		} finally {
			if (isStillActiveProject()) {
				setRestoringSessionId(undefined);
			}
		}
	};

	const openOrchestrator = async () => {
		if (!projectId || isProjectRestarting) return;
		if (orchestrator) {
			void navigate({
				to: "/projects/$projectId/sessions/$sessionId",
				params: { projectId, sessionId: orchestrator.id },
			});
			return;
		}
		setSpawnError(null);
		setOrchestratorStartupError(projectId, null);
		setIsSpawning(true);
		try {
			const sessionId = await spawnOrchestrator(projectId, "board");
			await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
			setOrchestratorStartupError(projectId, null);
			void navigate({
				to: "/projects/$projectId/sessions/$sessionId",
				params: { projectId, sessionId },
			});
		} catch (err) {
			// Never fail silently: the daemon's message (e.g. a worktree/branch
			// conflict) is the only actionable signal the user gets.
			console.error("Failed to spawn orchestrator:", err);
			setSpawnError(err instanceof Error ? err.message : "Could not spawn orchestrator");
		} finally {
			setIsSpawning(false);
		}
	};

	const restartOrchestrator = async () => {
		if (!projectId) return;
		await restartProjectOrchestrator({
			projectId,
			queryClient,
			navigate,
			setProjectRestarting,
			setOrchestratorReplacementError,
		});
	};

	const actions = projectId ? (
		<>
			{isLinux ? <NotificationCenter /> : null}
			{visibleSpawnError && !showProjectEmpty && (
				<TopbarKillError className="max-w-content-max truncate" title={visibleSpawnError}>
					{visibleSpawnError}
				</TopbarKillError>
			)}
			<TopbarButton
				aria-label="New task"
				disabled={isProjectRestarting}
				onClick={() => projectId && requestNewTask(projectId)}
				variant="accent"
			>
				<Plus className="size-icon-md" aria-hidden="true" />
				New task
			</TopbarButton>
			<TopbarButton
				aria-label={orchestrator ? "Orchestrator" : "Spawn Orchestrator"}
				disabled={isSpawning || isProjectRestarting}
				onClick={() => void openOrchestrator()}
				variant="primary"
			>
				<OrchestratorIcon className="size-icon-md" aria-hidden="true" />
				{isProjectRestarting
					? "Restarting..."
					: isSpawning
						? "Spawning..."
						: orchestrator
							? "Orchestrator"
							: "Spawn Orchestrator"}
			</TopbarButton>
		</>
	) : isLinux ? (
		<NotificationCenter />
	) : undefined;

	return (
		<div className="flex h-full min-h-0 flex-col bg-background text-foreground">
			{/* The first-launch welcome carries its own orientation; a "Board"
			    header above it would describe a board that isn't rendered
			    (review feedback on #2432). The shell topbar crumb already
			    names the board/project, so only the actions row stays here —
			    and on inset-topbar platforms even that moves into the framed topbar. */}
			{!showWelcome && actions && !boardActionsInFramedTopbar ? (
				<div className="flex items-center justify-end gap-2 px-4.5 pt-4">{actions}</div>
			) : null}

			<div className={cn("min-h-0 flex-1 overflow-hidden", showWelcome ? "p-0" : "p-4.5")}>
				{projectId && health.state !== "ok" ? (
					<div className="mb-3 flex items-center gap-3 rounded-md border border-border bg-surface px-3 py-2 text-xs text-muted-foreground">
						<AlertTriangle className="size-icon-base shrink-0 text-warning" aria-hidden="true" />
						<span className="min-w-0 flex-1">{health.message}</span>
						{health.state === "restart_needed" || health.state === "duplicates" ? (
							<TopbarButton disabled={isProjectRestarting} onClick={() => void restartOrchestrator()} variant="primary">
								<RotateCw className="size-3.5" aria-hidden="true" />
								Restart
							</TopbarButton>
						) : null}
					</div>
				) : null}
				{workspaceQuery.isError ? (
					<p className="py-10 text-center text-xs text-passive">Could not load sessions.</p>
				) : showWelcome ? (
					<BoardWelcome />
				) : showProjectEmpty ? (
					<ProjectBoardEmpty
						hasOrchestrator={orchestrator !== undefined}
						isSpawning={isSpawning}
						isProjectRestarting={isProjectRestarting}
						onNewTask={() => projectId && requestNewTask(projectId)}
						onOpenOrchestrator={() => void openOrchestrator()}
						spawnError={visibleSpawnError}
					/>
				) : (
					<div className="h-full overflow-x-auto overflow-y-hidden">
						<div className="grid h-full min-w-[64rem] grid-cols-4 gap-2 xl:min-w-0">
							{COLUMNS.map((col) => (
								<BoardColumn
									key={`${projectId ?? "all"}:${col.zone}`}
									col={col}
									sessions={byZone.get(col.zone) ?? []}
									onOpen={openSession}
								/>
							))}
						</div>
					</div>
				)}
			</div>

			{archived.length > 0 && (
				<div className="shrink-0 border-t border-border px-4.5">
					{/* agent-orchestrator's archive bar (Dashboard.tsx + globals.css):
					    a full-width chevron + label + count toggle row. The button is
					    37px (not the 35.5px its text-control implies) because the
					    unlayered `button { font: inherit }` in styles.css outranks
					    Tailwind's layered text utilities, leaving it at 14px/21px. */}
					<button
						aria-expanded={archiveExpanded}
						aria-label={`Archive, ${archived.length} ${archived.length === 1 ? "session" : "sessions"}`}
						className="group flex min-h-row-md w-full items-center gap-2 py-2 text-muted-foreground transition-colors hover:text-foreground"
						onClick={() => setArchiveExpanded((v) => !v)}
						type="button"
					>
						<svg
							aria-hidden="true"
							className={cn(
								"size-icon-2xs shrink-0 transition-transform duration-normal",
								archiveExpanded && "rotate-90",
							)}
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							viewBox="0 0 24 24"
						>
							<path d="m9 18 6-6-6-6" />
						</svg>
						<span className="font-mono text-2xs font-medium uppercase tracking-wide-sm">Archive</span>
						<span className="ml-auto shrink-0 font-mono text-micro text-passive">{archived.length}</span>
					</button>
					{archiveExpanded && (
						<div aria-label="Archived sessions" className="max-h-[45vh] overflow-y-auto pb-3" role="list">
							{archived.map((s) => (
								<ArchiveSessionRow
									key={s.id}
									session={s}
									onOpen={() => openSession(s)}
									restoreAction={(event) => void restoreArchivedSession(event, s)}
									restoreError={restoreErrors[s.id]}
									isRestoring={restoringSessionId === s.id}
									isRestoreDisabled={restoringSessionId !== undefined}
								/>
							))}
						</div>
					)}
				</div>
			)}
			{restoreUnavailableSession && (
				<RestoreUnavailableDialog
					open={true}
					session={restoreUnavailableSession}
					onOpenChange={(open) => {
						if (!open) setRestoreUnavailableSession(undefined);
					}}
					onRecreated={async () => {
						await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
					}}
				/>
			)}
		</div>
	);
}

function BoardColumn({
	col,
	sessions,
	onOpen,
}: {
	col: Column;
	sessions: WorkspaceSession[];
	onOpen: (s: WorkspaceSession) => void;
}) {
	if (col.zone === "working") return <WorkLaneColumn sessions={sessions} onOpen={onOpen} />;
	if (col.zone === "merge") return <MergeLaneColumn sessions={sessions} onOpen={onOpen} />;
	return <ZoneColumn col={col} sessions={sessions} onOpen={onOpen} />;
}

function ZoneColumn({
	col,
	sessions,
	onOpen,
}: {
	col: Column;
	sessions: WorkspaceSession[];
	onOpen: (s: WorkspaceSession) => void;
}) {
	return (
		<section
			aria-label={`${col.label} sessions`}
			className="flex min-w-0 flex-col overflow-hidden rounded-panel"
			style={{
				background: `linear-gradient(180deg, ${col.glow}, transparent var(--size-kanban-glow)), var(--color-overlay-subtle)`,
			}}
		>
			<div className="flex shrink-0 items-center gap-2.25 px-3.75 pb-2.75 pt-3.5">
				<span
					className="size-dot-sm rounded-full"
					style={{
						background: col.dot,
						boxShadow: col.dotGlow ? `0 0 7px color-mix(in srgb, ${col.dot} 60%, transparent)` : undefined,
					}}
				/>
				<span className={cn("text-caption font-semibold uppercase tracking-wide-md", col.titleClassName)}>
					{col.label}
				</span>
				<span className="ml-auto font-mono text-caption leading-none text-passive">{sessions.length}</span>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-2.75 pb-3">
				<div className="flex min-h-full flex-col gap-2.5">
					{sessions.map((session) => (
						<SessionCard key={session.id} session={session} onOpen={() => onOpen(session)} />
					))}
				</div>
			</div>
		</section>
	);
}

type SplitLaneTone = {
	label: string;
	countLabel: string;
	regionLabel: string;
	dotClassName: string;
	titleClassName: string;
	color: string;
	dotGlow: boolean;
};

const idleLaneTone: SplitLaneTone = {
	label: "Idle",
	countLabel: "idle",
	regionLabel: "Idle sessions",
	dotClassName: "bg-status-idle",
	titleClassName: "text-status-idle",
	color: "var(--color-status-idle)",
	dotGlow: false,
};

const workingLaneTone: SplitLaneTone = {
	label: "Working",
	countLabel: "working",
	regionLabel: "Working sessions",
	dotClassName: "bg-status-working",
	titleClassName: "text-status-working",
	color: "var(--color-status-working)",
	dotGlow: true,
};

const readyLaneTone: SplitLaneTone = {
	label: "Ready to merge",
	countLabel: "ready to merge",
	regionLabel: "Ready to merge sessions",
	dotClassName: "bg-status-ready",
	titleClassName: "text-status-ready",
	color: "var(--color-status-ready)",
	dotGlow: true,
};

const mergedLaneTone: SplitLaneTone = {
	label: "Merged",
	countLabel: "merged",
	regionLabel: "Merged sessions",
	dotClassName: "bg-status-merged",
	titleClassName: "text-status-merged",
	color: "var(--color-status-merged)",
	dotGlow: false,
};

function WorkLaneColumn({ sessions, onOpen }: { sessions: WorkspaceSession[]; onOpen: (s: WorkspaceSession) => void }) {
	const idleSessions = sessions.filter(isSessionIdle);
	const workingSessions = sessions.filter((session) => !isSessionIdle(session));

	return (
		<SplitLaneColumn
			ariaLabel="Idle / Working sessions"
			primarySessions={idleSessions}
			primaryTone={idleLaneTone}
			secondarySessions={workingSessions}
			secondaryTone={workingLaneTone}
			onOpen={onOpen}
		/>
	);
}

function MergeLaneColumn({
	sessions,
	onOpen,
}: {
	sessions: WorkspaceSession[];
	onOpen: (s: WorkspaceSession) => void;
}) {
	const mergedSessions = sessions.filter((session) => session.status === "merged");
	const readySessions = sessions.filter((session) => session.status !== "merged");

	return (
		<SplitLaneColumn
			ariaLabel="Ready to merge / Merged sessions"
			primarySessions={readySessions}
			primaryTone={readyLaneTone}
			secondarySessions={mergedSessions}
			secondaryTone={mergedLaneTone}
			onOpen={onOpen}
		/>
	);
}

function SplitLaneColumn({
	ariaLabel,
	primarySessions,
	primaryTone,
	secondarySessions,
	secondaryTone,
	onOpen,
}: {
	ariaLabel: string;
	primarySessions: WorkspaceSession[];
	primaryTone: SplitLaneTone;
	secondarySessions: WorkspaceSession[];
	secondaryTone: SplitLaneTone;
	onOpen: (s: WorkspaceSession) => void;
}) {
	const showPrimary = primarySessions.length > 0;
	const showSecondary = secondarySessions.length > 0;

	return (
		<section
			aria-label={ariaLabel}
			className="flex min-w-0 flex-col overflow-hidden rounded-panel"
			style={{
				background: `linear-gradient(180deg, color-mix(in srgb, ${primaryTone.color} 7%, transparent), transparent var(--size-kanban-glow)), var(--color-overlay-subtle)`,
			}}
		>
			<div className="flex shrink-0 items-center gap-2 px-3.75 pb-2.75 pt-3.5">
				<div
					aria-label={`${primaryTone.label} / ${secondaryTone.label} lane summary`}
					className="flex min-w-0 items-center gap-1.5 text-caption font-semibold uppercase tracking-wide-md"
					role="group"
				>
					<LaneStatusLabel tone={primaryTone} />
					<span className="text-passive" aria-hidden="true">
						/
					</span>
					<LaneStatusLabel tone={secondaryTone} />
				</div>
				<div className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-caption leading-none text-passive">
					<SessionCount count={primarySessions.length} label={primaryTone.countLabel} />
					<span aria-hidden="true">/</span>
					<SessionCount count={secondarySessions.length} label={secondaryTone.countLabel} />
				</div>
			</div>
			<div className="flex min-h-0 flex-1 flex-col">
				{showPrimary ? (
					<div
						aria-label={primaryTone.regionLabel}
						className={cn("min-h-0 overflow-y-auto px-2.75", showSecondary ? "flex-[3] pb-3" : "flex-1 pb-3")}
						role="region"
					>
						<div className="flex min-h-full flex-col gap-2.5">
							{primarySessions.map((session) => (
								<SessionCard key={session.id} session={session} onOpen={() => onOpen(session)} />
							))}
						</div>
					</div>
				) : null}
				{showSecondary ? (
					<SecondaryLaneSection
						sessions={secondarySessions}
						standalone={!showPrimary}
						tone={secondaryTone}
						onOpen={onOpen}
					/>
				) : null}
			</div>
		</section>
	);
}

function LaneStatusLabel({ tone }: { tone: SplitLaneTone }) {
	return (
		<span className={cn("inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap", tone.titleClassName)}>
			<span
				className={cn("size-dot-sm rounded-full", tone.dotClassName)}
				style={{ boxShadow: tone.dotGlow ? `0 0 7px color-mix(in srgb, ${tone.color} 60%, transparent)` : undefined }}
				aria-hidden="true"
			/>
			{tone.label}
		</span>
	);
}

function SessionCount({ count, label }: { count: number; label: string }) {
	return <span aria-label={`${count} ${label} ${count === 1 ? "session" : "sessions"}`}>{count}</span>;
}

function SecondaryLaneSection({
	sessions,
	onOpen,
	standalone,
	tone,
}: {
	sessions: WorkspaceSession[];
	onOpen: (s: WorkspaceSession) => void;
	standalone: boolean;
	tone: SplitLaneTone;
}) {
	return (
		<div
			aria-label={tone.regionLabel}
			className={cn(
				"min-h-0 overflow-hidden",
				standalone
					? "flex flex-1 flex-col bg-surface/35"
					: "flex flex-[2] flex-col rounded-t-(--radius-panel) border-t border-border bg-surface/35",
			)}
			role="region"
		>
			<div className="flex shrink-0 items-center gap-2.25 px-3.75 pb-2.5 pt-3">
				<div className="text-caption font-semibold uppercase tracking-wide-md">
					<LaneStatusLabel tone={tone} />
				</div>
				<span className="ml-auto font-mono text-caption leading-none text-passive">{sessions.length}</span>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-2.75 pb-3">
				<div className="flex min-h-full flex-col gap-2.5">
					{sessions.map((session) => (
						<SessionCard key={session.id} session={session} onOpen={() => onOpen(session)} />
					))}
				</div>
			</div>
		</div>
	);
}

function SessionCard({
	session,
	onOpen,
	interactive = true,
}: {
	session: WorkspaceSession;
	onOpen?: () => void;
	interactive?: boolean;
}) {
	const badge = getSessionStatusView(session.status);
	const issueId = canonicalTrackerIssueId(session.issueId);
	const branch = session.branch || "";
	const showBranch = branch !== "" && !sameLabel(branch, session.title) && !sameLabel(branch, session.id);
	const prSummaries = sessionPRDisplaySummaries(session, useSessionScmSummary(session.id).data);
	const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (!interactive || !onOpen) return;
		if (event.currentTarget !== event.target) return;
		if (event.key !== "Enter" && event.key !== " ") return;
		event.preventDefault();
		onOpen();
	};
	const cardBodyProps = interactive
		? {
				onClick: onOpen,
				onKeyDown: handleKeyDown,
				role: "button",
				tabIndex: 0,
			}
		: {};
	return (
		<div
			className={cn(
				"group relative w-full rounded-md border text-left transition-colors",
				badge.cardClassName ?? "border-border bg-surface",
				interactive && "hover:border-border-strong",
			)}
		>
			<div {...cardBodyProps}>
				<div className="flex items-center gap-2 px-3.25 pb-2.25 pt-3">
					<span className={cn("inline-flex items-center gap-1.5 text-caption font-medium", badge.className)}>
						<span className={cn("size-dot-sm rounded-full bg-current")} />
						{badge.label}
					</span>
					{issueId && (
						<span
							className="inline-flex max-w-branch-chip items-center truncate rounded-sm bg-accent/12 px-1.5 py-0.5 font-mono text-micro text-accent"
							title={`Intake issue: ${issueId}`}
						>
							{issueId}
						</span>
					)}
					<span className="ml-auto shrink-0 font-mono text-2xs tracking-wide-xs text-passive">
						{agentLabel(session.provider)}
					</span>
				</div>
				<div
					className={cn(
						"px-3.25 text-control font-medium leading-snug tracking-tight text-foreground",
						showBranch ? "pb-2" : "pb-3",
						"line-clamp-2 overflow-hidden",
					)}
				>
					{session.title}
				</div>
				{showBranch && <div className="px-3.25 pb-2.5 font-mono text-2xs text-passive">{branch}</div>}
			</div>
			<div className="border-t border-border px-3.25 py-2 font-mono text-2xs text-passive">
				{prSummaries.length === 0 ? (
					"no PR yet"
				) : (
					<div className="flex flex-col gap-1">
						{groupPRsByLifecycle(prSummaries).map((group) => (
							<BoardPRGroup group={group} key={group.status.label} linksInteractive={interactive} />
						))}
					</div>
				)}
			</div>
		</div>
	);
}

function ArchiveSessionRow({
	session,
	onOpen,
	restoreAction,
	restoreError,
	isRestoring,
	isRestoreDisabled,
}: {
	session: WorkspaceSession;
	onOpen: () => void;
	restoreAction: (event: MouseEvent<HTMLButtonElement>) => void;
	restoreError?: string;
	isRestoring: boolean;
	isRestoreDisabled: boolean;
}) {
	const badge = getSessionStatusView(session.status);
	const issueId = canonicalTrackerIssueId(session.issueId);
	const prSummaries = sessionPRDisplaySummaries(session, useSessionScmSummary(session.id).data);
	const branch = session.branch || "";

	return (
		<div className="border-t border-border first:border-t-0" role="listitem">
			<div className="flex min-h-row-lg items-center">
				<button
					aria-label={`Open ${session.title}`}
					className="min-w-0 flex-1 px-2 py-2 text-left transition-colors hover:bg-interactive-hover focus-visible:bg-interactive-hover focus-visible:outline-none"
					onClick={onOpen}
					type="button"
				>
					<div className="flex min-w-0 items-center gap-2">
						<span className={cn("inline-flex shrink-0 items-center gap-1.5 text-caption font-medium", badge.className)}>
							<span className="size-dot-sm rounded-full bg-current" aria-hidden="true" />
							{badge.label}
						</span>
						<span className="min-w-0 truncate text-control font-medium text-foreground">{session.title}</span>
						{issueId && (
							<span className="hidden max-w-branch-chip shrink-0 truncate rounded-sm bg-accent/12 px-1.5 py-0.5 font-mono text-micro text-accent sm:inline">
								{issueId}
							</span>
						)}
						<span className="ml-auto hidden shrink-0 font-mono text-2xs text-passive md:inline">
							{agentLabel(session.provider)}
						</span>
						<span className="w-15 shrink-0 text-right font-mono text-2xs text-passive">
							{formatTimeCompact(session.updatedAt)}
						</span>
					</div>
					<div className="mt-1 flex min-w-0 items-center gap-2 overflow-hidden font-mono text-2xs text-passive">
						{branch && <span className="max-w-branch-chip shrink-0 truncate">{branch}</span>}
						{branch && prSummaries.length > 0 && <span aria-hidden="true">·</span>}
						{prSummaries.length > 0 ? (
							<div className="flex min-w-0 items-center gap-2 overflow-hidden">
								{groupPRsByLifecycle(prSummaries).map((group) => (
									<BoardPRGroup group={group} key={group.status.label} linksInteractive={false} />
								))}
							</div>
						) : (
							<span>no PR yet</span>
						)}
					</div>
				</button>
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							aria-label={`Restore ${session.title}`}
							className="mx-1.5 grid size-control-board-sm shrink-0 place-items-center rounded-md text-passive transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent/50 disabled:cursor-not-allowed disabled:opacity-35"
							disabled={isRestoreDisabled}
							onClick={restoreAction}
							type="button"
						>
							<RotateCcw className={cn("size-icon-md", isRestoring && "animate-spin")} aria-hidden="true" />
						</button>
					</TooltipTrigger>
					<TooltipContent side="top">{isRestoring ? "Restoring session" : "Restore session"}</TooltipContent>
				</Tooltip>
			</div>
			{restoreError && (
				<div className="border-t border-border px-2 py-1.5 text-2xs text-destructive" role="alert">
					{restoreError}
				</div>
			)}
		</div>
	);
}

type BoardPRLifecycleStatus = { label: "closed" | "open" | "draft" | "merged"; className: string };
type BoardPRGroup = { status: BoardPRLifecycleStatus; prs: SessionPRSummary[] };

function BoardPRGroup({ group, linksInteractive = true }: { group: BoardPRGroup; linksInteractive?: boolean }) {
	return (
		<span
			aria-label={`${group.prs.map((pr) => `#${pr.number}`).join(", ")} ${group.status.label}`}
			className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1"
		>
			<span>PR</span>
			{group.prs.map((pr, index) => (
				<span key={pr.number}>
					{linksInteractive ? (
						<a
							className="text-passive underline-offset-2 transition-colors hover:text-foreground hover:underline"
							href={prBrowserUrl(pr)}
							rel="noreferrer"
							target="_blank"
						>
							#{pr.number}
						</a>
					) : (
						<span>#{pr.number}</span>
					)}
					{index < group.prs.length - 1 ? "," : null}
				</span>
			))}
			<span className={cn("font-medium", group.status.className)}>{group.status.label}</span>
		</span>
	);
}

function groupPRsByLifecycle(prs: SessionPRSummary[]): BoardPRGroup[] {
	const groups = new Map<BoardPRLifecycleStatus["label"], BoardPRGroup>();
	for (const pr of prs) {
		const status = prLifecycleStatus(pr);
		const group = groups.get(status.label);
		if (group) {
			group.prs.push(pr);
		} else {
			groups.set(status.label, { status, prs: [pr] });
		}
	}
	return Array.from(groups.values());
}

function prLifecycleStatus(pr: SessionPRSummary): BoardPRLifecycleStatus {
	if (pr.state === "draft") return { label: "draft", className: "text-passive" };
	if (pr.state === "merged") return { label: "merged", className: "text-accent" };
	if (pr.state === "closed") return { label: "closed", className: "text-error" };
	return { label: "open", className: "text-success" };
}

function sameLabel(a: string, b: string): boolean {
	const normalize = (value: string) =>
		value
			.toLowerCase()
			.replace(/^(feat|fix|chore|refactor|session)\//, "")
			.replace(/[^a-z0-9]+/g, "");
	return normalize(a) === normalize(b);
}

function agentLabel(provider: WorkspaceSession["provider"]): string {
	switch (provider) {
		case "claude-code":
			return "Claude";
		case "opencode":
			return "OpenCode";
		default:
			return provider;
	}
}
