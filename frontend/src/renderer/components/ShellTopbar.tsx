import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
	GitBranch,
	LayoutDashboard,
	PanelRightOpen,
	Plus,
	Settings2,
	SquareTerminal,
	Trash2,
	X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import { NotificationCenter } from "./NotificationCenter";
import { hasConfiguredOrchestratorAgent, sessionIsActive, type WorkspaceSession } from "../types/workspace";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { useReverbTopbarModel, type ReverbTopbarSurfaceOverride } from "../hooks/useReverbTopbarModel";
import { useTerminateSession } from "../hooks/useTerminateSession";
import { spawnOrchestrator } from "../lib/spawn-orchestrator";
import { addRendererExceptionStep, captureRendererEvent, captureRendererException } from "../lib/telemetry";
import { useUiStore } from "../stores/ui-store";
import { OrchestratorIcon } from "./icons";
import { isMacPlatform, usesBoardActionsInPanel } from "../lib/platform";
import { TopbarButton, TopbarKillError } from "./TopbarButton";
import { ReverbTopbar } from "./topbar/ReverbTopbar";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

const isMac = isMacPlatform();
const boardActionsInPanel = usesBoardActionsInPanel();
const dragStyle = isMac ? ({ WebkitAppRegion: "drag" } as React.CSSProperties) : undefined;
const noDragStyle = isMac ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined;

// Behavior-owning adapter for the shared Reverb workspace bar. The shell mounts
// it on Windows; board/session surfaces mount the same presentation in-panel on
// macOS and Linux. Route identity comes from useReverbTopbarModel while actions
// stay wired to the existing navigation, daemon, and ui-store boundaries.
export function ShellTopbar({
	surfaceOverride,
}: {
	surfaceOverride?: ReverbTopbarSurfaceOverride;
} = {}) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const {
		model,
		session,
		project,
		orchestrator,
		sessionId: currentSessionId,
		projectId,
		isSessionRoute,
		isProjectBoardRoute,
		isOrchestrator,
	} = useReverbTopbarModel(surfaceOverride);
	const restartingProjectIds = useUiStore((state) => state.restartingProjectIds);
	const requestNewTask = useUiStore((state) => state.requestNewTask);
	const openProjectSettings = useUiStore((state) => state.openProjectSettings);
	const requestNewShellTerminal = useUiStore((state) => state.requestNewShellTerminal);
	const isInspectorOpen = useUiStore((state) =>
		currentSessionId ? (state.inspectorSessions[currentSessionId]?.isOpen ?? true) : true,
	);
	const toggleInspector = useUiStore((state) => state.toggleInspector);
	const [isSpawning, setIsSpawning] = useState(false);
	// Board-scope spawn failures surface where the board actions render.
	const [boardSpawnError, setBoardSpawnError] = useState<string | null>(null);
	const isProjectRestarting = projectId ? restartingProjectIds.has(projectId) : false;
	const orchestratorTooltip = isProjectRestarting
		? "Restarting orchestrator"
		: isSpawning
			? "Spawning orchestrator"
			: "Open orchestrator";

	useEffect(() => {
		setBoardSpawnError(null);
	}, [currentSessionId, model.surface, projectId]);

	const openBoard = () =>
		projectId ? void navigate({ to: "/projects/$projectId", params: { projectId } }) : void navigate({ to: "/" });
	const openHome = () => void navigate({ to: "/" });

	const openNewTask = () => {
		if (!projectId || isProjectRestarting) return;
		requestNewTask(projectId);
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
		void captureRendererEvent("ao.renderer.orchestrator_open_requested", {
			project_id: projectId,
		});
		if (orchestrator) {
			void navigate({
				to: "/projects/$projectId/sessions/$sessionId",
				params: { projectId, sessionId: orchestrator.id },
			});
			return;
		}
		if (!hasConfiguredOrchestratorAgent(project)) {
			if (project) openProjectSettings(projectId);
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

	const projectActions =
		!boardActionsInPanel && isProjectBoardRoute ? (
			<>
				<Tooltip>
					<TooltipTrigger asChild>
						<span className="inline-flex" style={noDragStyle}>
							<TopbarButton aria-label="New task" disabled={isProjectRestarting} onClick={openNewTask} variant="icon">
								<Plus className="size-icon-md" aria-hidden="true" />
							</TopbarButton>
						</span>
					</TooltipTrigger>
					<TooltipContent side="bottom">New task</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<span className="inline-flex" style={noDragStyle}>
							<TopbarButton
								aria-label={orchestrator ? "Orchestrator" : "Spawn Orchestrator"}
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
		) : null;

	const sessionActions =
		isSessionRoute && session ? (
			<>
				{isOrchestrator ? (
					<>
						<Tooltip>
							<TooltipTrigger asChild>
								<span className="inline-flex" style={noDragStyle}>
									<TopbarButton
										aria-label="New task"
										disabled={isProjectRestarting}
										onClick={openNewTask}
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
								<TopbarButton aria-label="Open Board" onClick={openBoard} style={noDragStyle} variant="icon">
									<LayoutDashboard className="size-icon-md" aria-hidden="true" />
								</TopbarButton>
							</TooltipTrigger>
							<TooltipContent side="bottom">Open board</TooltipContent>
						</Tooltip>
					</>
				) : null}
				{/* Kill remains confirmation-gated and keyed by session so switching
			    workers never transfers an in-flight mutation or dialog. */}
				{!isOrchestrator && session && sessionIsActive(session) ? (
					<TopbarKillButton
						key={session.id}
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
							void navigate({
								to: "/projects/$projectId",
								params: { projectId: workspaceId },
							});
						}}
					/>
				) : null}
				{!isOrchestrator ? (
					<Tooltip>
						<TooltipTrigger asChild>
							<span className="inline-flex" style={noDragStyle}>
								<TopbarButton
									aria-label="Open orchestrator"
									disabled={isSpawning || isProjectRestarting}
									onClick={() => void openOrchestrator()}
									variant="icon"
								>
									<OrchestratorIcon className="size-icon-lg" aria-hidden="true" />
								</TopbarButton>
							</span>
						</TooltipTrigger>
						<TooltipContent side="bottom">{orchestratorTooltip}</TooltipContent>
					</Tooltip>
				) : null}
			</>
		) : null;
	const standaloneActions =
		surfaceOverride === "global-settings" ? (
			<TopbarButton
				aria-label="Close settings"
				onClick={openHome}
				style={noDragStyle}
				title="Close settings"
				variant="icon"
			>
				<X className="size-icon-xl" aria-hidden="true" />
			</TopbarButton>
		) : surfaceOverride === "standalone-terminals" ? (
			<TopbarButton
				aria-label="New terminal"
				data-priority="primary"
				onClick={requestNewShellTerminal}
				style={noDragStyle}
				variant="accent"
			>
				<Plus className="size-icon-lg" aria-hidden="true" />
				<span data-compact-label>New terminal</span>
			</TopbarButton>
		) : null;

	const leadingIcon =
		model.surface === "worker-session" ? (
			<GitBranch className="size-icon-md" />
		) : model.surface === "orchestrator-session" ? (
			<OrchestratorIcon className="size-icon-md" />
		) : model.surface === "global-settings" || model.surface === "project-settings" ? (
			<Settings2 className="size-icon-md" />
		) : model.surface === "standalone-terminals" ? (
			<SquareTerminal className="size-icon-md" />
		) : (
			<LayoutDashboard className="size-icon-md" />
		);
	const showInspectorOpenControl = Boolean(
		isSessionRoute && session && !isOrchestrator && currentSessionId && !isInspectorOpen,
	);

	return (
		<ReverbTopbar
			actions={standaloneActions ?? projectActions ?? sessionActions}
			dragStyle={dragStyle}
			error={
				boardSpawnError && (projectActions || (isSessionRoute && session && !isOrchestrator)) ? (
					<TopbarKillError className="max-w-content-max truncate" title={boardSpawnError}>
						{boardSpawnError}
					</TopbarKillError>
				) : null
			}
			leadingIcon={leadingIcon}
			model={model}
			separateUtilities={isOrchestrator || !isSessionRoute}
			utilities={
				<>
					<NotificationCenter style={noDragStyle} />
					{showInspectorOpenControl ? (
						<>
							<span aria-hidden="true" className="reverb-topbar__zone-divider shrink-0" />
							<TopbarButton
								aria-expanded="false"
								aria-label="Open inspector panel"
								onClick={() => toggleInspector(currentSessionId!)}
								style={noDragStyle}
								title="Open inspector · ⌘⇧B"
								variant="icon"
							>
								<PanelRightOpen className="size-icon-lg" aria-hidden="true" />
							</TopbarButton>
						</>
					) : null}
				</>
			}
		/>
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
	const [confirmOpen, setConfirmOpen] = useState(false);
	const kill = useTerminateSession();
	const error = kill.error instanceof Error ? kill.error.message : null;

	return (
		<>
			<Tooltip>
				<TooltipTrigger asChild>
					<TopbarButton
						aria-label="Kill session"
						onClick={() => {
							kill.reset();
							setConfirmOpen(true);
						}}
						style={noDragStyle}
						variant="killIcon"
					>
						<Trash2 className="size-icon-lg" aria-hidden="true" />
					</TopbarButton>
				</TooltipTrigger>
				<TooltipContent side="bottom">Kill session</TooltipContent>
			</Tooltip>
			<ConfirmDialog
				open={confirmOpen}
				onOpenChange={(open) => {
					if (!kill.isPending) setConfirmOpen(open);
				}}
				title="Kill session?"
				description={`Are you sure you want to kill "${session.title}"? This stops the agent and tears down its workspace. This cannot be undone.`}
				confirmLabel={kill.isPending ? "Killing..." : "Kill session"}
				destructive
				busy={kill.isPending}
				error={error}
				onConfirm={() => {
					kill.reset();
					kill.mutate(session, {
						onSuccess: (_data, terminatedSession) => {
							setConfirmOpen(false);
							onKilled(terminatedSession.workspaceId, orchestratorId);
						},
					});
				}}
			/>
		</>
	);
}
