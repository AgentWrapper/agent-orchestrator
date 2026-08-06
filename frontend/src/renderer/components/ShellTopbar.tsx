import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
	FolderGit2,
	LayoutDashboard,
	PanelRightOpen,
	Plus,
	Settings2,
	SquareTerminal,
	Trash2,
	X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { animate, useMotionValue, useReducedMotion } from "motion/react";
import { NotificationCenter } from "./NotificationCenter";
import { AgentAvatar } from "./AgentAvatar";
import { hasConfiguredOrchestratorAgent, sessionIsActive, type WorkspaceSession } from "../types/workspace";
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
import { useWindowFullScreen } from "../hooks/useWindowFullScreen";
import { TopbarButton, TopbarKillError } from "./TopbarButton";
import { ReverbTopbar } from "./topbar/ReverbTopbar";
import { TopbarActivityStatus } from "./topbar/TopbarActivityStatus";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { SessionTerminationPopover } from "./SessionTerminationPopover";

const isMac = isMacPlatform();
const boardActionsInPanel = usesBoardActionsInPanel();
const dragStyle = isMac ? ({ WebkitAppRegion: "drag" } as React.CSSProperties) : undefined;
const noDragStyle = isMac ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined;
// Match the titlebar cluster geometry while retaining the Reverb bar's compact
// 10px inset when no clearance is needed. These are the same fixed macOS
// measurements used by main's spring before the presentation was split out.
const PADDING_DEFAULT = 10;
const PADDING_CLEARANCE = 170;
const PADDING_CLEARANCE_FULLSCREEN = 112;

// Behavior-owning adapter for the shared Reverb workspace bar. The shell mounts
// it on Windows; board/session surfaces mount the same presentation in-panel on
// macOS and Linux. Route identity comes from useReverbTopbarModel while actions
// stay wired to the existing navigation, daemon, and ui-store boundaries.
export function ShellTopbar({
	surfaceOverride,
}: {
	surfaceOverride?: ReverbTopbarSurfaceOverride;
} = {}) {
	const { t } = useTranslation();
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
	const requestNewShellTerminal = useUiStore((state) => state.requestNewShellTerminal);
	const isSidebarOpen = useUiStore((state) => state.isSidebarOpen);
	const isFullScreen = useWindowFullScreen();
	const prefersReducedMotion = useReducedMotion();
	const targetPaddingLeft =
		isMac && !isSidebarOpen
			? isFullScreen
				? PADDING_CLEARANCE_FULLSCREEN
				: PADDING_CLEARANCE
			: PADDING_DEFAULT;
	const paddingLeft = useMotionValue(targetPaddingLeft);
	useEffect(() => {
		const controls = animate(
			paddingLeft,
			targetPaddingLeft,
			prefersReducedMotion
				? { duration: 0 }
				: { type: "spring", stiffness: 420, damping: 40, mass: 0.6 },
		);
		return controls.stop;
	}, [paddingLeft, prefersReducedMotion, targetPaddingLeft]);
	const isInspectorOpen = useUiStore((state) =>
		currentSessionId ? (state.inspectorSessions[currentSessionId]?.isOpen ?? true) : true,
	);
	const toggleInspector = useUiStore((state) => state.toggleInspector);
	const [isSpawning, setIsSpawning] = useState(false);
	// Board-scope spawn failures surface where the board actions render.
	const [boardSpawnError, setBoardSpawnError] = useState<string | null>(null);
	const isProjectRestarting = projectId ? restartingProjectIds.has(projectId) : false;
	const orchestratorTooltip = isProjectRestarting
		? t("shell.restarting")
		: isSpawning
			? t("shell.spawning")
			: orchestrator
				? t("shell.openOrchestrator")
				: t("shell.spawnOrchestratorLower");
	const orchestratorActionLabel = orchestrator ? t("shell.openOrchestrator") : t("shell.spawnOrchestrator");

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
			if (project) {
				void navigate({
					to: "/projects/$projectId/settings",
					params: { projectId },
				});
			}
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
			setBoardSpawnError(error instanceof Error ? error.message : t("shell.couldNotSpawn"));
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
							<TopbarButton
								aria-label={t("shell.newTask")}
								className="reverb-topbar__control--labeled"
								data-priority="primary"
								disabled={isProjectRestarting}
								onClick={openNewTask}
								variant="accent"
							>
								<Plus className="size-icon-md" aria-hidden="true" />
								<span data-compact-label>{t("shell.newTask")}</span>
							</TopbarButton>
						</span>
					</TooltipTrigger>
					<TooltipContent side="bottom">{t("shell.newTask")}</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<span className="inline-flex" style={noDragStyle}>
							<TopbarButton
								aria-label={orchestrator ? t("shell.orchestrator") : orchestratorActionLabel}
								data-priority="secondary"
								disabled={isSpawning || isProjectRestarting}
								onClick={() => void openOrchestrator()}
								variant="feature"
							>
								<OrchestratorIcon className="size-icon-md" aria-hidden="true" />
								<span data-compact-label>{t("shell.orchestrator")}</span>
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
						<ProjectTerminationFeedback projectId={projectId} />
						<Tooltip>
							<TooltipTrigger asChild>
								<span className="inline-flex" style={noDragStyle}>
									<TopbarButton
										aria-label={t("shell.newTask")}
										className="reverb-topbar__control--labeled"
										data-priority="primary"
										disabled={isProjectRestarting}
										onClick={openNewTask}
										variant="accent"
									>
										<Plus className="size-icon-md" aria-hidden="true" />
										<span data-compact-label>{t("shell.newTask")}</span>
									</TopbarButton>
								</span>
							</TooltipTrigger>
							<TooltipContent side="bottom">{t("shell.newTask")}</TooltipContent>
						</Tooltip>
						<Tooltip>
							<TooltipTrigger asChild>
								<TopbarButton
									aria-label={t("shell.openKanban")}
									data-priority="secondary"
									onClick={openBoard}
									style={noDragStyle}
									variant="feature"
								>
									<LayoutDashboard className="size-icon-md" aria-hidden="true" />
									<span data-compact-label>{t("shell.openKanban")}</span>
								</TopbarButton>
							</TooltipTrigger>
							<TooltipContent side="bottom">{t("shell.openKanban")}</TooltipContent>
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
									aria-label={orchestratorActionLabel}
									data-priority="secondary"
									disabled={isSpawning || isProjectRestarting}
									onClick={() => void openOrchestrator()}
									variant="feature"
								>
									<OrchestratorIcon className="size-icon-md" aria-hidden="true" />
									<span data-compact-label>{t("shell.orchestrator")}</span>
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
			aria-label={t("common.close")}
				onClick={openHome}
				style={noDragStyle}
			title={t("common.close")}
				variant="icon"
			>
				<X className="size-icon-xl" aria-hidden="true" />
			</TopbarButton>
		) : surfaceOverride === "standalone-terminals" ? (
			<TopbarButton
			aria-label={t("shortcut.new-shell-terminal")}
				data-priority="primary"
				onClick={requestNewShellTerminal}
				style={noDragStyle}
				variant="accent"
			>
				<Plus className="size-icon-lg" aria-hidden="true" />
				<span data-compact-label>{t("shortcut.new-shell-terminal")}</span>
			</TopbarButton>
		) : null;

	const context =
		isSessionRoute && session && isOrchestrator ? (
			<div className="reverb-topbar__state-content">
				<AgentAvatar className="size-icon-xs" decorative provider={session.provider} />
				<span className="reverb-topbar__state-label truncate font-mono">
					{session.provider}
				</span>
				<TopbarActivityStatus activity={session.activity} />
			</div>
		) : isProjectBoardRoute && orchestrator ? (
			<div className="reverb-topbar__state-content">
				<OrchestratorIcon className="size-icon-md shrink-0" aria-hidden="true" />
				<span className="reverb-topbar__state-label">{t("shell.orchestrator")}</span>
				<TopbarActivityStatus activity={orchestrator.activity} />
			</div>
		) : surfaceOverride === "project-settings" && project?.path ? (
			<div className="reverb-topbar__state-content">
				<FolderGit2 className="size-icon-md shrink-0" aria-hidden="true" />
				<span className="reverb-topbar__state-label truncate font-mono" title={project.path}>
					{project.path}
				</span>
			</div>
		) : null;

	const leadingIcon =
		model.surface === "worker-session" || model.surface === "orchestrator-session" ? (
			<FolderGit2 className="size-icon-md" />
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
			context={context}
			dragStyle={dragStyle}
			error={
				boardSpawnError && (projectActions || (isSessionRoute && session && !isOrchestrator)) ? (
					<TopbarKillError className="max-w-content-max truncate" title={boardSpawnError}>
						{boardSpawnError}
					</TopbarKillError>
				) : null
			}
			leadingIcon={leadingIcon}
			identityMeta={
				isSessionRoute && session && !isOrchestrator ? <TopbarActivityStatus activity={session.activity} /> : undefined
			}
			model={model}
			paddingLeft={isMac ? paddingLeft : undefined}
			separateUtilities={isOrchestrator || !isSessionRoute}
			utilities={
				<>
					<NotificationCenter style={noDragStyle} />
					{showInspectorOpenControl ? (
						<>
							<span aria-hidden="true" className="reverb-topbar__zone-divider shrink-0" />
							<TopbarButton
								aria-expanded="false"
								aria-label={t("shell.openInspector")}
								onClick={() => toggleInspector(currentSessionId!)}
								style={noDragStyle}
								title={t("shell.openInspectorTitle")}
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

// Confirmation stays attached to the compact top-bar icon, while teardown
// progress lives in the mutation cache so navigating back to the orchestrator
// cannot transfer another worker's pending/error state into this control.
export function TopbarKillButton({
	session,
	orchestratorId,
	onKilled,
}: {
	session: WorkspaceSession;
	orchestratorId?: string;
	onKilled: (workspaceId: string, orchestratorId?: string) => void;
}) {
	const { t } = useTranslation();
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
			<Tooltip>
				<TooltipTrigger asChild>
					<span className="inline-flex">
						<SessionTerminationPopover
							onConfirm={confirmKill}
							onOpenChange={setConfirmOpen}
							open={confirmOpen}
							session={session}
							trigger={
					<TopbarButton
						aria-label={isPending ? t("shell.killing") : t("shell.killSession")}
						disabled={isPending}
						onClick={() => {
							clearTerminateSessionState(queryClient, session.id);
						}}
						title={t("shell.killSession")}
						variant="killIcon"
					>
						<Trash2 className="size-icon-lg" aria-hidden="true" />
					</TopbarButton>
							}
						/>
					</span>
				</TooltipTrigger>
				<TooltipContent side="bottom">{t("shell.killSession")}</TooltipContent>
			</Tooltip>
			{error ? <TopbarKillError>{error}</TopbarKillError> : null}
		</div>
	);
}

function ProjectTerminationFeedback({ projectId }: { projectId: string | undefined }) {
	const { t } = useTranslation();
	const states = useProjectTerminateSessionStates(projectId);
	if (states.length === 0) return null;

	return (
		<div aria-label={t("shell.sessionTerminationStatus")} className="flex max-w-content-max items-center gap-2">
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
						title={t("shell.killingNamed", { title: state.session.title })}
					>
						{t("shell.killingNamed", { title: state.session.title })}
					</span>
				),
			)}
		</div>
	);
}
