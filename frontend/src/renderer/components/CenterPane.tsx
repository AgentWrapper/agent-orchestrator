import { ChevronLeft, Maximize2, Minimize2, Shield } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type WheelEvent } from "react";
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
const DEFAULT_TERMINAL_FONT_SIZE = 12;
const MIN_TERMINAL_FONT_SIZE = 10;
const MAX_TERMINAL_FONT_SIZE = 20;
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
	return Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, size));
}

function initialTerminalFontSize(): number {
	if (typeof window === "undefined") return DEFAULT_TERMINAL_FONT_SIZE;
	const raw = window.localStorage?.getItem(terminalFontSizeStorageKey);
	const parsed = raw === null ? Number.NaN : Number(raw);
	if (!Number.isFinite(parsed)) return DEFAULT_TERMINAL_FONT_SIZE;
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
				<div className="terminal-toolbar__controls">
					<button
						aria-label="Decrease terminal font size"
						className="terminal-toolbar__control"
						disabled={fontSize <= MIN_TERMINAL_FONT_SIZE}
						onClick={() => updateFontSize(-1)}
						title="Decrease terminal font size"
						type="button"
					>
						-
					</button>
					<span className="terminal-toolbar__font-size">{fontSize}px</span>
					<button
						aria-label="Increase terminal font size"
						className="terminal-toolbar__control"
						disabled={fontSize >= MAX_TERMINAL_FONT_SIZE}
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
						className="terminal-toolbar__control terminal-toolbar__control--icon"
						onClick={() => void toggleFullscreen()}
						title={isFullscreen ? "Exit fullscreen" : "Fullscreen terminal"}
						type="button"
					>
						{isFullscreen ? (
							<Minimize2 className="h-3.5 w-3.5" aria-hidden="true" />
						) : (
							<Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
						)}
					</button>
				</div>
			</div>
			{target.kind === "reviewer" ? (
				<div className="reviewer-terminal-header">
					<button
						aria-label="Back to agent terminal"
						className="reviewer-terminal-header__back"
						onClick={onSelectWorkerTerminal}
						type="button"
					>
						<ChevronLeft aria-hidden="true" />
						<span>agent</span>
					</button>
					<span className="reviewer-terminal-header__role">
						<Shield aria-hidden="true" />
						Reviewer
					</span>
					<span className="reviewer-terminal-header__harness">{target.harness}</span>
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
