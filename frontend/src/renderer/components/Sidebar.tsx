import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import {
	ChevronRight,
	Folder,
	FolderOpen,
	LayoutDashboard,
	MoreVertical,
	Pencil,
	Pin,
	Plus,
	RefreshCw,
	Search,
	Settings,
	Trash2,
} from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { UpdateStatus } from "../../main/update-settings";
import {
	hasConfiguredOrchestratorAgent,
	newestActiveOrchestrator,
	type WorkspaceSession,
	type WorkspaceSummary,
	workerSessions,
} from "../types/workspace";
import { getSessionDotView } from "../lib/session-presentation";
import { aoBridge } from "../lib/bridge";
import { useCommandPaletteEnabled } from "../hooks/useCommandPaletteEnabled";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { spawnOrchestrator } from "../lib/spawn-orchestrator";
import { renameSession } from "../lib/rename-session";
import { useResizable } from "../hooks/useResizable";
import { useShellMaybe } from "../lib/shell-context";
import { useUpdateStatus } from "../hooks/useUpdateStatus";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
	Sidebar as SidebarRoot,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarRail,
	SidebarMenuSub,
	SidebarMenuSubItem,
	useSidebar,
} from "./ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { OrchestratorIcon } from "./icons";
import aoLogo from "../../../assets/ao-logo.svg";
import { cn } from "../lib/utils";
import { useUiStore } from "../stores/ui-store"
import { ConfirmDialog } from "./ConfirmDialog";
import { CreateProjectFlow, type CreateProjectInput } from "./CreateProjectFlow";
import { ResizeHandle } from "./ResizeHandle";
import { isLinuxPlatform, isMacPlatform } from "../lib/platform";

// macOS + Linux paint framed chrome: the fixed TitlebarNav cluster carries the
// sidebar toggle + history arrows above this surface. Windows hangs the sidebar
// under its custom titlebar.
const isMac = isMacPlatform();
const isLinux = isLinuxPlatform();
const noDragStyle = isMac ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined;

// Shared styling for the per-project hover action buttons (dashboard,
// orchestrator, kebab): a 20px square icon button that tints on hover, matching
// the old SidebarMenuAction footprint.
const HOVER_ACTION_CLASS =
	"grid size-5 shrink-0 place-items-center rounded-md text-passive transition-colors hover:bg-interactive-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-50 data-[state=open]:bg-interactive-hover data-[state=open]:text-foreground [&_svg]:size-icon-lg";

// Shared nav-row chrome (Codex-style): inset pill hover/selected, 14px type, no accent bar.
const NAV_ROW_CLASS =
	"h-9 gap-2.5 rounded-lg px-2.5 text-sm font-medium text-muted-foreground transition-[background-color,color] hover:bg-interactive-hover hover:text-foreground active:bg-interactive-hover active:text-foreground data-[active=true]:bg-interactive-active data-[active=true]:font-medium data-[active=true]:text-foreground";

// Search + Pinned/Projects section chrome: same type, icon, and row size.
const SECTION_ROW_CLASS =
	"flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2.5 text-sm font-medium text-passive transition-colors hover:bg-interactive-hover hover:text-foreground [&_svg]:size-icon-md [&_svg]:shrink-0";

// Mirrors the daemon's display-name cap (maxDisplayNameLen) and the spawn
// `--name` flag, so inline edits never round-trip a value the API would reject.
const MAX_DISPLAY_NAME_LEN = 20;
export const SIDEBAR_DEFAULT_WIDTH = 240;
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 420;

type SidebarProps = {
	/** Hide the sidebar's right edge stroke on the welcome board inset chrome. */
	hideEdgeBorder?: boolean;
	/** Render the expanded sidebar over content without reserving layout width. */
	isOverlay?: boolean;
	underTopbar?: boolean;
	/** Chrome height to clear when underTopbar is set. Defaults to --size-toolbar. */
	topbarOffset?: "toolbar" | "titlebar" | "trafficLights";
	onPreviewLeave?: () => void;
	workspaceError?: string;
	workspaces: WorkspaceSummary[];
	onCreateProject: (input: CreateProjectInput) => Promise<void>;
	onInitializeProject: (path: string) => Promise<void>;
	onRemoveProject: (projectId: string) => Promise<void>;
};

// Selection state comes from the URL: which project/session is active is the
// route params, and clicks navigate rather than mutate a store.
function useSelection() {
	const navigate = useNavigate();
	const params = useParams({ strict: false }) as { projectId?: string; sessionId?: string };
	const pathname = useRouterState({ select: (state) => state.location.pathname });
	return {
		isHome: pathname === "/",
		activeProjectId: params.projectId,
		activeSessionId: params.sessionId,
		goHome: () => void navigate({ to: "/" }),
		goGlobalSettings: () => void navigate({ to: "/settings" }),
		goSettings: (projectId: string) => void navigate({ to: "/projects/$projectId/settings", params: { projectId } }),
		goProject: (projectId: string) => void navigate({ to: "/projects/$projectId", params: { projectId } }),
		goSession: (projectId: string, sessionId: string) =>
			void navigate({ to: "/projects/$projectId/sessions/$sessionId", params: { projectId, sessionId } }),
	};
}

// Activity controls motion; live PR context controls an active session's
// color. Idle activity remains visible as a static gray dot.
function SessionDot({ session }: { session: WorkspaceSession }) {
	const dot = getSessionDotView(session);
	return <span aria-hidden="true" className={cn("mt-px h-1.5 w-1.5 shrink-0 rounded-full", dot.className)} />;
}

// Built on shadcn's sidebar primitives (components/ui/sidebar): the provider in
// _shell owns the persistent open state plus a transient hover-preview state.
// Collapsed sidebars move fully off-canvas; previews return as overlays without
// reserving layout width.
export function Sidebar({
	hideEdgeBorder = false,
	isOverlay = false,
	underTopbar = true,
	topbarOffset = "toolbar",
	onPreviewLeave,
	workspaceError,
	workspaces,
	onCreateProject,
	onInitializeProject,
	onRemoveProject,
}: SidebarProps) {
	const { t } = useTranslation();
	const selection = useSelection();
	const { state, setOpen } = useSidebar();
	const isCollapsed = state === "collapsed";
	const [expandedChromeVisible, setExpandedChromeVisible] = useState(!isCollapsed);
	// One IPC subscription for both footer variants of the restart-to-update prompt.
	const updateStatus = useUpdateStatus();
	// Daemon status for the smoke suite's sr-only mirror in the footer. Null when
	// rendered outside the shell (unit tests) — the mirror simply doesn't render.
	const daemonStatus = useShellMaybe()?.daemonStatus ?? null;
	const commandPaletteEnabled = useCommandPaletteEnabled();
	const setCommandPaletteOpen = useUiStore((s) => s.setCommandPaletteOpen);

	useEffect(() => {
		if (isCollapsed) {
			setExpandedChromeVisible(false);
			return;
		}

		const reducedMotion =
			typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		if (reducedMotion) {
			setExpandedChromeVisible(true);
			return;
		}

		const timer = window.setTimeout(() => setExpandedChromeVisible(true), 160);
		return () => window.clearTimeout(timer);
	}, [isCollapsed]);

	// Disclosure state: projects are expanded by default; a project id present in
	// this set is collapsed (sessions hidden).
	const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(() => new Set());
	const toggleCollapsed = (id: string) =>
		setCollapsedIds((prev) => {
			const next = new Set(prev);
			next.has(id) ? next.delete(id) : next.add(id);
			return next;
		});
	// Section disclosure: Pinned / Projects headers collapse their bodies.
	const [pinnedOpen, setPinnedOpen] = useState(true);
	const [projectsOpen, setProjectsOpen] = useState(true);
	// Fetch the running app version to derive the build channel. Channel is
	// identity: derived from the version string, not the update-channel setting
	// (the setting can be changed mid-session; the binary cannot).
	const { data: appVersion } = useQuery({
		queryKey: ["app-version"],
		queryFn: () => aoBridge.app.getVersion(),
		staleTime: Infinity,
	});
	const isNightly = typeof appVersion === "string" && appVersion.includes("-nightly.");

	// agent-orchestrator's sidebar resize: drag the right edge (200-420px,
	// persisted), double-click to reset to 240px. Drives --ao-sidebar-w on :root,
	// which the provider forwards into shadcn's --sidebar-width. Dragging clamps
	// at SIDEBAR_MIN_WIDTH — collapsing stays on the explicit toggle (⌘B /
	// titlebar button), never on a drag.
	const {
		onPointerDown: onResizePointerDown,
		onCollapsedPointerDown: onCollapsedResizePointerDown,
		onDoubleClick: onResizeDoubleClick,
	} = useResizable({
		cssVar: "--ao-sidebar-w",
		storageKey: "ao-sidebar-w",
		defaultWidth: SIDEBAR_DEFAULT_WIDTH,
		min: SIDEBAR_MIN_WIDTH,
		max: SIDEBAR_MAX_WIDTH,
		edge: "right",
		onExpand: () => setOpen(true),
	});

	return (
		// Pinned sidebars start below shell chrome. Hover previews paint a
		// full-height surface behind the titlebar while their content keeps the
		// same chrome clearance, leaving the titlebar controls unobstructed.
		<SidebarRoot
			collapsible="offcanvas"
			data-expanded-chrome={expandedChromeVisible ? "visible" : "hidden"}
			data-topbar-offset={underTopbar ? topbarOffset : undefined}
			onPointerLeave={onPreviewLeave}
			overlay={isOverlay}
			className={cn(
				hideEdgeBorder ? "border-transparent" : "border-r-0 group-data-[side=left]:border-r-0",
				isOverlay && "z-sidebar-preview shadow-2xl",
				isOverlay || !underTopbar
					? "top-0 h-svh!"
					: "top-(--sidebar-chrome-offset) h-[calc(100svh-var(--sidebar-chrome-offset))]!",
			)}
		>
			<SidebarHeader
				className={cn(
					"gap-0 p-0 px-2 pt-2 group-data-[collapsible=icon]:px-1.5 group-data-[collapsible=icon]:pt-2",
					isOverlay && underTopbar && "pt-(--sidebar-chrome-offset)!",
				)}
			>
				{/* Brand (project-sidebar__brand); in the icon rail it becomes the old
            36px board button wrapping the 22px accent mark. */}
				<div
					className={cn(
						"flex shrink-0 items-center gap-1.5 px-1.5 group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-1 group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:pb-2",
						commandPaletteEnabled ? "pb-2" : "pb-3",
					)}
				>
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								aria-label={t("shell.orchestratorBoard")}
								className={cn(
									"grid h-5.5 w-5.5 shrink-0 place-items-center",
									"group-data-[collapsible=icon]:size-control-board group-data-[collapsible=icon]:rounded-lg",
									selection.isHome
										? "group-data-[collapsible=icon]:bg-interactive-active"
										: "group-data-[collapsible=icon]:hover:bg-interactive-hover",
								)}
								onClick={selection.goHome}
								type="button"
							>
								<img src={aoLogo} alt="" aria-hidden="true" className="h-5.5 w-5.5 -translate-y-[3px] rounded-md object-cover" />
							</button>
						</TooltipTrigger>
						<TooltipContent side="right" hidden={state !== "collapsed"}>
							{t("shell.orchestratorBoard")}
						</TooltipContent>
					</Tooltip>
					<span className="sidebar-expanded-chrome min-w-0 flex-1 truncate text-sm font-bold leading-tight tracking-tight-lg text-foreground group-data-[collapsible=icon]:hidden">
						Agent Orchestrator
					</span>
					{isNightly && (
						<span className="sidebar-expanded-chrome shrink-0 rounded-full bg-purple-subtle px-1.5 py-0.5 text-micro font-semibold leading-none text-purple-accent group-data-[collapsible=icon]:hidden">
							{t("shell.nightly")}
						</span>
					)}
				</div>
			</SidebarHeader>

			{/* Keep Search + section chrome fixed; only the project tree scrolls. */}
			<div className="flex shrink-0 flex-col gap-0 px-2 group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:px-1.5">
				{commandPaletteEnabled ? (
					<SidebarGroup className="p-0 pb-4">
						<SidebarGroupContent>
							<SidebarMenu className="gap-0.5 group-data-[collapsible=icon]:gap-1">
								<SidebarSearchButton onOpen={() => setCommandPaletteOpen(true)} />
							</SidebarMenu>
						</SidebarGroupContent>
					</SidebarGroup>
				) : null}

				{/* Pinned — collapsible; body empty until pin functionality lands. */}
				<div className="sidebar-expanded-chrome flex shrink-0 flex-col group-data-[collapsible=icon]:hidden">
					<SectionDisclosure
						icon={<Pin strokeWidth={1.75} aria-hidden="true" />}
						label={t("shell.pinned")}
						open={pinnedOpen}
						onToggle={() => setPinnedOpen((v) => !v)}
						className="mb-1"
					/>
					{pinnedOpen ? <div className="pb-2" /> : null}
				</div>

				{/* Projects — collapsible section; + sits inside the same hover pill. */}
				<div className="sidebar-expanded-chrome flex shrink-0 pb-1.5 group-data-[collapsible=icon]:hidden">
					<SectionDisclosure
						icon={
							projectsOpen ? (
								<FolderOpen strokeWidth={1.75} aria-hidden="true" />
							) : (
								<Folder strokeWidth={1.75} aria-hidden="true" />
							)
						}
						label={t("shell.projects")}
						open={projectsOpen}
						onToggle={() => setProjectsOpen((v) => !v)}
						trailing={
							<CreateProjectButton
								hideTrigger={workspaces.length === 0}
								onCreateProject={onCreateProject}
								onInitializeProject={onInitializeProject}
							/>
						}
					/>
				</div>
			</div>

			<SidebarContent className="scrollbar-none gap-0 px-2 group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:px-1.5">
				{/* Collapsed-rail still lists projects even when the expanded
				    Projects section is closed — the rail has no section chrome. */}
				{(projectsOpen || isCollapsed) && (
					<SidebarGroup className="p-0">
						{/* Tree (project-sidebar__tree) */}
						<SidebarGroupContent>
							{workspaceError ? (
								<div className="sidebar-expanded-chrome px-2.5 py-3 group-data-[collapsible=icon]:hidden">
									<p className="text-sm text-foreground">{t("shell.couldNotLoadProjects")}</p>
									<p className="mt-1 text-caption text-passive">{workspaceError}</p>
								</div>
							) : workspaces.length === 0 ? null : (
								<SidebarMenu className="gap-0.5 group-data-[collapsible=icon]:gap-1">
									{workspaces.map((workspace) => (
										<ProjectItem
											key={workspace.id}
											workspace={workspace}
											expanded={!collapsedIds.has(workspace.id)}
											selection={selection}
											onToggle={() => toggleCollapsed(workspace.id)}
											onRemoveProject={onRemoveProject}
										/>
									))}
									{isCollapsed && <CreateProjectListItem />}
								</SidebarMenu>
							)}
						</SidebarGroupContent>
					</SidebarGroup>
				)}
			</SidebarContent>

			{/* Footer — Settings opens the global settings page directly.
			    Top hairline matches the board Archive `border-t border-border-strong`.
			    Row height matches Archive (`h-row-md`). Bottom margin is the shell
			    inset minus 1px so the hairline meets Archive (the +1 surface-border
			    compensation overshoots on mac/linux). */}
			<SidebarFooter
				className={cn(
					"relative mt-auto gap-0 overflow-hidden border-t border-border-strong px-2 pb-0 pt-0 transition-[padding] duration-200 ease-linear group-data-[collapsible=icon]:min-h-16 group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:border-t-0 group-data-[collapsible=icon]:px-1.5 group-data-[collapsible=icon]:pb-0 group-data-[collapsible=icon]:pt-1.5",
					isMac || isLinux
						? "mb-[calc(var(--size-center-panel-inset-mac)-1px)]"
						: "mb-[calc(var(--size-center-panel-bottom-inset)-1px)]",
				)}
			>
				{/* Always-present daemon status mirror for the smoke suite: no visible
				    daemon-state copy is guaranteed to be mounted elsewhere. */}
				{daemonStatus && (
					<span aria-hidden="true" className="sr-only" data-testid="daemon-status" data-state={daemonStatus.state}>
						daemon {daemonStatus.state}
					</span>
				)}
				<div
					aria-hidden={isCollapsed || undefined}
					className="sidebar-expanded-chrome relative flex w-full min-w-46.5 flex-col gap-0.5 transition-[opacity,transform] duration-150 ease-out group-data-[collapsible=icon]:pointer-events-none group-data-[collapsible=icon]:-translate-x-2 group-data-[collapsible=icon]:opacity-0"
				>
					<RestartToUpdateRow status={updateStatus} tabIndex={isCollapsed ? -1 : 0} />
					<button
						aria-label={t("shell.settings")}
						className={cn(
							NAV_ROW_CLASS,
							"flex h-row-md w-full items-center text-left [&_svg]:size-icon-md [&_svg]:shrink-0",
						)}
						onClick={() => selection.goGlobalSettings()}
						tabIndex={isCollapsed ? -1 : 0}
						type="button"
					>
						<Settings aria-hidden="true" />
						<span className="tracking-tight">{t("shell.settings")}</span>
					</button>
				</div>
				<div
					aria-hidden={!isCollapsed || undefined}
					className="pointer-events-none absolute inset-x-1.5 bottom-0 top-auto flex min-h-row-md flex-col items-center justify-end gap-1 opacity-0 transition-opacity duration-150 ease-out group-data-[collapsible=icon]:pointer-events-auto group-data-[collapsible=icon]:opacity-100"
				>
					<RestartToUpdateRailButton status={updateStatus} tabIndex={isCollapsed ? 0 : -1} />
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								aria-label={t("shell.settings")}
								className="grid size-control-board place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground [&_svg]:size-icon-base"
								onClick={() => selection.goGlobalSettings()}
								tabIndex={isCollapsed ? 0 : -1}
								type="button"
							>
								<Settings aria-hidden="true" />
							</button>
						</TooltipTrigger>
						<TooltipContent side="right">{t("shell.settings")}</TooltipContent>
					</Tooltip>
				</div>
			</SidebarFooter>

			<ResizeHandle
				className="group-data-[state=collapsed]:hidden"
				onDoubleClick={onResizeDoubleClick}
				onPointerDown={onResizePointerDown}
				side="right"
				style={noDragStyle}
			/>
			<SidebarRail
				aria-label={t("shell.expandSidebar")}
				className="group-data-[state=expanded]:hidden hover:after:bg-transparent"
				onClick={() => setOpen(true)}
				onPointerDown={onCollapsedResizePointerDown}
			/>
		</SidebarRoot>
	);
}

type Selection = ReturnType<typeof useSelection>;

function ProjectItem({
	workspace,
	expanded,
	selection,
	onToggle,
	onRemoveProject,
}: {
	workspace: WorkspaceSummary;
	expanded: boolean;
	selection: Selection;
	onToggle: () => void;
	onRemoveProject: (projectId: string) => Promise<void>;
}) {
	const { t } = useTranslation();
	const projectActive = selection.activeProjectId === workspace.id && !selection.activeSessionId;
	const queryClient = useQueryClient();
	const [removeError, setRemoveError] = useState<string | null>(null);
	const [isRemoving, setIsRemoving] = useState(false);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [isSpawning, setIsSpawning] = useState(false);
	const restartingProjectIds = useUiStore((state) => state.restartingProjectIds);
	const isProjectRestarting = restartingProjectIds.has(workspace.id);
	const requestNewTask = useUiStore((state) => state.requestNewTask);
	// Keep completed PR sessions reachable while their runtime still exists.
	// Only termination removes a worker from the sidebar; archived sessions stay
	// reachable through SessionsBoard.
	const sessions = workerSessions(workspace.sessions).filter((session) => session.isTerminated !== true);
	// The project's live orchestrator (if any) backs the hover Orchestrator
	// button: navigate to it when present, otherwise spawn one first.
	const orchestrator = newestActiveOrchestrator(workspace.sessions);

	// Mirrors ShellTopbar's launcher: attach to the running orchestrator, or
	// spawn one via the daemon and follow it once the workspace refetches.
	const openOrchestrator = async () => {
		if (isProjectRestarting) return;
		if (orchestrator) {
			selection.goSession(workspace.id, orchestrator.id);
			return;
		}
		if (!hasConfiguredOrchestratorAgent(workspace)) {
			selection.goSettings(workspace.id);
			return;
		}
		setIsSpawning(true);
		try {
			const sessionId = await spawnOrchestrator(workspace.id, "sidebar");
			await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
			selection.goSession(workspace.id, sessionId);
		} catch (err) {
			console.error("Failed to spawn orchestrator:", err);
		} finally {
			setIsSpawning(false);
		}
	};

	const onProjectClick = () => {
		if (!expanded) {
			onToggle();
			selection.goProject(workspace.id);
		} else if (projectActive) {
			onToggle();
		} else {
			selection.goProject(workspace.id);
		}
	};

	// Folder icon always toggles disclosure, even when another project is
	// selected — without this, collapsing a non-active project required a
	// select click then a second click (felt like a double-click).
	const onFolderClick = (event: MouseEvent) => {
		event.stopPropagation();
		onToggle();
	};

	const removeProject = () => {
		setRemoveError(null);
		setConfirmOpen(true);
	};

	const handleConfirmRemove = async () => {
		setConfirmOpen(false);
		setIsRemoving(true);
		// Teardown can take a while when a project owns several sessions. Leave
		// the confirmation immediately and move to the route that remains valid
		// after removal while the sidebar keeps progress/error feedback visible.
		selection.goHome();
		try {
			await onRemoveProject(workspace.id);
		} catch (err) {
			const message = err instanceof Error ? err.message : t("shell.couldNotRemoveProject");
			setRemoveError(message);
		} finally {
			setIsRemoving(false);
		}
	};

	return (
		<SidebarMenuItem className="group-data-[collapsible=icon]:mb-0">
			{/* project-sidebar__proj-row */}
			<SidebarMenuButton
				aria-current={projectActive ? "page" : undefined}
				aria-expanded={expanded}
				isActive={projectActive}
				onClick={onProjectClick}
				tooltip={workspace.name}
				className={cn(
					NAV_ROW_CLASS,
					// Always reserve room for the action cluster (dashboard,
					// orchestrator, kebab) — icons are always visible, not hover-gated.
					"pr-sidebar-project-actions [&_svg]:size-icon-md",
					// Icon rail: the old 36px letter tile.
					"group-data-[collapsible=icon]:size-control-board! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:rounded-lg group-data-[collapsible=icon]:p-0! group-data-[collapsible=icon]:font-semibold",
				)}
			>
				<span
					aria-hidden="true"
					className="shrink-0 group-data-[collapsible=icon]:hidden"
					data-project-folder=""
					onClick={onFolderClick}
				>
					{expanded ? (
						<FolderOpen strokeWidth={1.75} aria-hidden="true" />
					) : (
						<Folder strokeWidth={1.75} aria-hidden="true" />
					)}
				</span>
				<span className="hidden group-data-[collapsible=icon]:block">{workspace.name.charAt(0).toUpperCase()}</span>
				<span className="sidebar-expanded-chrome min-w-0 flex-1 truncate group-data-[collapsible=icon]:hidden">
					{workspace.name}
				</span>
			</SidebarMenuButton>
			{/* Per-project actions: dashboard board, orchestrator, and a kebab
			menu. Always visible (not hover-gated) to avoid CSS :hover group
			propagation issues in Electron's Chromium. Hidden in the icon rail. */}
			<div
				className={cn(
					"sidebar-expanded-chrome absolute top-0 right-1.5 z-chrome flex h-9 items-center gap-px",
					"group-data-[collapsible=icon]:hidden",
				)}
			>
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							aria-label={t("shell.openProjectDashboard", { name: workspace.name })}
							className={HOVER_ACTION_CLASS}
							onClick={() => selection.goProject(workspace.id)}
							type="button"
						>
							<LayoutDashboard aria-hidden="true" />
						</button>
					</TooltipTrigger>
					<TooltipContent>{t("shell.dashboard")}</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							aria-label={
								orchestrator
									? t("shell.openProjectOrchestrator", { name: workspace.name })
									: t("shell.spawnProjectOrchestrator", { name: workspace.name })
							}
							className={HOVER_ACTION_CLASS}
							disabled={isSpawning || isProjectRestarting}
							onClick={() => void openOrchestrator()}
							type="button"
						>
							<OrchestratorIcon aria-hidden="true" />
						</button>
					</TooltipTrigger>
					<TooltipContent>
						{isProjectRestarting
							? t("shell.restarting")
							: isSpawning
								? t("shell.spawning")
								: orchestrator
									? t("shell.orchestrator")
									: t("shell.spawnOrchestratorLower")}
					</TooltipContent>
				</Tooltip>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
							<button aria-label={t("shell.projectActions", { name: workspace.name })} className={HOVER_ACTION_CLASS} type="button">
							<MoreVertical aria-hidden="true" />
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent side="right" align="start" className="min-w-44">
						<DropdownMenuItem disabled={isProjectRestarting} onSelect={() => requestNewTask(workspace.id)}>
							<Plus aria-hidden="true" />
								{t("shell.newSession")}
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem onSelect={() => selection.goSettings(workspace.id)}>
							<Settings aria-hidden="true" />
								{t("shell.projectSettings")}
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							className="text-destructive focus:text-destructive [&_svg]:text-destructive"
							disabled={isRemoving}
							onSelect={() => void removeProject()}
						>
							<Trash2 aria-hidden="true" />
								{t("shell.removeProjectTitle")}
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
			{isRemoving ? (
				<div className="sidebar-expanded-chrome px-5 py-1 text-2xs text-muted-foreground" role="status">
						{t("shell.removingNamed", { name: workspace.name })}
				</div>
			) : removeError ? (
				<div className="sidebar-expanded-chrome px-5 py-1 text-2xs text-destructive" role="alert">
					{removeError}
				</div>
			) : null}
			{/* project-sidebar__sessions: indented under the project parent so worker
          sessions read as children without adding a persistent guide rail. */}
			{expanded && sessions.length > 0 && (
				<SidebarMenuSub className="sidebar-expanded-chrome mx-0 ml-2 translate-x-0 gap-0.5 border-l-0 px-0 py-0.5">
					{sessions.map((session) => (
						<SessionRow
							key={session.id}
							session={session}
							active={selection.activeSessionId === session.id}
							onOpen={() => selection.goSession(workspace.id, session.id)}
						/>
					))}
				</SidebarMenuSub>
			)}
			<ConfirmDialog
				open={confirmOpen}
				onOpenChange={setConfirmOpen}
				title={t("shell.removeProjectTitle")}
				description={
					<>
						<p className="text-sm font-medium text-foreground">
							{t("shell.removeProjectLead", { name: workspace.name })}
						</p>
						<p className="mt-1 text-xs text-muted-foreground">{t("shell.removeProjectBody")}</p>
					</>
				}
				confirmLabel={t("shell.remove")}
				destructive
				onConfirm={handleConfirmRemove}
			/>
		</SidebarMenuItem>
	);
}

// One worker-session row. Reads as a link by default; a hover-revealed pencil
// flips the label into an inline input (Enter/blur saves, Escape cancels) that
// persists through the daemon rename endpoint, so the new name survives reload.
function SessionRow({ session, active, onOpen }: { session: WorkspaceSession; active: boolean; onOpen: () => void }) {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const [isEditing, setIsEditing] = useState(false);
	const [draft, setDraft] = useState(session.title);
	// Escape must not be swallowed by the blur-to-save path: the keydown handler
	// blurs the input, so it flags a cancel here for onBlur to honour.
	const cancelledRef = useRef(false);

	const startEditing = () => {
		setDraft(session.title);
		setIsEditing(true);
	};

	const commit = async () => {
		if (cancelledRef.current) {
			cancelledRef.current = false;
			setIsEditing(false);
			return;
		}
		setIsEditing(false);
		const name = draft.trim();
		if (!name || name === session.title) return;
		try {
			await renameSession(session.id, name);
			await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
		} catch (err) {
			console.error("Failed to rename session:", err);
		}
	};

	if (isEditing) {
		return (
			<SidebarMenuSubItem className="pl-7">
				<div className="relative flex h-8 w-full items-center gap-2 rounded-lg px-2.5 py-0">
					<SessionDot session={session} />
					<input
							aria-label={t("shell.renameSession", { title: session.title })}
						autoFocus
						className="min-w-0 flex-1 rounded-xs border border-accent bg-transparent px-1 py-px text-sm text-foreground outline-none focus-visible:ring-1 focus-visible:ring-accent"
						maxLength={MAX_DISPLAY_NAME_LEN}
						onBlur={() => void commit()}
						onChange={(e) => setDraft(e.target.value)}
						onFocus={(e) => e.currentTarget.select()}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								e.currentTarget.blur();
							} else if (e.key === "Escape") {
								e.preventDefault();
								cancelledRef.current = true;
								e.currentTarget.blur();
							}
						}}
						value={draft}
					/>
				</div>
			</SidebarMenuSubItem>
		);
	}

	return (
		<SidebarMenuSubItem className="pl-7">
			<button
				aria-current={active ? "page" : undefined}
					aria-label={t("shell.openSession", { title: session.title })}
				className={cn(
					"relative flex h-8 w-full items-center gap-2 rounded-lg px-2.5 py-0 pr-7 text-left text-sm outline-hidden transition-[background-color,color]",
					"hover:bg-interactive-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring",
					active && "bg-interactive-active text-foreground",
				)}
				onClick={onOpen}
				type="button"
			>
				<SessionDot session={session} />
				<span className="min-w-0 flex-1">
					<span className={cn("block truncate", active ? "text-foreground" : "text-muted-foreground")}>
						{session.title}
					</span>
				</span>
			</button>
			{/* Pencil reveals on row hover/focus (named group on SidebarMenuSubItem);
			it sits beside the row button rather than nested inside it. */}
			<button
					aria-label={t("shell.renameSession", { title: session.title })}
				className={cn(
					HOVER_ACTION_CLASS,
					"absolute top-1/2 right-1 -translate-y-1/2 opacity-0",
					"group-focus-within/menu-sub-item:opacity-100 group-hover/menu-sub-item:opacity-100",
				)}
				onClick={startEditing}
				type="button"
			>
				<Pencil aria-hidden="true" />
			</button>
		</SidebarMenuSubItem>
	);
}

// RestartToUpdateRow sits directly above the Settings row when an update is
// downloaded and staged. Transparent while fresh; orange (working tokens) once
// the main-process evaluator flags it escalated. Clicking installs immediately;
// the row itself is the prompt, so no confirmation dialog. Renders nothing in
// every other update state.
function RestartToUpdateRow({ status, tabIndex }: { status: UpdateStatus; tabIndex: number }) {
	const { t } = useTranslation();
	if (status.state !== "downloaded") return null;
	const escalated = status.escalated === true;
	return (
		<button
			aria-label={
				status.version
					? t("shell.restartInstallUpdateVersion", { version: status.version })
					: t("shell.restartInstallUpdate")
			}
			className={cn(
				"flex w-full items-center gap-2.5 rounded-lg p-2.5 text-left text-control font-medium transition-colors",
				escalated
					? "border border-working/35 bg-working/12 text-working hover:bg-working/18 [&_svg]:text-working"
					: "text-passive hover:bg-interactive-hover hover:text-foreground [&_svg]:text-passive",
			)}
			onClick={() => void aoBridge.updates.install()}
			tabIndex={tabIndex}
			type="button"
		>
			<RefreshCw aria-hidden="true" className="size-icon-lg shrink-0" />
			<span className="min-w-0 flex-1">
				<span className="block truncate tracking-tight">{t("shell.restartToUpdate")}</span>
				{status.version && (
					<span className={cn("block truncate text-caption font-normal", escalated ? "text-working" : "text-passive")}>
							{t("shell.versionReady", { version: status.version })}
					</span>
				)}
			</span>
			<span
				aria-hidden="true"
				className={cn("h-1.5 w-1.5 shrink-0 rounded-full", escalated ? "bg-working" : "bg-passive")}
			/>
		</button>
	);
}

// Icon-rail variant of RestartToUpdateRow for the collapsed sidebar: icon-only
// with the two-line copy in the tooltip.
function RestartToUpdateRailButton({ status, tabIndex }: { status: UpdateStatus; tabIndex: number }) {
	const { t } = useTranslation();
	if (status.state !== "downloaded") return null;
	const escalated = status.escalated === true;
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
						aria-label={
							status.version
								? t("shell.restartInstallUpdateVersion", { version: status.version })
								: t("shell.restartInstallUpdate")
						}
					className={cn(
						"grid size-9 place-items-center rounded-lg transition-colors [&_svg]:size-4",
						escalated
							? "bg-working/12 text-working hover:bg-working/18"
							: "text-passive hover:bg-interactive-hover hover:text-foreground",
					)}
					onClick={() => void aoBridge.updates.install()}
					tabIndex={tabIndex}
					type="button"
				>
					<RefreshCw aria-hidden="true" />
				</button>
			</TooltipTrigger>
			<TooltipContent side="right">
					{t("shell.restartToUpdate")}
					{status.version ? ` · ${t("shell.versionReady", { version: status.version })}` : ""}
			</TooltipContent>
		</Tooltip>
	);
}

function SectionDisclosure({
	icon,
	label,
	open,
	onToggle,
	className,
	trailing,
}: {
	icon: ReactNode;
	label: string;
	open: boolean;
	onToggle: () => void;
	className?: string;
	/** Optional trailing control (e.g. Projects "+") — stays inside the hover pill. */
	trailing?: ReactNode;
}) {
	const labelRow = (
		<>
			{icon}
			<span className="truncate">{label}</span>
			<ChevronRight
				aria-hidden="true"
				className={cn("size-3.5! shrink-0 transition-transform duration-150", open && "rotate-90")}
				strokeWidth={2}
			/>
		</>
	);

	if (trailing) {
		return (
			<div className={cn(SECTION_ROW_CLASS, "pr-1", className)}>
				<button
					aria-expanded={open}
					aria-label={label}
					className="flex min-w-0 flex-1 items-center gap-2 text-left"
					onClick={onToggle}
					type="button"
				>
					{labelRow}
				</button>
				{trailing}
			</div>
		);
	}

	return (
		<button
			aria-expanded={open}
			aria-label={label}
			className={cn(SECTION_ROW_CLASS, "text-left", className)}
			onClick={onToggle}
			type="button"
		>
			{labelRow}
		</button>
	);
}

function SidebarSearchButton({ onOpen }: { onOpen: () => void }) {
	const { t } = useTranslation();
	const { state } = useSidebar();
	const isCollapsed = state === "collapsed";
	return (
		<SidebarMenuItem className="group-data-[collapsible=icon]:mb-0">
			<SidebarMenuButton
				aria-label={t("shell.search")}
				onClick={() => {
					// Open on the microtask after this click rather than inside it: mounting
					// the palette dialog while this button's tooltip layer is still tearing
					// down from the same pointer sequence dismissed it immediately. The
					// "defers opening" test pins the deferral so it is not dropped as noise.
					queueMicrotask(onOpen);
				}}
				tooltip={isCollapsed ? t("shell.search") : undefined}
				className={cn(
					// Filled search trigger (Cursor-style): icon + label.
					"h-8 gap-2 rounded-lg bg-muted px-2.5 text-sm font-normal text-muted-foreground",
					"hover:bg-interactive-hover! hover:text-foreground active:bg-interactive-hover! [&_svg]:size-icon-sm!",
					"group-data-[collapsible=icon]:size-control-form! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:rounded-lg group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:p-0! group-data-[collapsible=icon]:hover:bg-interactive-hover!",
				)}
			>
				<Search strokeWidth={1.75} aria-hidden="true" />
				<span className="sidebar-expanded-chrome min-w-0 flex-1 truncate text-left leading-none group-data-[collapsible=icon]:hidden">
						{t("shell.search")}
				</span>
			</SidebarMenuButton>
		</SidebarMenuItem>
	);
}

function CreateProjectButton({
	hideTrigger = false,
	onCreateProject,
	onInitializeProject,
}: Pick<SidebarProps, "onCreateProject" | "onInitializeProject"> & { hideTrigger?: boolean }) {
	const { t } = useTranslation();
	// Single CreateProjectFlow owner for the sidebar: the header "+" stays mounted
	// (CSS-hidden when collapsed or on the empty start page) so it can own
	// openSignal for ⌘N on every shell route. The collapsed rail button below
	// reuses this flow via requestCreateProject().
	const createProjectNonce = useUiStore((state) => state.createProjectNonce);
	return (
		<CreateProjectFlow
			mode="choose"
			onCreateProject={onCreateProject}
			onInitializeProject={onInitializeProject}
			openSignal={createProjectNonce}
		>
			{({ disabled, choosePath, label }) => (
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							aria-label={t("shell.newProject")}
							className={cn(
								// No own hover fill — lives inside the Projects section hover pill.
								"grid size-icon-xl shrink-0 place-items-center rounded-sm text-passive transition-colors hover:text-foreground",
								hideTrigger && "hidden",
							)}
							disabled={disabled}
							onClick={choosePath}
							type="button"
						>
							<Plus className="size-icon-sm" aria-hidden="true" />
						</button>
					</TooltipTrigger>
					<TooltipContent>{label}</TooltipContent>
				</Tooltip>
			)}
		</CreateProjectFlow>
	);
}

function CreateProjectListItem() {
	const { t } = useTranslation();
	const requestCreateProject = useUiStore((state) => state.requestCreateProject);
	return (
		<SidebarMenuItem className="mb-px group-data-[collapsible=icon]:mb-0">
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						aria-label={t("shell.newProject")}
						className="grid h-control-board w-full place-items-center rounded-lg text-passive transition-colors hover:bg-interactive-hover hover:text-muted-foreground"
						onClick={() => requestCreateProject()}
						type="button"
					>
						<Plus className="size-icon-sm" aria-hidden="true" />
					</button>
				</TooltipTrigger>
				<TooltipContent side="right">{t("shell.newProject")}</TooltipContent>
			</Tooltip>
		</SidebarMenuItem>
	);
}
