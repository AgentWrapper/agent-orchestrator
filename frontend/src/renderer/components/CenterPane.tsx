import {
	ChevronLeft,
	ChevronRight,
	Maximize2,
	Minimize2,
	Pin,
	Plus,
	Search,
	Shield,
	Terminal as TerminalIcon,
	X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type DragEvent, type WheelEvent } from "react";
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

type ReorderableTerminalTab =
	| { id: string; kind: "session"; session: WorkspaceSession }
	| { id: string; kind: "shell"; shell: ShellTerminal };

function sessionTerminalTabId(sessionId: string): string {
	return `session:${sessionId}`;
}

function shellTerminalTabId(handleId: string): string {
	return `shell:${handleId}`;
}

function orderedTerminalTabs(tabs: ReorderableTerminalTab[], order: string[]): ReorderableTerminalTab[] {
	const byId = new Map(tabs.map((tab) => [tab.id, tab]));
	const ordered = order.flatMap((id) => {
		const tab = byId.get(id);
		if (!tab) return [];
		byId.delete(id);
		return [tab];
	});
	return [...ordered, ...byId.values()];
}

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
	const draggedTerminalTabIdRef = useRef<string | null>(null);
	const [fontSize, setFontSize] = useState(initialTerminalFontSize);
	const [isFullscreen, setIsFullscreen] = useState(false);
	const [terminalTabOrder, setTerminalTabOrder] = useState<string[]>([]);
	const [pinnedTerminalTabIds, setPinnedTerminalTabIds] = useState<string[]>([]);
	const [draggedTerminalTabId, setDraggedTerminalTabId] = useState<string | null>(null);
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
	const ownerSessionTab =
		sessionTabs.find((projectSession) => projectSession.id === effectiveTabOwnerSessionId) ?? sessionTabs[0];
	const reorderableTerminalTabs: ReorderableTerminalTab[] = [
		...sessionTabs
			.filter((projectSession) => projectSession.id !== ownerSessionTab?.id)
			.map((projectSession) => ({
				id: sessionTerminalTabId(projectSession.id),
				kind: "session" as const,
				session: projectSession,
			})),
		...shellTerminals.map((shell) => ({
			id: shellTerminalTabId(shell.handleId),
			kind: "shell" as const,
			shell,
		})),
	];
	const orderedTabs = orderedTerminalTabs(reorderableTerminalTabs, terminalTabOrder);
	const pinnedTabIds = new Set(pinnedTerminalTabIds);
	const pinnedTabs = orderedTabs.filter((tab) => pinnedTabIds.has(tab.id));
	const unpinnedTabs = orderedTabs.filter((tab) => !pinnedTabIds.has(tab.id));
	const visibleTerminalTabs = [
		...pinnedTabs.map((tab) => ({ ...tab, isPinned: true })),
		...(ownerSessionTab
			? [{ id: `owner:${ownerSessionTab.id}`, kind: "owner" as const, session: ownerSessionTab }]
			: []),
		...unpinnedTabs.map((tab) => ({ ...tab, isPinned: false })),
	];
	const tabOverflowWatch = visibleTerminalTabs.map((tab) => tab.id).join("|");
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

	const moveTerminalTab = (targetTabId: string) => {
		const sourceTabId = draggedTerminalTabIdRef.current;
		if (!sourceTabId || sourceTabId === targetTabId) return;
		setTerminalTabOrder((currentOrder) => {
			const nextOrder = orderedTerminalTabs(reorderableTerminalTabs, currentOrder).map((tab) => tab.id);
			const sourceIndex = nextOrder.indexOf(sourceTabId);
			const targetIndex = nextOrder.indexOf(targetTabId);
			if (sourceIndex < 0 || targetIndex < 0) return currentOrder;
			nextOrder.splice(sourceIndex, 1);
			nextOrder.splice(targetIndex, 0, sourceTabId);
			return nextOrder;
		});
	};

	const beginTerminalTabDrag = (event: DragEvent<HTMLSpanElement>, tabId: string) => {
		event.dataTransfer.effectAllowed = "move";
		event.dataTransfer.setData("text/plain", tabId);
		draggedTerminalTabIdRef.current = tabId;
		setDraggedTerminalTabId(tabId);
	};

	const endTerminalTabDrag = () => {
		draggedTerminalTabIdRef.current = null;
		setDraggedTerminalTabId(null);
	};

	const toggleTerminalTabPinned = (tabId: string) => {
		const shouldPin = !pinnedTerminalTabIds.includes(tabId);
		setPinnedTerminalTabIds((current) =>
			current.includes(tabId) ? current.filter((currentId) => currentId !== tabId) : [...current, tabId],
		);
		if (!shouldPin) return;
		setTerminalTabOrder((currentOrder) => {
			const nextOrder = orderedTerminalTabs(reorderableTerminalTabs, currentOrder)
				.map((tab) => tab.id)
				.filter((currentId) => currentId !== tabId);
			return [tabId, ...nextOrder];
		});
		tabsOverflow.ref.current?.scrollTo?.({ left: 0 });
	};

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
					{/* Each originating session owns a private set of worker and shell
					    tabs. The + menu adds tabs; pinning moves an added tab to the left. */}
					<div
						ref={tabsOverflow.ref}
						className="scrollbar-none flex min-w-flex-min flex-1 items-center gap-3 overflow-x-auto"
						onKeyDown={handleTerminalTabListKeyDown}
						role="tablist"
						aria-label={t("terminal.tabsAria")}
					>
						{visibleTerminalTabs.length > 0
							? visibleTerminalTabs.map((tab) => {
									if (tab.kind === "owner") {
										const isCurrent = tab.session.id === session?.id;
										return (
											<SessionPaneTab
												key={tab.id}
												isActive={isCurrent && target.kind !== "shell"}
												label={isOrchestratorSession(tab.session) ? t("shell.orchestrator") : tab.session.title}
												onSelect={isCurrent ? onSelectSessionTerminal : () => onSelectProjectSession?.(tab.session)}
												provider={tab.session.provider}
											/>
										);
									}

									const dragProps = {
										draggable: true,
										isDragging: draggedTerminalTabId === tab.id,
										onDragEnd: endTerminalTabDrag,
										onDragEnter: () => moveTerminalTab(tab.id),
										onDragOver: (event: DragEvent<HTMLSpanElement>) => {
											if (!draggedTerminalTabIdRef.current) return;
											event.preventDefault();
											event.dataTransfer.dropEffect = "move";
										},
										onDragStart: (event: DragEvent<HTMLSpanElement>) => beginTerminalTabDrag(event, tab.id),
										onDrop: (event: DragEvent<HTMLSpanElement>) => event.preventDefault(),
									};

									if (tab.kind === "session") {
										const isCurrent = tab.session.id === session?.id;
										return (
											<SessionPaneTab
												key={tab.id}
												{...dragProps}
												isActive={isCurrent && target.kind !== "shell"}
												isPinned={tab.isPinned}
												label={isOrchestratorSession(tab.session) ? t("shell.orchestrator") : tab.session.title}
												onClose={() => onCloseProjectSession?.(tab.session)}
												onSelect={isCurrent ? onSelectSessionTerminal : () => onSelectProjectSession?.(tab.session)}
												onTogglePinned={() => toggleTerminalTabPinned(tab.id)}
												provider={tab.session.provider}
											/>
										);
									}

									return (
										<ShellTerminalTab
											key={tab.id}
											{...dragProps}
											appearance="connected"
											isActive={target.kind === "shell" && target.handleId === tab.shell.handleId}
											isPinned={tab.isPinned}
											onClose={() => onCloseShellTerminal?.(tab.shell.handleId)}
											onRename={
												onRenameShellTerminal
													? (title) => onRenameShellTerminal(tab.shell.handleId, title)
													: undefined
											}
											onSelect={() => onSelectShellTerminal?.(tab.shell.handleId)}
											onTogglePinned={() => toggleTerminalTabPinned(tab.id)}
											shell={tab.shell}
										/>
									);
								})
							: !session && <span className="font-mono text-control text-passive">{t("terminal.noSession")}</span>}
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
	draggable?: boolean;
	isDragging?: boolean;
	isPinned?: boolean;
	onSelect?: () => void;
	onClose?: () => void;
	onTogglePinned?: () => void;
	onDragStart?: (event: DragEvent<HTMLSpanElement>) => void;
	onDragEnter?: (event: DragEvent<HTMLSpanElement>) => void;
	onDragOver?: (event: DragEvent<HTMLSpanElement>) => void;
	onDrop?: (event: DragEvent<HTMLSpanElement>) => void;
	onDragEnd?: (event: DragEvent<HTMLSpanElement>) => void;
};

// Shared tab chrome: the open tab is highlighted with the same rounded
// background as the inspector rail tabs (Summary · Reviews · Browser), and
// the full label only becomes the hover tooltip when the tab strip is
// crowded enough to truncate it.
function SessionPaneTab({
	label,
	provider,
	isActive,
	draggable = false,
	isDragging = false,
	isPinned = false,
	onSelect,
	onClose,
	onTogglePinned,
	onDragStart,
	onDragEnter,
	onDragOver,
	onDrop,
	onDragEnd,
}: SessionPaneTabProps) {
	const { t } = useTranslation();
	const { ref, isTruncated } = useTruncatedText<HTMLButtonElement>(label);
	return (
		<span
			className={cn(
				"session-pane-tab group relative inline-flex items-center rounded-md transition-colors",
				draggable && "cursor-grab active:cursor-grabbing",
				isDragging && "opacity-45",
				isActive
					? "bg-interactive-active after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-foreground/65"
					: "hover:bg-interactive-hover/60",
			)}
			draggable={draggable}
			onDragEnd={onDragEnd}
			onDragEnter={onDragEnter}
			onDragOver={onDragOver}
			onDragStart={onDragStart}
			onDrop={onDrop}
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
			{onTogglePinned ? (
				<button
					aria-label={t(isPinned ? "terminal.unpinTab" : "terminal.pinTab", { title: label })}
					className={cn(
						"inline-flex h-control-sm shrink-0 items-center justify-center overflow-hidden rounded-sm text-passive transition-[width,margin,background,color,opacity] hover:bg-interactive-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent/50",
						isPinned
							? "ml-1 w-control-xs opacity-100"
							: "ml-0 w-0 opacity-0 group-hover:ml-1 group-hover:w-control-xs group-hover:opacity-100 group-focus-within:ml-1 group-focus-within:w-control-xs group-focus-within:opacity-100",
					)}
					draggable={false}
					onClick={(event) => {
						event.stopPropagation();
						onTogglePinned();
					}}
					title={t(isPinned ? "terminal.unpinTab" : "terminal.pinTab", { title: label })}
					type="button"
				>
					<Pin aria-hidden="true" className={cn("size-icon-xs", isPinned && "fill-current")} />
				</button>
			) : null}
			{onClose ? (
				<button
					aria-label={t("terminal.closeSessionTab", { label })}
					className="inline-flex size-control-xs shrink-0 items-center justify-center rounded-sm text-passive opacity-0 transition-[background,color,opacity] group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-interactive-hover hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent/50"
					onClick={(event) => {
						event.stopPropagation();
						onClose();
					}}
					draggable={false}
					type="button"
				>
					<X aria-hidden="true" className="size-icon-sm" />
				</button>
			) : null}
		</span>
	);
}
