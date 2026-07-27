import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { motion } from "motion/react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
	AlertTriangle,
	Check,
	Copy,
	GitBranch,
	LayoutDashboard,
	LoaderCircle,
	Plus,
	RotateCcw,
	RotateCw,
	Trash2,
} from "lucide-react";
import {
	type WorkspaceSession,
	canonicalTrackerIssueId,
	hasConfiguredOrchestratorAgent,
	newestActiveOrchestrator,
	orchestratorHealth,
	workerSessions,
} from "../types/workspace";
import {
	attentionZone,
	boardAttentionZoneOrder,
	getAgentActivityView,
	getAttentionZoneViewForZone,
	getSessionStatusView,
	isSessionIdle,
	type AttentionZone,
	type AttentionZoneView,
	type SessionStatusView,
} from "../lib/session-presentation";
import { useSessionScmSummary, type SessionPRSummary } from "../hooks/useSessionScmSummary";
import { useRestoreSession } from "../hooks/useRestoreSession";
import { useTerminateSession } from "../hooks/useTerminateSession";
import { useWorkspaceQuery, workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { NotificationCenter } from "./NotificationCenter";
import { BoardWelcome, ProjectBoardEmpty } from "./BoardEmptyStates";
import { OrchestratorIcon } from "./icons";
import { AgentAvatar } from "./AgentAvatar";
import { TopbarButton, TopbarKillError } from "./TopbarButton";
import { spawnOrchestrator } from "../lib/spawn-orchestrator";
import { restartProjectOrchestrator } from "../lib/restart-orchestrator";
import { prBrowserUrl, sessionPRDisplaySummaries } from "../lib/pr-display";
import { formatTimeCompact } from "../lib/format-time";
import { aoBridge } from "../lib/bridge";
import { usesPreviewWorkspaceData } from "../lib/preview-mode";
import { cn } from "../lib/utils";
import { isLinuxPlatform, isMacPlatform, usesBoardActionsInPanel } from "../lib/platform";
import { useUiStore } from "../stores/ui-store";
import { RestoreUnavailableDialog } from "./RestoreUnavailableDialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { SessionTerminationDialog } from "./SessionTerminationDialog";
import { DaemonStartupLoader } from "./DaemonStartupLoader";
import { useShellMaybe } from "../lib/shell-context";
import { ReverbTopbar } from "./topbar/ReverbTopbar";
import type { ReverbTopbarModel } from "./topbar/topbar-model";

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

const isMac = isMacPlatform();
const dragStyle = isMac ? ({ WebkitAppRegion: "drag" } as React.CSSProperties) : undefined;

export function SessionsBoard({ projectId }: SessionsBoardProps) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const restoreSessionById = useRestoreSession();
	const workspaceQuery = useWorkspaceQuery();
	const shell = useShellMaybe();
	// Evaluated at render so platform mocks in tests can flip the in-panel chrome.
	const boardActionsInPanel = usesBoardActionsInPanel();
	/** Bell lives in the board action row when the shell topbar does not host it. */
	const boardOwnsNotificationCenter = isLinuxPlatform() || boardActionsInPanel;
	const all = workspaceQuery.data ?? [];
	const workspaces = projectId ? all.filter((w) => w.id === projectId) : all;
	const workspace = projectId ? workspaces[0] : undefined;
	const sessions = workspaces.flatMap((w) => workerSessions(w.sessions));
	const orchestrator = projectId ? newestActiveOrchestrator(workspaces[0]?.sessions ?? []) : undefined;
	const orchestratorActivityLabel = orchestrator ? getAgentActivityView(orchestrator.activity).label : undefined;
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
	const openProjectSettings = useUiStore((state) => state.openProjectSettings);
	const isProjectRestarting = projectId ? restartingProjectIds.has(projectId) : false;
	const health = workspace ? orchestratorHealth(workspace, isProjectRestarting) : { state: "ok" as const };
	const visibleSpawnError = spawnError ?? orchestratorStartupError;
	const orchestratorTooltip = isProjectRestarting
		? "Restarting orchestrator"
		: isSpawning
			? "Spawning orchestrator"
			: orchestrator
				? "Open orchestrator"
				: "Spawn orchestrator";
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
	const isDaemonReady = usesPreviewWorkspaceData || (shell ? shell.daemonStatus.state === "ready" : true);
	const daemonHasFailed = Boolean(shell?.daemonStatus.code);
	const workspaceStartupState = shell?.workspaceStartupState ?? "ready";
	const isLoaded = isDaemonReady && workspaceStartupState === "ready" && workspaceQuery.isSuccess;
	const showStartup =
		shell !== null &&
		!daemonHasFailed &&
		(!isDaemonReady || workspaceStartupState === "loading" || (!workspaceQuery.isSuccess && !workspaceQuery.isError));
	const showWelcome = !projectId && isLoaded && all.length === 0;
	const showProjectEmpty = projectId !== undefined && isLoaded && workspaces.length > 0 && sessions.length === 0;
	// Archived sessions cost one quiet line under the board until expanded.
	const [archiveExpanded, setArchiveExpanded] = useState(false);
	const [restoringSessionId, setRestoringSessionId] = useState<string | undefined>();
	const [restoreErrors, setRestoreErrors] = useState<Record<string, string>>({});
	const [restoreUnavailableSession, setRestoreUnavailableSession] = useState<WorkspaceSession | undefined>();
	const [terminationSession, setTerminationSession] = useState<WorkspaceSession | undefined>();
	const terminateSession = useTerminateSession({ onSuccess: () => setTerminationSession(undefined) });
	const activeProjectIdRef = useRef(projectId);
	activeProjectIdRef.current = projectId;
	useEffect(() => {
		setRestoringSessionId(undefined);
		setRestoreErrors({});
		setRestoreUnavailableSession(undefined);
		setTerminationSession(undefined);
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
		if (!hasConfiguredOrchestratorAgent(workspace)) {
			if (workspace) openProjectSettings(projectId);
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
			<Tooltip>
				<TooltipTrigger asChild>
					<span className="inline-flex">
						<TopbarButton
							aria-label="New task"
							disabled={isProjectRestarting}
							onClick={() => projectId && requestNewTask(projectId)}
							variant="icon"
						>
							<Plus className="size-icon-md" aria-hidden="true" />
						</TopbarButton>
					</span>
				</TooltipTrigger>
				<TooltipContent side="bottom">New task</TooltipContent>
			</Tooltip>
			<Tooltip>
				<TooltipTrigger asChild>
					<span className="inline-flex">
						<TopbarButton
							aria-label={
								orchestratorActivityLabel ? `Orchestrator, ${orchestratorActivityLabel}` : "Spawn Orchestrator"
							}
							disabled={isSpawning || isProjectRestarting}
							onClick={() => void openOrchestrator()}
							variant="icon"
						>
							<OrchestratorIcon className="size-icon-md" aria-hidden="true" />
						</TopbarButton>
					</span>
				</TooltipTrigger>
				<TooltipContent side="bottom">{orchestratorTooltip}</TooltipContent>
			</Tooltip>
		</>
	) : undefined;
	const model: ReverbTopbarModel = projectId
		? {
				surface: "project-board",
				breadcrumbs: [{ id: "board", label: "Board" }],
			}
		: {
				surface: "global-board",
				breadcrumbs: [{ id: "board", label: "Board" }],
			};
	return (
		<div className="flex h-full min-h-0 flex-col bg-background text-foreground" data-testid="board">
			{/* macOS/Linux keep board actions inside the center panel. Welcome
			    and daemon startup intentionally skip the workspace bar. */}
			{!showWelcome && !showStartup && boardActionsInPanel ? (
				<ReverbTopbar
					actions={actions}
					dragStyle={dragStyle}
					error={
						visibleSpawnError && !showProjectEmpty ? (
							<TopbarKillError className="max-w-content-max truncate" title={visibleSpawnError}>
								{visibleSpawnError}
							</TopbarKillError>
						) : null
					}
					leadingIcon={<LayoutDashboard className="size-icon-md" />}
					model={model}
					utilities={boardOwnsNotificationCenter ? <NotificationCenter /> : null}
				/>
			) : null}

			<div className="min-h-0 flex-1 overflow-hidden">
				{projectId && health.state !== "ok" ? (
					// A full-bleed strip, not a card: the column header rule below it runs
					// edge to edge, so an inset rounded box floats against it.
					<div className="flex items-center gap-3 border-b border-border bg-background px-3 py-2 text-xs text-muted-foreground">
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
				{showStartup ? (
					<DaemonStartupLoader />
				) : workspaceStartupState === "error" || workspaceQuery.isError ? (
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
						{/* Hairline column grid: vertical divide-x + one absolute header rule so
						    the horizontal divider stays continuous and level across lanes.
						    Keep `top-9` aligned with each column header's `h-9`. */}
						<div className="relative grid h-full min-w-[64rem] grid-cols-4 divide-x divide-border xl:min-w-0">
							<div
								aria-hidden="true"
								className="pointer-events-none absolute inset-x-0 top-9 z-10 border-t border-border"
							/>
							{COLUMNS.map((col) => (
								<BoardColumn
									key={`${projectId ?? "all"}:${col.zone}`}
									col={col}
									sessions={byZone.get(col.zone) ?? []}
									onOpen={openSession}
									onTerminate={(session) => {
										terminateSession.reset();
										setTerminationSession(session);
									}}
								/>
							))}
						</div>
					</div>
				)}
			</div>

			{archived.length > 0 && (
				<div className="shrink-0 border-t border-border">
						<button
							aria-expanded={archiveExpanded}
							aria-label={`Archive, ${archived.length} ${archived.length === 1 ? "session" : "sessions"}`}
							className="group flex w-full min-w-0 items-center gap-2 px-3 py-2 text-muted-foreground transition-colors hover:text-foreground"
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
							<span className="text-2xs font-medium tracking-wide-sm">Archive</span>
							<span className="ml-1.5 text-micro text-passive">{archived.length}</span>
						</button>
					<motion.div
						initial={false}
						animate={{ height: archiveExpanded ? "auto" : 0 }}
						transition={{ duration: 0.22, ease: [0.25, 0.46, 0.45, 0.94] }}
						style={{ overflow: "hidden" }}
					>
						<div
							aria-label="Archived sessions"
							className="board-scrollbar grid max-h-[45vh] grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] gap-2 overflow-y-auto px-3 pb-3"
							role="list"
						>
							{archived.map((s) => (
								<ArchiveSessionItem
									key={s.id}
									session={s}
									restoreAction={(event) => void restoreArchivedSession(event, s)}
									restoreError={restoreErrors[s.id]}
									isRestoring={restoringSessionId === s.id}
									isRestoreDisabled={restoringSessionId !== undefined}
								/>
							))}
						</div>
					</motion.div>
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
			<SessionTerminationDialog
				busy={terminateSession.isPending}
				error={terminateSession.error instanceof Error ? terminateSession.error.message : null}
				onConfirm={() => terminationSession && terminateSession.mutate(terminationSession)}
				onOpenChange={(open) => {
					if (!open && !terminateSession.isPending) setTerminationSession(undefined);
				}}
				open={terminationSession !== undefined}
				session={terminationSession}
			/>
		</div>
	);
}

function BoardColumn({
	col,
	sessions,
	onOpen,
	onTerminate,
}: {
	col: Column;
	sessions: WorkspaceSession[];
	onOpen: (s: WorkspaceSession) => void;
	onTerminate: (s: WorkspaceSession) => void;
}) {
	if (col.zone === "working")
		return <WorkLaneColumn col={col} sessions={sessions} onOpen={onOpen} onTerminate={onTerminate} />;
	if (col.zone === "merge")
		return <MergeLaneColumn col={col} sessions={sessions} onOpen={onOpen} onTerminate={onTerminate} />;
	return <ZoneColumn col={col} sessions={sessions} onOpen={onOpen} onTerminate={onTerminate} />;
}

/** Board column header: color swatch, name, count — the landing hero's board preview. */
function ColumnHeader({ color, count, label }: { color: string; count: number; label: string }) {
	return (
		<div className="flex h-9 shrink-0 items-center gap-2 px-3">
			<span aria-hidden="true" className="size-2 shrink-0 rounded-swatch" style={{ background: color }} />
			<span className="min-w-0 truncate text-xs font-medium tracking-wide-sm text-muted-foreground">{label}</span>
			<SessionCount count={count} label={label.toLowerCase()} />
		</div>
	);
}

function ZoneColumn({
	col,
	sessions,
	onOpen,
	onTerminate,
}: {
	col: Column;
	sessions: WorkspaceSession[];
	onOpen: (s: WorkspaceSession) => void;
	onTerminate: (s: WorkspaceSession) => void;
}) {
	return (
		<section
			aria-label={`${col.label} sessions`}
			className="flex min-w-0 flex-col overflow-hidden"
			data-testid="board-column"
			data-column={col.zone}
		>
			<ColumnHeader color={col.dot} count={sessions.length} label={col.label} />
			<div className="board-scrollbar board-lane-scroller min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-3">
				<div className="flex min-h-full flex-col gap-2.5">
					{sessions.map((session) => (
						<SessionCard
							key={session.id}
							session={session}
							onOpen={() => onOpen(session)}
							onTerminate={() => onTerminate(session)}
						/>
					))}
				</div>
			</div>
		</section>
	);
}

// Working sessions lead the lane; idle ones settle at the bottom of the same
// list. They are ordered, not sectioned: a sub-header inside a column competes
// with the column header above it.
function WorkLaneColumn({
	col,
	sessions,
	onOpen,
	onTerminate,
}: {
	col: Column;
	sessions: WorkspaceSession[];
	onOpen: (s: WorkspaceSession) => void;
	onTerminate: (s: WorkspaceSession) => void;
}) {
	const ordered = [...sessions.filter((session) => !isSessionIdle(session)), ...sessions.filter(isSessionIdle)];

	return <ZoneColumn col={col} sessions={ordered} onOpen={onOpen} onTerminate={onTerminate} />;
}

// Ready-to-merge leads; already-merged settles underneath, newest first in both.
function MergeLaneColumn({
	col,
	sessions,
	onOpen,
	onTerminate,
}: {
	col: Column;
	sessions: WorkspaceSession[];
	onOpen: (s: WorkspaceSession) => void;
	onTerminate: (s: WorkspaceSession) => void;
}) {
	const newestFirst = (left: WorkspaceSession, right: WorkspaceSession) => right.updatedAt.localeCompare(left.updatedAt);
	const ordered = [
		...sessions.filter((session) => session.status !== "merged").sort(newestFirst),
		...sessions.filter((session) => session.status === "merged").sort(newestFirst),
	];

	return <ZoneColumn col={col} sessions={ordered} onOpen={onOpen} onTerminate={onTerminate} />;
}

function SessionCount({ count, label }: { count: number; label: string }) {
	return (
		<span
			aria-label={`${count} ${label} ${count === 1 ? "session" : "sessions"}`}
			className="ml-2 text-xs tabular-nums leading-none text-passive"
		>
			{count}
		</span>
	);
}

function SessionCard({
	session,
	onOpen,
	onTerminate,
	interactive = true,
}: {
	session: WorkspaceSession;
	onOpen?: () => void;
	onTerminate?: () => void;
	interactive?: boolean;
}) {
	// The column header already names the stage (Working / Needs you / In review /
	// Ready to merge), so the card never repeats a status pill. It carries only its
	// own identity + code state: agent, title, branch, PRs, diff, updated time.
	const badge = getSessionStatusView(session.status);
	const issueId = canonicalTrackerIssueId(session.issueId);
	const branch = session.branch || "";
	const showBranch = branch !== "" && !sameLabel(branch, session.title) && !sameLabel(branch, session.id);
	const prSummaries = sessionPRDisplaySummaries(session, useSessionScmSummary(session.id).data);
	const changed = session.changedFiles ?? [];
	const additions = changed.reduce((total, file) => total + file.additions, 0);
	const deletions = changed.reduce((total, file) => total + file.deletions, 0);
	const showDiff = changed.length > 0 && additions + deletions > 0;
	const showTerminate = interactive && session.isTerminated !== true && onTerminate;
	const keepTerminateVisible = session.status === "merged";
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
			{...cardBodyProps}
			className={cn(
		"group relative w-full rounded-lg border text-left transition-[border-color,box-shadow,background-color,transform] duration-[100ms] ease-out",
		badge.cardClassName ?? "border-border bg-card",
		interactive && "cursor-pointer hover:border-border-strong hover:shadow-sm hover:bg-[color-mix(in_oklch,var(--foreground)_7%,var(--card))] active:scale-[0.98]",
			)}
			data-testid="board-session-card"
			data-session-id={session.id}
		>
			{showTerminate ? (
				<button
					aria-label={`Terminate ${session.title}`}
					className={cn(
						"absolute right-2 top-1.5 z-10 inline-flex size-control-md items-center justify-center rounded-sm text-passive transition-[color,background-color,opacity] hover:bg-error/10 hover:text-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
						keepTerminateVisible
							? "opacity-100"
							: "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100",
					)}
					onClick={(event) => {
						event.stopPropagation();
						onTerminate();
					}}
					title="Terminate session"
					type="button"
				>
					<Trash2 className="size-icon-sm" aria-hidden="true" />
				</button>
			) : null}
			<div className="flex items-start gap-2.5 px-3.5 pb-2.5 pt-3">
				<AgentAvatar className="mt-0.5" provider={session.provider} />
				<div className="min-w-0 flex-1">
					<div
						className={cn(
							"line-clamp-2 overflow-hidden text-sm-md font-semibold leading-tight tracking-tight text-foreground",
							showTerminate && "pr-6",
						)}
						title={session.title}
					>
						{session.title}
					</div>
					{showBranch && (
						<div className="mt-1.5 flex min-w-0 items-center gap-1.5 text-2xs text-passive">
							<GitBranch aria-hidden="true" className="size-icon-2xs shrink-0" />
							<span className="truncate">{branch}</span>
						</div>
					)}
				</div>
			</div>
			<div className="flex items-center gap-2 px-3.5 py-2 font-mono text-2xs text-passive">
				<div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
					{groupPRsByLifecycle(prSummaries).map((group) => (
						<BoardPRGroup group={group} key={group.status.label} linksInteractive={interactive} />
					))}
					{showDiff && (
						<span
							className="inline-flex items-center gap-1 whitespace-nowrap"
							title={`${additions} added, ${deletions} removed`}
						>
							<span className="text-success">+{additions}</span>
							<span className="text-error">−{deletions}</span>
						</span>
					)}
					{issueId && (
						<span
							className="max-w-branch-chip truncate rounded-sm bg-accent/12 px-1.5 py-0.5 text-micro text-accent"
							title={`Intake issue: ${issueId}`}
						>
							{issueId}
						</span>
					)}
				</div>
				<span className="shrink-0 whitespace-nowrap" title={`Updated ${session.updatedAt}`}>
					{formatTimeCompact(session.updatedAt)}
				</
			</div>
		</div>
	);
}

function ArchiveSessionItem({
	session,
	restoreAction,
	restoreError,
	isRestoring,
	isRestoreDisabled,
}: {
	session: WorkspaceSession;
	restoreAction: (event: MouseEvent<HTMLButtonElement>) => void;
	restoreError?: string;
	isRestoring: boolean;
	isRestoreDisabled: boolean;
}) {
	const badge = getSessionStatusView(session.status);
	const issueId = canonicalTrackerIssueId(session.issueId);
	const prSummaries = sessionPRDisplaySummaries(session, useSessionScmSummary(session.id).data);
	const branch = session.branch || "";
	const prMetadata =
		prSummaries.length > 0 ? (
			<div className="flex flex-col gap-1">
				{groupPRsByLifecycle(prSummaries).map((group) => (
					<BoardPRGroup group={group} key={group.status.label} linksInteractive={false} />
				))}
			</div>
		) : (
			<span>no PR yet</span>
		);
	const restoreButton = (
		<ArchiveRestoreButton
			isDisabled={isRestoreDisabled}
			isRestoring={isRestoring}
			label={`Restore ${session.title}`}
			onClick={restoreAction}
		/>
	);

	return (
		<div className="flex min-h-28 flex-col overflow-hidden rounded-md border border-border bg-background" role="listitem">
			<div className="flex min-w-0 items-center gap-2 px-3 pt-2">
				<ArchiveStatus badge={badge} />
				<span className="ml-auto shrink-0 text-2xs text-passive">{formatTimeCompact(session.updatedAt)}</span>
				{restoreButton}
			</div>
			<div className="min-h-0 flex-1 px-3 pb-2 pt-1.5 text-left">
				<div className="line-clamp-2 text-control font-medium leading-snug text-foreground">{session.title}</div>
				<div className="mt-1 flex min-w-0 items-center gap-2">
					<AgentAvatar provider={session.provider} />
					{issueId && (
						<span className="max-w-branch-chip truncate rounded-sm bg-accent/12 px-1.5 py-0.5 text-micro text-accent">
							{issueId}
						</span>
					)}
				</div>
				{branch && (
					<div className="mt-2 flex min-w-0 items-center gap-1 text-2xs text-passive">
						<span className="truncate">{branch}</span>
						<CopyActionButton label={`branch ${branch}`} value={branch} />
					</div>
				)}
			</div>
			<div aria-hidden="true" className="mx-3 my-px h-px bg-border" />
			<div className="px-3 py-1.5 text-2xs text-passive">{prMetadata}</div>
			<ArchiveRestoreError message={restoreError} />
		</div>
	);
}

function ArchiveStatus({ badge }: { badge: SessionStatusView }) {
	return (
		<span className={cn("inline-flex shrink-0 items-center gap-1.5 text-caption font-medium", badge.className)}>
			<span className="size-dot-sm rounded-full bg-current" aria-hidden="true" />
			{badge.label}
		</span>
	);
}

function ArchiveRestoreButton({
	label,
	onClick,
	isRestoring,
	isDisabled,
}: {
	label: string;
	onClick: (event: MouseEvent<HTMLButtonElement>) => void;
	isRestoring: boolean;
	isDisabled: boolean;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					aria-label={label}
					className="grid size-control-board-sm shrink-0 place-items-center rounded-md text-passive transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent/50 disabled:cursor-not-allowed disabled:opacity-35"
					disabled={isDisabled}
					onClick={onClick}
					type="button"
				>
					<RotateCcw className={cn("size-icon-md", isRestoring && "animate-spin")} aria-hidden="true" />
				</button>
			</TooltipTrigger>
			<TooltipContent side="top">{isRestoring ? "Restoring session" : "Restore session"}</TooltipContent>
		</Tooltip>
	);
}

function ArchiveRestoreError({ message }: { message?: string }) {
	return message ? (
		<div className="border-t border-border px-2 py-1.5 text-2xs text-destructive" role="alert">
			{message}
		</div>
	) : null;
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
				<span className="inline-flex items-center" key={pr.number}>
					{linksInteractive ? (
						<a
							className="text-passive underline-offset-2 transition-colors hover:text-foreground hover:underline"
							href={prBrowserUrl(pr)}
							onClick={(event) => event.stopPropagation()}
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

function CopyActionButton({ label, value }: { label: string; value: string }) {
	const [copied, setCopied] = useState(false);
	const copiedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (copiedTimeoutRef.current !== null) clearTimeout(copiedTimeoutRef.current);
		},
		[],
	);
	const buttonLabel = copied ? `Copied ${label}` : `Copy ${label}`;
	const copyValue = async (event: MouseEvent<HTMLButtonElement>) => {
		event.stopPropagation();
		try {
			await aoBridge.clipboard.writeText(value);
		} catch {
			return;
		}
		setCopied(true);
		if (copiedTimeoutRef.current !== null) clearTimeout(copiedTimeoutRef.current);
		copiedTimeoutRef.current = setTimeout(() => {
			setCopied(false);
			copiedTimeoutRef.current = null;
		}, 1_500);
	};
	return (
		<button
			aria-label={buttonLabel}
			className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-passive transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
			onClick={(event) => void copyValue(event)}
			title={buttonLabel}
			type="button"
		>
			{copied ? (
				<Check className="size-icon-2xs text-success" aria-hidden="true" />
			) : (
				<Copy className="size-icon-2xs" aria-hidden="true" />
			)}
		</button>
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
