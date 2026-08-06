import {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
	type CSSProperties,
	type HTMLAttributes,
} from "react";
import { useTranslation } from "react-i18next";
import {
	DndContext,
	KeyboardSensor,
	PointerSensor,
	closestCenter,
	useSensor,
	useSensors,
	type DragEndEvent,
} from "@dnd-kit/core";
import {
	SortableContext,
	arrayMove,
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Globe2, Plus, X } from "lucide-react";
import type { BrowserTabState } from "../../main/browser-view-host";
import { MAX_BROWSER_TABS } from "../../shared/browser-tabs";
import { browserTabLabel } from "../lib/browser-tab-label";
import { useResizable } from "../hooks/useResizable";
import { cn } from "../lib/utils";

const RAIL_DEFAULT_WIDTH = 220;
const RAIL_MIN_WIDTH = 180;
const RAIL_MAX_WIDTH = 320;
const HOVER_OPEN_DELAY_MS = 150;
const HOVER_CLOSE_DELAY_MS = 140;

export type BrowserTabsRailHandle = {
	// Lets the toolbar's "+" button (outside the rail) force the hover flyout
	// closed before creating a tab, the same safeguard rows inside the rail
	// already get — see the comment above handleSelectTab/handleCloseTab.
	closeFlyout: () => void;
};

type BrowserTabsRailProps = {
	tabs: BrowserTabState[];
	activeTabId: string;
	poppedOut: boolean;
	onSelectTab: (tabId: string) => Promise<void>;
	onCloseTab: (tabId: string) => Promise<void>;
	onOpenTab: () => Promise<void>;
	onReorderTabs: (orderedIds: string[]) => void;
	onFlyoutOpenChange: (open: boolean) => void;
};

export const BrowserTabsRail = forwardRef<BrowserTabsRailHandle, BrowserTabsRailProps>(function BrowserTabsRail(
	{ tabs, activeTabId, poppedOut, onSelectTab, onCloseTab, onOpenTab, onReorderTabs, onFlyoutOpenChange },
	ref,
) {
	const { t } = useTranslation();
	const [flyoutOpen, setFlyoutOpen] = useState(false);
	const openTimerRef = useRef<number | null>(null);
	const closeTimerRef = useRef<number | null>(null);
	// Docked is always icon-only with a hover preview; only popped-out/fullscreen
	// (which has room to spare) is permanently expanded — there's no user-facing
	// "pin it open while docked" mode. Docked sits on the right of the viewport
	// (out of the way of the address bar); popped-out stays on the left.
	const expanded = poppedOut;

	const { onPointerDown: onResizePointerDown, onDoubleClick: onResizeDoubleClick } = useResizable({
		cssVar: "--ao-browser-tabs-w",
		storageKey: "ao-browser-tabs-w",
		defaultWidth: RAIL_DEFAULT_WIDTH,
		min: RAIL_MIN_WIDTH,
		max: RAIL_MAX_WIDTH,
		// The resize handle only ever renders in popped-out mode, which keeps
		// the rail on the left with the handle on its own right edge — grows
		// when dragged rightward, away from the viewport.
		edge: "right",
	});

	const clearOpenTimer = useCallback(() => {
		if (openTimerRef.current === null) return;
		window.clearTimeout(openTimerRef.current);
		openTimerRef.current = null;
	}, []);

	const clearCloseTimer = useCallback(() => {
		if (closeTimerRef.current === null) return;
		window.clearTimeout(closeTimerRef.current);
		closeTimerRef.current = null;
	}, []);

	const openFlyout = useCallback(
		(immediate = false) => {
			if (expanded) return;
			clearCloseTimer();
			if (flyoutOpen || openTimerRef.current !== null) return;
			// Warm the mirror frame now, not when the flyout box actually appears:
			// the native view parks (and visually disappears) the instant
			// data-state flips to "open", but the replacement screenshot is an
			// async capture — starting it here overlaps that round trip with the
			// hover-intent delay below, so by the time the box shows, the parked
			// swap already has a frame ready instead of a blank flash first. The
			// native view still paints over this frame's <img> until it's
			// actually parked, so warming early is invisible either way.
			onFlyoutOpenChange(true);
			const apply = () => {
				openTimerRef.current = null;
				setFlyoutOpen(true);
			};
			if (immediate) {
				apply();
				return;
			}
			openTimerRef.current = window.setTimeout(apply, HOVER_OPEN_DELAY_MS);
		},
		[clearCloseTimer, expanded, flyoutOpen, onFlyoutOpenChange],
	);

	const closeFlyout = useCallback(
		(immediate = false) => {
			clearOpenTimer();
			if (!flyoutOpen) return;
			clearCloseTimer();
			const apply = () => {
				closeTimerRef.current = null;
				setFlyoutOpen(false);
			};
			if (immediate) {
				apply();
				return;
			}
			closeTimerRef.current = window.setTimeout(apply, HOVER_CLOSE_DELAY_MS);
		},
		[clearCloseTimer, clearOpenTimer, flyoutOpen],
	);

	useImperativeHandle(ref, () => ({ closeFlyout: () => closeFlyout(true) }), [closeFlyout]);

	// Popping out mid-hover would otherwise leave the flyout mounted open on top
	// of the now-expanded persistent list.
	useEffect(() => {
		if (expanded && flyoutOpen) closeFlyout(true);
	}, [closeFlyout, expanded, flyoutOpen]);

	useEffect(() => () => {
		clearOpenTimer();
		clearCloseTimer();
	}, [clearCloseTimer, clearOpenTimer]);

	// Selecting/closing a tab closes the flyout immediately rather than waiting
	// for the hover-close delay: while the flyout is open the native view is
	// parked and mirrored by a single captured frame (see useBrowserView.ts), so
	// the newly-active tab would otherwise stay invisible — showing the old
	// tab's frozen frame — until the pointer actually leaves the rail. The
	// toolbar's new-tab button gets the same treatment via the closeFlyout
	// handle exposed above.
	const handleSelectTab = useCallback(
		(tabId: string) => {
			closeFlyout(true);
			void onSelectTab(tabId);
		},
		[closeFlyout, onSelectTab],
	);

	const handleCloseTab = useCallback(
		(tabId: string) => {
			closeFlyout(true);
			void onCloseTab(tabId);
		},
		[closeFlyout, onCloseTab],
	);

	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	);

	const handleDragEnd = useCallback(
		(event: DragEndEvent) => {
			const { active, over } = event;
			if (!over || active.id === over.id) return;
			const ids = tabs.map((tab) => tab.id);
			const oldIndex = ids.indexOf(String(active.id));
			const newIndex = ids.indexOf(String(over.id));
			if (oldIndex === -1 || newIndex === -1) return;
			onReorderTabs(arrayMove(ids, oldIndex, newIndex));
		},
		[onReorderTabs, tabs],
	);

	const onlyTab = tabs.length === 1;
	const tabIds = tabs.map((tab) => tab.id);
	const closeTitle = t("browser.onlyTab");
	const canOpenTab = tabs.length < MAX_BROWSER_TABS;

	return (
		<div
			className={cn(
				"browser-tabs-rail relative flex h-full shrink-0 flex-col border-border bg-surface",
				expanded ? "border-r" : "border-l",
				expanded ? "w-(--ao-browser-tabs-w)" : "w-8",
			)}
			data-testid="browser-tabs-rail"
			onBlur={
				!expanded
					? (event) => {
							if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
							closeFlyout();
						}
					: undefined
			}
			onFocus={!expanded ? () => openFlyout(true) : undefined}
			onPointerEnter={!expanded ? () => openFlyout() : undefined}
			onPointerLeave={!expanded ? () => closeFlyout() : undefined}
		>
			{/* Docked keeps "+" in the toolbar (BrowserPanel.tsx) — putting it here
			    too would add a header row this rail's nav doesn't have, breaking the
			    icon-rail/flyout alignment above. Popped-out has no flyout to keep in
			    sync, so it's free to live here instead, full-width like a tab row. */}
			{expanded ? (
				<button
					aria-label={t("browser.openNewTab")}
					className={cn(
						"flex h-8 w-full shrink-0 items-center gap-1.5 border-b border-border p-1.5 text-left text-sm transition-colors",
						"text-muted-foreground hover:bg-interactive-hover hover:text-foreground",
						"disabled:pointer-events-none disabled:opacity-50",
					)}
					disabled={!canOpenTab}
					onClick={() => void onOpenTab()}
					type="button"
				>
					<Plus aria-hidden="true" className="size-icon-base shrink-0" />
					<span className="truncate">{t("browser.newTab")}</span>
				</button>
			) : null}
			<nav aria-label={t("browser.tabsAria", { count: tabs.length })} className="min-h-0 flex-1 overflow-y-auto">
				<DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd} sensors={sensors}>
					<SortableContext items={tabIds} strategy={verticalListSortingStrategy}>
						<div className="flex flex-col">
							{tabs.map((tab) =>
								expanded ? (
									<SortableExpandedTabRow
										active={tab.id === activeTabId}
										closeTitle={closeTitle}
										key={tab.id}
										onClose={() => handleCloseTab(tab.id)}
										onSelect={() => handleSelectTab(tab.id)}
										onlyTab={onlyTab}
										tab={tab}
									/>
								) : (
									<SortableIconTabRow
										active={tab.id === activeTabId}
										closeTitle={closeTitle}
										key={tab.id}
										onClose={() => handleCloseTab(tab.id)}
										onSelect={() => handleSelectTab(tab.id)}
										onlyTab={onlyTab}
										tab={tab}
									/>
								),
							)}
						</div>
					</SortableContext>
				</DndContext>
			</nav>
			{expanded ? (
				<div
					className="absolute inset-y-0 right-0 w-1.5 cursor-col-resize touch-none"
					onDoubleClick={onResizeDoubleClick}
					onPointerDown={onResizePointerDown}
				/>
			) : null}
			{/* Kept mounted (not conditionally rendered) so `data-state` alone drives
			    visibility: the existing OPEN_DIALOG_OR_MENU_SELECTOR MutationObserver
			    in useBrowserView.ts already watches role="menu" + data-state="open"
			    anywhere in the document, so toggling this attribute reuses the native
			    view's park/mirror machinery with no changes there. Positioned
			    relative to this same rail root that `<nav>` fills top-to-bottom, so
			    the two row lists start at the exact same y with no separate spacer. */}
			{!expanded ? (
				<div
					className={cn(
						"absolute inset-y-0 right-full z-chrome w-56 overflow-hidden border border-border bg-card shadow-(--shadow-popover)",
						"transition-[opacity,transform] duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
						"data-[state=closed]:pointer-events-none data-[state=closed]:opacity-0 data-[state=closed]:-translate-x-3",
						"data-[state=open]:opacity-100 data-[state=open]:translate-x-0",
					)}
					data-state={flyoutOpen ? "open" : "closed"}
					data-testid="browser-tabs-flyout"
					role="menu"
				>
					<div className="flex h-full flex-col overflow-y-auto">
						{tabs.map((tab) => (
							<ExpandedTabRow
								active={tab.id === activeTabId}
								closeTitle={closeTitle}
								key={tab.id}
								onClose={() => handleCloseTab(tab.id)}
								onSelect={() => handleSelectTab(tab.id)}
								onlyTab={onlyTab}
								tab={tab}
							/>
						))}
					</div>
				</div>
			) : null}
		</div>
	);
});

type RowChrome = {
	setNodeRef?: (node: HTMLElement | null) => void;
	style?: CSSProperties;
	dragProps?: HTMLAttributes<HTMLElement>;
};

type TabRowProps = {
	tab: BrowserTabState;
	active: boolean;
	onlyTab: boolean;
	onSelect: () => void;
	onClose: () => void;
	closeTitle: string;
	chrome?: RowChrome;
};

function TabFavicon({ className, tab }: { className: string; tab: BrowserTabState }) {
	// object-cover guarantees containment regardless of the source image's own
	// aspect ratio (some sites' favicons aren't perfectly square), so it can
	// never spill past its box into the row next to it.
	if (tab.favicon) return <img alt="" className={cn("shrink-0 object-cover", className)} src={tab.favicon} />;
	return <Globe2 aria-hidden="true" className={cn("shrink-0 text-passive", className)} />;
}

function IconTabRow({ active, chrome, onSelect, tab }: TabRowProps) {
	const label = browserTabLabel(tab.title, tab.url);
	return (
		<button
			aria-current={active ? "true" : undefined}
			aria-label={`${label.title} — ${label.subtitle}`}
			className={cn(
				"flex h-8 w-full items-center justify-center overflow-hidden p-1.5 transition-colors",
				"hover:bg-interactive-hover",
				active && "bg-interactive-active",
			)}
			onClick={onSelect}
			ref={chrome?.setNodeRef}
			style={chrome?.style}
			type="button"
			{...chrome?.dragProps}
		>
			<TabFavicon className="size-icon-base" tab={tab} />
		</button>
	);
}

function ExpandedTabRow({ active, chrome, closeTitle, onClose, onSelect, onlyTab, tab }: TabRowProps) {
	const { t } = useTranslation();
	const label = browserTabLabel(tab.title, tab.url);
	const closeLabel = t("browser.closeTab", { title: label.title });
	return (
		<div
			className={cn(
				"group/tab-row flex h-8 w-full items-center overflow-hidden transition-colors",
				"hover:bg-interactive-hover",
				active && "bg-interactive-active",
			)}
			ref={chrome?.setNodeRef}
			style={chrome?.style}
			{...chrome?.dragProps}
		>
			<button
				className="flex min-w-0 flex-1 items-center gap-1.5 p-1.5 text-left outline-hidden"
				onClick={onSelect}
				type="button"
			>
				<TabFavicon className="size-icon-base shrink-0" tab={tab} />
				<span
					className={cn(
						"min-w-0 flex-1 truncate text-sm",
						active ? "text-foreground" : "text-muted-foreground group-hover/tab-row:text-foreground",
					)}
				>
					{label.title}
				</span>
			</button>
			<button
				aria-label={closeLabel}
				className={cn(
					"grid size-5 shrink-0 place-items-center overflow-hidden text-passive opacity-0",
					"transition-opacity hover:bg-interactive-hover hover:text-foreground",
					"group-hover/tab-row:opacity-100 group-focus-within/tab-row:opacity-100",
					"disabled:pointer-events-none",
				)}
				disabled={onlyTab}
				onClick={(event) => {
					event.stopPropagation();
					onClose();
				}}
				title={onlyTab ? closeTitle : closeLabel}
				type="button"
			>
				<X aria-hidden="true" className="size-icon-sm" />
			</button>
		</div>
	);
}

function SortableIconTabRow(props: TabRowProps) {
	const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: props.tab.id });
	const style: CSSProperties = { transform: CSS.Transform.toString(transform), transition };
	return <IconTabRow {...props} chrome={{ dragProps: { ...attributes, ...listeners }, setNodeRef, style }} />;
}

function SortableExpandedTabRow(props: TabRowProps) {
	const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: props.tab.id });
	const style: CSSProperties = { transform: CSS.Transform.toString(transform), transition };
	return <ExpandedTabRow {...props} chrome={{ dragProps: { ...attributes, ...listeners }, setNodeRef, style }} />;
}
