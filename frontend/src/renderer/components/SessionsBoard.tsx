import {
	useEffect,
	useRef,
	useState,
	type KeyboardEvent,
	type MouseEvent,
	type PointerEvent as ReactPointerEvent,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
	AlertTriangle,
	Check,
	CircleCheck,
	CirclePause,
	Copy,
	GitBranch,
	GitMerge,
	LayoutGrid,
	LoaderCircle,
	Plus,
	RotateCcw,
	RotateCw,
	Rows3,
	Trash2,
	type LucideIcon,
} from "lucide-react";
import {
	type SessionStatus,
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
	getAttentionZoneView,
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
import { TopbarButton, TopbarKillError, topbarProjectLabelClass } from "./TopbarButton";
import { spawnOrchestrator } from "../lib/spawn-orchestrator";
import { restartProjectOrchestrator } from "../lib/restart-orchestrator";
import { prBrowserUrl, sessionPRDisplaySummaries } from "../lib/pr-display";
import { formatTimeCompact } from "../lib/format-time";
import { aoBridge } from "../lib/bridge";
import { cn } from "../lib/utils";
import { isLinuxPlatform, isMacPlatform, usesBoardActionsInPanel } from "../lib/platform";
import { useUiStore } from "../stores/ui-store";
import { RestoreUnavailableDialog } from "./RestoreUnavailableDialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { SessionTerminationDialog } from "./SessionTerminationDialog";

type SessionsBoardProps = {
	/** When set, the board shows only this project's sessions. */
	projectId?: string;
};

// Live merged sessions remain in-flow. A terminated runtime is archived even
// when its SCM outcome remains `merged`.
type Column = AttentionZoneView;
const COLUMNS: Column[] = boardAttentionZoneOrder.map((zone) => getAttentionZoneViewForZone(zone));
type ArchiveLayout = "rows" | "grid";
const archiveLayoutStorageKey = "ao.board.archive.layout";
const archiveHeightStorageKey = "ao.board.archive.height";

// The archive opens showing a couple of cards, not every one it holds — it sits
// under the lanes and used to push them off screen when a project had a long
// history. Past the default it scrolls, and the drag handle overrides both.
const ARCHIVE_DEFAULT_HEIGHT: Record<ArchiveLayout, number> = { rows: 336, grid: 226 };
const ARCHIVE_MIN_HEIGHT = 112;
const archiveMaxHeight = () => (typeof window === "undefined" ? 640 : Math.round(window.innerHeight * 0.7));

function initialArchiveLayout(): ArchiveLayout {
	if (typeof window === "undefined") return "grid";
	return window.localStorage?.getItem(archiveLayoutStorageKey) === "rows" ? "rows" : "grid";
}

function initialArchiveHeight(): number | undefined {
	if (typeof window === "undefined") return undefined;
	const stored = Number(window.localStorage?.getItem(archiveHeightStorageKey));
	return Number.isFinite(stored) && stored >= ARCHIVE_MIN_HEIGHT ? stored : undefined;
}

function isArchivedSession(session: WorkspaceSession): boolean {
	return session.isTerminated === true || session.status === "terminated";
}

const isMac = isMacPlatform();
const dragStyle = isMac ? ({ WebkitAppRegion: "drag" } as React.CSSProperties) : undefined;
const noDragStyle = isMac ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined;

export function SessionsBoard({ projectId }: SessionsBoardProps) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const restoreSessionById = useRestoreSession();
	const workspaceQuery = useWorkspaceQuery();
	// Evaluated at render so platform mocks in tests can flip the in-panel chrome.
	const boardActionsInPanel = usesBoardActionsInPanel();
	/** Bell lives in the board action row when the shell topbar does not host it. */
	const boardOwnsNotificationCenter = isLinuxPlatform() || boardActionsInPanel;
	const all = workspaceQuery.data ?? [];
	const workspaces = projectId ? all.filter((w) => w.id === projectId) : all;
	const workspace = projectId ? workspaces[0] : undefined;
	// Same crumb as ShellTopbar: project name in scope, else root-board "Board".
	const boardLabel = workspace?.name ?? (projectId ? "" : "Board");
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
	const [archiveLayout, setArchiveLayout] = useState<ArchiveLayout>(initialArchiveLayout);
	// undefined = follow the layout's default; a number = the user dragged it.
	const [archiveHeight, setArchiveHeight] = useState<number | undefined>(initialArchiveHeight);
	const archiveResizeRef = useRef<{ startY: number; startHeight: number } | null>(null);
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
	const clampArchiveHeight = (value: number) =>
		Math.min(Math.max(value, ARCHIVE_MIN_HEIGHT), archiveMaxHeight());
	const commitArchiveHeight = (value: number) => {
		const next = clampArchiveHeight(value);
		setArchiveHeight(next);
		window.localStorage?.setItem(archiveHeightStorageKey, String(next));
	};
	const resolvedArchiveHeight = archiveHeight ?? ARCHIVE_DEFAULT_HEIGHT[archiveLayout];
	const startArchiveResize = (event: ReactPointerEvent<HTMLDivElement>) => {
		event.preventDefault();
		archiveResizeRef.current = { startY: event.clientY, startHeight: resolvedArchiveHeight };
		event.currentTarget.setPointerCapture(event.pointerId);
	};
	const moveArchiveResize = (event: ReactPointerEvent<HTMLDivElement>) => {
		const drag = archiveResizeRef.current;
		if (!drag) return;
		// The handle is on the panel's top edge, so dragging up grows the archive.
		commitArchiveHeight(drag.startHeight - (event.clientY - drag.startY));
	};
	const endArchiveResize = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (!archiveResizeRef.current) return;
		archiveResizeRef.current = null;
		event.currentTarget.releasePointerCapture(event.pointerId);
	};
	const nudgeArchiveHeight = (event: KeyboardEvent<HTMLDivElement>) => {
		const step = event.shiftKey ? 64 : 16;
		if (event.key === "ArrowUp") {
			event.preventDefault();
			commitArchiveHeight(resolvedArchiveHeight + step);
		} else if (event.key === "ArrowDown") {
			event.preventDefault();
			commitArchiveHeight(resolvedArchiveHeight - step);
		}
	};

	const chooseArchiveLayout = (layout: ArchiveLayout) => {
		window.localStorage?.setItem(archiveLayoutStorageKey, layout);
		setArchiveLayout(layout);
	};

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
			if (workspace) {
				void navigate({ to: "/projects/$projectId/settings", params: { projectId } });
			}
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
			{boardOwnsNotificationCenter ? <NotificationCenter /> : null}
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
	) : boardOwnsNotificationCenter ? (
		<NotificationCenter />
	) : undefined;

	return (
		<div className="flex h-full min-h-0 flex-col bg-background text-foreground" data-testid="board">
			{/* macOS: shell topbar is hidden on board routes, so the project/"Board"
			    crumb + New task / Orchestrator / bell live in this in-panel row.
			    Win/Linux keep the crumb and actions in the framed ShellTopbar.
			    Welcome skips the row — a dangling "Board" above the import
			    chooser was review feedback on #2432. */}
			{!showWelcome && boardActionsInPanel && (boardLabel || actions) ? (
				<div
					className="center-panel-titlebar flex h-toolbar shrink-0 items-center gap-2 border-b border-border-strong pr-4.5"
					style={dragStyle}
				>
					{boardLabel ? <span className={topbarProjectLabelClass}>{boardLabel}</span> : null}
					<div className="min-w-0 flex-1" />
					{actions ? (
						<div className="flex shrink-0 items-center gap-2" style={noDragStyle}>
							{actions}
						</div>
					) : null}
				</div>
			) : null}

			<div className="min-h-0 flex-1 overflow-hidden">
				{projectId && health.state !== "ok" ? (
					<div className="mx-3 my-3 flex items-center gap-3 rounded-md border border-border bg-surface px-3 py-2 text-xs text-muted-foreground">
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
						{/* Hairline column grid: vertical divide-x + one absolute header rule so
						    the horizontal divider stays continuous and level across lanes.
						    Keep `top-12` aligned with each column header's `h-12`. */}
						<div className="relative grid h-full min-w-[64rem] grid-cols-4 divide-x divide-border-strong xl:min-w-0">
							<div
								aria-hidden="true"
								className="pointer-events-none absolute inset-x-0 top-12 z-10 border-t border-border-strong"
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
				<div className="relative shrink-0 border-t border-border-strong px-3">
					{archiveExpanded && (
						<div
							aria-label="Resize archive"
							aria-orientation="horizontal"
							aria-valuemin={ARCHIVE_MIN_HEIGHT}
							aria-valuenow={Math.round(resolvedArchiveHeight)}
							className="group absolute inset-x-0 -top-1 z-10 flex h-2 cursor-row-resize touch-none items-center justify-center focus-visible:outline-none"
							onKeyDown={nudgeArchiveHeight}
							onPointerDown={startArchiveResize}
							onPointerMove={moveArchiveResize}
							onPointerUp={endArchiveResize}
							onPointerCancel={endArchiveResize}
							role="separator"
							tabIndex={0}
						>
							<span
								aria-hidden="true"
								className="h-0.5 w-10 rounded-full bg-border-strong transition-colors group-hover:bg-accent group-focus-visible:bg-accent"
							/>
						</div>
					)}
					{/* agent-orchestrator's archive bar (Dashboard.tsx + globals.css):
					    a full-width chevron + label + count toggle row. The button is
					    37px (not the 35.5px its text-control implies) because the
					    unlayered `button { font: inherit }` in styles.css outranks
					    Tailwind's layered text utilities, leaving it at 14px/21px. */}
					<div className={cn("flex items-center gap-2", archiveExpanded ? "min-h-11" : "min-h-row-md")}>
						<button
							aria-expanded={archiveExpanded}
							aria-label={`Archive, ${archived.length} ${archived.length === 1 ? "session" : "sessions"}`}
							className="group flex min-w-0 items-center gap-2 py-2 text-muted-foreground transition-colors hover:text-foreground"
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
							<span className="ml-1.5 font-mono text-micro text-passive">{archived.length}</span>
						</button>
						{archiveExpanded && (
							<div
								aria-label="Archive layout"
								className="ml-auto flex shrink-0 items-center rounded-md border border-border bg-surface-faint p-0.5"
								role="group"
							>
								<ArchiveLayoutButton
									active={archiveLayout === "rows"}
									icon={Rows3}
									label="Rows"
									onClick={() => chooseArchiveLayout("rows")}
								/>
								<ArchiveLayoutButton
									active={archiveLayout === "grid"}
									icon={LayoutGrid}
									label="Columns"
									onClick={() => chooseArchiveLayout("grid")}
								/>
							</div>
						)}
					</div>
					{archiveExpanded && (
						<div
							aria-label="Archived sessions"
							style={{ height: resolvedArchiveHeight }}
							className={cn(
								"board-scrollbar gap-2.5 overflow-y-auto pb-3",
								// The card is identical in both modes — the toggle only decides
								// how many sit on a line.
								//
								// content-start + auto-rows-min keep the cards at their own
								// height: a grid defaults to stretching its rows over the
								// container, so dragging the panel taller inflated every card
								// instead of leaving the new room empty. Same reason the flex
								// mode pins shrink-0 on its children.
								archiveLayout === "grid"
									? "grid auto-rows-min grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] content-start"
									: "flex flex-col [&>*]:shrink-0",
							)}
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
	if (col.zone === "working") return <WorkLaneColumn sessions={sessions} onOpen={onOpen} onTerminate={onTerminate} />;
	if (col.zone === "merge") return <MergeLaneColumn sessions={sessions} onOpen={onOpen} onTerminate={onTerminate} />;
	return <ZoneColumn col={col} sessions={sessions} onOpen={onOpen} onTerminate={onTerminate} />;
}

/**
 * Column and lane titles. They sit directly above a stack of cards, so without
 * their own band and weight they read as another card footer rather than as the
 * heading for everything under them.
 */
function LaneHeadingBar({ color }: { color: string }) {
	return <span aria-hidden="true" className="h-3.5 w-0.5 shrink-0 rounded-full" style={{ background: color }} />;
}

function LaneHeadingText({ className, children }: { className?: string; children: string }) {
	return (
		<span className={cn("truncate font-mono text-xs font-semibold uppercase tracking-wide-md", className)}>
			{children}
		</span>
	);
}

function LaneHeadingCount({ count, label }: { count: number; label: string }) {
	return (
		<span
			aria-label={`${count} ${label} ${count === 1 ? "session" : "sessions"}`}
			className="ml-auto shrink-0 rounded-full bg-muted px-2 py-0.5 font-mono text-2xs leading-none tabular-nums text-muted-foreground"
		>
			{count}
		</span>
	);
}

const laneHeadingBandClass = "flex h-12 shrink-0 items-center gap-2.5 border-b border-border bg-surface-faint px-4";

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
			<div className={laneHeadingBandClass}>
				<LaneHeadingBar color={col.dot} />
				<LaneHeadingText className={col.titleClassName}>{col.label}</LaneHeadingText>
				<LaneHeadingCount count={sessions.length} label={col.label.toLowerCase()} />
			</div>
			<div className="board-scrollbar min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-3">
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

type SplitLaneTone = {
	label: string;
	countLabel: string;
	regionLabel: string;
	dotClassName: string;
	titleClassName: string;
	color: string;
	dotGlow: boolean;
	icon: LucideIcon;
};

const idleLaneTone: SplitLaneTone = {
	label: "Idle",
	countLabel: "idle",
	regionLabel: "Idle sessions",
	dotClassName: "bg-status-idle",
	titleClassName: "text-status-idle",
	color: "var(--color-status-idle)",
	dotGlow: false,
	icon: CirclePause,
};

const workingLaneTone: SplitLaneTone = {
	label: "Working",
	countLabel: "working",
	regionLabel: "Working sessions",
	dotClassName: "bg-status-working",
	titleClassName: "text-status-working",
	color: "var(--color-status-working)",
	dotGlow: true,
	icon: LoaderCircle,
};

const readyLaneTone: SplitLaneTone = {
	label: "Ready to merge",
	countLabel: "ready to merge",
	regionLabel: "Ready to merge sessions",
	dotClassName: "bg-status-ready",
	titleClassName: "text-status-ready",
	color: "var(--color-status-ready)",
	dotGlow: true,
	icon: GitMerge,
};

const mergedLaneTone: SplitLaneTone = {
	label: "Merged",
	countLabel: "merged",
	regionLabel: "Merged sessions",
	dotClassName: "bg-status-merged",
	titleClassName: "text-status-merged",
	color: "var(--color-status-merged)",
	dotGlow: false,
	icon: CircleCheck,
};

function WorkLaneColumn({
	sessions,
	onOpen,
	onTerminate,
}: {
	sessions: WorkspaceSession[];
	onOpen: (s: WorkspaceSession) => void;
	onTerminate: (s: WorkspaceSession) => void;
}) {
	const idleSessions = sessions.filter(isSessionIdle);
	const workingSessions = sessions.filter((session) => !isSessionIdle(session));

	return (
		<SplitLaneColumn
			ariaLabel="Idle / Working sessions"
			zone="working"
			primarySessions={idleSessions}
			primaryTone={idleLaneTone}
			secondarySessions={workingSessions}
			secondaryTone={workingLaneTone}
			onOpen={onOpen}
			onTerminate={onTerminate}
		/>
	);
}

function MergeLaneColumn({
	sessions,
	onOpen,
	onTerminate,
}: {
	sessions: WorkspaceSession[];
	onOpen: (s: WorkspaceSession) => void;
	onTerminate: (s: WorkspaceSession) => void;
}) {
	const mergedSessions = sessions.filter((session) => session.status === "merged");
	const readySessions = sessions.filter((session) => session.status !== "merged");

	return (
		<SplitLaneColumn
			ariaLabel="Ready to merge / Merged sessions"
			zone="merge"
			primarySessions={readySessions}
			primaryTone={readyLaneTone}
			secondarySessions={mergedSessions}
			secondaryTone={mergedLaneTone}
			onOpen={onOpen}
			onTerminate={onTerminate}
		/>
	);
}

function SplitLaneColumn({
	ariaLabel,
	zone,
	primarySessions,
	primaryTone,
	secondarySessions,
	secondaryTone,
	onOpen,
	onTerminate,
}: {
	ariaLabel: string;
	zone: Extract<AttentionZone, "working" | "merge">;
	primarySessions: WorkspaceSession[];
	primaryTone: SplitLaneTone;
	secondarySessions: WorkspaceSession[];
	secondaryTone: SplitLaneTone;
	onOpen: (s: WorkspaceSession) => void;
	onTerminate: (s: WorkspaceSession) => void;
}) {
	const showPrimary = primarySessions.length > 0;
	const showSecondary = secondarySessions.length > 0;
	// The header names the lane the column starts with, and nothing else. Naming
	// both meant "Working" appeared twice whenever both lanes had work — once up
	// here and again on the section that actually holds the working cards — and
	// it named an Idle lane that wasn't on screen when every session was active.
	const headerTone = showPrimary ? primaryTone : secondaryTone;
	const headerCount = showPrimary ? primarySessions.length : secondarySessions.length;

	return (
		<section
			aria-label={ariaLabel}
			className="flex min-w-0 flex-col overflow-hidden"
			data-column={zone}
			data-testid="board-column"
		>
			<div className={laneHeadingBandClass}>
				<div
					aria-label={`${primaryTone.label} / ${secondaryTone.label} lane summary`}
					className="flex min-w-0 items-center gap-2.5"
					role="group"
				>
					<LaneStatusLabel tone={headerTone} />
				</div>
				<LaneHeadingCount count={headerCount} label={headerTone.countLabel} />
			</div>
			{/* One scroller for the whole column: the lanes are sized by their content
			    so a short primary lane doesn't reserve height the secondary header
			    then has to sit below. */}
			<div className="board-scrollbar min-h-0 flex-1 overflow-y-auto pb-3">
				{showPrimary ? (
					<div aria-label={primaryTone.regionLabel} className="px-3 pt-3" role="region">
						<div className="flex flex-col gap-2.5">
							{primarySessions.map((session) => (
								<SessionCard
									key={session.id}
									session={session}
									onOpen={() => onOpen(session)}
									onTerminate={() => onTerminate(session)}
								/>
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
						onTerminate={onTerminate}
					/>
				) : null}
			</div>
		</section>
	);
}

function LaneStatusLabel({ tone }: { tone: SplitLaneTone }) {
	return (
		<span className="inline-flex min-w-0 items-center gap-2.5">
			<LaneHeadingBar color={tone.color} />
			<LaneHeadingText className={tone.titleClassName}>{tone.label}</LaneHeadingText>
		</span>
	);
}

function SecondaryLaneSection({
	sessions,
	onOpen,
	onTerminate,
	standalone,
	tone,
}: {
	sessions: WorkspaceSession[];
	onOpen: (s: WorkspaceSession) => void;
	onTerminate?: (s: WorkspaceSession) => void;
	standalone: boolean;
	tone: SplitLaneTone;
}) {
	return (
		<div aria-label={tone.regionLabel} className="flex flex-col" role="region">
			{/* When this lane is the only one with work, the column header already
			    names it — a second identical header would just repeat itself. */}
			{!standalone && (
				<div className="mt-3 flex shrink-0 items-center gap-2.5 border-y border-border bg-surface-faint px-4 py-2.5">
					<LaneStatusLabel tone={tone} />
					<LaneHeadingCount count={sessions.length} label={tone.countLabel} />
				</div>
			)}
			<div className={cn("flex flex-col gap-2.5 px-3", standalone && "pt-3")}>
				{sessions.map((session) => (
					<SessionCard
						key={session.id}
						session={session}
						onOpen={() => onOpen(session)}
						onTerminate={onTerminate ? () => onTerminate(session) : undefined}
					/>
				))}
			</div>
		</div>
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
	// Ready to merge), so the card carries no status pill — only its own identity +
	// code state: agent, title, branch, PRs, diff, updated time.
	const badge = getSessionStatusView(session.status);
	const issueId = canonicalTrackerIssueId(session.issueId);
	const branch = session.branch || "";
	const showBranch = branch !== "" && !sameLabel(branch, session.title) && !sameLabel(branch, session.id);
	const prSummaries = sessionPRDisplaySummaries(session, useSessionScmSummary(session.id).data);
	// Diff totals come from the PR summaries (populated by the SCM API in the real
	// app). session.changedFiles only exists in mock data, so using it would show
	// nothing in the packaged app.
	const additions = prSummaries.reduce((total, pr) => total + pr.additions, 0);
	const deletions = prSummaries.reduce((total, pr) => total + pr.deletions, 0);
	const showDiff = additions + deletions > 0;
	// A session with no PR yet (the whole Working lane) would otherwise leave the
	// meta row empty apart from the timestamp. Name the agent there: at 16px the
	// brand mark is the one fact on the card that isn't legible at a glance.
	const showAgentName = prSummaries.length === 0 && !showDiff && !issueId;
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
				"group relative w-full rounded-lg border text-left transition-[border-color,box-shadow]",
				badge.cardClassName ?? "border-border bg-surface",
				interactive && "cursor-pointer hover:border-border-strong hover:shadow-sm",
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
					{/* Status is not shown visually (the column names the stage), but the
					    "Needs you" lane mixes several reasons the PR line can't convey, so
					    keep the specific status in the accessible name for screen readers. */}
					<span className="sr-only">Status: {badge.label}</span>
					{showBranch && (
						<div className="mt-1.5 flex min-w-0 items-center gap-1.5 font-mono text-2xs text-passive">
							<GitBranch aria-hidden="true" className="size-icon-2xs shrink-0" />
							<span className="truncate">{branch}</span>
							<CopyActionButton label={`branch ${branch}`} value={branch} />
						</div>
					)}
				</div>
			</div>
			<div aria-hidden="true" className="mx-3.5 my-px h-px bg-border" />
			<div className="flex items-center gap-2 px-3.5 py-2 font-mono text-2xs text-passive">
				<div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
					{showAgentName && (
						<span className="truncate" title={`Agent: ${session.provider}`}>
							{session.provider}
						</span>
					)}
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
				<span
					className="shrink-0 whitespace-nowrap tabular-nums"
					title={`Updated ${session.updatedAt}`}
				>
					{formatTimeCompact(session.updatedAt)}
				</span>
			</div>
		</div>
	);
}

/**
 * An archived session, drawn as the same card as the live board (see
 * {@link SessionCard}) so the archive reads as one system with the lanes above
 * it. Two things the board card doesn't need are kept: the status, because no
 * column header names the stage down here, and the restore control.
 *
 * The rows/grid toggle only changes how many cards sit per line — the card
 * itself is identical either way.
 */
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
	const showBranch = branch !== "" && !sameLabel(branch, session.title) && !sameLabel(branch, session.id);

	return (
		<div
			className="group relative w-full rounded-lg border border-border bg-surface text-left"
			data-testid="archive-session-card"
			role="listitem"
		>
			<ArchiveRestoreButton
				isDisabled={isRestoreDisabled}
				isRestoring={isRestoring}
				label={`Restore ${session.title}`}
				onClick={restoreAction}
			/>
			<div className="flex items-start gap-2.5 px-3.5 pb-2.5 pt-3">
				<AgentAvatar className="mt-0.5" provider={session.provider} />
				<div className="min-w-0 flex-1">
					<div
						className="line-clamp-2 overflow-hidden pr-6 text-sm-md font-semibold leading-tight tracking-tight text-foreground"
						title={session.title}
					>
						{session.title}
					</div>
					{showBranch && (
						<div className="mt-1.5 flex min-w-0 items-center gap-1.5 font-mono text-2xs text-passive">
							<GitBranch aria-hidden="true" className="size-icon-2xs shrink-0" />
							<span className="truncate">{branch}</span>
							<CopyActionButton label={`branch ${branch}`} value={branch} />
						</div>
					)}
				</div>
			</div>
			<div aria-hidden="true" className="mx-3.5 my-px h-px bg-border" />
			<div className="flex items-center gap-2 px-3.5 py-2 font-mono text-2xs text-passive">
				<div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
					<ArchiveStatus badge={badge} status={session.status} />
					{prSummaries.length > 0 ? (
						groupPRsByLifecycle(prSummaries).map((group) => (
							<BoardPRGroup group={group} key={group.status.label} linksInteractive={false} />
						))
					) : (
						<span>no PR yet</span>
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
				<span
					className="shrink-0 whitespace-nowrap tabular-nums"
					title={`Updated ${session.updatedAt}`}
				>
					{formatTimeCompact(session.updatedAt)}
				</span>
			</div>
			<ArchiveRestoreError message={restoreError} />
		</div>
	);
}

function ArchiveStatus({ badge, status }: { badge: SessionStatusView; status: SessionStatus }) {
	const Icon = getAttentionZoneView(status).icon;
	return (
		<span className={cn("inline-flex shrink-0 items-center gap-1.5 font-medium", badge.className)}>
			<Icon className="size-icon-xs shrink-0" aria-hidden="true" />
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
					// Sits where the live card puts Terminate, so the primary per-card
					// action is in the same place whether a session is running or archived.
					className="absolute right-2 top-1.5 z-10 grid size-control-board-sm shrink-0 place-items-center rounded-md text-passive transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent/50 disabled:cursor-not-allowed disabled:opacity-35"
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

function ArchiveLayoutButton({
	active,
	icon: Icon,
	label,
	onClick,
}: {
	active: boolean;
	icon: typeof Rows3;
	label: string;
	onClick: () => void;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					aria-label={label}
					aria-pressed={active}
					className={cn(
						"grid size-control-sm place-items-center rounded-sm text-passive transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent/50",
						active && "bg-interactive-active text-foreground",
					)}
					onClick={onClick}
					type="button"
				>
					<Icon className="size-icon-sm" aria-hidden="true" />
				</button>
			</TooltipTrigger>
			<TooltipContent side="top">{label}</TooltipContent>
		</Tooltip>
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
