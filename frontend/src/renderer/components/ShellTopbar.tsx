import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { GitBranch, LayoutDashboard, PanelRightClose, PanelRightOpen, Plus, Square, Trash2 } from "lucide-react";
import { useState } from "react";
import { NotificationCenter } from "./NotificationCenter";
import {
	findProjectOrchestrator,
	isOrchestratorSession,
	sessionIsActive,
	workerDisplayStatus,
	type WorkerDisplayStatus,
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

const isMac = typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(navigator.userAgent);
const dragStyle = isMac ? ({ WebkitAppRegion: "drag" } as React.CSSProperties) : undefined;
const noDragStyle = isMac ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined;

// Session status → pill tone, mirroring agent-orchestrator's StatusBadge
// (working=orange & breathing, input=amber, fail=red, ready=green, done=neutral).
// Tones are theme vars so the pill tracks the light/dark status palettes.
const STATUS_PILL: Record<WorkerDisplayStatus, { label: string; tone: string; breathe: boolean }> = {
	working: { label: "Working", tone: "var(--orange)", breathe: true },
	needs_you: { label: "Needs input", tone: "var(--amber)", breathe: false },
	in_review: { label: "In review", tone: "var(--fg-muted)", breathe: false },
	ci_failed: { label: "CI failed", tone: "var(--red)", breathe: false },
	no_signal: { label: "No signal", tone: "var(--fg-muted)", breathe: false },
	mergeable: { label: "Ready", tone: "var(--green)", breathe: false },
	done: { label: "Done", tone: "var(--fg-muted)", breathe: false },
	unknown: { label: "Unknown", tone: "var(--fg-muted)", breathe: false },
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
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const params = useParams({ strict: false }) as { projectId?: string; sessionId?: string };
	const isInspectorOpen = useUiStore((state) => state.isInspectorOpen);
	const toggleInspector = useUiStore((state) => state.toggleInspector);
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
	const project = projectId ? all.find((workspace) => workspace.id === projectId) : undefined;
	const projectLabel = project?.name ?? session?.workspaceName ?? (projectId ? "" : "agent-orchestrator");
	const orchestrator = projectId ? findProjectOrchestrator(all, projectId) : undefined;

	const openBoard = () =>
		projectId ? void navigate({ to: "/projects/$projectId", params: { projectId } }) : void navigate({ to: "/" });

	const openNewTask = () => {
		if (!projectId) return;
		setIsNewTaskOpen(true);
	};

	const handleTaskCreated = async (sessionId: string) => {
		if (!projectId) return;
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
			const sessionId = await spawnOrchestrator(projectId);
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
		<header className={cn("dashboard-app-header", isMac && "is-under-titlebar-nav")} style={dragStyle}>
			<div className="session-topbar__lead">
				{isSessionRoute && isOrchestrator ? (
					<div className="topbar-project-pills-group">
						<div className="topbar-project-line">
							<span className="dashboard-app-header__project">{projectLabel}</span>
							<span aria-hidden="true" className="topbar-identity-sep">
								·
							</span>
							<span className="session-detail-mode-badge session-detail-mode-badge--neutral">
								<OrchestratorIcon className="size-3 shrink-0" aria-hidden="true" />
								Orchestrator
							</span>
						</div>
					</div>
				) : isSessionRoute ? (
					<div className="session-topbar__identity">
						<div className="session-topbar__branch">
							<GitBranch className="h-3 w-3 shrink-0" aria-hidden="true" />
							<span className="truncate">{session?.branch || `session/${session?.id ?? ""}`}</span>
						</div>
						{session ? <SessionStatusPill session={session} /> : null}
					</div>
				) : isProjectBoardRoute ? null : (
					<div className="topbar-project-line">
						<span className="dashboard-app-header__project">{projectLabel}</span>
					</div>
				)}
			</div>

			<div className="dashboard-app-header__spacer" />

			<div className="dashboard-app-header__actions">
				<NotificationCenter style={noDragStyle} />
				{isSessionRoute ? (
					<>
						{isOrchestrator ? (
							<>
								<button
									aria-label="New task"
									className="dashboard-app-header__primary-btn"
									onClick={openNewTask}
									style={noDragStyle}
									type="button"
								>
									<Plus className="h-3.5 w-3.5" aria-hidden="true" />
									New task
								</button>
								<button
									aria-label="Open Kanban"
									className="dashboard-app-header__accent-btn"
									onClick={openBoard}
									style={noDragStyle}
									type="button"
								>
									<LayoutDashboard className="h-3.5 w-3.5" aria-hidden="true" />
									Kanban
								</button>
							</>
						) : null}
						{/* Kill control sits beside the orchestrator link for active workers —
						    moved here from the inspector's Summary "Danger zone". */}
						{!isOrchestrator && session && sessionIsActive(session) ? <TopbarKillButton session={session} /> : null}
						{!isOrchestrator && (
							<button
								aria-label="Open orchestrator"
								className="dashboard-app-header__primary-btn dashboard-app-header__primary-btn--compact"
								disabled={isSpawning}
								onClick={() => void openOrchestrator()}
								style={noDragStyle}
								type="button"
							>
								<OrchestratorIcon className="h-3.5 w-3.5" aria-hidden="true" />
								{isSpawning ? "Spawning…" : "Orchestrator"}
							</button>
						)}
						{/* Inspector collapse (worker sessions only — orchestrators have no rail). */}
						{!isOrchestrator && (
							<button
								aria-label={isInspectorOpen ? "Close inspector panel" : "Open inspector panel"}
								aria-pressed={isInspectorOpen}
								className="dashboard-app-header__icon-btn"
								onClick={toggleInspector}
								style={noDragStyle}
								title={`${isInspectorOpen ? "Close" : "Open"} inspector · ⌘⇧B`}
								type="button"
							>
								{isInspectorOpen ? (
									<PanelRightClose className="h-[15px] w-[15px]" aria-hidden="true" />
								) : (
									<PanelRightOpen className="h-[15px] w-[15px]" aria-hidden="true" />
								)}
							</button>
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
export function TopbarKillButton({ session }: { session: WorkspaceSession }) {
	const queryClient = useQueryClient();
	const [confirming, setConfirming] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const kill = useMutation({
		mutationFn: async () => {
			const { error: apiError } = await apiClient.POST("/api/v1/sessions/{sessionId}/kill", {
				params: { path: { sessionId: session.id } },
			});
			if (apiError) throw new Error(apiErrorMessage(apiError));
		},
		onSuccess: () => {
			setConfirming(false);
			void queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
		},
		onError: (e) => setError(e instanceof Error ? e.message : "Kill failed"),
	});

	if (confirming) {
		return (
			<div className="dashboard-app-header__kill-confirm" style={noDragStyle}>
				<button
					aria-label="Confirm kill"
					className="dashboard-app-header__kill-confirm-btn"
					disabled={kill.isPending}
					onClick={() => kill.mutate()}
					type="button"
				>
					<Square className="h-3.5 w-3.5" aria-hidden="true" />
					{kill.isPending ? "Killing…" : "Confirm kill"}
				</button>
				<button
					className="dashboard-app-header__kill-cancel-btn"
					disabled={kill.isPending}
					onClick={() => setConfirming(false)}
					type="button"
				>
					Cancel
				</button>
				{error ? (
					<span className="dashboard-app-header__kill-error" role="alert">
						{error}
					</span>
				) : null}
			</div>
		);
	}

	return (
		<button
			aria-label="Kill session"
			className="dashboard-app-header__kill-btn"
			onClick={() => {
				setError(null);
				setConfirming(true);
			}}
			style={noDragStyle}
			title="Kill session"
			type="button"
		>
			<Trash2 className="h-[13px] w-[13px]" aria-hidden="true" />
			Kill
		</button>
	);
}

// StatusBadge --pill: tinted bordered pill (inset 25%-tone hairline + 7%-tone
// fill) with a 6px dot that breathes while the agent is working.
function SessionStatusPill({ session }: { session: WorkspaceSession }) {
	const { label, tone, breathe } = STATUS_PILL[workerDisplayStatus(session)];
	return (
		<span
			className="inline-flex shrink-0 items-center gap-[7px] whitespace-nowrap rounded-[7px] px-[11px] py-[5px] text-[11.5px] font-semibold leading-none"
			style={{
				color: tone,
				background: `color-mix(in srgb, ${tone} 7%, transparent)`,
				boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${tone} 25%, transparent)`,
			}}
		>
			<span
				className={cn("h-1.5 w-1.5 rounded-full", breathe && "animate-status-pulse")}
				style={{ background: tone }}
			/>
			{label}
		</span>
	);
}
