import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { GitBranch, LayoutDashboard, PanelRightClose, PanelRightOpen, Plus, Square, Trash2 } from "lucide-react";
import { useState } from "react";
import { NotificationCenter } from "./NotificationCenter";
import {
	findProjectOrchestrator,
	isOrchestratorSession,
	sessionIsActive,
	type SessionActivityState,
	type WorkspaceSession,
} from "../types/workspace";
import { useWorkspaceQuery, workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { spawnOrchestrator } from "../lib/spawn-orchestrator";
import { addRendererExceptionStep, captureRendererEvent, captureRendererException } from "../lib/telemetry";
import { useUiStore } from "../stores/ui-store";
import { OrchestratorIcon } from "./icons";
import { NewTaskDialog } from "./NewTaskDialog";
import { cn } from "../lib/utils";
import { StatusPill } from "./StatusPill";
import {
	TopbarButton,
	TopbarKillError,
	topbarHeaderClass,
	topbarHeaderMacClass,
	topbarProjectLabelClass,
} from "./TopbarButton";
import { useTranslation } from "react-i18next";

const isMac = typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(navigator.userAgent);
const isLinux =
	typeof navigator !== "undefined" &&
	((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform)
		.toLowerCase()
		.includes("linux");
const dragStyle = isMac ? ({ WebkitAppRegion: "drag" } as React.CSSProperties) : undefined;
const noDragStyle = isMac ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined;


// Topbar shows only the raw agent activity state. SCM/context badges stay in
// the inspector Summary > Activity row.
const TOPBAR_ACTIVITY_PILL: Record<SessionActivityState, { tone: string; breathe: boolean }> = {
	active: { tone: "var(--color-working)", breathe: true },
	idle: { tone: "var(--color-text-muted)", breathe: false },
	waiting_input: { tone: "var(--color-warning)", breathe: false },
	blocked: { tone: "var(--color-warning)", breathe: false },
	exited: { tone: "var(--color-text-muted)", breathe: false },
	unknown: { tone: "var(--color-text-muted)", breathe: false },
};

const TOPBAR_ACTIVITY_LABEL_KEY: Record<SessionActivityState, string> = {
	active: "topbar.status.active",
	idle: "topbar.status.idle",
	waiting_input: 'topbar.status.waiting',
	blocked: "topbar.status.blocked",
	exited: "topbar.status.exit",
	unknown: "topbar.status.unknown",
};


// The one app topbar (.dashboard-app-header), rendered by the shell layout
// across the full window width — above both the sidebar and the route outlet —
// so the crumb and actions sit at identical offsets on every screen and the
// macOS traffic lights + TitlebarNav cluster live in its left inset
// (.is-under-titlebar-nav pads past them). The
// variant is derived from the route, not props: a sessionId in the URL swaps
// the lead to the session identity (orchestrator crumb + mode badge, or worker
// branch + status pill) and the actions to board/orchestrator + inspector
// controls (orchestrators open the Kanban board; workers open their orchestrator);
// otherwise it's the dashboard crumb plus the Orchestrator launcher when a
// project is in scope. Merges the old DashboardTopbar/Topbar pair —
// agent-orchestrator keeps those as two components aligned only by CSS.
export function ShellTopbar() {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const params = useParams({ strict: false }) as { projectId?: string; sessionId?: string };
	const isInspectorOpen = useUiStore((state) => state.isInspectorOpen);
	const toggleInspector = useUiStore((state) => state.toggleInspector);
	const restartingProjectIds = useUiStore((state) => state.restartingProjectIds);
	const [isSpawning, setIsSpawning] = useState(false);
	const [isNewTaskOpen, setIsNewTaskOpen] = useState(false);
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
	// route slug. "agent-orchestrator" is the root-board crumb only.
	const projectId = session?.workspaceId ?? params.projectId;
	const isProjectBoardRoute = !isSessionRoute && Boolean(projectId);
	const isRootBoardRoute = !isSessionRoute && !isProjectBoardRoute;
	const project = projectId ? all.find((workspace) => workspace.id === projectId) : undefined;
	const projectLabel = project?.name ?? session?.workspaceName ?? (projectId ? "" : "agent-orchestrator");
	const orchestrator = projectId ? findProjectOrchestrator(all, projectId) : undefined;
	const isProjectRestarting = projectId ? restartingProjectIds.has(projectId) : false;

	if (isLinux && !isSessionRoute) {
		return null;
	}

	const openBoard = () =>
		projectId ? void navigate({ to: "/projects/$projectId", params: { projectId } }) : void navigate({ to: "/" });

	const openNewTask = () => {
		if (!projectId || isProjectRestarting) return;
		setIsNewTaskOpen(true);
	};

	const handleTaskCreated = async (sessionId: string) => {
		if (!projectId || isProjectRestarting) return;
		await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
		void navigate({
			to: "/projects/$projectId/sessions/$sessionId",
			params: { projectId, sessionId },
		});
	};

	const openOrchestrator = async () => {
		if (!projectId) return;
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
		} finally {
			setIsSpawning(false);
		}
	};

	return (
		<header className={cn(topbarHeaderClass, isMac && topbarHeaderMacClass)} style={dragStyle}>
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
								{t("topbar.orchestrator")}
							</span>
						</div>
					</div>
				) : isSessionRoute ? (
					<div className="flex min-w-0 items-center gap-3">
						<div className="inline-flex min-w-0 items-center gap-1 font-mono text-2xs leading-none text-passive">
							<GitBranch className="size-icon-2xs shrink-0" aria-hidden="true" />
							<span className="truncate">{session?.branch || `session/${session?.id ?? ""}`}</span>
						</div>
						{session ? <SessionStatusPill session={session} /> : null}
					</div>
				) : isProjectBoardRoute || (isMac && isRootBoardRoute) ? null : (
					<div className="inline-flex min-w-0 items-center gap-1.5">
						<span className={topbarProjectLabelClass}>{projectLabel}</span>
					</div>
				)}
			</div>

			<div className="min-w-0 flex-1" />

			<div className="flex shrink-0 items-center gap-1.5">
				{!isLinux ? <NotificationCenter style={noDragStyle} /> : null}
				{isSessionRoute ? (
					<>
						{isOrchestrator ? (
							<>
								<TopbarButton
									aria-label={t("topbar.newTask")}
									disabled={isProjectRestarting}
									onClick={openNewTask}
									style={noDragStyle}
									variant="primary"
								>
									<Plus className="size-icon-md" aria-hidden="true" />
									{t("topbar.newTask")}
								</TopbarButton>
								<TopbarButton aria-label={t("topbar.openKanban")} onClick={openBoard} style={noDragStyle} variant="accent">
									<LayoutDashboard className="size-icon-md" aria-hidden="true" />
									{t("topbar.kanban")}
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
								aria-label={t("topbar.openOrchestrator")}
								disabled={isSpawning || isProjectRestarting}
								onClick={() => void openOrchestrator()}
								style={noDragStyle}
								variant="primary"
							>
								<OrchestratorIcon className="size-icon-md" aria-hidden="true" />
								{isProjectRestarting ? t("topbar.restarting") : isSpawning ? t("topbar.spawning") : t("topbar.orchestrator")}
							</TopbarButton>
						)}
						{/* Inspector collapse (worker sessions only — orchestrators have no rail). */}
						{!isOrchestrator && (
							<TopbarButton
								aria-label={isInspectorOpen ? t("topbar.inspector.close") : t("topbar.inspector.open")}
								aria-pressed={isInspectorOpen}
								onClick={toggleInspector}
								style={noDragStyle}
								title={t("topbar.inspector.shortcutTitle", {
									action: isInspectorOpen ? t("topbar.inspector.closeAction") : t("topbar.inspector.openAction"),
								})}
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
			</div>
			<NewTaskDialog
				open={isNewTaskOpen}
				projectId={projectId}
				onCreated={(sessionId) => void handleTaskCreated(sessionId)}
				onOpenChange={setIsNewTaskOpen}
			/>
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
	const { t } = useTranslation();
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
			setError(e instanceof Error ? e.message : t("topbar.kill.failed"));
		},
	});

	if (confirming) {
		return (
			<div className="inline-flex items-center gap-1.5" style={noDragStyle}>
				<TopbarButton
					aria-label={t("topbar.kill.confirm")}
					disabled={kill.isPending}
					onClick={() => kill.mutate()}
					variant="killConfirm"
				>
					<Square className="size-icon-md" aria-hidden="true" />
					{kill.isPending ? t("topbar.kill.killing") : t("topbar.kill.confirm")}
				</TopbarButton>
				<TopbarButton disabled={kill.isPending} onClick={() => setConfirming(false)} variant="killCancel">
					{t("topbar.kill.cancel")}
				</TopbarButton>
				{error ? <TopbarKillError>{error}</TopbarKillError> : null}
			</div>
		);
	}

	return (
		<TopbarButton
			aria-label={t("topbar.kill.session")}
			onClick={() => {
				setError(null);
				setConfirming(true);
			}}
			style={noDragStyle}
			title={t("topbar.kill.session")}
			variant="kill"
		>
			<Trash2 className="size-icon-sm" aria-hidden="true" />
			{t("topbar.kill.label")}
		</TopbarButton>
	);
}

function SessionStatusPill({ session }: { session: WorkspaceSession }) {
	const { t } = useTranslation();
	const activityState = session.activity?.state ?? "unknown";
	const { tone, breathe } = TOPBAR_ACTIVITY_PILL[activityState];
	const label = t(TOPBAR_ACTIVITY_LABEL_KEY[activityState]);
	return <StatusPill label={label} tone={tone} breathe={breathe} leading="none" />;
}
