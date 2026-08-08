import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
	BrowserAgentActivityState,
	BrowserDevToolsState,
	BrowserMirrorFrame,
	BrowserNavState,
	BrowserRect,
	BrowserTabState,
	BrowserTabsState,
} from "../../main/browser-view-host";
import type { BrowserAnnotationCancelPayload, BrowserAnnotationSubmitPayload } from "../../shared/browser-annotations";
import { OPEN_BROWSER_OVERLAY_SELECTOR } from "../lib/dom-selectors";

export type { BrowserNavState };

export type BrowserVisualTransition = {
	kind: "tab-switch" | "popout";
	snapshotUrl: string;
};

type UseBrowserViewOptions = {
	sessionId: string;
	active: boolean;
	poppedOut: boolean;
	/**
	 * When true, the view is cleared and the daemon-driven preview is suppressed.
	 * Use when the session is terminated: the old preview content should not
	 * remain visible even if the DB still carries a preview_url.
	 */
	terminated?: boolean;
	/**
	 * Preview target driven by the daemon (via `ao preview`, streamed over CDC).
	 * When set, the view navigates here automatically; an empty value clears it.
	 */
	previewUrl?: string;
	/**
	 * Monotonic counter the daemon bumps on every `ao preview` call, even when
	 * previewUrl is unchanged. The view re-navigates whenever it advances, so a
	 * repeated `ao preview <same-url>` still refreshes (and CDC replays of an
	 * unrelated session update, which leave it unchanged, are ignored).
	 */
	previewRevision?: number;
};

export type BrowserViewModel = {
	viewId: string;
	navState: BrowserNavState;
	mirrorFrame: BrowserMirrorFrame | null;
	slotRef: (node: HTMLDivElement | null) => void;
	navigate: (url: string) => Promise<void>;
	goBack: () => Promise<void>;
	goForward: () => Promise<void>;
	reload: () => Promise<void>;
	stop: () => Promise<void>;
	tabs: BrowserTabState[];
	activeTabId: string;
	tabNotice: string;
	selectTab: (tabId: string) => Promise<void>;
	closeTab: (tabId: string) => Promise<void>;
	devtoolsState: BrowserDevToolsState;
	openDevTools: () => Promise<void>;
	closeDevTools: () => Promise<void>;
	prepareForOverlay: () => Promise<void>;
	finishOverlay: () => void;
	visualTransition: BrowserVisualTransition | null;
	agentBrowserActive: boolean;
	agentBrowserActivity: BrowserAgentActivityState | null;
	destroy: () => void;
	annotationMode: boolean;
	setAnnotationMode: (enabled: boolean) => Promise<void>;
};

const EMPTY_NAV_STATE: BrowserNavState = {
	viewId: "",
	url: "",
	title: "",
	canGoBack: false,
	canGoForward: false,
	isLoading: false,
};

const EMPTY_TABS_STATE: BrowserTabsState = {
	viewId: "",
	activeTabId: "",
	tabs: [],
};

const EMPTY_DEVTOOLS_STATE: BrowserDevToolsState = {
	viewId: "",
	open: false,
	activeTabId: "",
};

type PreviewTrigger = { revision: number | null; target: string };

// The native view survives React session switches, so remember which preview
// trigger was already consumed for each session. This prevents switching back
// from reasserting previewUrl over a URL the user manually navigated to.
const consumedPreviewTriggers = new Map<string, PreviewTrigger>();

export function resetConsumedPreviewTriggersForTest(): void {
	consumedPreviewTriggers.clear();
}

const HIDDEN_RECT: BrowserRect = { x: 0, y: 0, width: 0, height: 0 };
const VISUAL_TRANSITION_DURATION_MS = 240;
const VISUAL_TRANSITION_CAPTURE_TIMEOUT_MS = 120;

// The native WebContentsView is a window-level overlay, so DOM `overflow:
// hidden` never clips it — it paints wherever the slot's bounding box lands.
// Inside the collapsible inspector the slot sits in a `min-w-[280px]` wrapper,
// so on a narrow panel (small window, or mid-collapse) the slot's box spills
// past its resizable-panel column. Intersect the slot box with that column so
// the view can only ever paint inside it, never over the terminal/sidebar.
function visibleSlotRect(node: HTMLElement): BrowserRect {
	const rect = node.getBoundingClientRect();
	let { left, top, right, bottom } = rect;
	const column = node.closest<HTMLElement>("[data-panel]");
	if (column) {
		const bounds = column.getBoundingClientRect();
		left = Math.max(left, bounds.left);
		top = Math.max(top, bounds.top);
		right = Math.min(right, bounds.right);
		bottom = Math.min(bottom, bounds.bottom);
	}
	return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

// `requestFullscreen` (the terminal pane's fullscreen button) promotes an element
// into the DOM top layer, which covers every other DOM node — but not the native
// view, which Chromium composites above the page regardless. The transition also
// leaves the slot's own box untouched, since the top layer does not reflow
// normal-flow siblings, so neither the ResizeObserver nor `resize` fires and the
// view would keep painting at its pre-fullscreen bounds, over the fullscreen
// element and without its own (now hidden) toolbar. Nothing outside the
// fullscreen subtree is visible, so hide the view unless the slot is inside it.
function hiddenByFullscreen(node: HTMLElement): boolean {
	// Truthy, not `!== null`: the spec says null, but jsdom (and older engines)
	// leave `fullscreenElement` undefined when nothing is fullscreen.
	const fullscreen = document.fullscreenElement;
	return Boolean(fullscreen) && !fullscreen!.contains(node);
}

function afterNextPaint(): Promise<void> {
	const schedule = (callback: () => void) => {
		if (window.requestAnimationFrame) window.requestAnimationFrame(() => callback());
		else window.setTimeout(callback, 16);
	};
	return new Promise((resolve) => schedule(() => schedule(resolve)));
}

async function decodeMirrorFrame(source: string): Promise<void> {
	const image = new Image();
	image.src = source;
	if (typeof image.decode !== "function") return;
	await image.decode().catch(() => undefined);
}

export function useBrowserView({
	sessionId,
	active,
	poppedOut,
	terminated,
	previewUrl,
	previewRevision,
}: UseBrowserViewOptions): BrowserViewModel {
	const [viewId, setViewId] = useState("");
	const [navState, setNavState] = useState<BrowserNavState>(EMPTY_NAV_STATE);
	const [mirrorFrame, setMirrorFrame] = useState<BrowserMirrorFrame | null>(null);
	const [annotationMode, setAnnotationModeState] = useState(false);
	const [tabsState, setTabsState] = useState<BrowserTabsState>(EMPTY_TABS_STATE);
	const [devtoolsState, setDevtoolsState] = useState<BrowserDevToolsState>(EMPTY_DEVTOOLS_STATE);
	const [tabNotice, setTabNotice] = useState("");
	const [visualTransition, setVisualTransition] = useState<BrowserVisualTransition | null>(null);
	const [agentBrowserActive, setAgentBrowserActive] = useState(false);
	const [agentBrowserActivity, setAgentBrowserActivity] = useState<BrowserAgentActivityState | null>(null);
	const [stateSessionId, setStateSessionId] = useState(sessionId);
	const slotNodeRef = useRef<HTMLDivElement | null>(null);
	const viewIdRef = useRef("");
	const annotationModeRef = useRef(false);
	const activeRef = useRef(active);
	const poppedOutRef = useRef(poppedOut);
	const frameRef = useRef<number | null>(null);
	const settleTimerRef = useRef<number | null>(null);
	const observerRef = useRef<ResizeObserver | null>(null);
	const previewTriggerRef = useRef<{ revision: number | null; target: string } | null>(null);
	const hasUrlRef = useRef(false);
	const overlayOpenRef = useRef(false);
	const modalOpenRef = useRef(false);
	const mirrorTokenRef = useRef(0);
	const mirrorTimerRef = useRef<number | null>(null);
	const tabNoticeTimerRef = useRef<number | null>(null);
	const visualTransitionTimerRef = useRef<number | null>(null);
	const hasNativeBrowser = Boolean(window.ao?.browser);

	useEffect(() => {
		activeRef.current = active;
	}, [active]);

	useEffect(() => {
		hasUrlRef.current = Boolean(navState.url);
	}, [navState.url]);

	useEffect(() => {
		annotationModeRef.current = annotationMode;
	}, [annotationMode]);

	const sendHiddenBounds = useCallback((id = viewIdRef.current) => {
		if (!id) return;
		window.ao?.browser.setBounds({ viewId: id, rect: HIDDEN_RECT, visible: false });
	}, []);

	const clearVisualTransitionTimer = useCallback(() => {
		if (visualTransitionTimerRef.current === null) return;
		window.clearTimeout(visualTransitionTimerRef.current);
		visualTransitionTimerRef.current = null;
	}, []);

	const clearMirrorTimer = useCallback(() => {
		if (mirrorTimerRef.current === null) return;
		window.clearTimeout(mirrorTimerRef.current);
		mirrorTimerRef.current = null;
	}, []);

	const showVisualTransition = useCallback(
		async (kind: BrowserVisualTransition["kind"], timeoutCapture = true) => {
			const id = viewIdRef.current;
			if (!id || !hasNativeBrowser || !hasUrlRef.current) return;
			const capture = window.ao?.browser
				.capture?.(id)
				.then((frame) => frame?.dataUrl ?? "")
				.catch(() => "");
			if (!capture) return;
			let timeoutId: number | null = null;
			const snapshotUrl = timeoutCapture
				? await Promise.race([
						capture,
						new Promise<string>((resolve) => {
							timeoutId = window.setTimeout(() => resolve(""), VISUAL_TRANSITION_CAPTURE_TIMEOUT_MS);
						}),
					])
				: await capture;
			if (timeoutId !== null) window.clearTimeout(timeoutId);
			if (!snapshotUrl || viewIdRef.current !== id) return;
			clearVisualTransitionTimer();
			setVisualTransition({ kind, snapshotUrl });
			visualTransitionTimerRef.current = window.setTimeout(() => {
				visualTransitionTimerRef.current = null;
				setVisualTransition(null);
			}, VISUAL_TRANSITION_DURATION_MS);
		},
		[clearVisualTransitionTimer, hasNativeBrowser],
	);

	const measureAndSend = useCallback(() => {
		// measureAndSend runs both from the scheduleMeasure() rAF callback and as a
		// direct synchronous call (parking on overlay open, the settle timer). A
		// direct call may land while a scheduled frame is still queued, so cancel
		// that live handle rather than blindly nulling it — otherwise the
		// scheduleMeasure() dedupe guard and cancelScheduledMeasure() cleanup would
		// both trust a frameRef that no longer reflects the pending frame.
		if (frameRef.current !== null) {
			if (window.cancelAnimationFrame) window.cancelAnimationFrame(frameRef.current);
			window.clearTimeout(frameRef.current);
		}
		frameRef.current = null;
		const id = viewIdRef.current;
		const node = slotNodeRef.current;
		if (!id) return;
		if (!activeRef.current || !node || !node.isConnected || hiddenByFullscreen(node)) {
			sendHiddenBounds(id);
			return;
		}
		const rect = visibleSlotRect(node);
		if (modalOpenRef.current) {
			if (rect.width > 0 && rect.height > 0) {
				window.ao?.browser.setBounds({ viewId: id, rect, visible: true, parked: true });
			} else {
				sendHiddenBounds(id);
			}
			return;
		}
		const payload = {
			viewId: id,
			rect,
			visible: rect.width > 0 && rect.height > 0,
		};
		window.ao?.browser.setBounds(payload);
	}, [sendHiddenBounds]);

	const cancelScheduledMeasure = useCallback(() => {
		if (frameRef.current === null) return;
		if (window.cancelAnimationFrame) {
			window.cancelAnimationFrame(frameRef.current);
		}
		window.clearTimeout(frameRef.current);
		frameRef.current = null;
	}, []);

	const scheduleMeasure = useCallback(() => {
		if (frameRef.current !== null) return;
		frameRef.current = window.requestAnimationFrame
			? window.requestAnimationFrame(() => measureAndSend())
			: window.setTimeout(() => measureAndSend(), 16);
	}, [measureAndSend]);

	// A ResizeObserver only fires on size changes, so a position-only layout shift
	// leaves the native overlay at stale bounds: entering/leaving pop-out moves the
	// slot into a different panel, and opening the inspector (what `ao preview`
	// does) reflows the slot's x without changing the observed node's box size.
	// Neither fires the observer, so the view visibly spills over the sidebar/
	// terminal until an unrelated window resize re-measures it. Re-measure now and
	// again once the panel transition has settled (~240ms) so the final geometry
	// always wins.
	const scheduleSettleMeasure = useCallback(() => {
		scheduleMeasure();
		if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
		settleTimerRef.current = window.setTimeout(() => {
			settleTimerRef.current = null;
			measureAndSend();
		}, 280);
	}, [measureAndSend, scheduleMeasure]);

	const slotRef = useCallback(
		(node: HTMLDivElement | null) => {
			observerRef.current?.disconnect();
			slotNodeRef.current = node;
			if (!node) {
				sendHiddenBounds();
				return;
			}
			const observer = new ResizeObserver(scheduleMeasure);
			observer.observe(node);
			// Also track the resizable-panel column: while the inspector
			// collapse/expand animates, the slot's own width stays pinned by
			// `min-w-[280px]` (so a slot-only observer never fires), but the
			// column's width changes every frame. Observing it re-measures
			// through the whole animation so the view never lags behind.
			const column = node.closest("[data-panel]");
			if (column) observer.observe(column);
			observerRef.current = observer;
			scheduleMeasure();
		},
		[scheduleMeasure, sendHiddenBounds],
	);

	useEffect(() => {
		let disposed = false;
		// Preview revisions are scoped to a session. A native view survives session
		// switches, so seed from the per-session consumed trigger to avoid
		// reasserting previewUrl over manual navigation on switch-back.
		previewTriggerRef.current = hasNativeBrowser ? (consumedPreviewTriggers.get(sessionId) ?? null) : null;
		setStateSessionId(sessionId);
		setViewId("");
		setNavState(EMPTY_NAV_STATE);
		setTabsState(EMPTY_TABS_STATE);
		setDevtoolsState(EMPTY_DEVTOOLS_STATE);
		setTabNotice("");
		setVisualTransition(null);
		setAgentBrowserActive(false);
		setAgentBrowserActivity(null);
		clearVisualTransitionTimer();
		if (tabNoticeTimerRef.current !== null) {
			window.clearTimeout(tabNoticeTimerRef.current);
			tabNoticeTimerRef.current = null;
		}
		if (!hasNativeBrowser) {
			const state = {
				...EMPTY_NAV_STATE,
				viewId: `preview-${sessionId}`,
				url: "",
				title: "",
			};
			viewIdRef.current = state.viewId;
			setViewId(state.viewId);
			setNavState(state);
			setDevtoolsState((current) => ({ ...current, viewId: state.viewId, activeTabId: "" }));
			return () => {
				disposed = true;
				viewIdRef.current = "";
			};
		}
		window.ao?.browser.ensure(sessionId).then((state) => {
			if (disposed) return;
			viewIdRef.current = state.viewId;
			setViewId(state.viewId);
			setNavState(state);
			void window.ao?.browser
				.getTabs(state.viewId)
				.then((tabs) => {
					if (!disposed && viewIdRef.current === tabs.viewId) setTabsState(tabs);
				})
				.catch(() => undefined);
			scheduleSettleMeasure();
		});
		return () => {
			disposed = true;
			const id = viewIdRef.current;
			if (id) {
				if (annotationModeRef.current) {
					void window.ao?.browser.setAnnotationMode({ viewId: id, enabled: false });
					setAnnotationModeState(false);
				}
				sendHiddenBounds(id);
			}
			viewIdRef.current = "";
		};
	}, [
		clearVisualTransitionTimer,
		hasNativeBrowser,
		scheduleSettleMeasure,
		sendHiddenBounds,
		sessionId,
	]);

	useEffect(() => {
		return window.ao?.browser.onNavState((state) => {
			if (state.viewId !== viewIdRef.current) return;
			if (!state.url) {
				// A blank tab has no native pixels to cover these handoff frames with.
				// Drop any frame from the previously selected tab so AO's empty state
				// is revealed as soon as the blank tab becomes active.
				clearMirrorTimer();
				clearVisualTransitionTimer();
				setMirrorFrame(null);
				setVisualTransition(null);
			}
			setNavState(state);
		});
	}, [clearMirrorTimer, clearVisualTransitionTimer]);

	useEffect(() => {
		return window.ao?.browser.onTabsState((state) => {
			if (state.viewId !== viewIdRef.current) return;
			setTabsState(state);
			if (state.change?.kind !== "popup") return;
			setTabNotice("Opened new tab");
			if (tabNoticeTimerRef.current !== null) window.clearTimeout(tabNoticeTimerRef.current);
			tabNoticeTimerRef.current = window.setTimeout(() => {
				tabNoticeTimerRef.current = null;
				setTabNotice("");
			}, 3_000);
		});
	}, []);

	useEffect(() => {
		return window.ao?.browser.onDevToolsState((state) => {
			if (state.viewId !== viewIdRef.current) return;
			setDevtoolsState(state);
		});
	}, []);

	useEffect(() => {
		return window.ao?.browser.onAgentActivity((state) => {
			if (state.viewId !== viewIdRef.current) return;
			setAgentBrowserActive(state.active);
			setAgentBrowserActivity(state);
		});
	}, []);

	useEffect(
		() => () => {
			if (tabNoticeTimerRef.current !== null) window.clearTimeout(tabNoticeTimerRef.current);
			clearVisualTransitionTimer();
		},
		[clearVisualTransitionTimer],
	);

	useLayoutEffect(() => {
		if (active) {
			scheduleSettleMeasure();
		} else {
			sendHiddenBounds();
		}
	}, [active, navState.url, poppedOut, scheduleSettleMeasure, sendHiddenBounds]);

	const captureMirrorThenPark = useCallback(
		async (id: string) => {
			const token = ++mirrorTokenRef.current;
			const live = () =>
				mirrorTokenRef.current === token && overlayOpenRef.current && viewIdRef.current === id;
			const frame = await (window.ao?.browser.capture?.(id) ?? Promise.resolve(null)).catch(() => null);
			if (!live()) return;

			// Do not move the native view until its replacement has painted. Moving
			// it first exposes the empty renderer slot and causes the visible flash.
			if (frame?.dataUrl) {
				await decodeMirrorFrame(frame.dataUrl);
				if (!live()) return;
				setMirrorFrame(frame);
				await afterNextPaint();
				if (!live()) return;
			}
			modalOpenRef.current = true;
			measureAndSend();
		},
		[measureAndSend],
	);
	useEffect(() => {
		if (poppedOutRef.current === poppedOut) return;
		poppedOutRef.current = poppedOut;
		if (!hasNativeBrowser || !activeRef.current || !hasUrlRef.current) {
			scheduleSettleMeasure();
			return;
		}
		measureAndSend();
		window.setTimeout(() => {
			measureAndSend();
		}, 0);
		scheduleSettleMeasure();
	}, [hasNativeBrowser, measureAndSend, poppedOut, scheduleSettleMeasure]);

	const prepareForOverlay = useCallback(async () => {
		const id = viewIdRef.current;
		if (!id || !hasNativeBrowser || !activeRef.current || !hasUrlRef.current) return;
		const token = ++mirrorTokenRef.current;
		clearMirrorTimer();
		const frame = await (window.ao?.browser.capture?.(id) ?? Promise.resolve(null)).catch(() => null);
		if (frame && mirrorTokenRef.current === token && viewIdRef.current === id) setMirrorFrame(frame);
	}, [clearMirrorTimer, hasNativeBrowser]);

	const finishOverlay = useCallback(() => {
		modalOpenRef.current = false;
		mirrorTokenRef.current += 1;
		clearMirrorTimer();
		scheduleSettleMeasure();
	}, [clearMirrorTimer, scheduleSettleMeasure]);


	useEffect(() => {
		if (!hasNativeBrowser) return;
		const update = () => {
			const open = document.querySelector(OPEN_BROWSER_OVERLAY_SELECTOR) !== null;
			if (open === overlayOpenRef.current) return;
			overlayOpenRef.current = open;
			if (open) {
				clearMirrorTimer();
				const id = viewIdRef.current;
				if (id && activeRef.current && hasUrlRef.current) {
					void captureMirrorThenPark(id);
					// Park the native view synchronously, in the same tick the overlay
					// opened. `modalOpenRef` is already true, so measureAndSend() emits
					// the `parked: true` bounds now instead of a frame later — deferring
					// to rAF leaves a ~16ms window where the live view paints over the
					// freshly-opened dropdown, which stacks into a stuck overlay under
					// rapid toggling. rAF still refines geometry on later resize/scroll.
				} else {
					modalOpenRef.current = true;
					sendHiddenBounds();
				}
			} else {
				mirrorTokenRef.current += 1;
				modalOpenRef.current = false;
				scheduleSettleMeasure();
				clearMirrorTimer();
				mirrorTimerRef.current = window.setTimeout(() => {
					mirrorTimerRef.current = null;
					setMirrorFrame(null);
				}, 320);
			}
		};
		update();
		const observer = new MutationObserver(update);
		// Radix reuses its portal node and flips `data-state` in place rather than
		// adding/removing a body child, so a `childList`-only observer misses the
		// open/close transition under rapid toggling and the overlay state desyncs.
		// Watch subtree attribute flips on `data-state` too so the transition is
		// always observed. This widens the firing rate a lot — `data-state` is used
		// across Radix (tooltips, accordions, selects, switches, …), so `update()`
		// now runs a document-wide querySelector on activity anywhere in the app
		// before it can bail. Cheap enough in practice, but not free.
		observer.observe(document.body, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["data-state"],
		});
		return () => {
			observer.disconnect();
			clearMirrorTimer();
			mirrorTokenRef.current += 1;
			overlayOpenRef.current = false;
			modalOpenRef.current = false;
		};
	}, [captureMirrorThenPark, hasNativeBrowser, scheduleSettleMeasure, sendHiddenBounds]);

	useEffect(() => {
		const handle = () => scheduleMeasure();
		// Fullscreen animates on macOS, so settle-measure: hiding lands on the
		// leading edge, and the restore on exit waits for the final geometry.
		const handleFullscreenChange = () => scheduleSettleMeasure();
		window.addEventListener("resize", handle);
		window.addEventListener("scroll", handle, true);
		document.addEventListener("fullscreenchange", handleFullscreenChange);
		return () => {
			window.removeEventListener("resize", handle);
			window.removeEventListener("scroll", handle, true);
			document.removeEventListener("fullscreenchange", handleFullscreenChange);
			observerRef.current?.disconnect();
			cancelScheduledMeasure();
			if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
		};
	}, [cancelScheduledMeasure, scheduleMeasure, scheduleSettleMeasure]);

	const withView = useCallback(async (fn: (id: string) => Promise<BrowserNavState | void>) => {
		const id = viewIdRef.current;
		if (!id) return;
		try {
			const next = await fn(id);
			if (next) setNavState(next);
		} catch {
			// navigation errors are handled by the did-fail-load event channel
		}
	}, []);

	const setAnnotationMode = useCallback(
		async (enabled: boolean) => {
			const id = viewIdRef.current;
			if (!id || !hasNativeBrowser) {
				setAnnotationModeState(false);
				return;
			}
			await window.ao!.browser.setAnnotationMode({ viewId: id, enabled });
			setAnnotationModeState(enabled);
		},
		[hasNativeBrowser],
	);

	const selectTab = useCallback(
		async (tabId: string) => {
			const viewId = viewIdRef.current;
			if (!viewId || !hasNativeBrowser) return;
			await showVisualTransition("tab-switch");
			const state = await window.ao!.browser.selectTab({ viewId, tabId });
			if (viewIdRef.current === state.viewId) setTabsState(state);
		},
		[hasNativeBrowser, showVisualTransition],
	);

	const closeTab = useCallback(
		async (tabId: string) => {
			const viewId = viewIdRef.current;
			if (!viewId || !hasNativeBrowser) return;
			const state = await window.ao!.browser.closeTab({ viewId, tabId });
			if (viewIdRef.current === state.viewId) setTabsState(state);
		},
		[hasNativeBrowser],
	);

	const runDevtools = useCallback(
		async (operation: "open" | "close") => {
			const id = viewIdRef.current;
			if (!id || !hasNativeBrowser) return;
			try {
				const next = await window.ao!.browser.devtools({ viewId: id, operation });
				if (viewIdRef.current === next.viewId) setDevtoolsState(next);
			} catch {
				// The main process reports the unavailable state through the normal
				// browser lifecycle; a failed optional DevTools action should not
				// become an unhandled renderer rejection.
			}
		},
		[hasNativeBrowser],
	);

	useEffect(() => {
		const handleDone = (payload: BrowserAnnotationSubmitPayload | BrowserAnnotationCancelPayload) => {
			if (payload.viewId !== viewIdRef.current) return;
			setAnnotationModeState(false);
		};
		const offSubmit = window.ao?.browser.onAnnotationSubmit(handleDone);
		const offCancel = window.ao?.browser.onAnnotationCancel(handleDone);
		return () => {
			offSubmit?.();
			offCancel?.();
		};
	}, []);

	useEffect(() => {
		if (navState.url || !annotationModeRef.current) return;
		void setAnnotationMode(false);
	}, [navState.url, setAnnotationMode]);

	const navigate = useCallback(
		(url: string) => {
			if (!hasNativeBrowser) {
				const normalized = url.trim();
				setNavState((current) => ({
					...current,
					url: normalized,
					title: normalized ? "AO preview" : "",
					isLoading: false,
				}));
				return Promise.resolve();
			}
			return withView((id) => window.ao!.browser.navigate({ viewId: id, url }));
		},
		[hasNativeBrowser, withView],
	);

	const clear = useCallback(() => {
		if (!hasNativeBrowser) {
			setNavState((current) => ({ ...current, url: "", title: "", isLoading: false }));
			return Promise.resolve();
		}
		return withView((id) => window.ao!.browser.clear(id));
	}, [hasNativeBrowser, withView]);

	// Drive the view from the daemon-set preview target. Current daemons key
	// this on previewRevision (bumped on every `ao preview` call); older daemons
	// did not send it, so fall back to URL changes for compatibility.
	useEffect(() => {
		// During a session switch React still renders once with the prior
		// viewId state, while the cleanup has already cleared viewIdRef. Do not
		// consume the new session's preview revision against that stale view.
		if (!viewId || viewIdRef.current !== viewId || terminated) return;
		const target = previewUrl?.trim() ?? "";
		const revision = typeof previewRevision === "number" ? previewRevision : null;
		const previous = previewTriggerRef.current;
		if (previous?.revision === revision && previous.target === target) return;
		if (revision !== null && previous?.revision === revision) return;
		const consumed: PreviewTrigger = { revision, target };
		previewTriggerRef.current = consumed;
		if (hasNativeBrowser) consumedPreviewTriggers.set(sessionId, consumed);
		if (target) {
			void navigate(target);
		} else if ((revision !== null && revision > 0) || previous?.target) {
			void clear();
		}
	}, [clear, hasNativeBrowser, navigate, previewRevision, previewUrl, sessionId, terminated, viewId]);

	const destroy = useCallback(() => {
		const id = viewIdRef.current;
		if (!id) return;
		if (annotationModeRef.current) {
			void window.ao?.browser.setAnnotationMode({ viewId: id, enabled: false });
			setAnnotationModeState(false);
		}
		mirrorTokenRef.current += 1;
		overlayOpenRef.current = false;
		modalOpenRef.current = false;
		setMirrorFrame(null);
		clearMirrorTimer();
		setVisualTransition(null);
		clearVisualTransitionTimer();
		sendHiddenBounds(id);
		window.ao?.browser.destroy(id);
		viewIdRef.current = "";
		setViewId("");
		setNavState(EMPTY_NAV_STATE);
		setTabsState(EMPTY_TABS_STATE);
	}, [
		clearMirrorTimer,
		clearVisualTransitionTimer,
		sendHiddenBounds,
	]);

	// Termination invalidates the complete session-owned browser, including all
	// tabs, captures, profile state, and target mappings. `clear` remains the
	// explicit preview-reset operation.
	useEffect(() => {
		if (!terminated || !viewId) return;
		consumedPreviewTriggers.delete(sessionId);
		destroy();
	}, [destroy, sessionId, terminated, viewId]);

	// Hook state survives a `sessionId` prop change until the reset effect above
	// commits. Keep navigation, tab, and activity state hidden during that
	// intervening render so consumers can never interpret the departed session's
	// state as belonging to the destination session.
	const stateBelongsToSession = stateSessionId === sessionId;

	return {
		viewId: stateBelongsToSession ? viewId : "",
		navState: stateBelongsToSession ? navState : EMPTY_NAV_STATE,
		mirrorFrame: stateBelongsToSession ? mirrorFrame : null,
		slotRef,
		navigate,
		goBack: () => (hasNativeBrowser ? withView((id) => window.ao!.browser.goBack(id)) : Promise.resolve()),
		goForward: () => (hasNativeBrowser ? withView((id) => window.ao!.browser.goForward(id)) : Promise.resolve()),
		reload: () => (hasNativeBrowser ? withView((id) => window.ao!.browser.reload(id)) : Promise.resolve()),
		stop: () => (hasNativeBrowser ? withView((id) => window.ao!.browser.stop(id)) : Promise.resolve()),
		tabs: stateBelongsToSession ? tabsState.tabs : [],
		activeTabId: stateBelongsToSession ? tabsState.activeTabId : "",
		tabNotice: stateBelongsToSession ? tabNotice : "",
		selectTab,
		closeTab,
		devtoolsState: stateBelongsToSession ? devtoolsState : EMPTY_DEVTOOLS_STATE,
		openDevTools: () => runDevtools("open"),
		closeDevTools: () => runDevtools("close"),
		prepareForOverlay,
		finishOverlay,
		visualTransition: stateBelongsToSession ? visualTransition : null,
		agentBrowserActive: stateBelongsToSession && agentBrowserActive,
		agentBrowserActivity: stateBelongsToSession ? agentBrowserActivity : null,
		destroy,
		annotationMode,
		setAnnotationMode,
	};
}
