import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import type { PanelImperativeHandle, PanelSize } from "react-resizable-panels";
import { BrowserPanelView, useBrowserAnnotationQueue } from "./BrowserPanel";
import { CenterPane } from "./CenterPane";
import { SessionChatSurface } from "./chat/SessionChatSurface";
import { SessionFilesView } from "./SessionFilesView";
import { SessionInspector } from "./SessionInspector";
import {
	SessionInterfaceActionGroup,
	SessionInterfaceSwitchButton,
	SessionInterfaceSwitchDialog,
	SessionInterfaceTransitionNotice,
} from "./SessionInterfaceSwitch";
import { ShellTopbar } from "./ShellTopbar";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "./ui/resizable";
import { useBrowserView } from "../hooks/useBrowserView";
import {
	useCloseShellTerminal,
	useOpenShellTerminal,
	useRenameShellTerminal,
	useShellTerminals,
} from "../hooks/useShellTerminals";
import {
	interfaceTransitionIsActive,
	useSessionInterfaceTransition,
} from "../hooks/useSessionInterfaceTransition";
import { useWorkspaceQuery } from "../hooks/useWorkspaceQuery";
import { useWindowFullScreen } from "../hooks/useWindowFullScreen";
import { apiErrorMessage } from "../lib/api-client";
import { hidesShellTopbar } from "../lib/platform";
import { useShell } from "../lib/shell-context";
import { cn } from "../lib/utils";
import { isOrchestratorSession, sessionIsActive, workerSessions, type WorkspaceSession } from "../types/workspace";
import { terminalTargetBelongsToSession, type TerminalTarget } from "../types/terminal";
import { matchesRendererShortcut } from "../stores/keybindings-store";
import { useResolvedTheme, useUiStore, type InspectorView } from "../stores/ui-store";

// Inspector labels hide below 360px, so this is the smallest initial width
// that presents both each destination icon and its name.
const INSPECTOR_DEFAULT_PX = 360;
const INSPECTOR_DEFAULT_SIZE = `${INSPECTOR_DEFAULT_PX}px`;
const INSPECTOR_MIN_PX = 240;
const INSPECTOR_MIN_SIZE = `${INSPECTOR_MIN_PX}px`;
const INSPECTOR_MAX_PERCENT = 50;
const INSPECTOR_COLLAPSED_SIZE = "0%";
const INSPECTOR_MOTION_MS = 240;
const inspectorWidthStorageKey = "ao.inspector.widthPx";
const emptySessionTabIds: string[] = [];
const shellTopbarHiddenByPlatform = hidesShellTopbar();

function initialInspectorSize(): string {
	const raw = typeof window === "undefined" ? null : window.localStorage?.getItem(inspectorWidthStorageKey);
	const parsed = raw === null ? Number.NaN : Number(raw);
	if (!Number.isFinite(parsed)) return INSPECTOR_DEFAULT_SIZE;
	return `${Math.max(INSPECTOR_MIN_PX, Math.round(parsed))}px`;
}

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

// The session detail screen: terminal + inspector rail. Its top chrome is
// column-owned on every platform: ShellTopbar ends at the inspector divider,
// while SessionInspector owns its tabs and persistent collapse control.
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
	const { t } = useTranslation();
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
	const inspectorRef = useRef<PanelImperativeHandle | null>(null);
	const inspectorSeparatorRef = useRef<HTMLDivElement | null>(null);
	const [inspectorMotionState, setInspectorMotionState] = useState<"closed" | "closing" | "open" | "opening">(
		isInspectorOpen ? "open" : "closed",
	);
	const [terminalTarget, setTerminalTarget] = useState<TerminalTarget>({
		kind: "worker",
	});
	const [browserPoppedOut, setBrowserPoppedOut] = useState(false);
	const [filesPoppedOut, setFilesPoppedOut] = useState(false);
	const [interfaceSwitchDialogOpen, setInterfaceSwitchDialogOpen] = useState(false);
	const [dismissedTransitionID, setDismissedTransitionID] = useState("");
	const isNativeFullScreen = useWindowFullScreen();

	const session = workspaces.flatMap((workspace) => workspace.sessions).find((s) => s.id === sessionId);
	const allSessions = workspaces.flatMap((workspace) => workspace.sessions);
	const tabOwnerSession = allSessions.find((candidate) => candidate.id === tabOwnerSessionId) ?? session;
	const ownerSessionId = tabOwnerSession?.id ?? sessionId;
	const storedSessionTabIds = useUiStore((state) => state.sessionTabsByOwner[ownerSessionId] ?? emptySessionTabIds);
	const addSessionTab = useUiStore((state) => state.addSessionTab);
	const removeSessionTab = useUiStore((state) => state.removeSessionTab);
	const activeShellTerminalHandleId = useUiStore((state) => state.activeShellTerminalHandleId);
	const setActiveShellTerminal = useUiStore((state) => state.setActiveShellTerminal);
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
			// A session-backed tab owns the route, topbar identity, sidebar
			// selection, and visible agent terminal as one selection. Clear any
			// standalone shell first so its global active handle cannot immediately
			// override the routed session during the navigation commit.
			setActiveShellTerminal(null);
			setTerminalTarget({ kind: "worker" });
			void navigate({
				to: "/projects/$projectId/sessions/$sessionId",
				params: {
					projectId: projectSession.workspaceId,
					sessionId: projectSession.id,
				},
				search: projectSession.id === ownerSessionId ? {} : { tabOwner: ownerSessionId },
			});
		},
		[navigate, ownerSessionId, setActiveShellTerminal],
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
	const interfaceSwitch = useSessionInterfaceTransition(session?.id);

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
						generation: shell.createdAt,
						kind: "shell",
						handleId: shell.handleId,
						sessionId: ownerSessionId,
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
				generation: shell.createdAt,
				kind: "shell",
				handleId: shell.handleId,
				sessionId: ownerSessionId,
				title: shell.title,
			});
		},
		[shellTerminals, setActiveShellTerminal],
	);

	const closeShellTerminalByHandle = useCallback(
		(handleId: string) => {
			if (terminalTarget.kind === "shell" && terminalTarget.handleId === handleId) {
				const closingIndex = shellTerminals.findIndex((shell) => shell.handleId === handleId);
				const nextShell = shellTerminals[closingIndex - 1] ?? shellTerminals[closingIndex + 1];
				if (nextShell) {
					setActiveShellTerminal(nextShell.handleId);
					setTerminalTarget({
						generation: nextShell.createdAt,
						kind: "shell",
						handleId: nextShell.handleId,
						sessionId: ownerSessionId,
						title: nextShell.title,
					});
				} else {
					setActiveShellTerminal(null);
					setTerminalTarget({ kind: "worker" });
				}
			} else if (activeShellTerminalHandleId === handleId) {
				setActiveShellTerminal(null);
			}
			closeShellTerminal.mutate(handleId);
		},
		[
			activeShellTerminalHandleId,
			closeShellTerminal,
			ownerSessionId,
			setActiveShellTerminal,
			shellTerminals,
			terminalTarget,
		],
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
			current.kind === "shell" &&
			current.handleId === shell.handleId &&
			current.generation === shell.createdAt &&
			current.title === shell.title
				? current
				: {
						generation: shell.createdAt,
						kind: "shell",
						handleId: shell.handleId,
						sessionId: ownerSessionId,
						title: shell.title,
					},
		);
	}, [activeShellTerminalHandleId, ownerSessionId, shellTerminals]);

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
	// Orchestrators get the full workspace width; only workers need the inspector rail.
	const hasInspector = Boolean(session && !isOrchestrator);
	const activeInterfaceTransition = interfaceTransitionIsActive(interfaceSwitch.transition);
	const chatControllerTransitioning = Boolean(
		interfaceSwitch.transition?.targetMode === "chat" &&
			(activeInterfaceTransition || interfaceSwitch.settling),
	);
	const interfaceTarget =
		(activeInterfaceTransition ? interfaceSwitch.transition?.targetMode : interfaceSwitch.status?.targetMode) ??
		(session?.mode === "chat" ? "tui" : "chat");
	const interfaceWaitingForInput = Boolean(
		session &&
		(session.status === "needs_input" ||
			session.activity?.state === "waiting_input" ||
			session.activity?.state === "blocked"),
	);
	const beginInterfaceSwitch = useCallback(
		async (policy: "drain" | "interrupt") => {
			try {
				await interfaceSwitch.start({ targetMode: interfaceTarget, policy });
				setInterfaceSwitchDialogOpen(false);
			} catch {
				// The mutation owns the typed error. Keep the dialog open so it is
				// visible instead of also producing an unhandled rejection.
				setInterfaceSwitchDialogOpen(true);
			}
		},
		[interfaceSwitch, interfaceTarget],
	);
	const requestInterfaceSwitch = useCallback(() => {
		interfaceSwitch.resetStartError();
		setInterfaceSwitchDialogOpen(true);
	}, [interfaceSwitch]);
	const showInterfaceSwitchAction = Boolean(
		interfaceSwitch.status || interfaceSwitch.isLoading || interfaceSwitch.statusError,
	);
	const interfaceSwitchAction = session && showInterfaceSwitchAction ? (
		<SessionInterfaceSwitchButton
			target={interfaceTarget}
			supported={Boolean(interfaceSwitch.status?.supported) && !activeInterfaceTransition}
			disabledReason={
				interfaceSwitch.isLoading
					? "Checking whether this agent can switch interfaces…"
					: interfaceSwitch.status?.reason || interfaceSwitch.statusError
			}
			pending={interfaceSwitch.starting || activeInterfaceTransition}
			transition={interfaceSwitch.transition}
			cancelling={interfaceSwitch.cancelling}
			cancelError={interfaceSwitch.cancelError}
			onClick={requestInterfaceSwitch}
			onCancel={() => {
				void interfaceSwitch.cancel().catch(() => {});
			}}
		/>
	) : null;
	// Our route-level Reverb topbar remains the owner of navigation and session
	// controls. Only the newly introduced interface switch belongs in the
	// secondary terminal/chat strip.
	const sessionHeaderActions = interfaceSwitchAction ? (
		<SessionInterfaceActionGroup>{interfaceSwitchAction}</SessionInterfaceActionGroup>
	) : null;
	const previewUrl = session?.previewUrl?.trim() || undefined;
	const previewRevision = session?.previewRevision;
	const browserSlotVisible = Boolean(
		session && hasInspector && (browserPoppedOut || (isInspectorOpen && inspectorView === "browser")),
	);
	const browserView = useBrowserView({
		sessionId,
		active: browserSlotVisible,
		poppedOut: browserPoppedOut,
		terminated: session ? !sessionIsActive(session) : false,
		previewUrl,
		previewRevision,
	});
	const browserAnnotationQueue = useBrowserAnnotationQueue({
		sessionId: session?.id,
		navUrl: browserView.navState.url,
	});

	useLayoutEffect(() => {
		setTerminalTarget({ kind: "worker" });
		setBrowserPoppedOut(false);
		setFilesPoppedOut(false);
	}, [sessionId]);

	// Shell tabs belong to the tab layout owner, while reviewer terminals belong
	// to the worker currently selected inside that layout. Reject stale handles
	// synchronously during route changes so the cache cannot cross-wire sessions.
	const routedTerminalTarget =
		terminalTarget.kind === "shell"
			? terminalTargetBelongsToSession(terminalTarget, ownerSessionId)
				? terminalTarget
				: ({ kind: "worker" } satisfies TerminalTarget)
			: terminalTargetBelongsToSession(terminalTarget, sessionId)
				? terminalTarget
				: ({ kind: "worker" } satisfies TerminalTarget);
	const showChatSurface = session?.mode === "chat" && routedTerminalTarget.kind === "worker";

	// The pane shows one terminal at a time, so selecting a shell or the reviewer
	// takes the agent's terminal off screen while the route still points here.
	// Publish which one is showing: the notification runtime lives outside this
	// subtree and must not treat "on the session route" as "watching the agent".
	useEffect(() => {
		setVisibleTerminalKind(sessionId, routedTerminalTarget.kind);
		return () => clearVisibleTerminalKind(sessionId);
	}, [clearVisibleTerminalKind, routedTerminalTarget.kind, sessionId, setVisibleTerminalKind]);

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

	// Computed when the inspector panel mounts and frozen while it stays
	// mounted: rrp re-registers the panel (a layout effect keyed on defaultSize,
	// among others) whenever this prop's identity changes, and the imperative
	// collapse()/expand() below can race that re-registration within the same
	// commit — rrp then throws "Panel constraints not found for Panel
	// inspector", which unwinds the whole route to the router's CatchBoundary
	// (the toggle button looks dead and the session view is torn down).
	// Re-derived per panel mount (not once per SessionView mount — navigating
	// orchestrator → worker keeps this component mounted while the panel
	// remounts) so a freshly mounted panel reflects the store on its own,
	// without an imperative fix-up in the mount commit. Afterwards the
	// imperative API owns the size, so this must never track live open state.
	const inspectorDefaultSizeRef = useRef<string | null>(null);
	if (!hasInspector) {
		inspectorDefaultSizeRef.current = null;
	} else if (inspectorDefaultSizeRef.current === null) {
		inspectorDefaultSizeRef.current = isInspectorOpen ? initialInspectorSize() : INSPECTOR_COLLAPSED_SIZE;
	}
	const inspectorDefaultSize = inspectorDefaultSizeRef.current ?? INSPECTOR_COLLAPSED_SIZE;

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

	// Drive the collapsible panel from the store so the topbar button and ⌘⇧B
	// stay in sync. The panel itself still resizes once at each edge of the
	// transition. This now mirrors the left sidebar's spring-like layout motion;
	// styles.css disables that motion while the separator is actively dragged so
	// the resize handle remains exactly under the pointer.
	// When the inspector panel mounts into
	// the already-live group (orchestrator/loading → worker), rrp only derives
	// the new panel's constraints in the next commit. This effect intentionally
	// runs before the readiness effect below, so mount and StrictMode's effect
	// replay remain imperative-free; later store changes can safely drive the
	// registered panel.
	const inspectorImperativeReadyRef = useRef(false);
	// A route change from Orchestrator to a worker mounts the inspector into an
	// already-live SessionView. Synchronize the content state before paint while
	// the panel handle is still being registered; otherwise the panel can have an
	// open width while its contents remain hidden as "closed".
	useLayoutEffect(() => {
		if (!hasInspector) {
			setInspectorMotionState("closed");
			return;
		}
		if (!inspectorImperativeReadyRef.current) {
			setInspectorMotionState(isInspectorOpen ? "open" : "closed");
		}
	}, [hasInspector, isInspectorOpen]);
	useEffect(() => {
		if (!hasInspector) return;
		if (!inspectorImperativeReadyRef.current) return;
		const panel = inspectorRef.current;
		if (!panel) return;
		if (isInspectorOpen) {
			setInspectorMotionState("opening");
			panel.resize(initialInspectorSize());
			const frame = window.requestAnimationFrame(() => setInspectorMotionState("open"));
			return () => window.cancelAnimationFrame(frame);
		}
		setInspectorMotionState("closing");
		// Closing flips `collapsible` back on in this same commit, while rrp
		// refreshes its constraints in a follow-up commit. Repeat on the next
		// frame so the explicit top-bar control reaches a true zero-width rail.
		// The flex transition starts immediately; content remains mounted until
		// its clipped closing motion has finished.
		panel.collapse();
		const collapseFrame = window.requestAnimationFrame(() => panel.collapse());
		const timer = window.setTimeout(() => setInspectorMotionState("closed"), INSPECTOR_MOTION_MS);
		return () => {
			window.clearTimeout(timer);
			window.cancelAnimationFrame(collapseFrame);
		};
	}, [hasInspector, isInspectorOpen]);
	useEffect(() => {
		if (!hasInspector || !inspectorRef.current) {
			inspectorImperativeReadyRef.current = false;
			return;
		}
		inspectorImperativeReadyRef.current = true;
		return () => {
			inspectorImperativeReadyRef.current = false;
		};
	}, [hasInspector]);

	// Persist explicit resizes in pixels so the same inspector width is restored
	// when the window or left sidebar changes. Open panels are non-collapsible,
	// so dragging can never leave a residual collapsed rail or fight the top-bar
	// toggle.
	// Gated on an actively dragged separator: rrp v4 derives sizes from the
	// observed DOM layout, so the flex-grow transition that animates
	// expand()/collapse() (styles.css) fires onResize with transient
	// mid-animation sizes too. Writing those back turned the imperative
	// collapse into a feedback loop — a mid-collapse size read as "dragged
	// back open", re-toggled the store, and the panel bounced back (the
	// topbar button looked dead). rrp marks the separator
	// data-separator="active" only during a pointer drag — the same hook the
	// transition-suppressing CSS keys on, so drag writes are never transition
	// frames.
	// Also wrapped in useCallback: rrp v4's panel registration useLayoutEffect
	// includes onResize in its dep array, so an unstable reference would
	// de-register/re-register the inspector panel on every render and race
	// with the expand()/collapse() effect above.
	const handleInspectorResize = useCallback(
		(size: PanelSize) => {
			if (inspectorSeparatorRef.current?.getAttribute("data-separator") !== "active") return;
			if (size.inPixels <= 0) return;
			window.localStorage?.setItem(inspectorWidthStorageKey, String(Math.round(size.inPixels)));
			const currentOpen = useUiStore.getState().inspectorSessions[sessionId]?.isOpen ?? true;
			if (!currentOpen) toggleInspector(sessionId);
		},
		[sessionId, toggleInspector],
	);
	const inspectorPanelVisible = inspectorMotionState !== "closed";

	if (!session && !workspaceQuery.isLoading) {
		return (
			<div className="flex h-full min-h-0 flex-col bg-background text-foreground">
				<ShellTopbar />
				<div className="grid min-h-0 flex-1 place-items-center p-6 text-center font-mono text-xs text-passive">
					{t("session.notFound")}
				</div>
			</div>
		);
	}

	return (
		<div className="relative flex h-full min-h-0 flex-col bg-background text-foreground" data-testid="session-detail">
			<ResizablePanelGroup
				className="session-split min-h-0 flex-1"
				id="session-workspace"
				orientation="horizontal"
				style={{ "--session-inspector-max-width": `${INSPECTOR_MAX_PERCENT}%` } as CSSProperties}
			>
				{/* react-resizable-panels v4: bare numbers are PIXELS; percentages must
            be strings. Numeric sizes here once clamped the inspector to 45px. */}
				<ResizablePanel defaultSize="72%" id="terminal" minSize={`${100 - INSPECTOR_MAX_PERCENT}%`}>
					<div className="flex h-full min-h-0 flex-col">
						<ShellTopbar />
						{/* The committed mode owns the agent surface. Auxiliary shell and
						    reviewer targets remain terminal surfaces in either mode. */}
						{showChatSurface ? (
							<SessionChatSurface
								session={session}
								headerActions={sessionHeaderActions}
								controllerTransitioning={chatControllerTransitioning}
								onOpenShell={addShellTerminal}
								openingShell={openShellTerminal.isPending}
								shellError={
									openShellTerminal.error ? apiErrorMessage(openShellTerminal.error) : undefined
								}
							/>
						) : (
							<CenterPane
								agentInputDisabled={
									(interfaceSwitch.starting || activeInterfaceTransition) && session?.mode === "tui"
								}
								availableProjectSessions={availableSessions.filter(
									(candidate) => candidate.id !== tabOwnerSession?.id,
								)}
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
								projectSessions={projectSessions}
								session={session}
								shellTerminals={shellTerminals}
								tabOwnerSessionId={ownerSessionId}
								terminalTarget={routedTerminalTarget}
								theme={theme}
								topbarActions={sessionHeaderActions}
							/>
						)}
						{interfaceSwitch.transition?.id !== dismissedTransitionID ? (
							<SessionInterfaceTransitionNotice
								transition={interfaceSwitch.transition}
								onDismiss={() => setDismissedTransitionID(interfaceSwitch.transition?.id ?? "")}
							/>
						) : null}
					</div>
				</ResizablePanel>
				{hasInspector ? (
					<>
						<ResizableHandle
							aria-hidden={!inspectorPanelVisible}
							className={cn(
								"w-1.75 cursor-col-resize touch-none bg-transparent transition-[width] duration-200 ease-out after:w-px after:bg-border-strong hover:after:bg-border focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:after:bg-border data-[separator=active]:after:bg-border",
								!inspectorPanelVisible && "pointer-events-none w-0 after:hidden",
							)}
							disabled={!isInspectorOpen}
							elementRef={inspectorSeparatorRef}
						/>
						<ResizablePanel
							aria-hidden={!inspectorPanelVisible}
							className="session-inspector-panel"
							collapsible={!isInspectorOpen}
							defaultSize={inspectorDefaultSize}
							id="inspector"
							inert={!isInspectorOpen}
							maxSize={`${INSPECTOR_MAX_PERCENT}%`}
							minSize={INSPECTOR_MIN_SIZE}
							onResize={handleInspectorResize}
							panelRef={inspectorRef}
							style={{ overflow: "hidden" }}
						>
							{/* Stable content width while the panel animates (yyork pattern):
                  the pane clips instead of reflowing the inspector mid-collapse. */}
							<div
								className="session-inspector-motion h-full min-w-inspector-min"
								data-motion-state={inspectorMotionState}
							>
								<SessionInspector
									browserAnnotationQueue={browserAnnotationQueue}
									browserPoppedOut={browserPoppedOut}
									filesView={
										session ? (
											<SessionFilesView
												onToggleMaximized={handleToggleFilesPopOut}
												sessionId={session.id}
											/>
										) : null
									}
									isInspectorVisible={inspectorPanelVisible}
									onOpenFiles={handleOpenFiles}
									onOpenReviewerTerminal={({ handleId, harness }) =>
										setTerminalTarget({ kind: "reviewer", handleId, harness, sessionId })
									}
									onToggleBrowserPopOut={handleToggleBrowserPopOut}
									onToggleVisibility={() => toggleInspector(sessionId)}
									onViewChange={(next: InspectorView) => setInspectorViewForSession(sessionId, next)}
									view={inspectorView}
									browserView={browserView}
									session={session}
								/>
							</div>
						</ResizablePanel>
					</>
				) : null}
			</ResizablePanelGroup>
			<SessionInterfaceSwitchDialog
				open={interfaceSwitchDialogOpen}
				target={interfaceTarget}
				waitingForInput={interfaceWaitingForInput}
				busy={interfaceSwitch.starting}
				error={interfaceSwitch.startError}
				onOpenChange={setInterfaceSwitchDialogOpen}
				onChoose={(policy) => void beginInterfaceSwitch(policy)}
			/>
			{filesPoppedOut && session
				? createPortal(
						<div
							className={cn(
								"files-popout-overlay",
								shellTopbarHiddenByPlatform && !isNativeFullScreen && "files-popout-overlay--mac-windowed",
							)}
						>
							<SessionFilesView
								isMaximized
								onToggleMaximized={handleToggleFilesPopOut}
								sessionId={session.id}
							/>
						</div>,
						document.body,
					)
				: null}
			{/* Maximized browser: a fixed overlay across the app workspace,
          portaled to <body> so it escapes the shell layout (covering the
          sidebar + topbar, not just the session area) and sits outside any
          `[data-panel]` column, so the native WebContentsView is not clamped
          and fills the window below any native titlebar overlay. */}
			{browserPoppedOut && session
				? createPortal(
						<div
							className={cn(
								"browser-popout-overlay",
								shellTopbarHiddenByPlatform && !isNativeFullScreen && "browser-popout-overlay--mac-windowed",
							)}
						>
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
