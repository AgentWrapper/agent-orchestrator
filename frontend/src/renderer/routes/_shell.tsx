import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { type CSSProperties, useCallback, useEffect, useRef } from "react";
import { ShellTopbar } from "../components/ShellTopbar";
import { OrchestratorReplacementDialog } from "../components/OrchestratorReplacementDialog";
import { Sidebar } from "../components/Sidebar";
import { SidebarProvider } from "../components/ui/sidebar";
import { TitlebarNav } from "../components/TitlebarNav";
import { agentsQueryKey, agentsQueryOptions, refreshAgents } from "../hooks/useAgentsQuery";
import { useDaemonStatus } from "../hooks/useDaemonStatus";
import { useWorkspaceQuery, workspaceQueryKey, workspaceQueryOptions } from "../hooks/useWorkspaceQuery";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import { refreshDaemonStatus } from "../lib/daemon-status";
import { addRendererExceptionStep, captureRendererEvent, captureRendererException } from "../lib/telemetry";
import { ShellProvider } from "../lib/shell-context";
import { spawnOrchestrator } from "../lib/spawn-orchestrator";
import { restartProjectOrchestrator } from "../lib/restart-orchestrator";
import { captureOrchestratorReplacementFailure } from "../lib/orchestrator-replacement-telemetry";
import { readStoredTheme, type Theme, useUiStore } from "../stores/ui-store";
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

function systemTheme(): Theme {
	return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : "Could not load projects";
}

// Persistent app shell: the Sidebar + shared state survive route changes; only
// the <Outlet> content (board / session / settings / …) swaps. Lifted out of
// the old single <App>, with selection now owned by the router (route params)
// instead of Zustand. The daemon-status effect runs here exactly once.
function ShellLayout() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const workspaceQuery = useWorkspaceQuery();
	const workspaces = workspaceQuery.data ?? [];
	const daemonStatus = useDaemonStatus(queryClient);
	const agentCatalogPortRef = useRef<number | undefined>(undefined);
	const { theme, setTheme, isSidebarOpen, toggleSidebar } = useUiStore();
	const setProjectRestarting = useUiStore((state) => state.setProjectRestarting);
	const orchestratorReplacementErrors = useUiStore((state) => state.orchestratorReplacementErrors);
	const setOrchestratorReplacementError = useUiStore((state) => state.setOrchestratorReplacementError);
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
					config: {
						worker: { agent: input.workerAgent },
						orchestrator: { agent: input.orchestratorAgent },
						trackerIntake: input.trackerIntake,
					},
				},
			});
			if (error) {
				const failure = new Error(apiErrorMessage(error));
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
				path: data.project.path,
				type: "main",
				orchestratorAgent: input.orchestratorAgent as WorkspaceSummary["orchestratorAgent"],
				sessions: [],
			};
			void captureRendererEvent("ao.renderer.project_add_succeeded", { project_id: workspace.id });
			updateWorkspaces((current) => [workspace, ...current.filter((item) => item.id !== workspace.id)]);
			try {
				const sessionId = await spawnOrchestrator(workspace.id, "project_add");
				await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
				void navigate({
					to: "/projects/$projectId/sessions/$sessionId",
					params: { projectId: workspace.id, sessionId },
				});
			} catch (spawnError) {
				void navigate({ to: "/projects/$projectId", params: { projectId: workspace.id } });
				const message = spawnError instanceof Error ? spawnError.message : "Could not start orchestrator";
				throw new Error(`Project added, but orchestrator did not start: ${message}`);
			}
		},
		[navigate, queryClient, updateWorkspaces],
	);

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
				const failure = new Error(apiErrorMessage(error));
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
		document.documentElement.dataset.theme = theme;
		document.documentElement.style.colorScheme = theme;
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

	return (
		<ShellProvider value={{ daemonStatus, createProject }}>
			{/* The topbar spans the full window width above the sidebar row (the
          macOS traffic lights + TitlebarNav cluster sit in its left inset),
          and the sidebar hangs below it — so the sidebar border stops at the
          header instead of cutting through the titlebar strip. The bar lives
          in the layout, not the screens, so the crumb and actions never shift
          when the outlet content swaps. */}
			<div className="flex h-screen min-h-0 flex-col bg-background text-foreground">
				<ShellTopbar />
				{/* Controlled by the ui-store so TitlebarNav / Topbar toggles (which
            call the store directly) stay in sync. --sidebar-width chains to
            the drag-resizable --ao-sidebar-w set on :root by useResizable. */}
				<SidebarProvider
					className="min-h-0 flex-1"
					onOpenChange={(open) => open !== isSidebarOpen && toggleSidebar()}
					open={isSidebarOpen}
					style={{ "--sidebar-width": "var(--ao-sidebar-w, 240px)", "--sidebar-width-icon": "48px" } as CSSProperties}
				>
					<Sidebar
						daemonStatus={daemonStatus}
						underTopbar
						onCreateProject={createProject}
						onRemoveProject={removeProject}
						workspaceError={workspaceQuery.isError ? errorMessage(workspaceQuery.error) : undefined}
						workspaces={workspaces}
					/>
					<main className="flex min-w-0 flex-1 flex-col">
						<div className="min-h-0 flex-1">
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
