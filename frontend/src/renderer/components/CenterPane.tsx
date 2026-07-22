import { ChevronLeft, Maximize2, Minimize2, Shield, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type WheelEvent } from "react";
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
}: CenterPaneProps) {
	const paneRef = useRef<HTMLDivElement | null>(null);
	const wheelZoomRemainderRef = useRef(0);
	const lastWheelZoomAtRef = useRef(0);
	const [fontSize, setFontSize] = useState(initialTerminalFontSize);
	const [isFullscreen, setIsFullscreen] = useState(false);
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
			className="terminal-pane-frame flex h-full min-h-0 min-w-0 flex-col bg-background"
			onWheelCapture={handleWheelZoom}
		>
			<div className="flex h-inspector-tabs shrink-0 items-center border-b border-border bg-background px-5">
				<div className="flex min-w-0 items-center gap-3">
					<span className="shrink-0 font-mono text-caption font-semibold uppercase tracking-wide-lg text-muted-foreground">
						TERMINAL
					</span>
					{/* The session's own pane is always the first tab; standalone shells
					    follow it in the order they were opened. With no shells open this
					    renders as the plain session label it has always been. */}
					<button
						aria-current={target.kind !== "shell"}
						className={cn(
							"min-w-0 shrink-0 truncate rounded-sm px-1 font-mono text-control font-semibold transition-colors",
							target.kind === "shell" ? "text-passive/60 hover:text-passive" : "text-passive hover:text-foreground",
						)}
						onClick={onSelectSessionTerminal}
						title="Session terminal"
						type="button"
					>
						{!session ? "No session" : isOrchestratorSession(session) ? "Orchestrator" : session.title}
					</button>
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
				<div className="ml-auto flex items-center gap-3 font-mono text-passive">
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
			{target.kind === "reviewer" ? (
				<div className="flex h-toolbar shrink-0 items-center gap-3 border-b border-border bg-background px-4">
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
			<div className="min-h-0 flex-1">
				<TerminalPane
					daemonReady={daemonReady}
					fontSize={fontSize}
					session={session}
					terminalTarget={target}
					theme={theme}
				/>
			</div>
		</div>
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
function ShellTerminalTab({ shell, isActive, onSelect, onClose }: ShellTerminalTabProps) {
	return (
		<span
			className={cn(
				"group inline-flex min-w-0 shrink-0 items-center gap-1 rounded-sm pl-1.5 transition-colors",
				isActive ? "bg-interactive-hover" : "hover:bg-interactive-hover/60",
			)}
		>
			<button
				aria-current={isActive}
				className={cn(
					"min-w-0 max-w-shell-tab-max truncate font-mono text-control font-semibold transition-colors",
					isActive ? "text-foreground" : "text-passive hover:text-foreground",
				)}
				onClick={onSelect}
				title={shell.workingDir}
				type="button"
			>
				{shell.title}
			</button>
			<button
				aria-label={`Close terminal ${shell.title}`}
				className="inline-flex size-control-sm shrink-0 items-center justify-center rounded-sm text-passive transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent/50"
				onClick={onClose}
				title="Close terminal"
				type="button"
			>
				<X aria-hidden="true" className="size-icon-sm" />
			</button>
		</span>
	);
}
