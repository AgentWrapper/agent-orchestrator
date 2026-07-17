import { createFileRoute, Outlet, useMatchRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { type CSSProperties, useCallback, useEffect, useRef } from "react";
import { NotificationRuntime } from "../components/NotificationCenter";
import { GlobalNewTaskDialog } from "../components/GlobalNewTaskDialog";
import { ShellTopbar } from "../components/ShellTopbar";
import { OrchestratorReplacementDialog } from "../components/OrchestratorReplacementDialog";
import { Sidebar } from "../components/Sidebar";
import { SidebarProvider } from "../components/ui/sidebar";
import { TitlebarNav } from "../components/TitlebarNav";
import { WindowTitlebar } from "../components/WindowTitlebar";
import { agentsQueryKey, agentsQueryOptions, refreshAgents } from "../hooks/useAgentsQuery";
import { useDaemonStatus } from "../hooks/useDaemonStatus";
import { useWorkspaceQuery, workspaceQueryKey, workspaceQueryOptions } from "../hooks/useWorkspaceQuery";
import { apiClient, apiErrorCode, apiErrorMessage } from "../lib/api-client";
import { refreshDaemonStatus } from "../lib/daemon-status";
import { addRendererExceptionStep, captureRendererEvent, captureRendererException } from "../lib/telemetry";
import { ShellProvider } from "../lib/shell-context";
import { restartProjectOrchestrator } from "../lib/restart-orchestrator";
import { captureOrchestratorReplacementFailure } from "../lib/orchestrator-replacement-telemetry";
import { applyDocumentTheme, readStoredTheme, systemTheme } from "../lib/theme";
import { aoBridge } from "../lib/bridge";
import { useUiStore } from "../stores/ui-store";
import type { WorkspaceSummary } from "../types/workspace";
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

const isLinux =
	typeof navigator !== "undefined" &&
	((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform)
		.toLowerCase()
		.includes("linux");

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
	const { theme, setTheme, isSidebarOpen, toggleSidebar } = useUiStore();
	const requestNewTask = useUiStore((state) => state.requestNewTask);
	const requestCreateProject = useUiStore((state) => state.requestCreateProject);
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
	const setProjectRestarting = useUiStore((state) => state.setProjectRestarting);
	const orchestratorReplacementErrors = useUiStore((state) => state.orchestratorReplacementErrors);
	const setOrchestratorReplacementError = useUiStore((state) => state.setOrchestratorReplacementError);
	const setOrchestratorStartupError = useUiStore((state) => state.setOrchestratorStartupError);
	const replacementErrorProjectId = Object.keys(orchestratorReplacementErrors)[0] ?? null;

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
				kind: data.project.kind === "workspace" ? "workspace" : "single_repo",
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
		applyDocumentTheme(theme);
	}, [theme]);

	useEffect(() => {
		if (daemonStatus.state !== "ready" || !daemonStatus.port) return;
		if (agentCatalogPortRef.current === daemonStatus.port) return;

		agentCatalogPortRef.current = daemonStatus.port;
		void queryClient.invalidateQueries({ queryKey: agentsQueryKey });
		void queryClient.fetchQuery({ ...agentsQueryOptions, queryFn: refreshAgents });
		void queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
	}, [daemonStatus.port, daemonStatus.state, queryClient]);

	// Follow OS appearance only until the user picks a theme explicitly.
	useEffect(() => {
		if (readStoredTheme()) return;

		const mediaQuery = window.matchMedia("(prefers-color-scheme: light)");
		const handleChange = () => setTheme(systemTheme());
		mediaQuery.addEventListener("change", handleChange);
		return () => mediaQuery.removeEventListener("change", handleChange);
	}, [setTheme]);

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

	return (
		<ShellProvider value={{ daemonStatus, createProject, initializeProjectRepository }}>
			<NotificationRuntime />
			<GlobalNewTaskDialog />
			{/* The topbar spans the full window width above the sidebar row (the
          macOS traffic lights + TitlebarNav cluster sit in its left inset),
          and the sidebar hangs below it — so the sidebar border stops at the
          header instead of cutting through the titlebar strip. The bar lives
          in the layout, not the screens, so the crumb and actions never shift
          when the outlet content swaps. */}
			<div className="flex h-screen min-h-0 flex-col bg-background text-foreground">
				{/* Windows-only custom title bar (logo + File/Edit/View/… menu); paints
            the chrome the frameless window drops. Renders null on macOS/Linux. */}
				<WindowTitlebar />
				<ShellTopbar />
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
					<Sidebar
						daemonStatus={daemonStatus}
						underTopbar={isLinux ? isSessionRoute : true}
						onCreateProject={createProject}
						onInitializeProject={initializeProjectRepository}
						onRemoveProject={removeProject}
						workspaceError={workspaceQuery.isError ? errorMessage(workspaceQuery.error) : undefined}
						workspaces={workspaces}
					/>
					<main className="flex min-w-0 flex-1 flex-col overflow-x-hidden">
						<div className="min-h-0 flex-1 overflow-x-hidden">
							<Outlet />
						</div>
					</main>
					{/* Fixed macOS titlebar cluster beside the traffic lights — rendered
              once here so the toggle/history buttons never move when the
              sidebar collapses or expands. MUST come after the topbar in the
              DOM: Electron builds the window-drag region in document order
              (drag rects add, no-drag rects subtract), so the cluster's
              no-drag holes only survive if they're processed after the drag
              strips they overlap. Rendered first, real clicks get swallowed
              by window-drag even though DOM hit-testing looks correct. */}
					<TitlebarNav />
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
			</div>
		</ShellProvider>
	);
}
