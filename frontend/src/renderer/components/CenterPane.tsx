import { ChevronLeft, Maximize2, Minimize2, Shield } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type WheelEvent } from "react";
import { TERMINAL_FONT_SIZE_DEFAULT, TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_MIN } from "../lib/design-tokens";
import type { Theme } from "../stores/ui-store";
import type { TerminalTarget } from "../types/terminal";
import type { WorkspaceSession } from "../types/workspace";
import { TerminalPane } from "./TerminalPane";

type CenterPaneProps = {
	session?: WorkspaceSession;
	theme: Theme;
	daemonReady: boolean;
	terminalTarget?: TerminalTarget;
	onSelectWorkerTerminal?: () => void;
};

const terminalFontSizeStorageKey = "ao.terminal.fontSize";
const WHEEL_ZOOM_THRESHOLD = 80;
const WHEEL_ZOOM_RESET_MS = 250;

// Browser-mode scrollback cap: how many lines of history the xterm normal buffer
// keeps. Bounded so a long-running agent's transcript stays legible, and user-
// configurable per the GH #60 scope note (default ~5000). Electron ignores it
// (alt-buffer; tmux owns history), so the control is browser-mode only.
const terminalScrollbackStorageKey = "ao.terminal.scrollback";
const DEFAULT_TERMINAL_SCROLLBACK = 5000;
const MIN_TERMINAL_SCROLLBACK = 1000;
const MAX_TERMINAL_SCROLLBACK = 100000;
const TERMINAL_SCROLLBACK_STEP = 1000;

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

function clampTerminalScrollback(lines: number): number {
	// Snap to the step so the readout stays tidy and the stored value round-trips.
	const stepped = Math.round(lines / TERMINAL_SCROLLBACK_STEP) * TERMINAL_SCROLLBACK_STEP;
	return Math.min(MAX_TERMINAL_SCROLLBACK, Math.max(MIN_TERMINAL_SCROLLBACK, stepped));
}

function initialTerminalScrollback(): number {
	if (typeof window === "undefined") return DEFAULT_TERMINAL_SCROLLBACK;
	const raw = window.localStorage?.getItem(terminalScrollbackStorageKey);
	const parsed = raw === null ? Number.NaN : Number(raw);
	if (!Number.isFinite(parsed)) return DEFAULT_TERMINAL_SCROLLBACK;
	return clampTerminalScrollback(parsed);
}

export function CenterPane({ session, theme, daemonReady, terminalTarget, onSelectWorkerTerminal }: CenterPaneProps) {
	const paneRef = useRef<HTMLDivElement | null>(null);
	const wheelZoomRemainderRef = useRef(0);
	const lastWheelZoomAtRef = useRef(0);
	const [fontSize, setFontSize] = useState(initialTerminalFontSize);
	const [scrollback, setScrollback] = useState(initialTerminalScrollback);
	const [isFullscreen, setIsFullscreen] = useState(false);
	const target = terminalTarget ?? { kind: "worker" };
	// Electron pins scrollback to 0 (tmux owns history), so only expose the
	// control where it has an effect — browser mode.
	const showScrollbackControl = typeof window !== "undefined" && !window.ao;

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

	const updateScrollback = useCallback((delta: number) => {
		setScrollback((current) => {
			const next = clampTerminalScrollback(current + delta);
			window.localStorage?.setItem(terminalScrollbackStorageKey, String(next));
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
			<div className="terminal-toolbar">
				<div className="terminal-toolbar__label">
					<span className="terminal-toolbar__eyebrow">TERMINAL</span>
					<span className="terminal-toolbar__session">{session?.title ?? "No session"}</span>
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
					{showScrollbackControl && (
						<>
							<button
								aria-label="Decrease terminal scrollback"
								className="terminal-toolbar__control"
								disabled={scrollback <= MIN_TERMINAL_SCROLLBACK}
								onClick={() => updateScrollback(-TERMINAL_SCROLLBACK_STEP)}
								title="Decrease terminal scrollback"
								type="button"
							>
								-
							</button>
							<span className="terminal-toolbar__font-size" title="Terminal scrollback (history lines kept)">
								{scrollback.toLocaleString()} sb
							</span>
							<button
								aria-label="Increase terminal scrollback"
								className="terminal-toolbar__control"
								disabled={scrollback >= MAX_TERMINAL_SCROLLBACK}
								onClick={() => updateScrollback(TERMINAL_SCROLLBACK_STEP)}
								title="Increase terminal scrollback"
								type="button"
							>
								+
							</button>
						</>
					)}
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
					scrollback={scrollback}
					session={session}
					terminalTarget={target}
					theme={theme}
				/>
			</div>
		</div>
	);
}
