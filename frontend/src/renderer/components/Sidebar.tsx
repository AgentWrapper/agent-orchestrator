import * as Dialog from "@radix-ui/react-dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import {
	ChevronRight,
	CheckCircle2,
	Folder,
	FolderPlus,
	GitPullRequest,
	LayoutDashboard,
	Moon,
	MoreVertical,
	Pencil,
	Plus,
	Search,
	Settings,
	Smartphone,
	Sun,
	Trash2,
	X,
	XCircle,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ImportFolderScan } from "../../preload";
import {
	attentionZone,
	newestActiveOrchestrator,
	sessionIsActive,
	type ProjectKind,
	type WorkspaceSession,
	type WorkspaceSummary,
	workerSessions,
} from "../types/workspace";
import { aoBridge } from "../lib/bridge";
import { workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { spawnOrchestrator } from "../lib/spawn-orchestrator";
import { renameSession } from "../lib/rename-session";
import { useEventsConnection } from "../hooks/useEventsConnection";
import { useResizable } from "../hooks/useResizable";
import { ConnectMobileModal } from "./ConnectMobileModal";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
	Sidebar as SidebarRoot,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarRail,
	SidebarMenuSub,
	SidebarMenuSubItem,
	SidebarTrigger,
	useSidebar,
} from "./ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { OrchestratorIcon } from "./icons";
import aoLogo from "../assets/ao-logo.png";
import { cn } from "../lib/utils";
import { useUiStore } from "../stores/ui-store";
import { CreateProjectAgentSheet, type CreateProjectAgentSelection } from "./CreateProjectAgentSheet";
import { Button } from "./ui/button";

// The macOS hiddenInset traffic lights and the fixed TitlebarNav overlay live
// in the full-width topbar's left inset (_shell renders the bar above the
// sidebar row); the sidebar itself starts below the 56px header, so its border
// never crosses the titlebar strip.
const isMac = typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(navigator.userAgent);
const noDragStyle = isMac ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined;

// Shared styling for the per-project hover action buttons (dashboard,
// orchestrator, kebab): a 20px square icon button that tints on hover, matching
// the old SidebarMenuAction footprint.
const HOVER_ACTION_CLASS =
	"grid size-5 shrink-0 place-items-center rounded-md text-passive transition-colors hover:bg-interactive-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-50 data-[state=open]:bg-interactive-hover data-[state=open]:text-foreground [&_svg]:size-[15px]";

// Mirrors the daemon's display-name cap (maxDisplayNameLen) and the spawn
// `--name` flag, so inline edits never round-trip a value the API would reject.
const MAX_DISPLAY_NAME_LEN = 20;
const SIDEBAR_DEFAULT_WIDTH = 240;
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 420;
const SIDEBAR_COLLAPSE_THRESHOLD = SIDEBAR_MIN_WIDTH;

type SidebarProps = {
	daemonStatus: { state: string; message?: string };
	underTopbar?: boolean;
	workspaceError?: string;
	workspaces: WorkspaceSummary[];
	onCreateProject: (input: { path: string; asWorkspace?: boolean } & CreateProjectAgentSelection) => Promise<void>;
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
		goPrs: () => void navigate({ to: "/prs" }),
		goGlobalSettings: () => void navigate({ to: "/settings" }),
		goSettings: (projectId: string) => void navigate({ to: "/projects/$projectId/settings", params: { projectId } }),
		goProject: (projectId: string) => void navigate({ to: "/projects/$projectId", params: { projectId } }),
		goSession: (projectId: string, sessionId: string) =>
			void navigate({ to: "/projects/$projectId/sessions/$sessionId", params: { projectId, sessionId } }),
	};
}

// 6px session dot: mirrors the board's status language so the sidebar can be
// scanned without opening the project board.
function SessionDot({ session }: { session: WorkspaceSession }) {
	const zone = attentionZone(session);
	return (
		<span
			aria-hidden="true"
			className={cn(
				"mt-px h-1.5 w-1.5 shrink-0 rounded-full",
				zone === "working" && "animate-status-pulse bg-working",
				zone === "action" && (session.status === "ci_failed" ? "bg-error" : "bg-warning"),
				zone === "pending" && "bg-passive",
				zone === "merge" && "bg-success",
				zone === "done" && "bg-passive",
			)}
		/>
	);
}

// Built on shadcn's sidebar primitives (components/ui/sidebar): the provider in
// _shell owns open state (synced to the ui-store) and `collapsible="icon"`
// replaces the old hand-rolled CollapsedRail — the same tree restyles itself
// via group-data-[collapsible=icon] into the 48px letter rail.
export function Sidebar({
	daemonStatus,
	underTopbar = true,
	workspaceError,
	workspaces,
	onCreateProject,
	onRemoveProject,
}: SidebarProps) {
	const selection = useSelection();
	const eventsConnection = useEventsConnection();
	const { state, setOpen } = useSidebar();
	const isCollapsed = state === "collapsed";
	const [expandedChromeVisible, setExpandedChromeVisible] = useState(!isCollapsed);
	const theme = useUiStore((s) => s.theme);
	const toggleTheme = useUiStore((s) => s.toggleTheme);

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

	// Connect Mobile pairing modal, opened from the Settings menu.
	const [mobileOpen, setMobileOpen] = useState(false);

	// Disclosure state: projects are expanded by default; a project id present in
	// this set is collapsed (sessions hidden).
	const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(() => new Set());
	const toggleCollapsed = (id: string) =>
		setCollapsedIds((prev) => {
			const next = new Set(prev);
			next.has(id) ? next.delete(id) : next.add(id);
			return next;
		});
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
	// which the provider forwards into shadcn's --sidebar-width.
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
		collapseBelow: SIDEBAR_COLLAPSE_THRESHOLD,
		onCollapse: () => setOpen(false),
		onExpand: () => setOpen(true),
	});

	return (
		// The container is fixed-positioned by the shadcn primitive; offset it
		// below the 56px shell topbar so the bar runs edge-to-edge above it
		// (same override as shadcn's header-above-sidebar block).
		<SidebarRoot
			collapsible="icon"
			data-expanded-chrome={expandedChromeVisible ? "visible" : "hidden"}
			className={cn("border-border", underTopbar ? "top-14 h-[calc(100svh-3.5rem)]!" : "top-0 h-svh!")}
		>
			<SidebarHeader className="gap-0 p-0 pl-2.5 pr-[7px] pt-3.5 group-data-[collapsible=icon]:px-1.5">
				{/* Brand (project-sidebar__brand); in the icon rail it becomes the old
            36px board button wrapping the 22px accent mark. */}
				<div className="flex shrink-0 items-center gap-2.5 px-2 pb-[18px] group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-1 group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:pb-2">
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								aria-label="Orchestrator board"
								className={cn(
									"grid h-[22px] w-[22px] shrink-0 place-items-center",
									"group-data-[collapsible=icon]:size-9 group-data-[collapsible=icon]:rounded-lg",
									selection.isHome
										? "group-data-[collapsible=icon]:bg-interactive-active"
										: "group-data-[collapsible=icon]:hover:bg-interactive-hover",
								)}
								onClick={selection.goHome}
								type="button"
							>
								<img src={aoLogo} alt="" aria-hidden="true" className="h-[22px] w-[22px] rounded-[6px] object-cover" />
							</button>
						</TooltipTrigger>
						<TooltipContent side="right" hidden={state !== "collapsed"}>
							Orchestrator board
						</TooltipContent>
					</Tooltip>
					{!isMac && (
						<Tooltip>
							<TooltipTrigger asChild>
								<SidebarTrigger
									aria-label="Expand sidebar"
									className="hidden size-9 shrink-0 rounded-lg text-passive hover:bg-interactive-hover hover:text-foreground group-data-[collapsible=icon]:grid [&_svg]:size-4"
								/>
							</TooltipTrigger>
							<TooltipContent side="right">Expand sidebar · ⌘B</TooltipContent>
						</Tooltip>
					)}
					<span className="sidebar-expanded-chrome min-w-0 flex-1 truncate text-[14px] font-bold tracking-[-0.015em] text-foreground group-data-[collapsible=icon]:hidden">
						Agent Orchestrator
					</span>
					{isNightly && (
						<span
							className="sidebar-expanded-chrome shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none group-data-[collapsible=icon]:hidden"
							style={{
								color: "var(--purple)",
								background: "color-mix(in srgb, var(--purple) 12%, transparent)",
							}}
						>
							nightly
						</span>
					)}
					{/* On macOS the toggle lives in the titlebar cluster instead. */}
					{!isMac && (
						<Tooltip>
							<TooltipTrigger asChild>
								<SidebarTrigger
									aria-label="Collapse sidebar"
									className="sidebar-expanded-chrome size-[18px] shrink-0 rounded-[4px] p-0 text-passive hover:bg-interactive-hover hover:text-foreground group-data-[collapsible=icon]:hidden [&_svg]:size-[15px]"
								/>
							</TooltipTrigger>
							<TooltipContent>Collapse sidebar · ⌘B</TooltipContent>
						</Tooltip>
					)}
				</div>
			</SidebarHeader>

			<SidebarContent className="gap-0 pl-2.5 pr-[7px] group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:px-1.5">
				<SidebarGroup className="p-0">
					{/* Section label (project-sidebar__nav-label) */}
					<div className="sidebar-expanded-chrome flex shrink-0 items-center justify-between px-2 pb-2 group-data-[collapsible=icon]:hidden">
						<SidebarGroupLabel className="h-auto rounded-none p-0 text-[10.5px] font-semibold uppercase tracking-[0.09em] text-passive">
							Projects
						</SidebarGroupLabel>
						<CreateProjectButton onCreateProject={onCreateProject} />
					</div>

					{/* Tree (project-sidebar__tree) */}
					<SidebarGroupContent>
						{workspaceError ? (
							<div className="sidebar-expanded-chrome px-2 py-3 group-data-[collapsible=icon]:hidden">
								<p className="text-[12px] text-foreground">Could not load projects.</p>
								<p className="mt-1 text-[11px] text-passive">{workspaceError}</p>
							</div>
						) : workspaces.length === 0 ? (
							<div className="sidebar-expanded-chrome px-2 py-3 group-data-[collapsible=icon]:hidden">
								<p className="text-[12px] text-passive">No projects yet.</p>
								<p className="mt-1 text-[11px] text-passive">
									Click <span className="text-foreground">+</span> above to register a repo or workspace.
								</p>
							</div>
						) : (
							<SidebarMenu className="gap-0 group-data-[collapsible=icon]:gap-1">
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
								{isCollapsed && <CreateProjectListItem onCreateProject={onCreateProject} />}
							</SidebarMenu>
						)}
					</SidebarGroupContent>
				</SidebarGroup>
			</SidebarContent>

			{/* Footer (project-sidebar__footer) — single Settings menu. Divergence
          (user-requested 2026-06-10): the trigger stretches the full row width
          (flex-1) with a uniform 7px footer inset on all sides (reference uses
          12px top, 0 bottom, content-hugging button). The icon rail keeps the
          icon-only settings action plus expand toggle (off macOS). */}
			<SidebarFooter className="relative mt-auto min-h-[51px] gap-0 overflow-hidden border-t border-border p-[7px] transition-[padding] duration-200 ease-linear group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:px-1.5">
				<div className="sidebar-expanded-chrome relative flex min-h-[37px] w-full min-w-[186px] items-center transition-[opacity,transform] duration-150 ease-out group-data-[collapsible=icon]:pointer-events-none group-data-[collapsible=icon]:-translate-x-2 group-data-[collapsible=icon]:opacity-0">
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<button
								aria-label="Settings"
								className="flex flex-1 items-center justify-start gap-2.5 rounded-md p-2 text-[13px] font-medium text-passive transition-colors hover:bg-interactive-hover hover:text-foreground data-[state=open]:bg-interactive-hover data-[state=open]:text-foreground [&_svg]:size-[15px] [&_svg]:text-passive"
								type="button"
							>
								<Settings aria-hidden="true" />
								<span className="tracking-[-0.01em]">Settings</span>
							</button>
						</DropdownMenuTrigger>
						<DropdownMenuContent
							align="start"
							className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-0"
							side="top"
						>
							<DropdownMenuItem onSelect={toggleTheme}>
								{theme === "dark" ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
								{theme === "dark" ? "Light mode" : "Dark mode"}
							</DropdownMenuItem>
							<DropdownMenuSeparator />
							<DropdownMenuItem onSelect={selection.goPrs}>
								<GitPullRequest aria-hidden="true" />
								Pull requests
							</DropdownMenuItem>
							<DropdownMenuItem disabled>
								<Search aria-hidden="true" />
								Search
								<DropdownMenuShortcut>⌘K</DropdownMenuShortcut>
							</DropdownMenuItem>
							<DropdownMenuSeparator />
							<DropdownMenuItem onSelect={() => setTimeout(() => setMobileOpen(true), 0)}>
								<Smartphone aria-hidden="true" />
								Connect Mobile
							</DropdownMenuItem>
							<DropdownMenuSeparator />
							{selection.activeProjectId && (
								<DropdownMenuItem onSelect={() => selection.goSettings(selection.activeProjectId!)}>
									<Settings aria-hidden="true" />
									Project settings
								</DropdownMenuItem>
							)}
							<DropdownMenuItem onSelect={selection.goGlobalSettings}>
								<Settings aria-hidden="true" />
								Global settings
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
					<Tooltip>
						<TooltipTrigger asChild>
							<span
								aria-label={`Daemon ${daemonStatus.state}`}
								className={cn(
									"absolute right-1.5 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full",
									daemonStatus.state === "ready" && eventsConnection !== "disconnected" ? "bg-success" : "bg-amber",
								)}
							/>
						</TooltipTrigger>
						<TooltipContent side="top">
							daemon {daemonStatus.state}
							{eventsConnection === "disconnected" && " · events offline"}
						</TooltipContent>
					</Tooltip>
				</div>
				<div className="pointer-events-none absolute inset-x-1.5 top-[7px] flex min-h-[37px] flex-col items-center justify-center gap-1 opacity-0 transition-opacity duration-150 ease-out group-data-[collapsible=icon]:pointer-events-auto group-data-[collapsible=icon]:opacity-100">
					<DropdownMenu>
						<Tooltip>
							<TooltipTrigger asChild>
								<DropdownMenuTrigger asChild>
									<button
										aria-label="Settings"
										className="grid size-9 place-items-center rounded-lg text-passive transition-colors hover:bg-interactive-hover hover:text-foreground [&_svg]:size-4"
										type="button"
									>
										<Settings aria-hidden="true" />
									</button>
								</DropdownMenuTrigger>
							</TooltipTrigger>
							<TooltipContent side="right">Settings</TooltipContent>
						</Tooltip>
						<DropdownMenuContent align="start" className="min-w-0" side="top">
							<DropdownMenuItem onSelect={toggleTheme}>
								{theme === "dark" ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
								{theme === "dark" ? "Light mode" : "Dark mode"}
							</DropdownMenuItem>
							<DropdownMenuSeparator />
							<DropdownMenuItem onSelect={selection.goPrs}>
								<GitPullRequest aria-hidden="true" />
								Pull requests
							</DropdownMenuItem>
							<DropdownMenuItem disabled>
								<Search aria-hidden="true" />
								Search
								<DropdownMenuShortcut>⌘K</DropdownMenuShortcut>
							</DropdownMenuItem>
							<DropdownMenuSeparator />
							<DropdownMenuItem onSelect={() => setTimeout(() => setMobileOpen(true), 0)}>
								<Smartphone aria-hidden="true" />
								Connect Mobile
							</DropdownMenuItem>
							<DropdownMenuSeparator />
							{selection.activeProjectId && (
								<DropdownMenuItem onSelect={() => selection.goSettings(selection.activeProjectId!)}>
									<Settings aria-hidden="true" />
									Project settings
								</DropdownMenuItem>
							)}
							<DropdownMenuItem onSelect={selection.goGlobalSettings}>
								<Settings aria-hidden="true" />
								Global settings
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</SidebarFooter>

			<div
				className="resize-handle resize-handle--right group-data-[collapsible=icon]:hidden"
				onPointerDown={onResizePointerDown}
				onDoubleClick={onResizeDoubleClick}
				style={noDragStyle}
			/>
			<SidebarRail
				aria-label="Expand sidebar"
				className="group-data-[state=expanded]:hidden hover:after:bg-transparent"
				onClick={() => setOpen(true)}
				onPointerDown={onCollapsedResizePointerDown}
			/>

			<ConnectMobileModal open={mobileOpen} onOpenChange={setMobileOpen} />
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
	const projectActive = selection.activeProjectId === workspace.id && !selection.activeSessionId;
	const queryClient = useQueryClient();
	const [removeError, setRemoveError] = useState<string | null>(null);
	const [isRemoving, setIsRemoving] = useState(false);
	const [isSpawning, setIsSpawning] = useState(false);
	const restartingProjectIds = useUiStore((state) => state.restartingProjectIds);
	const isProjectRestarting = restartingProjectIds.has(workspace.id);
	// Live workers only: merged/terminated sessions leave the sidebar and stay
	// reachable through the board's Done / Terminated bar (SessionsBoard).
	const sessions = workerSessions(workspace.sessions).filter(sessionIsActive);
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

	const removeProject = async () => {
		setRemoveError(null);
		const confirmed = window.confirm(
			`Remove project ${workspace.name}? This stops its live sessions and removes it from the sidebar, but keeps the repository folder and stored history on disk.`,
		);
		if (!confirmed) return;

		setIsRemoving(true);
		try {
			await onRemoveProject(workspace.id);
			// The route for a removed project no longer resolves; fall back home.
			if (selection.activeProjectId === workspace.id) selection.goHome();
		} catch (err) {
			const message = err instanceof Error ? err.message : "Could not remove project";
			setRemoveError(message);
			window.alert(message);
		} finally {
			setIsRemoving(false);
		}
	};

	return (
		<SidebarMenuItem className="mb-px group-data-[collapsible=icon]:mb-0">
			{/* project-sidebar__proj-row */}
			<SidebarMenuButton
				aria-current={projectActive ? "page" : undefined}
				aria-expanded={expanded}
				isActive={projectActive}
				onClick={onProjectClick}
				tooltip={workspace.name}
				className={cn(
					"relative h-9 gap-[9px] rounded-[5px] px-1.5 py-0 text-[13px] font-medium text-muted-foreground transition-[background-color,padding,color]",
					"before:absolute before:top-2 before:bottom-2 before:left-0 before:w-px before:rounded-full before:bg-transparent",
					"hover:bg-interactive-hover hover:text-foreground active:bg-interactive-hover active:text-foreground",
					"data-[active=true]:bg-interactive-active data-[active=true]:font-semibold data-[active=true]:text-foreground data-[active=true]:before:bg-accent",
					// Always reserve room for the action cluster (dashboard,
					// orchestrator, kebab) — icons are always visible, not hover-gated.
					"pr-[84px]",
					// Icon rail: the old 36px letter tile.
					"group-data-[collapsible=icon]:size-9! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:rounded-lg group-data-[collapsible=icon]:p-0! group-data-[collapsible=icon]:font-semibold",
				)}
			>
				<ChevronRight
					className={cn(
						"h-[9px]! w-[9px]! shrink-0 text-passive transition-transform group-data-[collapsible=icon]:hidden",
						expanded && "rotate-90",
					)}
					strokeWidth={2.5}
					aria-hidden="true"
				/>
				<span className="hidden group-data-[collapsible=icon]:block">{workspace.name.charAt(0).toUpperCase()}</span>
				<span className="sidebar-expanded-chrome min-w-0 flex-1 truncate group-data-[collapsible=icon]:hidden">
					{workspace.name}
				</span>
				<span className="hidden h-4 min-w-4 shrink-0 place-items-center rounded bg-interactive-hover px-1 font-mono text-[10px] leading-none text-passive">
					{sessions.length}
				</span>
			</SidebarMenuButton>
			{/* Per-project actions: dashboard board, orchestrator, and a kebab
			menu. Always visible (not hover-gated) to avoid CSS :hover group
			propagation issues in Electron's Chromium. Hidden in the icon rail. */}
			<div
				className={cn(
					"sidebar-expanded-chrome absolute top-0 right-1 z-10 flex h-9 items-center gap-px",
					"group-data-[collapsible=icon]:hidden",
				)}
			>
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							aria-label={`Open ${workspace.name} dashboard`}
							className={HOVER_ACTION_CLASS}
							onClick={() => selection.goProject(workspace.id)}
							type="button"
						>
							<LayoutDashboard aria-hidden="true" />
						</button>
					</TooltipTrigger>
					<TooltipContent>Dashboard</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							aria-label={orchestrator ? `Open ${workspace.name} orchestrator` : `Spawn ${workspace.name} orchestrator`}
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
							? "Restarting…"
							: isSpawning
								? "Spawning…"
								: orchestrator
									? "Orchestrator"
									: "Spawn orchestrator"}
					</TooltipContent>
				</Tooltip>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<button aria-label={`Project actions for ${workspace.name}`} className={HOVER_ACTION_CLASS} type="button">
							<MoreVertical aria-hidden="true" />
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent side="right" align="start" className="min-w-44">
						<DropdownMenuItem onSelect={() => selection.goSettings(workspace.id)}>
							<Settings aria-hidden="true" />
							Project settings
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							className="text-destructive focus:text-destructive [&_svg]:text-destructive"
							disabled={isRemoving}
							onSelect={() => void removeProject()}
						>
							<Trash2 aria-hidden="true" />
							Remove project
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
			{removeError && (
				<span className="sr-only" role="status">
					{removeError}
				</span>
			)}
			{/* project-sidebar__sessions: indented under the project parent so worker
          sessions read as children without adding a persistent guide rail. */}
			{expanded && sessions.length > 0 && (
				<SidebarMenuSub className="sidebar-expanded-chrome mx-0 ml-[18px] translate-x-0 gap-0 border-l-0 px-0 py-1 pl-2.5">
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
		</SidebarMenuItem>
	);
}

// One worker-session row. Reads as a link by default; a hover-revealed pencil
// flips the label into an inline input (Enter/blur saves, Escape cancels) that
// persists through the daemon rename endpoint, so the new name survives reload.
function SessionRow({ session, active, onOpen }: { session: WorkspaceSession; active: boolean; onOpen: () => void }) {
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
			<SidebarMenuSubItem>
				<div className="relative flex h-auto w-full items-center gap-[9px] rounded-[4px] py-[5px] pl-2.5 pr-1.5">
					<SessionDot session={session} />
					<input
						aria-label={`Rename ${session.title}`}
						autoFocus
						className="min-w-0 flex-1 rounded-[3px] border border-accent bg-transparent px-1 py-px text-[12px] text-foreground outline-none focus-visible:ring-1 focus-visible:ring-accent"
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
		<SidebarMenuSubItem>
			<button
				aria-current={active ? "page" : undefined}
				aria-label={`Open ${session.title}`}
				className={cn(
					"relative flex h-auto w-full items-center gap-[9px] rounded-[4px] py-[5px] pl-2.5 pr-7 text-left outline-hidden transition-[color]",
					"before:absolute before:top-1.5 before:bottom-1.5 before:left-0 before:w-px before:rounded-full before:bg-transparent",
					"hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring",
					active && "text-foreground before:bg-accent",
				)}
				onClick={onOpen}
				type="button"
			>
				<SessionDot session={session} />
				<span className="min-w-0 flex-1">
					<span className={cn("block truncate text-[12px]", active ? "text-foreground" : "text-muted-foreground")}>
						{session.title}
					</span>
				</span>
			</button>
			{/* Pencil reveals on row hover/focus (named group on SidebarMenuSubItem);
			it sits beside the row button rather than nested inside it. */}
			<button
				aria-label={`Rename ${session.title}`}
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

function CreateProjectButton({ onCreateProject }: Pick<SidebarProps, "onCreateProject">) {
	return (
		<CreateProjectFlow onCreateProject={onCreateProject}>
			{({ disabled, choosePath, label }) => (
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							aria-label="New project"
							className="grid h-[18px] w-[18px] place-items-center rounded-[4px] text-passive transition-colors hover:bg-interactive-hover hover:text-muted-foreground"
							disabled={disabled}
							onClick={choosePath}
							type="button"
						>
							<Plus className="h-[13px] w-[13px]" aria-hidden="true" />
						</button>
					</TooltipTrigger>
					<TooltipContent>{label}</TooltipContent>
				</Tooltip>
			)}
		</CreateProjectFlow>
	);
}

function CreateProjectListItem({ onCreateProject }: Pick<SidebarProps, "onCreateProject">) {
	return (
		<CreateProjectFlow onCreateProject={onCreateProject}>
			{({ disabled, choosePath, label }) => (
				<SidebarMenuItem className="mb-px group-data-[collapsible=icon]:mb-0">
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								aria-label="New project"
								className="grid h-9 w-full place-items-center rounded-[5px] text-passive transition-colors hover:bg-interactive-hover hover:text-muted-foreground"
								disabled={disabled}
								onClick={choosePath}
								type="button"
							>
								<Plus className="h-[13px] w-[13px]" aria-hidden="true" />
							</button>
						</TooltipTrigger>
						<TooltipContent side="right">{label}</TooltipContent>
					</Tooltip>
				</SidebarMenuItem>
			)}
		</CreateProjectFlow>
	);
}

function CreateProjectFlow({
	children,
	onCreateProject,
}: Pick<SidebarProps, "onCreateProject"> & {
	children: (state: { choosePath: () => void; disabled: boolean; label: string }) => ReactNode;
}) {
	const [error, setError] = useState<string | null>(null);
	const [modePickerOpen, setModePickerOpen] = useState(false);
	const [folderPickerOpen, setFolderPickerOpen] = useState(false);
	const [selectedKind, setSelectedKind] = useState<ProjectKind>("single_repo");
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const [validationScan, setValidationScan] = useState<ImportFolderScan | null>(null);
	const [isChoosingPath, setIsChoosingPath] = useState(false);
	const [isCreating, setIsCreating] = useState(false);

	const openFolderStep = (kind: ProjectKind) => {
		setError(null);
		setValidationScan(null);
		setSelectedKind(kind);
		setModePickerOpen(false);
		window.requestAnimationFrame(() => setFolderPickerOpen(true));
	};

	const choosePath = async () => {
		setError(null);
		setIsChoosingPath(true);
		try {
			const path = await aoBridge.app.chooseDirectory(
				selectedKind === "workspace" ? "Choose a workspace folder" : "Choose a project repository",
			);
			if (path) {
				setValidationScan(null);
				setSelectedPath(path);
				setFolderPickerOpen(false);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not add project");
		} finally {
			setIsChoosingPath(false);
		}
	};

	const createProject = async (selection: CreateProjectAgentSelection) => {
		if (!selectedPath) return;
		setError(null);
		setIsCreating(true);
		try {
			await onCreateProject({ path: selectedPath, asWorkspace: selectedKind === "workspace", ...selection });
			setSelectedPath(null);
		} catch (err) {
			const message = err instanceof Error ? err.message : "Could not add project";
			setError(message);
			if (shouldScanCreateFailure(message)) {
				try {
					const scan = await aoBridge.app.scanImportFolder({
						path: selectedPath,
						mode: selectedKind === "workspace" ? "workspace" : "project",
					});
					setValidationScan(scan);
				} catch {
					setValidationScan({ path: selectedPath, repos: [] });
				}
			} else {
				setValidationScan(null);
			}
			setSelectedPath(null);
			setFolderPickerOpen(true);
		} finally {
			setIsCreating(false);
		}
	};

	const label = isChoosingPath ? "Opening..." : isCreating ? "Creating..." : "New project";

	return (
		<>
			{children({ choosePath: () => setModePickerOpen(true), disabled: isChoosingPath || isCreating, label })}
			<CreateProjectModeDialog
				disabled={isChoosingPath || isCreating}
				open={modePickerOpen}
				onOpenChange={(open) => !isChoosingPath && !isCreating && setModePickerOpen(open)}
				onSelect={openFolderStep}
			/>
			<CreateProjectFolderDialog
				disabled={isChoosingPath || isCreating}
				error={error}
				kind={selectedKind}
				open={folderPickerOpen}
				scan={validationScan}
				onBack={() => {
					setError(null);
					setValidationScan(null);
					setFolderPickerOpen(false);
					window.requestAnimationFrame(() => setModePickerOpen(true));
				}}
				onChooseFolder={() => void choosePath()}
				onOpenChange={(open) => {
					if (!isChoosingPath && !isCreating) {
						setFolderPickerOpen(open);
						if (!open) {
							setError(null);
							setValidationScan(null);
						}
					}
				}}
			/>
			<CreateProjectAgentSheet
				error={error}
				isCreating={isCreating}
				kind={selectedKind}
				onOpenChange={(open) => {
					if (!open) {
						setSelectedPath(null);
						if (!folderPickerOpen) setError(null);
					}
				}}
				onSubmit={createProject}
				open={selectedPath !== null}
				path={selectedPath}
			/>
		</>
	);
}

function shouldScanCreateFailure(message: string): boolean {
	if (/daemon|server|conflict|already exists|not ready|start|orchestrator|permission denied/i.test(message))
		return false;
	if (/\b(?:PATH|ID)_ALREADY_REGISTERED\b/i.test(message) || /already registered/i.test(message)) return false;
	return /workspace|repo|repository|git|path|folder|worktree|bare|branch|commit|remote/i.test(message);
}

function CreateProjectModeDialog({
	disabled,
	onOpenChange,
	onSelect,
	open,
}: {
	disabled: boolean;
	onOpenChange: (open: boolean) => void;
	onSelect: (kind: ProjectKind) => void;
	open: boolean;
}) {
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-50 bg-black/55 data-[state=open]:animate-overlay-in" />
				<Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[min(720px,calc(100svh-24px))] w-[min(680px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-border bg-popover p-0 text-popover-foreground shadow-xl data-[state=open]:animate-modal-in">
					<div className="flex shrink-0 items-start justify-between gap-4 px-4 pb-3 pt-4 sm:px-6 sm:pb-4 sm:pt-5">
						<div className="min-w-0">
							<Dialog.Title className="text-[18px] font-semibold text-foreground">
								Import to Agent Orchestrator
							</Dialog.Title>
							<Dialog.Description className="mt-1 text-[13px] font-medium text-muted-foreground">
								What are you importing?
							</Dialog.Description>
						</div>
						<Dialog.Close asChild>
							<button
								type="button"
								className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-surface hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
								aria-label="Close new project dialog"
								disabled={disabled}
							>
								<X className="size-4" aria-hidden="true" />
							</button>
						</Dialog.Close>
					</div>
					<div className="grid min-h-0 gap-3 overflow-y-auto px-4 pb-4 sm:grid-cols-2 sm:px-6 sm:pb-6">
						<ProjectModeButton
							description="Several Git repos that live under one parent folder."
							disabled={disabled}
							kind="workspace"
							onClick={() => onSelect("workspace")}
						/>
						<ProjectModeButton
							description="A single Git repository — one codebase, tracked in one repo."
							disabled={disabled}
							kind="single_repo"
							onClick={() => onSelect("single_repo")}
						/>
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

function ProjectModeButton({
	description,
	disabled,
	kind,
	onClick,
}: {
	description: string;
	disabled: boolean;
	kind: ProjectKind;
	onClick: () => void;
}) {
	const isWorkspace = kind === "workspace";
	return (
		<button
			type="button"
			aria-label={isWorkspace ? "Workspace" : "Project"}
			className="flex min-h-[176px] w-full flex-col justify-end rounded-lg border border-border bg-card px-4 py-4 text-left transition-colors hover:bg-background focus-visible:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-50 sm:min-h-[220px] sm:px-5 sm:py-5"
			disabled={disabled}
			onClick={onClick}
		>
			<span className="mb-3 flex min-h-[70px] w-full items-center justify-center sm:mb-4 sm:min-h-[92px]">
				{isWorkspace ? (
					<span className="mx-auto w-[min(210px,100%)] rounded-lg border border-dashed border-border px-3 py-3">
						<span className="mx-auto mb-2 flex w-[min(160px,100%)] items-center gap-2 font-mono text-[11px] font-semibold text-muted-foreground">
							<Folder className="size-3.5" aria-hidden="true" />
							my-workspace/
						</span>
						{["web-app", "api-server", "shared-libs"].map((repo) => (
							<span
								key={repo}
								className="mx-auto mb-1.5 flex w-[min(170px,100%)] items-center gap-2 rounded-md bg-background px-2.5 py-1.5 font-mono text-[12px] font-semibold text-foreground last:mb-0"
							>
								<span className="size-1.5 rounded-full bg-success" aria-hidden="true" />
								{repo}
							</span>
						))}
					</span>
				) : (
					<span className="mx-auto max-w-full rounded-lg border border-border bg-background px-4 py-3 font-mono text-[12px] font-semibold text-foreground sm:px-5 sm:py-3.5 sm:text-[13px]">
						<span className="mr-2 inline-block size-1.5 rounded-full bg-success" aria-hidden="true" />
						web-app <span className="px-2 text-muted-foreground">·</span>
						<span className="text-muted-foreground">main</span>
					</span>
				)}
			</span>
			<span className="block text-[15px] font-semibold text-foreground sm:text-[16px]">
				{isWorkspace ? "Workspace" : "Project"}
			</span>
			<span className="mt-2 block text-[12px] leading-5 text-muted-foreground sm:min-h-[40px] sm:text-[13px]">
				{description}
			</span>
			<span className="mt-3 font-mono text-[12px] font-semibold text-passive">
				<span className="mr-2 text-passive">•</span>
				{isWorkspace ? "Multiple repositories" : "One repository"}
			</span>
		</button>
	);
}

function CreateProjectFolderDialog({
	disabled,
	error,
	kind,
	onBack,
	onChooseFolder,
	onOpenChange,
	open,
	scan,
}: {
	disabled: boolean;
	error: string | null;
	kind: ProjectKind;
	onBack: () => void;
	onChooseFolder: () => void;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	scan: ImportFolderScan | null;
}) {
	const isWorkspace = kind === "workspace";
	const failedRepos = scan?.repos.filter((repo) => repo.status === "error" || !repo.hasRemote) ?? [];
	const hasScan = scan !== null;
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 z-50 bg-black/55 data-[state=open]:animate-overlay-in" />
				<Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[min(640px,calc(100svh-24px))] w-[min(640px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-border bg-popover p-0 text-popover-foreground shadow-xl data-[state=open]:animate-modal-in">
					<div className="flex shrink-0 items-start gap-3 border-b border-border px-4 py-4 sm:gap-4 sm:px-6 sm:py-5">
						<button
							type="button"
							className="grid size-8 shrink-0 place-items-center rounded-lg border border-border text-muted-foreground transition hover:bg-surface hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
							aria-label="Back to import type"
							disabled={disabled}
							onClick={onBack}
						>
							<ChevronRight className="size-4 rotate-180" aria-hidden="true" />
						</button>
						<div className="min-w-0 flex-1">
							<Dialog.Title className="text-[18px] font-semibold text-foreground">
								{isWorkspace ? "Import workspace" : "Import project"}
							</Dialog.Title>
							<Dialog.Description className="mt-1 max-w-[520px] text-[13px] font-medium leading-5 text-muted-foreground">
								{isWorkspace
									? "Pick a folder that contains your Git repositories. Each repo inside it joins the workspace."
									: "Import a single Git repository as one project."}
							</Dialog.Description>
						</div>
						<Dialog.Close asChild>
							<button
								type="button"
								className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-surface hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
								aria-label="Close import dialog"
								disabled={disabled}
							>
								<X className="size-4" aria-hidden="true" />
							</button>
						</Dialog.Close>
					</div>
					<div className="min-h-0 overflow-y-auto px-4 py-4 sm:px-6 sm:py-6">
						{hasScan ? (
							<div className="space-y-4">
								<div className="flex items-center gap-3 rounded-lg border border-border bg-background px-4 py-3">
									<Folder className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
									<div className="min-w-0 flex-1">
										<div className="truncate font-mono text-[14px] font-semibold text-foreground">
											{displayImportPath(scan.path)}
										</div>
										<div className="mt-0.5 text-[12px] text-muted-foreground">
											{isWorkspace ? "Workspace root" : "Project folder"}
										</div>
									</div>
									<Button type="button" variant="outline" disabled={disabled} onClick={onChooseFolder}>
										Change
									</Button>
								</div>

								{error && (
									<div className="rounded-lg border border-destructive/40 bg-destructive/10">
										<div className="border-b border-destructive/30 px-4 py-3 font-mono text-[12px] font-semibold uppercase tracking-[0.12em] text-destructive">
											<span className="mr-2 inline-block size-2 rounded-full bg-destructive" aria-hidden="true" />
											Import failed · {isWorkspace ? "workspace" : "project"} not registered
										</div>
										<div className="px-4 py-3 text-[12px] leading-5 text-destructive">{error}</div>
										{failedRepos.length > 0 && (
											<div className="border-t border-destructive/30">
												{failedRepos.map((repo) => (
													<ImportRepoRow key={repo.path} repo={repo} failed />
												))}
											</div>
										)}
									</div>
								)}

								{scan.repos
									.filter((repo) => repo.status !== "error" && repo.hasRemote)
									.map((repo) => (
										<div key={repo.path} className="rounded-lg border border-border bg-background">
											<ImportRepoRow repo={repo} />
										</div>
									))}

								{scan.repos.length === 0 && (
									<div className="rounded-lg border border-border bg-background px-4 py-4 text-[12px] text-muted-foreground">
										No repositories detected in this folder.
									</div>
								)}
							</div>
						) : (
							<button
								type="button"
								className="flex min-h-[132px] w-full flex-col items-center justify-center rounded-lg border border-dashed border-border bg-background px-4 py-5 text-center transition-colors hover:bg-surface disabled:pointer-events-none disabled:opacity-50 sm:min-h-[160px] sm:px-5 sm:py-6"
								disabled={disabled}
								onClick={onChooseFolder}
							>
								<span className="mb-4 grid size-11 place-items-center rounded-xl bg-card text-muted-foreground">
									<FolderPlus className="size-5" aria-hidden="true" />
								</span>
								<span className="text-[15px] font-semibold text-foreground">
									{isWorkspace ? "Choose a folder" : "Choose a project folder"}
								</span>
								<span className="mt-2 max-w-full text-pretty text-[12px] text-muted-foreground sm:text-[13px]">
									{isWorkspace
										? "Opens your system file picker — pick the folder that holds your repos"
										: "Opens your system file picker — select one repo folder"}
								</span>
							</button>
						)}
						{error && !hasScan && (
							<div
								className={cn(
									"mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] leading-5 text-destructive",
								)}
							>
								{error}
							</div>
						)}
					</div>
					<div className="flex shrink-0 flex-col gap-3 border-t border-border px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
						<p className="text-[12px] font-medium text-muted-foreground">
							{hasScan && failedRepos.length > 0
								? `Resolve ${failedRepos.length} failed ${failedRepos.length === 1 ? "repository" : "repositories"} to continue`
								: isWorkspace
									? "No repositories to import"
									: "No project selected"}
						</p>
						<div className="flex flex-wrap items-center justify-end gap-2 sm:gap-3">
							<Button type="button" variant="outline" disabled={disabled} onClick={() => onOpenChange(false)}>
								Cancel
							</Button>
							<Button type="button" variant="primary" disabled>
								{isWorkspace ? "Import workspace" : "Import project"}
							</Button>
						</div>
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

function ImportRepoRow({ failed = false, repo }: { failed?: boolean; repo: ImportFolderScan["repos"][number] }) {
	return (
		<div className="flex items-center gap-3 px-4 py-3">
			{failed ? (
				<XCircle className="size-5 shrink-0 text-destructive" aria-hidden="true" />
			) : (
				<CheckCircle2 className="size-5 shrink-0 text-success" aria-hidden="true" />
			)}
			<div className="min-w-0 flex-1">
				<div className="truncate text-[14px] font-semibold text-foreground">{repo.name}</div>
				<div className="mt-0.5 truncate font-mono text-[12px] text-muted-foreground">
					{displayImportPath(repo.path)}
				</div>
			</div>
			<div
				className={cn(
					"hidden max-w-[260px] shrink-0 truncate text-right font-mono text-[12px] sm:block",
					failed ? "text-muted-foreground" : "text-muted-foreground",
				)}
			>
				{failed ? (repo.reason ?? "Repository cannot be imported") : `${repo.branch} ${remoteDisplay(repo.remote)}`}
			</div>
		</div>
	);
}

function displayImportPath(value: string) {
	return value.replace(/^\/Users\/[^/]+/, "~");
}

function remoteDisplay(remote: string) {
	const ssh = remote.match(/^[^@]+@([^:]+):(.+)$/);
	if (ssh?.[1] && ssh[2]) return `${ssh[1]}/${ssh[2].replace(/\.git$/, "")}`;
	try {
		const url = new URL(remote);
		return `${url.host}${url.pathname.replace(/\.git$/, "")}`;
	} catch {
		return remote.replace(/^https?:\/\//, "").replace(/\.git$/, "");
	}
}
