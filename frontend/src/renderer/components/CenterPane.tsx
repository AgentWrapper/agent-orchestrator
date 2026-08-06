import {
	ChevronLeft,
	ChevronRight,
	Maximize2,
	Minimize2,
	Plus,
	Search,
	Shield,
	Terminal as TerminalIcon,
	X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type WheelEvent } from "react";
import { useTranslation } from "react-i18next";
import { defaultShortcutBindings, shortcutBindingLabel } from "../../shared/shortcuts";
import { useOverflowScroll } from "../hooks/useOverflowScroll";
import { useTruncatedText } from "../hooks/useTruncatedText";
import type { ShellTerminal } from "../hooks/useShellTerminals";
import { TERMINAL_FONT_SIZE_DEFAULT, TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_MIN } from "../lib/design-tokens";
import { aoBridge } from "../lib/bridge";
import { isMacPlatform } from "../lib/platform";
import { handleTerminalTabListKeyDown } from "../lib/terminal-tabs";
import { cn } from "../lib/utils";
import type { Theme } from "../stores/ui-store";
import type { TerminalTarget } from "../types/terminal";
import { isOrchestratorSession, type WorkspaceSession } from "../types/workspace";
import { AgentAvatar } from "./AgentAvatar";
import { ShellTerminalTab } from "./ShellTerminalTab";
import { TerminalPane } from "./TerminalPane";
import { Input } from "./ui/input";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuShortcut,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";

type CenterPaneProps = {
	session?: WorkspaceSession;
	/** Tabs pinned to the originating session's private layout. */
	projectSessions?: WorkspaceSession[];
	availableProjectSessions?: WorkspaceSession[];
	tabOwnerSessionId?: string;
	onAddProjectSession?: (session: WorkspaceSession) => void;
	onCloseProjectSession?: (session: WorkspaceSession) => void;
	onSelectProjectSession?: (session: WorkspaceSession) => void;
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
	/** Opens a new standalone shell tab (the "+" at the end of the tab bar). */
	onNewShellTerminal?: () => void;
};

const terminalFontSizeStorageKey = "ao.terminal.fontSize";
const WHEEL_ZOOM_THRESHOLD = 80;
const WHEEL_ZOOM_RESET_MS = 250;
const COMPACT_SESSION_LIMIT = 5;
const isMac = isMacPlatform();
const newTerminalShortcutLabel = shortcutBindingLabel(defaultShortcutBindings("new-shell-terminal", isMac)[0], isMac);

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
	projectSessions,
	availableProjectSessions = [],
	tabOwnerSessionId,
	onAddProjectSession,
	onCloseProjectSession,
	onSelectProjectSession,
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
}: CenterPaneProps) {
	const { t } = useTranslation();
	const paneRef = useRef<HTMLDivElement | null>(null);
	const wheelZoomRemainderRef = useRef(0);
	const lastWheelZoomAtRef = useRef(0);
	const [fontSize, setFontSize] = useState(initialTerminalFontSize);
	const [isFullscreen, setIsFullscreen] = useState(false);
	const [showAllSessions, setShowAllSessions] = useState(false);
	const [sessionSearch, setSessionSearch] = useState("");
	const sessionTabs = projectSessions?.length ? projectSessions : session ? [session] : [];
	const effectiveTabOwnerSessionId = tabOwnerSessionId ?? session?.id;
	const hasMoreSessions = availableProjectSessions.length > COMPACT_SESSION_LIMIT;
	const normalizedSessionSearch = sessionSearch.trim().toLowerCase();
	const filteredSessions = normalizedSessionSearch
		? availableProjectSessions.filter((candidate) =>
				`${candidate.title} ${candidate.workspaceName}`.toLowerCase().includes(normalizedSessionSearch),
			)
		: availableProjectSessions;
	const expandedSessionList = showAllSessions || normalizedSessionSearch.length > 0;
	const visibleSessions = expandedSessionList ? filteredSessions : filteredSessions.slice(0, COMPACT_SESSION_LIMIT);
	const tabOverflowWatch = `${sessionTabs.map((item) => item.id).join("|")}|${shellTerminals
		.map((terminal) => terminal.handleId)
		.join("|")}`;
	const tabsOverflow = useOverflowScroll<HTMLDivElement>(tabOverflowWatch);
	const target = terminalTarget ?? { kind: "worker" };
	const activeTerminalLabel =
		target.kind === "shell"
			? (shellTerminals.find((shell) => shell.handleId === target.handleId)?.title ?? target.title)
			: target.kind === "reviewer"
				? `${t("terminal.reviewer")} · ${target.harness}`
				: session
					? isOrchestratorSession(session)
						? t("shell.orchestrator")
						: session.title
					: t("terminal.noSession");

	useEffect(() => {
		const handleFullscreenChange = () => setIsFullscreen(document.fullscreenElement === paneRef.current);
		document.addEventListener("fullscreenchange", handleFullscreenChange);
		return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
	}, []);

	useEffect(
		() =>
			aoBridge.app.onCloseShellTerminalShortcut(() => {
				if (target.kind === "shell") onCloseShellTerminal?.(target.handleId);
			}),
		[target, onCloseShellTerminal],
	);

	useEffect(() => {
		aoBridge.app.setCloseShellTerminalShortcutEnabled(
			target.kind === "shell" && Boolean(onCloseShellTerminal),
		);
		return () => aoBridge.app.setCloseShellTerminalShortcutEnabled(false);
	}, [target.kind, onCloseShellTerminal]);

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
			className="terminal-pane-frame flex h-full min-h-0 min-w-flex-min flex-col px-px"
			onWheelCapture={handleWheelZoom}
		>
			<div className="flex h-inspector-tabs shrink-0 items-center px-1.5">
				<div className="flex min-w-flex-min flex-1 items-center gap-3">
					<button
						aria-label={t("terminal.scrollTabsLeft")}
						className={cn(
							"inline-flex size-control-sm shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent/50 disabled:pointer-events-none disabled:opacity-0",
							!tabsOverflow.canScrollLeft && "hidden",
						)}
						disabled={!tabsOverflow.canScrollLeft}
						onClick={() => tabsOverflow.scrollByDirection(-1)}
						title={t("terminal.scrollTabsLeft")}
						type="button"
					>
						<ChevronLeft aria-hidden="true" className="size-icon-md" />
					</button>
					{/* Each originating session owns a private set of pinned worker and
					    shell tabs. The + menu is the only way to add to that layout. */}
					<div
						ref={tabsOverflow.ref}
						className="scrollbar-none flex min-w-flex-min flex-1 items-center gap-3 overflow-x-auto"
						onKeyDown={handleTerminalTabListKeyDown}
						role="tablist"
						aria-label={t("terminal.tabsAria")}
					>
						{sessionTabs.length > 0
							? sessionTabs.map((projectSession) => {
									const isCurrent = projectSession.id === session?.id;
									return (
										<SessionPaneTab
											key={projectSession.id}
											isActive={isCurrent && target.kind !== "shell"}
											label={isOrchestratorSession(projectSession) ? t("shell.orchestrator") : projectSession.title}
											provider={projectSession.provider}
											onSelect={isCurrent ? onSelectSessionTerminal : () => onSelectProjectSession?.(projectSession)}
											onClose={
												projectSession.id !== effectiveTabOwnerSessionId
													? () => onCloseProjectSession?.(projectSession)
													: undefined
											}
										/>
									);
								})
							: !session && <span className="font-mono text-control text-passive">{t("terminal.noSession")}</span>}
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
							"inline-flex size-control-sm shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent/50 disabled:pointer-events-none disabled:opacity-0",
							!tabsOverflow.canScrollRight && "hidden",
						)}
						disabled={!tabsOverflow.canScrollRight}
						onClick={() => tabsOverflow.scrollByDirection(1)}
						title={t("terminal.scrollTabsRight")}
						type="button"
					>
						<ChevronRight aria-hidden="true" className="size-icon-md" />
					</button>
					<DropdownMenu
						onOpenChange={(open) => {
							if (!open) {
								setShowAllSessions(false);
								setSessionSearch("");
							}
						}}
					>
						<DropdownMenuTrigger asChild>
							<button
								aria-label={t("terminal.addTab")}
								className="inline-flex size-control-sm shrink-0 items-center justify-center rounded-md bg-interactive-active text-muted-foreground transition-[background,color] duration-fast hover:bg-interactive-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent/50 data-[state=open]:bg-interactive-hover data-[state=open]:text-foreground"
								title={t("terminal.newWithShortcut", { shortcut: newTerminalShortcutLabel })}
								type="button"
							>
								<Plus aria-hidden="true" className="size-icon-md" />
							</button>
						</DropdownMenuTrigger>
						<DropdownMenuContent
							align="end"
							className="w-64 rounded-xl border-border-strong/80 bg-popover/95 p-1.5 shadow-(--shadow-popover) backdrop-blur-xl"
							sideOffset={8}
						>
							<DropdownMenuItem
								className="min-h-8 rounded-lg px-2 py-1.5"
								onSelect={onNewShellTerminal}
							>
								<TerminalIcon aria-hidden="true" className="size-icon-xs!" />
								<span className="min-w-0 flex-1 truncate">{t("shortcut.new-shell-terminal")}</span>
								<DropdownMenuShortcut className="font-mono tracking-normal">
									{newTerminalShortcutLabel}
								</DropdownMenuShortcut>
							</DropdownMenuItem>
							<DropdownMenuSeparator className="mx-0.5 my-1.5" />
							<DropdownMenuLabel className="px-2 pt-0.5 pb-1 text-2xs font-semibold tracking-wide text-passive uppercase">
								{t("command.group.sessions")}
							</DropdownMenuLabel>
							{hasMoreSessions ? (
								<div className="relative px-0.5 pb-1">
									<Search
										aria-hidden="true"
										className="pointer-events-none absolute top-1/2 left-2.5 size-icon-sm -translate-y-1/2 text-passive"
									/>
									<Input
										aria-label={t("terminal.searchSessions")}
										className="h-control-form rounded-lg border-border/70 bg-background/50 pr-2.5 pl-7 text-control"
										onChange={(event) => setSessionSearch(event.target.value)}
										onKeyDown={(event) => event.stopPropagation()}
										placeholder={t("terminal.searchSessions")}
										value={sessionSearch}
									/>
								</div>
							) : null}
							<div className={cn(expandedSessionList && "h-52 overflow-y-auto overscroll-contain")}>
								{visibleSessions.length > 0 ? (
									visibleSessions.map((candidate) => {
										const isOpen = sessionTabs.some((tab) => tab.id === candidate.id);
										return (
											<DropdownMenuItem
												key={candidate.id}
												className="min-h-8 rounded-lg px-2 py-1.5"
												disabled={isOpen}
												onSelect={() => onAddProjectSession?.(candidate)}
											>
												<AgentAvatar
													className="size-icon-xs"
													decorative
													provider={candidate.provider}
												/>
												<span className="min-w-0 flex-1 truncate">{candidate.title}</span>
												<span className="max-w-20 truncate text-micro text-passive">
													{isOpen ? t("inspector.open") : candidate.workspaceName}
												</span>
											</DropdownMenuItem>
										);
									})
								) : (
									<DropdownMenuItem disabled>{t("terminal.noSessionsFound")}</DropdownMenuItem>
								)}
							</div>
							{hasMoreSessions && !expandedSessionList ? (
								<>
									<DropdownMenuSeparator className="mx-0.5 my-1.5" />
									<DropdownMenuItem
										className="justify-center text-foreground"
										onSelect={(event) => {
											event.preventDefault();
											setShowAllSessions(true);
										}}
									>
										{t("terminal.showAllSessions")}
									</DropdownMenuItem>
								</>
							) : null}
						</DropdownMenuContent>
					</DropdownMenu>
						<span aria-hidden="true" className="h-4 w-px shrink-0 bg-border" />
						<div className="flex shrink-0 items-center gap-1 font-mono text-passive/70">
							<button
								aria-label={t("terminal.decreaseFontSize")}
								className="inline-flex size-control-sm items-center justify-center rounded-sm bg-transparent text-control leading-none transition-[background,color,opacity] duration-fast hover:bg-interactive-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent/50 disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-passive"
								disabled={fontSize <= TERMINAL_FONT_SIZE_MIN}
								onClick={() => updateFontSize(-1)}
								title={t("terminal.decreaseFontSize")}
								type="button"
							>
								-
							</button>
							<span
								aria-label={t("terminal.fontSizeAria", { size: fontSize })}
								className="w-font-size-label text-center text-xs font-semibold text-muted-foreground"
							>
								{fontSize}px
							</span>
							<button
								aria-label={t("terminal.increaseFontSize")}
								className="inline-flex size-control-sm items-center justify-center rounded-sm bg-transparent text-control leading-none transition-[background,color,opacity] duration-fast hover:bg-interactive-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent/50 disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-passive"
								disabled={fontSize >= TERMINAL_FONT_SIZE_MAX}
								onClick={() => updateFontSize(1)}
								title={t("terminal.increaseFontSize")}
								type="button"
							>
								+
							</button>
							<button
								aria-label={isFullscreen ? t("terminal.exitFullscreenAria") : t("terminal.openFullscreenAria")}
								aria-pressed={isFullscreen}
								className="inline-flex size-control-sm items-center justify-center rounded-sm bg-transparent text-control leading-none transition-[background,color] duration-fast hover:bg-interactive-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent/50"
								onClick={() => void toggleFullscreen()}
								title={isFullscreen ? t("terminal.exitFullscreen") : t("terminal.fullscreen")}
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
			<div aria-label={t("terminal.panelAria", { title: activeTerminalLabel })} className="relative min-h-0 flex-1" role="tabpanel">
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
	provider: string;
	isActive: boolean;
	onSelect?: () => void;
	onClose?: () => void;
};

// Shared tab chrome: the open tab is highlighted with the same rounded
// background as the inspector rail tabs (Summary · Reviews · Browser), and
// the full label only becomes the hover tooltip when the tab strip is
// crowded enough to truncate it.
function SessionPaneTab({ label, provider, isActive, onSelect, onClose }: SessionPaneTabProps) {
	const { t } = useTranslation();
	const { ref, isTruncated } = useTruncatedText<HTMLButtonElement>(label);
	return (
		<span
			className={cn(
				"session-pane-tab group relative inline-flex items-center rounded-md transition-colors",
				isActive
					? "bg-interactive-active after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-foreground/65"
					: "hover:bg-interactive-hover/60",
			)}
		>
			<button
				ref={ref}
				aria-current={isActive}
				aria-selected={isActive}
				className={cn(
					"session-pane-tab__label inline-flex min-w-flex-min max-w-shell-tab-max items-center gap-1 overflow-hidden font-mono font-semibold transition-colors",
					isActive ? "text-foreground" : "text-passive/60 hover:text-passive",
				)}
				onClick={onSelect}
				role="tab"
				tabIndex={isActive ? 0 : -1}
				title={isTruncated ? label : t("terminal.sessionAria")}
				type="button"
			>
				<AgentAvatar className="size-icon-xs" decorative provider={provider} />
				<span className="truncate">{label}</span>
			</button>
			{onClose ? (
				<button
					aria-label={t("terminal.closeSessionTab", { label })}
					className="inline-flex size-control-xs shrink-0 items-center justify-center rounded-sm text-passive opacity-0 transition-[background,color,opacity] group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-interactive-hover hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent/50"
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
