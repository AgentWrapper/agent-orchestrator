import { createFileRoute, Outlet, useMatchRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { CommandPalette } from "../components/CommandPalette";
import { CenterPanelShell } from "../components/CenterPanelShell";
import { DaemonFailureBanner } from "../components/DaemonFailureBanner";
import { NotificationRuntime } from "../components/NotificationCenter";
import { GlobalNewTaskDialog } from "../components/GlobalNewTaskDialog";
import { KeyboardShortcutsDialog } from "../components/KeyboardShortcutsDialog";
import { ShellTopbar } from "../components/ShellTopbar";
import { OrchestratorReplacementDialog } from "../components/OrchestratorReplacementDialog";
import { Sidebar } from "../components/Sidebar";
import { SidebarProvider } from "../components/ui/sidebar";
import { WindowTitlebar } from "../components/WindowTitlebar";
import { agentsQueryKey, agentsQueryOptions, refreshAgents } from "../hooks/useAgentsQuery";
import { useDaemonStatus } from "../hooks/useDaemonStatus";
import { useOpenShellTerminal } from "../hooks/useShellTerminals";
import { useWorkspaceQuery, workspaceQueryKey, workspaceQueryOptions } from "../hooks/useWorkspaceQuery";
import { apiClient, apiErrorCode, apiErrorMessage } from "../lib/api-client";
import { refreshDaemonStatus } from "../lib/daemon-status";
import { addRendererExceptionStep, captureRendererEvent, captureRendererException } from "../lib/telemetry";
import { ShellProvider } from "../lib/shell-context";
import { restartProjectOrchestrator } from "../lib/restart-orchestrator";
import { captureOrchestratorReplacementFailure } from "../lib/orchestrator-replacement-telemetry";
import { applyDocumentTheme } from "../lib/theme";
import { aoBridge } from "../lib/bridge";
import {
	isLinuxPlatform,
	isMacPlatform,
	isWindowsPlatform,
	usesFramedAppTopbar,
	hidesShellTopbar,
} from "../lib/platform";
import { useUiStore } from "../stores/ui-store";
import { toProjectKind, type WorkspaceSummary } from "../types/workspace";
import type { components } from "../../api/schema";

export const Route = createFileRoute("/_shell")({
	// Prefetch the workspace list for the whole shell (parent loaders run before
	// children); pairs with the router's defaultPreload: "intent" so a hovered
	// nav target is warm before the click.
	loader: async ({ context }) => {
		await refreshDaemonStatus().catch(() => undefined);
		return context.queryClient.ensureQueryData(workspaceQueryOptions);
	},
	component: ShellLayout,
});

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : "Could not load projects";
}

type CreateProjectConfigInput = {
	workerAgent: string;
	orchestratorAgent: string;
	trackerIntake?: components["schemas"]["TrackerIntakeConfig"];
};

export function createProjectConfig(input: CreateProjectConfigInput): components["schemas"]["ProjectConfig"] {
	return {
		worker: { agent: input.workerAgent as components["schemas"]["RoleOverride"]["agent"] },
		orchestrator: { agent: input.orchestratorAgent as components["schemas"]["RoleOverride"]["agent"] },
		...(input.trackerIntake ? { trackerIntake: input.trackerIntake } : {}),
	};
}

const isMac = isMacPlatform();
const isWindows = isWindowsPlatform();
const isLinux = isLinuxPlatform();
const framedAppTopbar = usesFramedAppTopbar();
const shellTopbarHiddenByPlatform = hidesShellTopbar();

// Persistent app shell: the Sidebar + shared state survive route changes; only
// the <Outlet> content (board / session / settings / …) swaps. Lifted out of
// the old single <App>, with selection now owned by the router (route params)
// instead of Zustand. The daemon-status effect runs here exactly once.
function ShellLayout() {
	const navigate = useNavigate();
	const matchRoute = useMatchRoute();
	const queryClient = useQueryClient();
	const workspaceQuery = useWorkspaceQuery();
	const workspaces = workspaceQuery.data ?? [];
	const daemonStatus = useDaemonStatus(queryClient);
	const agentCatalogPortRef = useRef<number | undefined>(undefined);
	const { themePreference, resolvedTheme, isSidebarOpen, toggleSidebar } = useUiStore();
	const syncSystemTheme = useUiStore((state) => state.syncSystemTheme);
	const requestNewTask = useUiStore((state) => state.requestNewTask);
	const requestCreateProject = useUiStore((state) => state.requestCreateProject);
	const requestNewShellTerminal = useUiStore((state) => state.requestNewShellTerminal);
	const newShellTerminalNonce = useUiStore((state) => state.newShellTerminalNonce);
	const setActiveShellTerminal = useUiStore((state) => state.setActiveShellTerminal);
	const openShellTerminal = useOpenShellTerminal();
	// Seeded to the current value so a mount never opens a terminal unasked.
	const handledShellNonceRef = useRef(newShellTerminalNonce);
	const [isKeyboardShortcutsOpen, setIsKeyboardShortcutsOpen] = useState(false);
	const routeParams = useParams({ strict: false }) as { projectId?: string; sessionId?: string };
	// Project in scope for a new-session shortcut: the route's project, or the
	// workspace owning the open session (so the shortcut works from a worker's
	// detail view, where the URL carries only a sessionId).
	const scopedProjectId = routeParams.projectId
		? routeParams.projectId
		: routeParams.sessionId
			? workspaces.find((workspace) => workspace.sessions.some((session) => session.id === routeParams.sessionId))?.id
			: undefined;
	const isSessionRoute =
		Boolean(matchRoute({ to: "/projects/$projectId/sessions/$sessionId", fuzzy: true })) ||
		Boolean(matchRoute({ to: "/sessions/$sessionId", fuzzy: true }));
	// First-launch root board only (no projects in scope).
	const isWelcomeBoard = Boolean(matchRoute({ to: "/" })) && workspaces.length === 0;
	const isSettingsRoute =
		Boolean(matchRoute({ to: "/settings", fuzzy: true })) ||
		Boolean(matchRoute({ to: "/projects/$projectId/settings", fuzzy: true }));
	// Welcome/settings always self-frame. Platforms that hide the shell-owned
	// topbar (macOS) use the same full-height inset; session actions mount
	// inside SessionView.
	const selfFramedCenterPanel = isWelcomeBoard || isSettingsRoute;
	const hideShellTopbar = selfFramedCenterPanel || shellTopbarHiddenByPlatform;
	const setProjectRestarting = useUiStore((state) => state.setProjectRestarting);
	const orchestratorReplacementErrors = useUiStore((state) => state.orchestratorReplacementErrors);
	const setOrchestratorReplacementError = useUiStore((state) => state.setOrchestratorReplacementError);
	const setOrchestratorStartupError = useUiStore((state) => state.setOrchestratorStartupError);
	const replacementErrorProjectId = Object.keys(orchestratorReplacementErrors)[0] ?? null;

	const navigateSession = useCallback(
		(direction: -1 | 1) => {
			if (!scopedProjectId) return;
			const sessions = (workspaces.find((workspace) => workspace.id === scopedProjectId)?.sessions ?? []).filter(
				(session) => session.status !== "terminated",
			);
			if (sessions.length === 0) return;
			const currentIndex = sessions.findIndex((session) => session.id === routeParams.sessionId);
			const nextIndex =
				currentIndex === -1
					? direction === 1
						? 0
						: sessions.length - 1
					: (currentIndex + direction + sessions.length) % sessions.length;
			const session = sessions[nextIndex];
			if (!session || session.id === routeParams.sessionId) return;
			void navigate({
				to: "/projects/$projectId/sessions/$sessionId",
				params: { projectId: scopedProjectId, sessionId: session.id },
			});
		},
		[navigate, routeParams.sessionId, scopedProjectId, workspaces],
	);

	const updateWorkspaces = useCallback(
		(updater: (workspaces: WorkspaceSummary[]) => WorkspaceSummary[]) => {
			queryClient.setQueryData<WorkspaceSummary[]>(workspaceQueryKey, (current = []) => updater(current));
		},
		[queryClient],
	);

	const createProject = useCallback(
		async (input: {
			path: string;
			workerAgent: string;
			orchestratorAgent: string;
			trackerIntake?: components["schemas"]["TrackerIntakeConfig"];
			asWorkspace?: boolean;
		}) => {
			void addRendererExceptionStep("Project add requested", {
				source: "project-add",
				operation: "project_add",
				surface: "project_board",
			});
			void captureRendererEvent("ao.renderer.project_add_requested");
			const status = await refreshDaemonStatus();
			if (status.state !== "ready" || !status.port) {
				throw new Error(status.message || "AO daemon is not ready.");
			}
			const { data, error } = await apiClient.POST("/api/v1/projects", {
				body: {
					path: input.path,
					asWorkspace: input.asWorkspace || undefined,
					config: createProjectConfig(input),
				},
			});
			if (error) {
				const failure = new Error(apiErrorMessage(error)) as Error & { code?: string };
				failure.code = apiErrorCode(error);
				void captureRendererException(failure, {
					source: "project-add",
					operation: "project_add",
					surface: "project_board",
				});
				throw failure;
			}
			if (!data?.project) throw new Error("Project creation returned no project");

			const workspace: WorkspaceSummary = {
				id: data.project.id,
				name: data.project.name,
				kind: toProjectKind(data.project.kind),
				path: data.project.path,
				workspaceRepos: data.project.workspaceRepos,
				type: "main",
				orchestratorAgent: input.orchestratorAgent as WorkspaceSummary["orchestratorAgent"],
				sessions: [],
			};
			void captureRendererEvent("ao.renderer.project_add_succeeded", { project_id: workspace.id });
			updateWorkspaces((current) => [workspace, ...current.filter((item) => item.id !== workspace.id)]);
			setOrchestratorStartupError(workspace.id, null);
			try {
				void captureRendererEvent("ao.renderer.orchestrator_spawn_requested", {
					project_id: workspace.id,
					source: "project_add",
				});
				const {
					data: spawnData,
					error: spawnError,
					response: spawnResponse,
				} = await apiClient.POST("/api/v1/sessions", {
					body: {
						projectId: workspace.id,
						kind: "orchestrator",
						harness: input.orchestratorAgent as components["schemas"]["SpawnSessionRequest"]["harness"],
					},
				});
				if (spawnError || !spawnData?.session?.id) {
					const message = spawnError
						? apiErrorMessage(spawnError, `Failed to spawn orchestrator (${spawnResponse.status})`)
						: `Failed to spawn orchestrator (${spawnResponse.status})`;
					throw new Error(message);
				}
				void captureRendererEvent("ao.renderer.orchestrator_spawn_succeeded", {
					project_id: workspace.id,
					source: "project_add",
				});
				const sessionId = spawnData.session.id;
				await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
				void navigate({
					to: "/projects/$projectId/sessions/$sessionId",
					params: { projectId: workspace.id, sessionId },
				});
			} catch (spawnError) {
				void captureRendererEvent("ao.renderer.orchestrator_spawn_failed", {
					project_id: workspace.id,
					source: "project_add",
				});
				void navigate({ to: "/projects/$projectId", params: { projectId: workspace.id } });
				const message = spawnError instanceof Error ? spawnError.message : "Could not start orchestrator";
				const startupMessage = `Project added, but orchestrator did not start: ${message}`;
				setOrchestratorStartupError(workspace.id, startupMessage);
			}
		},
		[navigate, queryClient, setOrchestratorStartupError, updateWorkspaces],
	);

	const initializeProjectRepository = useCallback(async (path: string) => {
		const { error } = await apiClient.POST("/api/v1/projects/initialize", {
			body: { path },
		});
		if (error) {
			const failure = new Error(apiErrorMessage(error)) as Error & { code?: string };
			failure.code = apiErrorCode(error);
			throw failure;
		}
	}, []);

	const removeProject = useCallback(
		async (projectId: string) => {
			void addRendererExceptionStep("Project removal requested", {
				source: "project-remove",
				operation: "project_remove",
				surface: "project_board",
				project_id: projectId,
			});
			const { error } = await apiClient.DELETE("/api/v1/projects/{id}", {
				params: { path: { id: projectId } },
			});
			if (error) {
				const failure = new Error(apiErrorMessage(error)) as Error & { code?: string };
				failure.code = apiErrorCode(error);
				void captureRendererException(failure, {
					source: "project-remove",
					operation: "project_remove",
					surface: "project_board",
					project_id: projectId,
				});
				throw failure;
			}
			void captureRendererEvent("ao.renderer.project_removed", { project_id: projectId });
			updateWorkspaces((current) => current.filter((item) => item.id !== projectId));
		},
		[updateWorkspaces],
	);

	const restartOrchestrator = useCallback(
		async (projectId: string) => {
			await restartProjectOrchestrator({
				projectId,
				queryClient,
				navigate,
				setProjectRestarting,
				setOrchestratorReplacementError,
				onError: (error) => {
					captureOrchestratorReplacementFailure(error, projectId);
				},
			});
		},
		[navigate, queryClient, setOrchestratorReplacementError, setProjectRestarting],
	);

	useEffect(() => {
		applyDocumentTheme(resolvedTheme);
	}, [resolvedTheme]);

	// Keep Electron's nativeTheme in step with the shell so the embedded preview
	// WebContentsView (which follows prefers-color-scheme) flips at the same time.
	// Send the preference, not the resolved theme, so "system" keeps both surfaces
	// following the OS instead of freezing matchMedia to a forced value.
	useEffect(() => {
		void aoBridge.theme?.set(themePreference);
	}, [themePreference]);

	useEffect(() => {
		if (daemonStatus.state !== "ready" || !daemonStatus.port) return;
		if (agentCatalogPortRef.current === daemonStatus.port) return;

		agentCatalogPortRef.current = daemonStatus.port;
		void queryClient.invalidateQueries({ queryKey: agentsQueryKey });
		void queryClient.fetchQuery({ ...agentsQueryOptions, queryFn: refreshAgents });
		void queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
	}, [daemonStatus.port, daemonStatus.state, queryClient]);

	// Follow OS appearance while the user keeps Theme on System — updates
	// resolvedTheme (and thus React consumers) without writing light/dark to storage.
	useEffect(() => {
		if (themePreference !== "system") return;

		const mediaQuery = window.matchMedia("(prefers-color-scheme: light)");
		const handleChange = () => syncSystemTheme();
		mediaQuery.addEventListener("change", handleChange);
		return () => mediaQuery.removeEventListener("change", handleChange);
	}, [themePreference, syncSystemTheme]);

	// ⌘B lives in SidebarProvider (shadcn's built-in shortcut), which routes
	// through onOpenChange back into the ui-store.
	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && /^[1-9]$/.test(event.key)) {
				const workspace = workspaces[Number(event.key) - 1];
				if (workspace) {
					event.preventDefault();
					void navigate({ to: "/projects/$projectId", params: { projectId: workspace.id } });
				}
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [navigate, workspaces]);

	// New session (⌘N / Ctrl+Shift+N) is detected in the main process and
	// delivered here, so it fires even when focus is inside xterm or a native
	// Browser-preview view. The shell owns the routing: open the New Task flow
	// for the in-scope project, else fall back to create-project.
	useEffect(
		() =>
			aoBridge.app.onNewSessionShortcut(() => {
				if (scopedProjectId) {
					requestNewTask(scopedProjectId);
				} else {
					requestCreateProject();
				}
			}),
		[scopedProjectId, requestNewTask, requestCreateProject],
	);

	useEffect(() => aoBridge.app.onKeyboardShortcutsHelp(() => setIsKeyboardShortcutsOpen(true)), []);

	// New standalone terminal (Ctrl+Shift+`), also detected in the main process so it
	// fires from inside a terminal pane. It raises the same store signal as the
	// tab-strip + button so the two cannot drift apart.
	useEffect(() => aoBridge.app.onNewShellTerminalShortcut(() => requestNewShellTerminal()), [requestNewShellTerminal]);

	// The shell layout is the single consumer of that signal, because it is the
	// only component mounted on EVERY route. Owning it here is what lets the
	// button and Ctrl+Shift+` work from the board, a project page, or a session alike
	// — when the session view owned it, both silently did nothing outside a
	// session, since nothing was listening.
	//
	// Where the new shell becomes visible depends on where the user is: inside a
	// session it joins that pane's tab strip, anywhere else it gets the
	// standalone /terminals view. Either way the store records it as active, and
	// whichever view is on screen selects it.
	useEffect(() => {
		if (handledShellNonceRef.current === newShellTerminalNonce) return;
		handledShellNonceRef.current = newShellTerminalNonce;
		openShellTerminal.mutate(scopedProjectId, {
			onSuccess: (shell) => {
				setActiveShellTerminal(shell.handleId);
				if (!routeParams.sessionId) {
					void navigate({ to: "/terminals" });
				}
			},
		});
	}, [
		newShellTerminalNonce,
		openShellTerminal,
		scopedProjectId,
		routeParams.sessionId,
		navigate,
		setActiveShellTerminal,
	]);

	useEffect(() => aoBridge.app.onOpenSettingsShortcut(() => void navigate({ to: "/settings" })), [navigate]);

	useEffect(() => {
		const disposePrevious = aoBridge.app.onPreviousSessionShortcut(() => navigateSession(-1));
		const disposeNext = aoBridge.app.onNextSessionShortcut(() => navigateSession(1));
		return () => {
			disposePrevious();
			disposeNext();
		};
	}, [navigateSession]);

	useEffect(
		() =>
			aoBridge.app.onFocusTerminalShortcut(() => {
				document.querySelector<HTMLElement>(".xterm-helper-textarea")?.focus();
			}),
		[],
	);

	return (
		<ShellProvider value={{ daemonStatus, createProject, initializeProjectRepository }}>
			<NotificationRuntime />
			<GlobalNewTaskDialog />
			<KeyboardShortcutsDialog open={isKeyboardShortcutsOpen} onOpenChange={setIsKeyboardShortcutsOpen} />
			{/* Shell chrome: Win/Linux hang the sidebar under a topbar. macOS uses a
          full-height sidebar with TitlebarNav under the traffic lights. The bar
          lives in the layout so crumb/actions never shift when the outlet swaps. */}
			<div className="flex h-screen min-h-0 flex-col bg-sidebar text-foreground">
				{/* Windows-only custom title bar (sidebar toggle + File/Edit/View/…
            menu); paints the chrome the frameless window drops. Renders null on
            macOS/Linux. */}
				<WindowTitlebar />
				{/* App routes render their topbar inside the framed panel, matching the board chrome across platforms while leaving OS titlebars native. */}
				{!framedAppTopbar && !hideShellTopbar ? <ShellTopbar /> : null}
				{/* Controlled by the ui-store so TitlebarNav / Topbar toggles (which
            call the store directly) stay in sync. --sidebar-width chains to
            the drag-resizable --ao-sidebar-w set on :root by useResizable. */}
				<SidebarProvider
					className="min-h-0 flex-1 overflow-x-hidden"
					onOpenChange={(open) => open !== isSidebarOpen && toggleSidebar()}
					open={isSidebarOpen}
					style={
						{
							"--sidebar-width": "var(--ao-sidebar-w, var(--size-sidebar-default))",
							"--sidebar-width-icon": "var(--size-sidebar-icon)",
						} as CSSProperties
					}
				>
					{/* Hang the fixed sidebar below shell chrome on Win/Linux. macOS
              keeps a full-height sidebar so TitlebarNav can sit under the
              traffic lights inside the sidebar header (no center-panel pad). */}
					<Sidebar
						hideEdgeBorder={isWelcomeBoard}
						historyLocked={isWelcomeBoard}
						underTopbar={isWindows || (!framedAppTopbar && !hideShellTopbar && (isLinux ? isSessionRoute : true))}
						topbarOffset={isWindows ? "titlebar" : "toolbar"}
						onCreateProject={createProject}
						onInitializeProject={initializeProjectRepository}
						onRemoveProject={removeProject}
						workspaceError={workspaceQuery.isError ? errorMessage(workspaceQuery.error) : undefined}
						workspaces={workspaces}
					/>
					<main className="flex min-w-0 flex-1 flex-col overflow-x-hidden">
						<div className="min-h-0 flex-1 overflow-x-hidden">
							{/* Board/session routes render inside the same inset box the welcome board and settings paint for themselves, so every screen sits within the app's outer boundary. */}
							{hideShellTopbar ? (
								selfFramedCenterPanel ? (
									<Outlet />
								) : (
									// Platform hides shell topbar: full-height panel; session mounts actions in-panel.
									<CenterPanelShell>
										<Outlet />
									</CenterPanelShell>
								)
							) : framedAppTopbar ? (
								<CenterPanelShell>
									<ShellTopbar />
									<div className="flex min-h-0 flex-1 flex-col">
										<Outlet />
									</div>
								</CenterPanelShell>
							) : (
								<CenterPanelShell>
									<Outlet />
								</CenterPanelShell>
							)}
						</div>
					</main>
					<DaemonFailureBanner status={daemonStatus} />
					{/* When ShellTopbar is hidden, keep a macOS window-drag strip over
              the traffic-light band only (same --size-traffic-light-clearance
              as the Sidebar header pad). TitlebarNav sits in the sidebar below
              that band, so a taller strip would cover the toggle/arrows and
              swallow clicks. Width matches the sidebar. */}
					{hideShellTopbar && isMac ? (
						<div
							aria-hidden="true"
							className="fixed top-0 left-0 z-chrome h-traffic-light-clearance w-(--ao-sidebar-w,var(--size-sidebar-default))"
							style={{ WebkitAppRegion: "drag" } as CSSProperties}
						/>
					) : null}
				</SidebarProvider>
				<OrchestratorReplacementDialog
					error={replacementErrorProjectId ? orchestratorReplacementErrors[replacementErrorProjectId] : undefined}
					onOpenChange={(open) => {
						if (!open && replacementErrorProjectId) setOrchestratorReplacementError(replacementErrorProjectId, null);
					}}
					onRetry={(projectId) => void restartOrchestrator(projectId)}
					projectId={replacementErrorProjectId}
					workspaces={workspaces}
				/>
				<CommandPalette />
			</div>
		</ShellProvider>
	);
}
