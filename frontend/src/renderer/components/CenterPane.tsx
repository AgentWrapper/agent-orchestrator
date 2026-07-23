import { ChevronLeft, ChevronRight, Maximize2, Minimize2, Plus, Shield, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type WheelEvent } from "react";
import { useOverflowScroll } from "../hooks/useOverflowScroll";
import { useTruncatedText } from "../hooks/useTruncatedText";
import type { ShellTerminal } from "../hooks/useShellTerminals";
import { TERMINAL_FONT_SIZE_DEFAULT, TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_MIN } from "../lib/design-tokens";
import { cn } from "../lib/utils";
import type { Theme } from "../stores/ui-store";
import type { TerminalTarget } from "../types/terminal";
import { isOrchestratorSession, type WorkspaceSession } from "../types/workspace";
import { TerminalPane } from "./TerminalPane";

type CenterPaneProps = {
	session?: WorkspaceSession;
	theme: Theme;
	daemonReady: boolean;
	terminalTarget?: TerminalTarget;
	onSelectWorkerTerminal?: () => void;
	/** Standalone shells to render as tabs beside the session's own pane. */
	shellTerminals?: ShellTerminal[];
	onSelectSessionTerminal?: () => void;
	onSelectShellTerminal?: (handleId: string) => void;
	onCloseShellTerminal?: (handleId: string) => void;
	/** Opens a new standalone shell tab (Superset-style "+" at the end of the tab bar). */
	onNewShellTerminal?: () => void;
};

const terminalFontSizeStorageKey = "ao.terminal.fontSize";
const WHEEL_ZOOM_THRESHOLD = 80;
const WHEEL_ZOOM_RESET_MS = 250;

function clampTerminalFontSize(size: number): number {
	return Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, size));
}

function initialTerminalFontSize(): number {
	if (typeof window === "undefined") return TERMINAL_FONT_SIZE_DEFAULT;
	const raw = window.localStorage?.getItem(terminalFontSizeStorageKey);
	const parsed = raw === null ? Number.NaN : Number(raw);
	if (!Number.isFinite(parsed)) return TERMINAL_FONT_SIZE_DEFAULT;
	return clampTerminalFontSize(parsed);
}

export function CenterPane({
	session,
	theme,
	daemonReady,
	terminalTarget,
	onSelectWorkerTerminal,
	shellTerminals = [],
	onSelectSessionTerminal,
	onSelectShellTerminal,
	onCloseShellTerminal,
	onNewShellTerminal,
}: CenterPaneProps) {
	const paneRef = useRef<HTMLDivElement | null>(null);
	const wheelZoomRemainderRef = useRef(0);
	const lastWheelZoomAtRef = useRef(0);
	const [fontSize, setFontSize] = useState(initialTerminalFontSize);
	const [isFullscreen, setIsFullscreen] = useState(false);
	const tabOverflowWatch = `session|${shellTerminals.map((t) => t.handleId).join("|")}`;
	const tabsOverflow = useOverflowScroll<HTMLDivElement>(tabOverflowWatch);
	const target = terminalTarget ?? { kind: "worker" };

	useEffect(() => {
		const handleFullscreenChange = () => setIsFullscreen(document.fullscreenElement === paneRef.current);
		document.addEventListener("fullscreenchange", handleFullscreenChange);
		return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
	}, []);

	const updateFontSize = useCallback((delta: number) => {
		setFontSize((current) => {
			const next = clampTerminalFontSize(current + delta);
			window.localStorage?.setItem(terminalFontSizeStorageKey, String(next));
			return next;
		});
	}, []);

	const toggleFullscreen = useCallback(async () => {
		const pane = paneRef.current;
		if (!pane) return;
		try {
			if (document.fullscreenElement === pane) {
				await document.exitFullscreen();
				return;
			}
			await pane.requestFullscreen();
		} catch (error) {
			console.warn("Unable to toggle terminal fullscreen", error);
		}
	}, []);

	const handleWheelZoom = useCallback(
		(event: WheelEvent<HTMLDivElement>) => {
			if (!event.ctrlKey && !event.metaKey) return;
			event.preventDefault();
			event.stopPropagation();

			if (event.timeStamp - lastWheelZoomAtRef.current > WHEEL_ZOOM_RESET_MS) {
				wheelZoomRemainderRef.current = 0;
			}
			lastWheelZoomAtRef.current = event.timeStamp;
			wheelZoomRemainderRef.current += event.deltaY;

			const steps = Math.floor(Math.abs(wheelZoomRemainderRef.current) / WHEEL_ZOOM_THRESHOLD);
			if (steps === 0) return;

			const direction = wheelZoomRemainderRef.current > 0 ? -1 : 1;
			updateFontSize(direction * steps);
			wheelZoomRemainderRef.current -= Math.sign(wheelZoomRemainderRef.current) * steps * WHEEL_ZOOM_THRESHOLD;
		},
		[updateFontSize],
	);

	return (
		<div
			ref={paneRef}
			className="terminal-pane-frame flex h-full min-h-0 min-w-flex-min flex-col"
			onWheelCapture={handleWheelZoom}
		>
			<div className="flex h-inspector-tabs shrink-0 items-center border-b border-border px-5">
				<div className="flex min-w-flex-min flex-1 items-center gap-3">
					<span className="shrink-0 font-mono text-caption font-semibold uppercase tracking-wide-lg text-muted-foreground">
						TERMINAL
					</span>
					<button
						aria-label="Scroll tabs left"
						className={cn(
							"inline-flex size-control-sm shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent/50 disabled:pointer-events-none disabled:opacity-0",
							!tabsOverflow.canScrollLeft && "invisible",
						)}
						disabled={!tabsOverflow.canScrollLeft}
						onClick={() => tabsOverflow.scrollByDirection(-1)}
						title="Scroll tabs left"
						type="button"
					>
						<ChevronLeft aria-hidden="true" className="size-icon-md" />
					</button>
					{/* The session's own pane is always the first tab; standalone shells
					    follow it in the order they were opened. With no shells open this
					    renders as the plain session label it has always been. Tabs shrink
					    and truncate like browser tabs down to a minimum width; beyond
					    that the strip scrolls and edge chevrons reveal the overflow. */}
					<div
						ref={tabsOverflow.ref}
						className="scrollbar-none flex min-w-flex-min flex-1 items-center gap-3 overflow-x-auto"
					>
						<SessionPaneTab
							isActive={target.kind !== "shell"}
							label={!session ? "No session" : isOrchestratorSession(session) ? "Orchestrator" : session.title}
							onSelect={onSelectSessionTerminal}
						/>
						{shellTerminals.map((shell) => (
							<ShellTerminalTab
								key={shell.handleId}
								isActive={target.kind === "shell" && target.handleId === shell.handleId}
								onClose={() => onCloseShellTerminal?.(shell.handleId)}
								onSelect={() => onSelectShellTerminal?.(shell.handleId)}
								shell={shell}
							/>
						))}
					</div>
					<button
						aria-label="Scroll tabs right"
						className={cn(
							"inline-flex size-control-sm shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent/50 disabled:pointer-events-none disabled:opacity-0",
							!tabsOverflow.canScrollRight && "invisible",
						)}
						disabled={!tabsOverflow.canScrollRight}
						onClick={() => tabsOverflow.scrollByDirection(1)}
						title="Scroll tabs right"
						type="button"
					>
						<ChevronRight aria-hidden="true" className="size-icon-md" />
					</button>
					{/* New shell tab at the end of the strip — the same action Ctrl+Shift+`
					    fires, routed through the store so the two cannot drift. */}
					{onNewShellTerminal && (
						<button
							aria-label="New terminal"
							className="inline-flex size-control-sm shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent/50"
							onClick={onNewShellTerminal}
							title="New terminal (Ctrl+Shift+`)"
							type="button"
						>
							<Plus aria-hidden="true" className="size-icon-md" />
						</button>
					)}
				</div>
			</div>
			{target.kind === "reviewer" ? (
				<div className="flex h-toolbar shrink-0 items-center gap-3 border-b border-border px-4">
					<button
						aria-label="Back to agent terminal"
						className="inline-flex h-control-board-sm items-center gap-1.5 rounded-md border border-border bg-transparent px-2.5 text-xs font-semibold leading-none text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground"
						onClick={onSelectWorkerTerminal}
						type="button"
					>
						<ChevronLeft aria-hidden="true" className="size-icon-lg" />
						<span>agent</span>
					</button>
					<span className="inline-flex items-center gap-1.5 font-mono text-xs font-semibold text-success-bright">
						<Shield aria-hidden="true" className="size-icon-lg" />
						Reviewer
					</span>
					<span className="ml-auto truncate font-mono text-xs text-passive">{target.harness}</span>
				</div>
			) : null}
			<div className="relative min-h-0 flex-1">
				<TerminalPane
					daemonReady={daemonReady}
					fontSize={fontSize}
					session={session}
					terminalTarget={target}
					theme={theme}
				/>
				{/* Display controls float over the terminal's top-right corner with no
				    chrome of their own, so they read as part of the terminal itself. */}
				<div className="absolute right-3 top-2 z-10 flex shrink-0 items-center gap-3 font-mono text-passive/70">
					<button
						aria-label="Decrease terminal font size"
						className="inline-flex size-control-sm items-center justify-center rounded-sm bg-transparent text-control leading-none transition-[background,color,opacity] duration-fast hover:bg-interactive-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent/50 disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-passive"
						disabled={fontSize <= TERMINAL_FONT_SIZE_MIN}
						onClick={() => updateFontSize(-1)}
						title="Decrease terminal font size"
						type="button"
					>
						-
					</button>
					<span className="w-font-size-label text-center text-xs font-semibold text-muted-foreground">
						{fontSize}px
					</span>
					<button
						aria-label="Increase terminal font size"
						className="inline-flex size-control-sm items-center justify-center rounded-sm bg-transparent text-control leading-none transition-[background,color,opacity] duration-fast hover:bg-interactive-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent/50 disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-passive"
						disabled={fontSize >= TERMINAL_FONT_SIZE_MAX}
						onClick={() => updateFontSize(1)}
						title="Increase terminal font size"
						type="button"
					>
						+
					</button>
					<button
						aria-label={isFullscreen ? "Exit terminal fullscreen" : "Open terminal fullscreen"}
						aria-pressed={isFullscreen}
						className="ml-1.5 inline-flex size-control-sm items-center justify-center rounded-sm bg-transparent text-control leading-none transition-[background,color] duration-fast hover:bg-interactive-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent/50"
						onClick={() => void toggleFullscreen()}
						title={isFullscreen ? "Exit fullscreen" : "Fullscreen terminal"}
						type="button"
					>
						{isFullscreen ? (
							<Minimize2 className="size-icon-md" aria-hidden="true" />
						) : (
							<Maximize2 className="size-icon-md" aria-hidden="true" />
						)}
					</button>
				</div>
			</div>
		</div>
	);
}

type SessionPaneTabProps = {
	label: string;
	isActive: boolean;
	onSelect?: () => void;
};

// Shared tab chrome: the open tab is highlighted with the same rounded
// background as the inspector rail tabs (Summary · Reviews · Browser), and
// the full label only becomes the hover tooltip when the tab strip is
// crowded enough to truncate it.
function SessionPaneTab({ label, isActive, onSelect }: SessionPaneTabProps) {
	const { ref, isTruncated } = useTruncatedText<HTMLButtonElement>(label);
	return (
		<span
			className={cn(
				"inline-flex min-w-shell-tab-min items-center rounded-md px-2 py-1 transition-colors",
				isActive ? "bg-interactive-active" : "hover:bg-interactive-hover/60",
			)}
		>
			<button
				ref={ref}
				aria-current={isActive}
				className={cn(
					"min-w-flex-min max-w-shell-tab-max truncate font-mono text-control font-semibold transition-colors",
					isActive ? "text-foreground" : "text-passive/60 hover:text-passive",
				)}
				onClick={onSelect}
				title={isTruncated ? label : "Session terminal"}
				type="button"
			>
				{label}
			</button>
		</span>
	);
}

type ShellTerminalTabProps = {
	shell: ShellTerminal;
	isActive: boolean;
	onSelect: () => void;
	onClose: () => void;
};

// The close control is a sibling button, not nested inside the tab button —
// nesting interactive elements is invalid HTML and breaks keyboard traversal.
// It stays hidden until the tab is hovered or focused (group-focus-within
// keeps it reachable from the keyboard).
function ShellTerminalTab({ shell, isActive, onSelect, onClose }: ShellTerminalTabProps) {
	const { ref, isTruncated } = useTruncatedText<HTMLButtonElement>(shell.title);
	return (
		<span
			className={cn(
				"group inline-flex min-w-shell-tab-min items-center gap-1 rounded-md px-2 py-1 transition-colors",
				isActive ? "bg-interactive-active" : "hover:bg-interactive-hover/60",
			)}
		>
			<button
				ref={ref}
				aria-current={isActive}
				className={cn(
					"min-w-flex-min max-w-shell-tab-max truncate font-mono text-control font-semibold transition-colors",
					isActive ? "text-foreground" : "text-passive hover:text-foreground",
				)}
				onClick={onSelect}
				title={isTruncated ? shell.title : shell.workingDir}
				type="button"
			>
				{shell.title}
			</button>
			<button
				aria-label={`Close terminal ${shell.title}`}
				className="inline-flex size-control-sm shrink-0 items-center justify-center rounded-sm text-passive opacity-0 transition-[background,color,opacity] group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-interactive-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent/50"
				onClick={onClose}
				title="Close terminal"
				type="button"
			>
				<X aria-hidden="true" className="size-icon-sm" />
			</button>
		</span>
	);
}
