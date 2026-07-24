import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { GitBranch, LayoutDashboard, PanelRightClose, PanelRightOpen, Plus, Square, Trash2 } from "lucide-react";
import { useState } from "react";
import { NotificationCenter } from "./NotificationCenter";
import {
	findProjectOrchestrator,
	isOrchestratorSession,
	sessionIsActive,
	type WorkspaceSession,
} from "../types/workspace";
import { useWorkspaceQuery, workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { spawnOrchestrator } from "../lib/spawn-orchestrator";
import { addRendererExceptionStep, captureRendererEvent, captureRendererException } from "../lib/telemetry";
import { useUiStore } from "../stores/ui-store";
import { OrchestratorIcon } from "./icons";
import { getAgentActivityView } from "../lib/session-presentation";
import { isLinuxPlatform, isMacPlatform, isWindowsPlatform, usesBoardActionsInPanel } from "../lib/platform";
import { StatusPill } from "./StatusPill";
import { TopbarButton, TopbarKillError, topbarHeaderClass, topbarProjectLabelClass } from "./TopbarButton";

const isMac = isMacPlatform();
const isLinux = isLinuxPlatform();
const isWindows = isWindowsPlatform();
const boardActionsInPanel = usesBoardActionsInPanel();
const dragStyle = isMac ? ({ WebkitAppRegion: "drag" } as React.CSSProperties) : undefined;
const noDragStyle = isMac ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined;

// The one app topbar (.dashboard-app-header). On Win/Linux the shell mounts it
// inside the framed center panel; when the platform hides the shell topbar
// (macOS), SessionView mounts the same component in-panel so Kill / Orchestrator
// / inspector stay available. The variant is derived from the route, not props:
// a sessionId in the URL swaps the lead to the session identity (orchestrator
// crumb + mode badge, or worker branch + status pill) and the actions to
// board/orchestrator + inspector controls (orchestrators open the Kanban board;
// workers open their orchestrator); otherwise it's the dashboard crumb plus the
// Orchestrator launcher when a project is in scope. Merges the old
// DashboardTopbar/Topbar pair — agent-orchestrator keeps those as two components
// aligned only by CSS.
export function ShellTopbar() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const params = useParams({ strict: false }) as { projectId?: string; sessionId?: string };
	const currentSessionId = params.sessionId;
	const isInspectorOpen = useUiStore((state) =>
		currentSessionId ? (state.inspectorSessions[currentSessionId]?.isOpen ?? false) : false,
	);
	const toggleInspector = useUiStore((state) => state.toggleInspector);
	const restartingProjectIds = useUiStore((state) => state.restartingProjectIds);
	const requestNewTask = useUiStore((state) => state.requestNewTask);
	const [isSpawning, setIsSpawning] = useState(false);
	// Board-scope spawn failures surface where the board actions render.
	const [boardSpawnError, setBoardSpawnError] = useState<string | null>(null);
	const all = useWorkspaceQuery().data ?? [];

	const session = params.sessionId
		? all.flatMap((workspace) => workspace.sessions).find((s) => s.id === params.sessionId)
		: undefined;
	const isSessionRoute = Boolean(params.sessionId);
	const isOrchestrator = session ? isOrchestratorSession(session) : false;
	// Project in scope: the session's workspace wins over the route param so the
	// cross-project /sessions/$sessionId route still resolves a crumb. A
	// projectId that no longer resolves (stale route after the project was
	// removed, or data still loading) shows an empty crumb — never the raw
	// route slug. "Board" is the root-board crumb only.
	const projectId = session?.workspaceId ?? params.projectId;
	const isProjectBoardRoute = !isSessionRoute && Boolean(projectId);
	const isRootBoardRoute = !isSessionRoute && !isProjectBoardRoute;
	const project = projectId ? all.find((workspace) => workspace.id === projectId) : undefined;
	const projectLabel = project?.name ?? session?.workspaceName ?? (projectId ? "" : "Board");
	const orchestrator = projectId ? findProjectOrchestrator(all, projectId) : undefined;
	const isProjectRestarting = projectId ? restartingProjectIds.has(projectId) : false;

	const openBoard = () =>
		projectId ? void navigate({ to: "/projects/$projectId", params: { projectId } }) : void navigate({ to: "/" });

	const openNewTask = () => {
		if (!projectId || isProjectRestarting) return;
		requestNewTask(projectId);
	};

	const handleToggleInspector = () => {
		if (!currentSessionId) return;
		toggleInspector(currentSessionId);
	};

	const openOrchestrator = async () => {
		if (!projectId) return;
		setBoardSpawnError(null);
		void addRendererExceptionStep("Orchestrator open requested", {
			source: "orchestrator-open",
			operation: "open_orchestrator",
			surface: isSessionRoute ? "session_detail" : "project_board",
			project_id: projectId,
		});
		void captureRendererEvent("ao.renderer.orchestrator_open_requested", { project_id: projectId });
		if (orchestrator) {
			void navigate({
				to: "/projects/$projectId/sessions/$sessionId",
				params: { projectId, sessionId: orchestrator.id },
			});
			return;
		}
		setIsSpawning(true);
		try {
			const sessionId = await spawnOrchestrator(projectId, "topbar");
			await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
			void navigate({
				to: "/projects/$projectId/sessions/$sessionId",
				params: { projectId, sessionId },
			});
		} catch (error) {
			void captureRendererException(error, {
				source: "orchestrator-open",
				operation: "open_orchestrator",
				surface: isSessionRoute ? "session_detail" : "project_board",
				project_id: projectId,
			});
			console.error("Failed to spawn orchestrator:", error);
			setBoardSpawnError(error instanceof Error ? error.message : "Could not spawn orchestrator");
		} finally {
			setIsSpawning(false);
		}
	};

	return (
		<header className={topbarHeaderClass} style={dragStyle}>
			<div className="flex min-w-0 items-center gap-3">
				{isSessionRoute && isOrchestrator ? (
					<div className="inline-flex min-w-0 items-center gap-2">
						<div className="inline-flex min-w-0 items-center gap-1.5">
							<span className={topbarProjectLabelClass}>{projectLabel}</span>
							<span aria-hidden="true" className="text-xs leading-none text-passive">
								·
							</span>
							<span className="inline-flex h-control-sm items-center gap-1 rounded-md border border-border bg-surface px-2 text-micro font-semibold leading-none tracking-wide-sm text-muted-foreground">
								<OrchestratorIcon className="size-3 shrink-0" aria-hidden="true" />
								Orchestrator
							</span>
						</div>
					</div>
				) : isSessionRoute ? (
					<div className="flex min-w-0 items-center gap-3">
						{session?.branch ? (
							<div className="inline-flex min-w-0 items-center gap-1 font-mono text-2xs leading-none text-passive">
								<GitBranch className="size-icon-2xs shrink-0" aria-hidden="true" />
								<span className="truncate">{session.branch}</span>
							</div>
						) : null}
						{session ? <SessionStatusPill session={session} /> : null}
					</div>
				) : (isProjectBoardRoute && boardActionsInPanel) ||
				  (isMac && isRootBoardRoute && boardActionsInPanel) ? null : (
					<div className="inline-flex min-w-0 items-center gap-1.5">
						<span className={topbarProjectLabelClass}>{projectLabel}</span>
					</div>
				)}
			</div>

			<div className="min-w-0 flex-1" />

			<div className="flex shrink-0 items-center gap-1.5">
				{/* Native-titlebar platforms keep the bell leading the actions row; the custom titlebar pins it to the far edge. */}
				{boardActionsInPanel && !isLinux && !isWindows ? <NotificationCenter style={noDragStyle} /> : null}
				{!boardActionsInPanel && isProjectBoardRoute ? (
					<>
						{boardSpawnError ? (
							<TopbarKillError className="max-w-content-max truncate" title={boardSpawnError}>
								{boardSpawnError}
							</TopbarKillError>
						) : null}
						<TopbarButton
							aria-label="New task"
							disabled={isProjectRestarting}
							onClick={openNewTask}
							style={noDragStyle}
							variant="accent"
						>
							<Plus className="size-icon-md" aria-hidden="true" />
							New task
						</TopbarButton>
						<TopbarButton
							aria-label={orchestrator ? "Orchestrator" : "Spawn Orchestrator"}
							disabled={isSpawning || isProjectRestarting}
							onClick={() => void openOrchestrator()}
							style={noDragStyle}
							variant="primary"
						>
							<OrchestratorIcon className="size-icon-md" aria-hidden="true" />
							{isProjectRestarting
								? "Restarting…"
								: isSpawning
									? "Spawning…"
									: orchestrator
										? "Orchestrator"
										: "Spawn Orchestrator"}
						</TopbarButton>
					</>
				) : null}
				{isSessionRoute ? (
					<>
						{isOrchestrator ? (
							<>
								<TopbarButton
									aria-label="New task"
									disabled={isProjectRestarting}
									onClick={openNewTask}
									style={noDragStyle}
									variant="accent"
								>
									<Plus className="size-icon-md" aria-hidden="true" />
									New task
								</TopbarButton>
								<TopbarButton aria-label="Open Kanban" onClick={openBoard} style={noDragStyle} variant="primary">
									<LayoutDashboard className="size-icon-md" aria-hidden="true" />
									Kanban
								</TopbarButton>
							</>
						) : null}
						{/* Kill control sits beside the orchestrator link for active workers —
						    moved here from the inspector's Summary "Danger zone". */}
						{!isOrchestrator && session && sessionIsActive(session) ? (
							<TopbarKillButton
								session={session}
								orchestratorId={orchestrator?.id}
								onKilled={(workspaceId, orchestratorId) => {
									if (orchestratorId) {
										void navigate({
											to: "/projects/$projectId/sessions/$sessionId",
											params: { projectId: workspaceId, sessionId: orchestratorId },
										});
										return;
									}
									void navigate({ to: "/projects/$projectId", params: { projectId: workspaceId } });
								}}
							/>
						) : null}
						{!isOrchestrator && (
							<TopbarButton
								aria-label="Open orchestrator"
								disabled={isSpawning || isProjectRestarting}
								onClick={() => void openOrchestrator()}
								style={noDragStyle}
								variant="primary"
							>
								<OrchestratorIcon className="size-icon-md" aria-hidden="true" />
								{isProjectRestarting ? "Restarting…" : isSpawning ? "Spawning…" : "Orchestrator"}
							</TopbarButton>
						)}
						{/* Inspector collapse (worker sessions only — orchestrators have no rail). */}
						{!isOrchestrator && (
							<TopbarButton
								aria-label={isInspectorOpen ? "Close inspector panel" : "Open inspector panel"}
								aria-pressed={isInspectorOpen}
								onClick={handleToggleInspector}
								style={noDragStyle}
								title={`${isInspectorOpen ? "Close" : "Open"} inspector · ⌘⇧B`}
								variant="icon"
							>
								{isInspectorOpen ? (
									<PanelRightClose className="size-icon-lg" aria-hidden="true" />
								) : (
									<PanelRightOpen className="size-icon-lg" aria-hidden="true" />
								)}
							</TopbarButton>
						)}
					</>
				) : null}
				{/* Custom-titlebar platforms pin the bell to the far right. */}
				{!boardActionsInPanel ? <NotificationCenter style={noDragStyle} /> : null}
			</div>
		</header>
	);
}

// Compact kill control for the topbar actions row. Stop a running worker and
// tear down its runtime/workspace. Kill is irreversible from the UI, so the
// button arms a one-step confirmation before firing POST /sessions/{id}/kill,
// then invalidates the workspace query so the session drops into the board's
// terminated group.
export function TopbarKillButton({
	session,
	orchestratorId,
	onKilled,
}: {
	session: WorkspaceSession;
	orchestratorId?: string;
	onKilled: (workspaceId: string, orchestratorId?: string) => void;
}) {
	const queryClient = useQueryClient();
	const [confirming, setConfirming] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const kill = useMutation({
		mutationFn: async () => {
			void captureRendererEvent("ao.renderer.session_kill_requested", { project_id: session.workspaceId });
			const { error: apiError } = await apiClient.POST("/api/v1/sessions/{sessionId}/kill", {
				params: { path: { sessionId: session.id } },
			});
			if (apiError) throw new Error(apiErrorMessage(apiError));
		},
		onSuccess: () => {
			void captureRendererEvent("ao.renderer.session_kill_succeeded", { project_id: session.workspaceId });
			setConfirming(false);
			void queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
			onKilled(session.workspaceId, orchestratorId);
		},
		onError: (e) => {
			void captureRendererEvent("ao.renderer.session_kill_failed", { project_id: session.workspaceId });
			setError(e instanceof Error ? e.message : "Kill failed");
		},
	});

	if (confirming) {
		return (
			<div className="inline-flex items-center gap-1.5" style={noDragStyle}>
				<TopbarButton
					aria-label="Confirm kill"
					disabled={kill.isPending}
					onClick={() => kill.mutate()}
					variant="killConfirm"
				>
					<Square className="size-icon-md" aria-hidden="true" />
					{kill.isPending ? "Killing…" : "Confirm kill"}
				</TopbarButton>
				<TopbarButton disabled={kill.isPending} onClick={() => setConfirming(false)} variant="killCancel">
					Cancel
				</TopbarButton>
				{error ? <TopbarKillError>{error}</TopbarKillError> : null}
			</div>
		);
	}

	return (
		<TopbarButton
			aria-label="Kill session"
			onClick={() => {
				setError(null);
				setConfirming(true);
			}}
			style={noDragStyle}
			title="Kill session"
			variant="kill"
		>
			<Trash2 className="size-icon-sm" aria-hidden="true" />
			Kill
		</TopbarButton>
	);
}

function SessionStatusPill({ session }: { session: WorkspaceSession }) {
	const { label, tone, breathe } = getAgentActivityView(session.activity);
	return <StatusPill label={label} tone={tone} breathe={breathe} leading="none" />;
}
