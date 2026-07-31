import { useEffect, useState } from "react";import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { GitBranch, LayoutDashboard, PanelRightOpen, Plus, Settings2, SquareTerminal, Trash2, X } from "lucide-react";

import { NotificationCenter } from "./NotificationCenter";
import {
	hasConfiguredOrchestratorAgent,
	sessionIsActive,
	type WorkspaceSession,
} from "../types/workspace";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { useReverbTopbarModel, type ReverbTopbarSurfaceOverride } from "../hooks/useReverbTopbarModel";
import {
	clearTerminateSessionState,
	useProjectTerminateSessionStates,
	useTerminateSession,
	useTerminateSessionState,
} from "../hooks/useTerminateSession";
import { spawnOrchestrator } from "../lib/spawn-orchestrator";
import { addRendererExceptionStep, captureRendererEvent, captureRendererException } from "../lib/telemetry";
import { useUiStore } from "../stores/ui-store";
import { OrchestratorIcon } from "./icons";
import { isMacPlatform, usesBoardActionsInPanel } from "../lib/platform";
import { TopbarButton, TopbarKillError } from "./TopbarButton";
import { SessionTerminationPopover } from "./SessionTerminationPopover";
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
			separateUtilities={false}
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

// Confirmation is modal, but teardown progress is not: confirming closes the
// dialog and returns to the project's orchestrator while the daemon finishes.
// Mutation-cache state is filtered by worker ID so rapid route switches never
// carry another worker's Killing/error state into the current topbar.
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
	const queryClient = useQueryClient();
	const kill = useTerminateSession();
	const { error, isPending } = useTerminateSessionState(session.id);

	const confirmKill = () => {
		setConfirmOpen(false);
		kill.mutate(session);
		onKilled(session.workspaceId, orchestratorId);
	};

	return (
		<div className="inline-flex items-center gap-1.5" style={noDragStyle}>
			<SessionTerminationPopover
				onConfirm={confirmKill}
				onOpenChange={setConfirmOpen}
				open={confirmOpen}
				session={session}
				trigger={
					<TopbarButton
						aria-label={isPending ? "Killing..." : "Kill session"}
						disabled={isPending}
						onClick={() => {
							clearTerminateSessionState(queryClient, session.id);
						}}
						title="Kill session"
						variant="kill"
					>
						<Trash2 className="size-icon-lg" aria-hidden="true" />
						{isPending ? "Killing..." : "Kill"}
					</TopbarButton>
				}
			/>
			{error ? <TopbarKillError>{error}</TopbarKillError> : null}
		</div>
	);
}

// exported for access from session route orchestrator header
export function ProjectTerminationFeedback({ projectId }: { projectId: string | undefined }) {
	const states = useProjectTerminateSessionStates(projectId);
	if (states.length === 0) return null;

	return (
		<div aria-label="Session termination status" className="flex max-w-content-max items-center gap-2">
			{states.map((state) =>
				state.error ? (
					<TopbarKillError className="max-w-48 truncate" key={state.session.id} title={state.error}>
						{state.session.title}: {state.error}
					</TopbarKillError>
				) : (
					<span
						className="max-w-40 truncate text-caption text-muted-foreground"
						key={state.session.id}
						role="status"
						title={`Killing ${state.session.title}…`}
					>
						Killing {state.session.title}…
					</span>
				),
			)}
		</div>
	);
}
