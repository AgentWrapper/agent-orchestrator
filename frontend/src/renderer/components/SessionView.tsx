import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "@tanstack/react-router";
import { motion } from "motion/react";
import { BrowserPanelView, useBrowserAnnotationQueue } from "./BrowserPanel";
import { CenterPane } from "./CenterPane";
import { SessionFilesView } from "./SessionFilesView";
import { SessionInspector } from "./SessionInspector";
import { ShellTopbar } from "./ShellTopbar";
import { useResolvedTheme, useUiStore, type InspectorView } from "../stores/ui-store";
import { useShell } from "../lib/shell-context";
import { useBrowserView } from "../hooks/useBrowserView";
import {
	useCloseShellTerminal,
	useOpenShellTerminal,
	useRenameShellTerminal,
	useShellTerminals,
} from "../hooks/useShellTerminals";
import { useWorkspaceQuery } from "../hooks/useWorkspaceQuery";
import { hidesShellTopbar } from "../lib/platform";
import { isOrchestratorSession, sessionIsActive, workerSessions, type WorkspaceSession } from "../types/workspace";
import type { TerminalTarget } from "../types/terminal";
import { matchesRendererShortcut } from "../stores/keybindings-store";

const INSPECTOR_WIDTH = 360;
const inspectorSpring = { type: "spring", stiffness: 420, damping: 40, mass: 0.6 } as const;
const shellTopbarHiddenByPlatform = hidesShellTopbar();
const emptySessionTabIds: string[] = [];


function previewRevealKey(previewUrl?: string, previewRevision?: number): string {
	const target = previewUrl?.trim();
	if (!target) return "";
	if (typeof previewRevision === "number") return `revision:${previewRevision}`;
	return `url:${target}`;
}

type SessionViewProps = {
	sessionId: string;
	tabOwnerSessionId?: string;
};

// The session detail screen: terminal + inspector rail. On Win/Linux the shell
// owns ShellTopbar above this view; when the platform hides the shell topbar
// (macOS), the same topbar mounts here so it still spans the framed panel.
// SessionInspector owns its tabs and persistent collapse control.
// Rendered by both the project-scoped and cross-project session routes.
// TerminalPane owns the terminal lifetime and remounts by terminal handle so
// each session gets a clean xterm/mux binding.
//
// The split is shadcn's resizable (react-resizable-panels v4) with a fully
// collapsible inspector: the panel is `collapsible` and driven to 0% via the
// imperative API from the ui-store (topbar button / ⌘⇧B), animated by the
// flex-grow transition in styles.css. The closed-only reopen button lives in
// ShellTopbar so a full-height rail is not required. Content keeps a stable
// min-width inside the clipped panel so nothing reflows mid-animation; split
// width persists.
export function SessionView({ sessionId, tabOwnerSessionId }: SessionViewProps) {
	const navigate = useNavigate();
	const workspaceQuery = useWorkspaceQuery();
	const workspaces = workspaceQuery.data ?? [];
	const theme = useResolvedTheme();
	const isInspectorOpen = useUiStore((state) => state.inspectorSessions[sessionId]?.isOpen ?? true);
	const inspectorView = useUiStore((state) => state.inspectorSessions[sessionId]?.view ?? "summary");
	const setInspectorOpenForSession = useUiStore((state) => state.setInspectorOpen);
	const toggleInspector = useUiStore((state) => state.toggleInspector);
	const setInspectorViewForSession = useUiStore((state) => state.setInspectorView);
	const markInspectorPreviewSeen = useUiStore((state) => state.markInspectorPreviewSeen);
	const setBrowserUnseen = useUiStore((state) => state.setBrowserUnseen);
	const { daemonStatus } = useShell();
	const [terminalTarget, setTerminalTarget] = useState<TerminalTarget>({
		kind: "worker",
	});
	const [browserPoppedOut, setBrowserPoppedOut] = useState(false);
	const [filesPoppedOut, setFilesPoppedOut] = useState(false);

	const session = workspaces.flatMap((workspace) => workspace.sessions).find((s) => s.id === sessionId);
	const allSessions = workspaces.flatMap((workspace) => workspace.sessions);
	const tabOwnerSession = allSessions.find((candidate) => candidate.id === tabOwnerSessionId) ?? session;
	const ownerSessionId = tabOwnerSession?.id ?? sessionId;
	const storedSessionTabIds = useUiStore((state) => state.sessionTabsByOwner[ownerSessionId] ?? emptySessionTabIds);
	const addSessionTab = useUiStore((state) => state.addSessionTab);
	const removeSessionTab = useUiStore((state) => state.removeSessionTab);
	const availableSessions = workspaces.flatMap((workspace) =>
		workerSessions(workspace.sessions).filter((candidate) => candidate.isTerminated !== true),
	);
	const projectSessions = tabOwnerSession
		? [
				tabOwnerSession,
				...storedSessionTabIds
					.map((tabId) => allSessions.find((candidate) => candidate.id === tabId))
					.filter((projectSession): projectSession is WorkspaceSession =>
						Boolean(projectSession && projectSession.isTerminated !== true && projectSession.id !== tabOwnerSession.id),
					),
			]
		: [];
	if (session && !projectSessions.some((projectSession) => projectSession.id === session.id)) {
		projectSessions.push(session);
	}
	const selectProjectSession = useCallback(
		(projectSession: WorkspaceSession) => {
			void navigate({
				to: "/projects/$projectId/sessions/$sessionId",
				params: {
					projectId: projectSession.workspaceId,
					sessionId: projectSession.id,
				},
				search: projectSession.id === ownerSessionId ? {} : { tabOwner: ownerSessionId },
			});
		},
		[navigate, ownerSessionId],
	);
	const addProjectSession = useCallback(
		(projectSession: WorkspaceSession) => {
			addSessionTab(ownerSessionId, projectSession.id);
			selectProjectSession(projectSession);
		},
		[addSessionTab, ownerSessionId, selectProjectSession],
	);
	const closeProjectSession = useCallback(
		(projectSession: WorkspaceSession) => {
			removeSessionTab(ownerSessionId, projectSession.id);
			if (projectSession.id === sessionId && tabOwnerSession) selectProjectSession(tabOwnerSession);
		},
		[ownerSessionId, removeSessionTab, selectProjectSession, sessionId, tabOwnerSession],
	);

	// Shell terminals opened inside a session live beside its pane as extra tabs.
	//
	// Scope shells to the tab layout's originating session. Navigating to a
	// pinned worker keeps the owner's shell tabs; opening that worker directly
	// from the sidebar uses its own separate shell set.
	const allShellTerminals = useShellTerminals().data ?? [];
	const shellTerminals = useMemo(
		() => allShellTerminals.filter((shell) => shell.sessionId === ownerSessionId),
		[allShellTerminals, ownerSessionId],
	);
	const openShellTerminal = useOpenShellTerminal();
	const closeShellTerminal = useCloseShellTerminal();
	const renameShellTerminal = useRenameShellTerminal();
	const activeShellTerminalHandleId = useUiStore((state) => state.activeShellTerminalHandleId);
	const setActiveShellTerminal = useUiStore((state) => state.setActiveShellTerminal);
	const setVisibleTerminalKind = useUiStore((state) => state.setVisibleTerminalKind);
	const clearVisibleTerminalKind = useUiStore((state) => state.clearVisibleTerminalKind);
	const renameShellTerminalByHandle = useCallback(
		(handleId: string, title: string) => renameShellTerminal.mutate({ handleId, title }),
		[renameShellTerminal],
	);

	const addShellTerminal = useCallback(() => {
		openShellTerminal.mutate(
			{ projectId: tabOwnerSession?.workspaceId, sessionId: ownerSessionId },
			{
				onSuccess: (shell) => {
					setActiveShellTerminal(shell.handleId);
					setTerminalTarget({
						kind: "shell",
						handleId: shell.handleId,
						title: shell.title,
					});
				},
			},
		);
	}, [openShellTerminal, ownerSessionId, setActiveShellTerminal, tabOwnerSession?.workspaceId]);

	const selectShellTerminal = useCallback(
		(handleId: string) => {
			const shell = shellTerminals.find((s) => s.handleId === handleId);
			if (!shell) return;
			setActiveShellTerminal(shell.handleId);
			setTerminalTarget({
				kind: "shell",
				handleId: shell.handleId,
				title: shell.title,
			});
		},
		[shellTerminals, setActiveShellTerminal],
	);

	const closeShellTerminalByHandle = useCallback(
		(handleId: string) => {
			setTerminalTarget((current) => {
				if (current.kind !== "shell" || current.handleId !== handleId) return current;
				// Active tab closed — move to the nearest remaining shell tab, or
				// fall back to the session's worker terminal if none remain.
				const remaining = shellTerminals.filter((s) => s.handleId !== handleId);
				const idx = shellTerminals.findIndex((s) => s.handleId === handleId);
				const next = remaining[idx] ?? remaining[idx - 1];
				return next ? { kind: "shell", handleId: next.handleId, title: next.title } : { kind: "worker" };
			});
			if (activeShellTerminalHandleId === handleId) setActiveShellTerminal(null);
			closeShellTerminal.mutate(handleId);
		},
		[closeShellTerminal, activeShellTerminalHandleId, shellTerminals, setActiveShellTerminal],
	);

	// Selecting the session's own pane also drops the active shell, so the effect
	// above does not immediately pull the view back to that shell.
	const selectSessionTerminal = useCallback(() => {
		setActiveShellTerminal(null);
		setTerminalTarget({ kind: "worker" });
	}, [setActiveShellTerminal]);

	// The shell layout owns opening (it is mounted on every route, so the button
	// and Ctrl+Shift+` work everywhere); this view only follows the result. When a new
	// shell becomes active while a session is on screen, switch the pane to it —
	// that is what makes the shortcut feel like it opened a terminal *here*.
	useEffect(() => {
		if (!activeShellTerminalHandleId) return;
		const shell = shellTerminals.find((s) => s.handleId === activeShellTerminalHandleId);
		if (!shell) return;
		setTerminalTarget((current) =>
			current.kind === "shell" && current.handleId === shell.handleId
				? current
				: { kind: "shell", handleId: shell.handleId, title: shell.title },
		);
	}, [activeShellTerminalHandleId, shellTerminals]);

	// If the pane is pointed at a shell that is not in THIS session's strip — e.g.
	// after navigating to a different session whose globally-active shell belongs
	// elsewhere — fall back to the session's own pane rather than render a tab
	// that isn't shown here.
	useEffect(() => {
		setTerminalTarget((current) =>
			current.kind === "shell" && !shellTerminals.some((s) => s.handleId === current.handleId)
				? { kind: "worker" }
				: current,
		);
	}, [shellTerminals]);
	const isOrchestrator = session ? isOrchestratorSession(session) : false;
	// Orchestrator sessions are terminal-only; only worker sessions have the rail.
	const hasInspector = Boolean(session && !isOrchestrator);
	const previewUrl = session?.previewUrl?.trim() || undefined;
	const previewRevision = session?.previewRevision;
	const browserView = useBrowserView({
		sessionId,
		active: Boolean(session && hasInspector && (browserPoppedOut || isInspectorOpen)),
		poppedOut: browserPoppedOut,
		terminated: session ? !sessionIsActive(session) : false,
		previewUrl,
		previewRevision,
	});
	const browserAnnotationQueue = useBrowserAnnotationQueue({
		sessionId: session?.id,
		navUrl: browserView.navState.url,
	});

	useEffect(() => {
		setTerminalTarget({ kind: "worker" });
		setBrowserPoppedOut(false);
		setFilesPoppedOut(false);
	}, [sessionId]);

	// The pane shows one terminal at a time, so selecting a shell or the reviewer
	// takes the agent's terminal off screen while the route still points here.
	// Publish which one is showing: the notification runtime lives outside this
	// subtree and must not treat "on the session route" as "watching the agent".
	useEffect(() => {
		setVisibleTerminalKind(sessionId, terminalTarget.kind);
		return () => clearVisibleTerminalKind(sessionId);
	}, [clearVisibleTerminalKind, sessionId, setVisibleTerminalKind, terminalTarget.kind]);

	const handleOpenFiles = useCallback(() => {
		setBrowserPoppedOut(false);
		setFilesPoppedOut(false);
		setInspectorViewForSession(sessionId, "files");
		setInspectorOpenForSession(sessionId, true);
	}, [sessionId, setInspectorOpenForSession, setInspectorViewForSession]);

	const handleToggleFilesPopOut = useCallback(
		(next: boolean) => {
			if (next) setBrowserPoppedOut(false);
			setFilesPoppedOut(next);
			setInspectorViewForSession(sessionId, "files");
			setInspectorOpenForSession(sessionId, true);
		},
		[sessionId, setInspectorOpenForSession, setInspectorViewForSession],
	);

	const handleToggleBrowserPopOut = useCallback((next: boolean) => {
		if (next) setFilesPoppedOut(false);
		setBrowserPoppedOut(next);
	}, []);

	// `ao preview` sets session.previewUrl (streamed over CDC); badge the inspector
	// rail's Browser tab so the user can open it when they choose — we never steal
	// focus by opening the rail ourselves. A left-click on a terminal link opens the
	// tab explicitly (see TerminalPane) and is exempt from the badge because the tab
	// is already the active view by the time the CDC echo arrives. Navigation alone
	// must not badge an already-present preview target, so the first observed preview
	// key for each session is baselined as "seen"; only a later revision/URL badges.
	useEffect(() => {
		if (!hasInspector) return;
		const previewKey = previewRevealKey(previewUrl, previewRevision);
		const seenKey = useUiStore.getState().inspectorSessions[sessionId]?.previewKey;
		if (seenKey === undefined) {
			markInspectorPreviewSeen(sessionId, previewKey);
			return;
		}
		if (seenKey === previewKey) return;
		markInspectorPreviewSeen(sessionId, previewKey);
		if (!previewKey) return;
		// Already looking at the Browser tab? Nothing to badge.
		if (isInspectorOpen && inspectorView === "browser") return;
		setBrowserUnseen(sessionId, true);
	}, [
		hasInspector,
		inspectorView,
		isInspectorOpen,
		markInspectorPreviewSeen,
		previewRevision,
		previewUrl,
		sessionId,
		setBrowserUnseen,
	]);

	// Keep the badge honest: clear it whenever the Browser tab is the open, active
	// view (covers opening the rail while already parked on Browser, which
	// setInspectorView's own clear does not see).
	useEffect(() => {
		if (hasInspector && isInspectorOpen && inspectorView === "browser") {
			setBrowserUnseen(sessionId, false);
		}
	}, [hasInspector, inspectorView, isInspectorOpen, sessionId, setBrowserUnseen]);

	useEffect(() => {
		if (!hasInspector) return;
		const handleKeyDown = (event: KeyboardEvent) => {
			if (!matchesRendererShortcut("toggle-inspector", event)) return;
			event.preventDefault();
			toggleInspector(sessionId);
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [hasInspector, sessionId, toggleInspector]);


	if (!session && !workspaceQuery.isLoading) {
		return (
			<div className="flex h-full min-h-0 flex-col bg-background text-foreground">
				{shellTopbarHiddenByPlatform ? <ShellTopbar /> : null}
				<div className="grid min-h-0 flex-1 place-items-center p-6 text-center text-xs text-passive">
					Session not found. It may have been cleaned up — pick another from the sidebar.
				</div>
			</div>
		);
	}

	return (
		<div className="relative flex h-full min-h-0 flex-col bg-background text-foreground" data-testid="session-detail">
			{shellTopbarHiddenByPlatform ? <ShellTopbar /> : null}
			<div className="relative flex min-h-0 flex-1">
				{/* Terminal pane fills the remaining space */}
				<div className="flex min-h-0 min-w-0 flex-1 flex-col">
					<CenterPane
						availableProjectSessions={availableSessions.filter((candidate) => candidate.id !== tabOwnerSession?.id)}
						daemonReady={daemonStatus.state === "ready"}
						onAddProjectSession={addProjectSession}
						onCloseProjectSession={closeProjectSession}
						onCloseShellTerminal={closeShellTerminalByHandle}
						onNewShellTerminal={addShellTerminal}
						onRenameShellTerminal={renameShellTerminalByHandle}
						onSelectProjectSession={selectProjectSession}
						onSelectSessionTerminal={selectSessionTerminal}
						onSelectShellTerminal={selectShellTerminal}
						onSelectWorkerTerminal={selectSessionTerminal}
						session={session}
						projectSessions={projectSessions}
						shellTerminals={shellTerminals}
						tabOwnerSessionId={ownerSessionId}
						terminalTarget={terminalTarget}
						theme={theme}
					/>
				</div>

				{hasInspector && (
					<>
						{/* Layout gap — animates to push the terminal pane left when inspector opens */}
						<motion.div
							initial={false}
							animate={{ width: isInspectorOpen ? INSPECTOR_WIDTH : 0 }}
							transition={inspectorSpring}
							className="shrink-0"
						/>
						{/* Inspector container — slides in/out via x transform */}
						<motion.div
							data-testid="inspector-container"
							initial={false}
							animate={{ x: isInspectorOpen ? "0%" : "100%" }}
							transition={inspectorSpring}
							className="absolute inset-y-0 right-0 z-chrome flex w-[360px] flex-col bg-sidebar border-l border-border overflow-hidden"
							// eslint-disable-next-line @typescript-eslint/no-explicit-any
							{...(!isInspectorOpen ? { inert: true } as any : {})}
						>
							<div className="h-full min-w-inspector-min">
								<SessionInspector
									browserAnnotationQueue={browserAnnotationQueue}
									browserPoppedOut={browserPoppedOut}
									filesView={
										session ? (
											<SessionFilesView
												onClose={() => setInspectorViewForSession(sessionId, "summary")}
												onToggleMaximized={handleToggleFilesPopOut}
												sessionId={session.id}
											/>
										) : null
									}
									isInspectorVisible={isInspectorOpen}
									onOpenFiles={handleOpenFiles}
									onOpenReviewerTerminal={({ handleId, harness }) =>
										setTerminalTarget({ kind: "reviewer", handleId, harness })
									}
									onToggleBrowserPopOut={handleToggleBrowserPopOut}
									onToggleVisibility={() => toggleInspector(sessionId)}
									onViewChange={(next: InspectorView) => setInspectorViewForSession(sessionId, next)}
									view={inspectorView}
									browserView={browserView}
									session={session}
								/>
							</div>
						</motion.div>
					</>
				)}
			</div>

			{filesPoppedOut && session ? (
				<div className="absolute inset-0 z-30 bg-background">
					<SessionFilesView
						isMaximized
						onClose={() => {
							setFilesPoppedOut(false);
							setInspectorViewForSession(sessionId, "summary");
						}}
						onToggleMaximized={handleToggleFilesPopOut}
						sessionId={session.id}
					/>
				</div>
			) : null}
			{/* Maximized browser: a fixed overlay across the app workspace,
          portaled to <body> so it escapes the shell layout (covering the
          sidebar + topbar, not just the session area) and sits outside any
          `[data-panel]` column, so the native WebContentsView is not clamped
          and fills the window below any native titlebar overlay. */}
			{browserPoppedOut && session
				? createPortal(
						<div className="browser-popout-overlay">
							<BrowserPanelView
								active
								annotationQueue={browserAnnotationQueue}
								browserView={browserView}
								onTogglePopOut={handleToggleBrowserPopOut}
								poppedOut
								session={session}
							/>
						</div>,
						document.body,
					)
				: null}
		</div>
	);
}
