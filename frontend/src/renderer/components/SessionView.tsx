import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { PanelImperativeHandle, PanelSize } from "react-resizable-panels";
import { BrowserPanelView } from "./BrowserPanel";
import { CenterPane } from "./CenterPane";
import { SessionInspector, type InspectorView } from "./SessionInspector";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "./ui/resizable";
import { Sheet, SheetContent, SheetTitle } from "./ui/sheet";
import { useUiStore } from "../stores/ui-store";
import { useShell } from "../lib/shell-context";
import { useBrowserView } from "../hooks/useBrowserView";
import { useIsMobile } from "../hooks/use-mobile";
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
	const { theme } = useUiStore();
	const isInspectorOpen = useUiStore((state) => state.isInspectorOpen);
	const toggleInspector = useUiStore((state) => state.toggleInspector);
	const isMobile = useIsMobile();
	const { daemonStatus } = useShell();
	const inspectorRef = useRef<PanelImperativeHandle | null>(null);
	const inspectorSeparatorRef = useRef<HTMLDivElement | null>(null);
	const [terminalTarget, setTerminalTarget] = useState<TerminalTarget>({ kind: "worker" });
	const [browserPoppedOut, setBrowserPoppedOut] = useState(false);
	const [inspectorView, setInspectorView] = useState<InspectorView>("summary");

	const session = workspaces.flatMap((workspace) => workspace.sessions).find((s) => s.id === sessionId);
	const isOrchestrator = session ? isOrchestratorSession(session) : false;
	// Orchestrator sessions are terminal-only; only worker sessions have the rail.
	const hasInspector = !isOrchestrator;
	const previewUrl = session?.previewUrl?.trim() || undefined;
	const previewRevision = session?.previewRevision;
	const revealedPreviewRef = useRef<number | null>(null);
	const browserView = useBrowserView({
		sessionId,
		active: Boolean(session && hasInspector && (browserPoppedOut || isInspectorOpen)),
		poppedOut: browserPoppedOut,
		terminated: session?.status === "terminated",
		previewUrl,
		previewRevision,
	});

	useEffect(() => {
		setTerminalTarget({ kind: "worker" });
		setBrowserPoppedOut(false);
		setInspectorView("summary");
		revealedPreviewRef.current = null;
	}, [sessionId]);

	// `ao preview` sets session.previewUrl (streamed over CDC); surface the result
	// in the inspector rail's Browser tab (opening the rail if collapsed), not the
	// center pane. Tracked per preview revision so re-revealing fires on every
	// `ao preview` (even a re-run of the same target) while a manual tab switch
	// sticks for a given revision. `ao preview clear` (empty url) does not reveal.
	useEffect(() => {
		const revision = previewRevision ?? 0;
		if (!previewUrl || revealedPreviewRef.current === revision) return;
		revealedPreviewRef.current = revision;
		setInspectorView("browser");
		if (!useUiStore.getState().isInspectorOpen) toggleInspector();
	}, [previewRevision, previewUrl, toggleInspector]);

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
	// `|| isMobile`: below md the resizable group is unmounted (inspector lives in
	// a bottom Sheet instead), so reset the cached default. Crossing the breakpoint
	// back to desktop then remounts the panel fresh and re-derives this from the
	// live store, keeping the mount-in-sync contract (no imperative call in the
	// mount commit, no "Panel constraints not found" throw).
	const inspectorDefaultSizeRef = useRef<string | null>(null);
	if (!hasInspector || isMobile) {
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
			toggleInspector();
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [hasInspector, toggleInspector]);

	// Drive the collapsible panel from the store so the topbar button, ⌘⇧B, and
	// drag-to-collapse all stay in sync. hasInspector must NOT be a dep: when
	// the inspector panel mounts into the already-live group (orchestrator →
	// worker navigation), rrp only derives the new panel's constraints in the
	// next commit, so an expand()/collapse() in the mount commit throws "Panel
	// constraints not found for Panel inspector" and unwinds the route. The
	// panel mounts in sync via inspectorDefaultSize above; only later toggles
	// need the imperative API, by which point registration has settled.
	useEffect(() => {
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
	}, [isInspectorOpen]);

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
			const open = useUiStore.getState().isInspectorOpen;
			if (size.asPercentage > 0) {
				window.localStorage?.setItem(inspectorSplitStorageKey, String(size.asPercentage));
				if (!open) toggleInspector();
			} else if (open) {
				toggleInspector();
			}
		},
		[toggleInspector],
	);

	if (!session && !workspaceQuery.isLoading) {
		return (
			<div className="grid h-full place-items-center bg-background p-6 text-center font-mono text-[12px] text-passive">
				Session not found. It may have been cleaned up — pick another from the sidebar.
			</div>
		);
	}

	const centerPane =
		browserPoppedOut && session ? (
			<BrowserPanelView
				active
				browserView={browserView}
				onTogglePopOut={setBrowserPoppedOut}
				poppedOut
				session={session}
			/>
		) : (
			<CenterPane
				daemonReady={daemonStatus.state === "ready" || import.meta.env.VITE_AO_API_BASE_URL != null}
				onSelectWorkerTerminal={() => setTerminalTarget({ kind: "worker" })}
				session={session}
				terminalTarget={terminalTarget}
				theme={theme}
			/>
		);

	// Shared by the desktop rail and the mobile Sheet — same inspector + props.
	const inspector = (
		<SessionInspector
			browserPoppedOut={browserPoppedOut}
			isInspectorVisible={isInspectorOpen}
			onOpenReviewerTerminal={({ handleId, harness }) => setTerminalTarget({ kind: "reviewer", handleId, harness })}
			onToggleBrowserPopOut={setBrowserPoppedOut}
			onViewChange={setInspectorView}
			view={inspectorView}
			browserView={browserView}
			session={session}
		/>
	);

	// Below md the resizable split clips both panes (~390px): the terminal goes
	// full-width and the inspector moves into a bottom Sheet, driven by the same
	// store flag as the desktop rail (topbar toggle, ⌘⇧B, and the `ao preview`
	// auto-reveal all flip isInspectorOpen). The rrp group is unmounted here, so
	// its imperative effects no-op safely (inspectorRef stays null) — including
	// when the viewport crosses the breakpoint at runtime.
	if (isMobile) {
		return (
			<div className="flex h-full min-h-0 flex-col bg-background text-foreground">
				<div className="min-h-0 flex-1">{centerPane}</div>
				{hasInspector ? (
					<Sheet
						open={isInspectorOpen}
						onOpenChange={(open) => {
							if (open !== isInspectorOpen) toggleInspector();
						}}
					>
						<SheetContent
							side="bottom"
							showCloseButton={false}
							aria-describedby={undefined}
							className="h-[88vh] gap-0 p-0"
						>
							<SheetTitle className="sr-only">Session inspector</SheetTitle>
							{/* Mobile needs its own visible dismiss control: there's no Esc key
							    on a phone, and the desktop topbar toggle (⌘⇧B) sits under this
							    Sheet's portaled overlay, so backdrop-tap was the only way out —
							    a thin, undiscoverable strip that trapped users. A labeled Close
							    button drives the same store flag as every other toggle. */}
							<div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-1.5">
								<span className="font-mono text-[11px] uppercase tracking-wide text-passive">Inspector</span>
								<button
									type="button"
									aria-label="Close inspector"
									onClick={() => toggleInspector()}
									className="grid size-10 place-items-center rounded-md text-passive transition-colors hover:bg-interactive-hover hover:text-foreground"
								>
									<X className="size-4" aria-hidden="true" />
								</button>
							</div>
							<div className="min-h-0 flex-1 overflow-hidden">{inspector}</div>
						</SheetContent>
					</Sheet>
				) : null}
			</div>
		);
	}

	return (
		<div className="flex h-full min-h-0 flex-col bg-background text-foreground">
			<ResizablePanelGroup className="session-split min-h-0 flex-1" id="session-workspace" orientation="horizontal">
				{/* react-resizable-panels v4: bare numbers are PIXELS; percentages must
            be strings. Numeric sizes here once clamped the inspector to 45px. */}
				<ResizablePanel defaultSize="72%" id="terminal" minSize="45%">
					{centerPane}
				</ResizablePanel>
				{hasInspector ? (
					<>
						<ResizableHandle
							className="session-inspector__resize-handle focus-visible:ring-0 focus-visible:ring-offset-0"
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
							<div className="h-full min-w-[280px]">{inspector}</div>
						</ResizablePanel>
					</>
				) : null}
			</ResizablePanelGroup>
		</div>
	);
}
