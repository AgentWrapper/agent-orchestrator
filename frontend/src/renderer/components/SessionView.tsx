import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PanelImperativeHandle, PanelSize } from "react-resizable-panels";
import { BrowserPanelView, useBrowserAnnotationQueue } from "./BrowserPanel";
import { CenterPane } from "./CenterPane";
import { SessionFilesView } from "./SessionFilesView";
import { SessionInspector } from "./SessionInspector";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "./ui/resizable";
import { useResolvedTheme, useUiStore, type InspectorView } from "../stores/ui-store";
import { useShell } from "../lib/shell-context";
import { useBrowserView } from "../hooks/useBrowserView";
import { useWorkspaceQuery } from "../hooks/useWorkspaceQuery";
import { isOrchestratorSession } from "../types/workspace";
import type { TerminalTarget } from "../types/terminal";

const INSPECTOR_MIN_PERCENT = 22;
const INSPECTOR_MAX_PERCENT = 45;
const inspectorSplitStorageKey = "ao.inspector.split";

function initialSplitPercent(): number {
	const raw = typeof window === "undefined" ? null : window.localStorage?.getItem(inspectorSplitStorageKey);
	const parsed = raw === null ? Number.NaN : Number(raw);
	if (!Number.isFinite(parsed)) return 28;
	return Math.min(INSPECTOR_MAX_PERCENT, Math.max(INSPECTOR_MIN_PERCENT, parsed));
}

function previewRevealKey(previewUrl?: string, previewRevision?: number): string {
	const target = previewUrl?.trim();
	if (!target) return "";
	if (typeof previewRevision === "number") return `revision:${previewRevision}`;
	return `url:${target}`;
}

type SessionViewProps = {
	sessionId: string;
};

// The session detail screen: terminal + git rail, under the shell-owned
// ShellTopbar. Rendered by both the project-scoped and cross-project session
// routes. TerminalPane owns the terminal lifetime and remounts by terminal
// handle so each session gets a clean xterm/mux binding.
//
// The split is shadcn's resizable (react-resizable-panels v4) with a fully
// collapsible inspector: the panel is `collapsible` and driven to 0% via the
// imperative API from the ui-store (topbar button / ⌘⇧B), animated by the
// flex-grow transition in styles.css. Content keeps a stable min-width inside
// the clipped panel so nothing reflows mid-animation; split width persists.
export function SessionView({ sessionId }: SessionViewProps) {
	const workspaceQuery = useWorkspaceQuery();
	const workspaces = workspaceQuery.data ?? [];
	const theme = useResolvedTheme();
	const isInspectorOpen = useUiStore((state) => state.inspectorSessions[sessionId]?.isOpen ?? false);
	const inspectorView = useUiStore((state) => state.inspectorSessions[sessionId]?.view ?? "summary");
	const setInspectorOpenForSession = useUiStore((state) => state.setInspectorOpen);
	const toggleInspector = useUiStore((state) => state.toggleInspector);
	const setInspectorViewForSession = useUiStore((state) => state.setInspectorView);
	const markInspectorPreviewSeen = useUiStore((state) => state.markInspectorPreviewSeen);
	const { daemonStatus } = useShell();
	const inspectorRef = useRef<PanelImperativeHandle | null>(null);
	const inspectorSeparatorRef = useRef<HTMLDivElement | null>(null);
	const [terminalTarget, setTerminalTarget] = useState<TerminalTarget>({ kind: "worker" });
	const [browserPoppedOut, setBrowserPoppedOut] = useState(false);
	const [filesPoppedOut, setFilesPoppedOut] = useState(false);

	const session = workspaces.flatMap((workspace) => workspace.sessions).find((s) => s.id === sessionId);
	const isOrchestrator = session ? isOrchestratorSession(session) : false;
	// Orchestrator sessions are terminal-only; only worker sessions have the rail.
	const hasInspector = Boolean(session && !isOrchestrator);
	const previewUrl = session?.previewUrl?.trim() || undefined;
	const previewRevision = session?.previewRevision;
	const browserView = useBrowserView({
		sessionId,
		active: Boolean(session && hasInspector && (browserPoppedOut || isInspectorOpen)),
		poppedOut: browserPoppedOut,
		terminated: session?.status === "terminated",
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

	// `ao preview` sets session.previewUrl (streamed over CDC); surface the result
	// in this session's inspector rail Browser tab (opening the rail if collapsed),
	// not the center pane. Navigation alone must not reveal an already-present
	// preview target, so the first observed preview key for each session is
	// baselined as "seen"; only a later revision/URL opens the rail.
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
		setInspectorViewForSession(sessionId, "browser");
		setInspectorOpenForSession(sessionId, true);
	}, [
		hasInspector,
		markInspectorPreviewSeen,
		previewRevision,
		previewUrl,
		sessionId,
		setInspectorOpenForSession,
		setInspectorViewForSession,
	]);

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
		inspectorDefaultSizeRef.current = isInspectorOpen ? `${initialSplitPercent()}%` : "0%";
	}
	const inspectorDefaultSize = inspectorDefaultSizeRef.current ?? "0%";

	useEffect(() => {
		if (!hasInspector) return;
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key.toLowerCase() !== "b" || !event.shiftKey) return;
			if (!event.metaKey && !event.ctrlKey) return;
			event.preventDefault();
			toggleInspector(sessionId);
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [hasInspector, sessionId, toggleInspector]);

	// Drive the collapsible panel from the store so the topbar button, ⌘⇧B, and
	// drag-to-collapse all stay in sync. When the inspector panel mounts into
	// the already-live group (orchestrator/loading → worker), rrp only derives
	// the new panel's constraints in the next commit. This effect intentionally
	// runs before the readiness effect below, so mount and StrictMode's effect
	// replay remain imperative-free; later store changes can safely drive the
	// registered panel.
	const inspectorImperativeReadyRef = useRef(false);
	useEffect(() => {
		if (!hasInspector || !inspectorImperativeReadyRef.current) return;
		const panel = inspectorRef.current;
		if (!panel) return;
		if (isInspectorOpen) {
			panel.expand();
			// expand() restores the "most recent" size, which is 0 when the panel
			// mounted collapsed — fall back to the persisted split.
			if (panel.getSize().asPercentage === 0) panel.resize(`${initialSplitPercent()}%`);
		} else {
			panel.collapse();
		}
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

	// Persist drags and mirror collapse state (dragging past minSize collapses)
	// back into the store. Read the store imperatively to avoid a stale closure.
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
			const currentOpen = useUiStore.getState().inspectorSessions[sessionId]?.isOpen ?? false;
			if (size.asPercentage > 0) {
				window.localStorage?.setItem(inspectorSplitStorageKey, String(size.asPercentage));
				if (!currentOpen) toggleInspector(sessionId);
			} else if (currentOpen) {
				toggleInspector(sessionId);
			}
		},
		[sessionId, toggleInspector],
	);

	if (!session && !workspaceQuery.isLoading) {
		return (
			<div className="grid h-full place-items-center bg-background p-6 text-center font-mono text-xs text-passive">
				Session not found. It may have been cleaned up — pick another from the sidebar.
			</div>
		);
	}

	return (
		<div className="relative flex h-full min-h-0 flex-col bg-background text-foreground">
			<ResizablePanelGroup className="session-split min-h-0 flex-1" id="session-workspace" orientation="horizontal">
				{/* react-resizable-panels v4: bare numbers are PIXELS; percentages must
            be strings. Numeric sizes here once clamped the inspector to 45px. */}
				<ResizablePanel defaultSize="72%" id="terminal" minSize="45%">
					<CenterPane
						daemonReady={daemonStatus.state === "ready"}
						onSelectWorkerTerminal={() => setTerminalTarget({ kind: "worker" })}
						session={session}
						terminalTarget={terminalTarget}
						theme={theme}
					/>
				</ResizablePanel>
				{hasInspector ? (
					<>
						<ResizableHandle
							className="w-1.75 cursor-col-resize touch-none bg-transparent after:w-px after:bg-border-strong hover:after:bg-border focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:after:bg-border data-[separator=active]:after:bg-border"
							elementRef={inspectorSeparatorRef}
						/>
						<ResizablePanel
							aria-hidden={!isInspectorOpen}
							collapsible
							defaultSize={inspectorDefaultSize}
							id="inspector"
							inert={!isInspectorOpen}
							maxSize={`${INSPECTOR_MAX_PERCENT}%`}
							minSize={`${INSPECTOR_MIN_PERCENT}%`}
							onResize={handleInspectorResize}
							panelRef={inspectorRef}
							style={{ overflow: "hidden" }}
						>
							{/* Stable content width while the panel animates (yyork pattern):
                  the pane clips instead of reflowing the inspector mid-collapse. */}
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
