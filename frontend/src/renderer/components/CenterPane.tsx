import { ChevronLeft, ChevronRight, Maximize2, Minimize2, Minus, Plus, Shield, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode, type WheelEvent } from "react";
import { useTranslation } from "react-i18next";
import { useOverflowScroll } from "../hooks/useOverflowScroll";
import { useTruncatedText } from "../hooks/useTruncatedText";
import type { ShellTerminal } from "../hooks/useShellTerminals";
import { TERMINAL_FONT_SIZE_DEFAULT, TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_MIN } from "../lib/design-tokens";
import { getAgentActivityView } from "../lib/session-presentation";
import { handleTerminalTabListKeyDown } from "../lib/terminal-tabs";
import { cn } from "../lib/utils";
import type { Theme } from "../stores/ui-store";
import type { TerminalTarget } from "../types/terminal";
import { isOrchestratorSession, type WorkspaceSession } from "../types/workspace";
import { ShellTerminalTab } from "./ShellTerminalTab";
import { TerminalPane } from "./TerminalPane";
import { AgentAvatar } from "./AgentAvatar";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

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
	onRenameShellTerminal?: (handleId: string, title: string) => void;
	/** Opens a new shell tab in this session's worktree (the button at the end of the tab bar). */
	onNewShellTerminal?: () => void;
	/** Session actions consolidated into the terminal bar by SessionView. */
	topbarActions?: ReactNode;
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
	onRenameShellTerminal,
	onNewShellTerminal,
	topbarActions,
}: CenterPaneProps) {
	const { t } = useTranslation();
	const paneRef = useRef<HTMLDivElement | null>(null);
	const wheelZoomRemainderRef = useRef(0);
	const lastWheelZoomAtRef = useRef(0);
	const [fontSize, setFontSize] = useState(initialTerminalFontSize);
	const [isFullscreen, setIsFullscreen] = useState(false);
	const tabOverflowWatch = `${session?.id ?? ""}|${shellTerminals.map((terminal) => terminal.handleId).join("|")}`;
	const tabsOverflow = useOverflowScroll<HTMLDivElement>(tabOverflowWatch);
	const target = terminalTarget ?? { kind: "worker" };
	const sessionTabLabel = session
		? isOrchestratorSession(session)
			? t("shell.orchestrator")
			: session.title
		: t("terminal.noSession");
	const activeTerminalLabel =
		target.kind === "shell"
			? (shellTerminals.find((shell) => shell.handleId === target.handleId)?.title ?? target.title)
			: target.kind === "reviewer"
				? `${t("terminal.reviewer")} · ${target.harness}`
				: sessionTabLabel;

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
			<div className="flex h-inspector-tabs shrink-0 items-stretch border-b border-border bg-background pl-4 pr-3">
				<div className="flex min-w-flex-min flex-1 items-center">
					<button
						aria-label={t("terminal.scrollTabsLeft")}
						className={cn(
							"mr-1 inline-flex size-control-sm shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent/50 disabled:pointer-events-none disabled:opacity-0",
							!tabsOverflow.canScrollLeft && "invisible",
						)}
						disabled={!tabsOverflow.canScrollLeft}
						onClick={() => tabsOverflow.scrollByDirection(-1)}
						title={t("terminal.scrollTabsLeft")}
						type="button"
					>
						<ChevronLeft aria-hidden="true" className="size-icon-md" />
					</button>
					{/* The session's own pane plus the shells opened from this strip; the
					    terminal button at the end adds a shell in the session's worktree. */}
					<div
						ref={tabsOverflow.ref}
						aria-label={t("terminal.tabsAria")}
						className="scrollbar-none flex min-w-flex-min flex-1 self-stretch items-end gap-1 overflow-x-auto pt-1.5"
						onKeyDown={handleTerminalTabListKeyDown}
						role="tablist"
					>
						{session ? (
							<SessionPaneTab
								isActive={target.kind !== "shell"}
								label={sessionTabLabel}
								onSelect={onSelectSessionTerminal}
								session={session}
							/>
						) : (
							<SessionPaneTab isActive={target.kind !== "shell"} label={sessionTabLabel} />
						)}
						{shellTerminals.map((shell) => (
							<ShellTerminalTab
								key={shell.handleId}
								appearance="connected"
								isActive={target.kind === "shell" && target.handleId === shell.handleId}
								onClose={() => onCloseShellTerminal?.(shell.handleId)}
								onRename={onRenameShellTerminal ? (title) => onRenameShellTerminal(shell.handleId, title) : undefined}
								onSelect={() => onSelectShellTerminal?.(shell.handleId)}
								shell={shell}
							/>
						))}
					</div>
					<button
						aria-label={t("terminal.scrollTabsRight")}
						className={cn(
							"mx-1 inline-flex size-control-sm shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent/50 disabled:pointer-events-none disabled:opacity-0",
							!tabsOverflow.canScrollRight && "invisible",
						)}
						disabled={!tabsOverflow.canScrollRight}
						onClick={() => tabsOverflow.scrollByDirection(1)}
						title={t("terminal.scrollTabsRight")}
						type="button"
					>
						<ChevronRight aria-hidden="true" className="size-icon-md" />
					</button>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								aria-label={t("shortcut.new-shell-terminal")}
								className="h-control-md shrink-0 gap-1.5 px-2.5"
								disabled={!onNewShellTerminal}
								onClick={onNewShellTerminal}
								size="sm"
								type="button"
								variant="ghost"
							>
								<Plus aria-hidden="true" className="size-icon-md" />
								<span>{t("shortcut.new-shell-terminal")}</span>
							</Button>
						</TooltipTrigger>
						<TooltipContent>{t("terminal.newWithShortcut", { shortcut: "Ctrl+Shift+`" })}</TooltipContent>
					</Tooltip>
				</div>
				<div
					aria-label={t("terminal.controlsAria")}
					className="ml-2 flex shrink-0 items-center gap-0.5 border-l border-border/70 pl-2"
					role="toolbar"
				>
					<TerminalControl
						disabled={fontSize <= TERMINAL_FONT_SIZE_MIN}
						label={t("terminal.decreaseFontSize")}
						onClick={() => updateFontSize(-1)}
					>
						<Minus aria-hidden="true" className="size-icon-sm" />
					</TerminalControl>
					<span
						aria-label={t("terminal.fontSizeAria", { size: fontSize })}
						className="w-font-size-label text-center font-mono text-micro tabular-nums text-muted-foreground"
					>
						{fontSize}px
					</span>
					<TerminalControl
						disabled={fontSize >= TERMINAL_FONT_SIZE_MAX}
						label={t("terminal.increaseFontSize")}
						onClick={() => updateFontSize(1)}
					>
						<Plus aria-hidden="true" className="size-icon-sm" />
					</TerminalControl>
					<div aria-hidden="true" className="mx-1 h-4 w-px bg-border/70" />
					<TerminalControl
						isPressed={isFullscreen}
						label={isFullscreen ? t("terminal.exitFullscreen") : t("terminal.fullscreen")}
						onClick={() => void toggleFullscreen()}
					>
						{isFullscreen ? (
							<Minimize2 aria-hidden="true" className="size-icon-md" />
						) : (
							<Maximize2 aria-hidden="true" className="size-icon-md" />
						)}
					</TerminalControl>
				</div>
				{topbarActions ? (
					<div className="ml-2 flex shrink-0 items-center border-l border-border/70 pl-2">{topbarActions}</div>
				) : null}
			</div>
			{target.kind === "reviewer" ? (
				<div className="flex h-toolbar shrink-0 items-center gap-3 border-b border-border px-4">
					<button
						aria-label={t("terminal.backToAgent")}
						className="inline-flex h-control-board-sm items-center gap-1.5 rounded-md border border-border bg-transparent px-2.5 text-xs font-semibold leading-none text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground"
						onClick={onSelectWorkerTerminal}
						type="button"
					>
						<ChevronLeft aria-hidden="true" className="size-icon-lg" />
						<span>{t("terminal.agent")}</span>
					</button>
					<span className="inline-flex items-center gap-1.5 font-mono text-xs font-semibold text-success-bright">
						<Shield aria-hidden="true" className="size-icon-lg" />
						{t("terminal.reviewer")}
					</span>
					<span className="ml-auto truncate font-mono text-xs text-passive">{target.harness}</span>
				</div>
			) : null}
			<div
				aria-label={t("terminal.panelAria", { title: activeTerminalLabel })}
				className="relative min-h-0 flex-1"
				role="tabpanel"
			>
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

type SessionPaneTabProps = {
	label: string;
	isActive: boolean;
	onSelect?: () => void;
	onClose?: () => void;
	session?: WorkspaceSession;
};

// Connected terminal-tab chrome: the open tab visually joins the terminal
// canvas, while the full label becomes a tooltip only when it is truncated.
function SessionPaneTab({ label, isActive, onSelect, onClose, session }: SessionPaneTabProps) {
	const { t } = useTranslation();
	const { ref, isTruncated } = useTruncatedText<HTMLButtonElement>(label);
	const activity = session ? getAgentActivityView(session.activity, t) : undefined;
	return (
		<span
			className={cn(
				"group relative inline-flex h-8 min-w-shell-tab-min items-center gap-1 rounded-t-md border px-2 transition-colors",
				isActive
					? "border-border border-b-terminal bg-terminal text-foreground before:absolute before:inset-x-2 before:top-0 before:h-px before:bg-accent"
					: "border-transparent text-passive hover:bg-interactive-hover/60 hover:text-foreground",
			)}
		>
			{session ? <AgentAvatar className="size-icon-base" decorative provider={session.provider} /> : null}
			<button
				ref={ref}
				aria-current={isActive}
				aria-label={activity ? `${label} · ${activity.label}` : label}
				aria-selected={isActive}
				className={cn(
					"inline-flex min-w-flex-min max-w-shell-tab-max items-center gap-1.5 text-control font-normal transition-colors",
					isActive ? "text-foreground" : "text-passive group-hover:text-foreground",
				)}
				onClick={onSelect}
				role="tab"
				tabIndex={isActive ? 0 : -1}
				title={isTruncated ? label : t("terminal.sessionAria")}
				type="button"
			>
				<span className="truncate">{label}</span>
				{activity ? (
					<span
						aria-hidden="true"
						className="inline-flex shrink-0 items-center"
						style={{ color: activity.tone }}
						title={activity.label}
					>
						<span
							className={cn("size-1.5 rounded-full", activity.breathe && "animate-status-pulse")}
							style={{ background: activity.tone }}
						/>
					</span>
				) : null}
			</button>
			{onClose ? (
				<button
					aria-label={t("terminal.closeSessionTab", { label })}
					className="inline-flex size-control-sm shrink-0 items-center justify-center rounded-sm text-passive opacity-0 transition-[background,color,opacity] group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-interactive-hover hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent/50"
					onClick={(event) => {
						event.stopPropagation();
						onClose();
					}}
					type="button"
				>
					<X aria-hidden="true" className="size-icon-sm" />
				</button>
			) : null}
		</span>
	);
}

type TerminalControlProps = {
	children: ReactNode;
	disabled?: boolean;
	isPressed?: boolean;
	label: string;
	onClick: () => void;
};

function TerminalControl({ children, disabled, isPressed, label, onClick }: TerminalControlProps) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					aria-label={label}
					aria-pressed={isPressed}
					className="size-control-sm p-0 text-passive"
					disabled={disabled}
					onClick={onClick}
					size="icon-sm"
					type="button"
					variant="ghost"
				>
					{children}
				</Button>
			</TooltipTrigger>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}
