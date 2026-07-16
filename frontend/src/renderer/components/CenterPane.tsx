import { ChevronLeft, ClipboardCheck, Maximize2, MessageSquareText, Minimize2, Shield, SquareTerminal } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type WheelEvent } from "react";
import { TERMINAL_FONT_SIZE_DEFAULT, TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_MIN } from "../lib/design-tokens";
import type { Theme } from "../stores/ui-store";
import type { TerminalTarget } from "../types/terminal";
import {
	isOrchestratorSession,
	isSuggestionDiscussionSession,
	type WorkspaceSession,
} from "../types/workspace";
import { TerminalPane, type OrchestratorViewMode } from "./TerminalPane";
import { OrchestratorAvatar } from "./OrchestratorAvatar";

type CenterPaneProps = {
	session?: WorkspaceSession;
	theme: Theme;
	daemonReady: boolean;
	terminalTarget?: TerminalTarget;
	onSelectWorkerTerminal?: () => void;
	projectSessions?: WorkspaceSession[];
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
	projectSessions = [],
}: CenterPaneProps) {
	const paneRef = useRef<HTMLDivElement | null>(null);
	const wheelZoomRemainderRef = useRef(0);
	const lastWheelZoomAtRef = useRef(0);
	const [fontSize, setFontSize] = useState(initialTerminalFontSize);
	const [isFullscreen, setIsFullscreen] = useState(false);
	const [orchestratorView, setOrchestratorView] = useState<OrchestratorViewMode>("conversation");
	const target = terminalTarget ?? { kind: "worker" };
	const isOrchestrator = Boolean(session && isOrchestratorSession(session) && target.kind !== "reviewer");
	const isSuggestionDiscussion = Boolean(
		session && isSuggestionDiscussionSession(session) && target.kind !== "reviewer",
	);
	const isConversationSession = isOrchestrator || isSuggestionDiscussion;
	const showTerminalControls = !isConversationSession || orchestratorView === "terminal";

	useEffect(() => {
		const handleFullscreenChange = () => setIsFullscreen(document.fullscreenElement === paneRef.current);
		document.addEventListener("fullscreenchange", handleFullscreenChange);
		return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
	}, []);

	useEffect(() => {
		if (isConversationSession) setOrchestratorView("conversation");
	}, [isConversationSession, session?.id]);

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
			<div className="flex h-toolbar shrink-0 items-center border-b border-border bg-background px-5">
				<div className="flex min-w-0 items-center gap-3">
					{isOrchestrator && session ? (
						<>
							<OrchestratorAvatar provider={session.provider} size="sm" />
							<div className="min-w-0 leading-tight">
								<div className="truncate text-xs font-semibold text-foreground">Orbit</div>
								<div className="truncate text-caption text-muted-foreground">Orchestrator</div>
							</div>
						</>
					) : isSuggestionDiscussion && session ? (
						<>
							<OrchestratorAvatar provider={session.provider} size="sm" />
							<div className="min-w-0 leading-tight">
								<div className="truncate text-xs font-semibold text-foreground">Suggestion discussion</div>
								<div className="truncate text-caption text-muted-foreground">{session.provider}</div>
							</div>
						</>
					) : (
						<>
							<span className="shrink-0 font-mono text-caption font-semibold uppercase tracking-wide-lg text-muted-foreground">
								TERMINAL
							</span>
							<span className="min-w-0 truncate font-mono text-control font-semibold text-passive">
								{!session ? "No session" : session.title}
							</span>
						</>
					)}
				</div>
				<div className="ml-auto flex items-center gap-3 font-mono text-passive">
					{isConversationSession && (
						<div className="flex items-center rounded-lg border border-border bg-surface p-0.5">
							<button
								aria-label="Show conversation"
								aria-pressed={orchestratorView === "conversation"}
								className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-caption font-semibold transition ${orchestratorView === "conversation" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
								onClick={() => setOrchestratorView("conversation")}
								type="button"
							>
								<MessageSquareText className="size-3.5" aria-hidden="true" />
								Conversation
							</button>
							{isOrchestrator ? (
								<button
									aria-label="Show review board"
									aria-pressed={orchestratorView === "review"}
									className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-caption font-semibold transition ${orchestratorView === "review" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
									onClick={() => setOrchestratorView("review")}
									type="button"
								>
									<ClipboardCheck className="size-3.5" aria-hidden="true" />
									Review
								</button>
							) : null}
							<button
								aria-label="Show terminal"
								aria-pressed={orchestratorView === "terminal"}
								className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-caption font-semibold transition ${orchestratorView === "terminal" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
								onClick={() => setOrchestratorView("terminal")}
								type="button"
							>
								<SquareTerminal className="size-3.5" aria-hidden="true" />
								Terminal
							</button>
						</div>
					)}
					{showTerminalControls && (
						<>
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
					session={session}
					terminalTarget={target}
					theme={theme}
					viewMode={isConversationSession ? orchestratorView : "terminal"}
					onViewModeChange={setOrchestratorView}
					reviewSessions={projectSessions}
				/>
			</div>
		</div>
	);
}
