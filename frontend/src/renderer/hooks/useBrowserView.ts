import { useCallback, useEffect, useRef, useState } from "react";
import type { BrowserNavState, BrowserRect } from "../../main/browser-view-host";
import type { BrowserAnnotationCancelPayload, BrowserAnnotationSubmitPayload } from "../../shared/browser-annotations";

export type { BrowserNavState };

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
	slotRef: (node: HTMLDivElement | null) => void;
	navigate: (url: string) => Promise<void>;
	goBack: () => Promise<void>;
	goForward: () => Promise<void>;
	reload: () => Promise<void>;
	stop: () => Promise<void>;
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

const HIDDEN_RECT: BrowserRect = { x: 0, y: 0, width: 0, height: 0 };

/**
 * Fire-and-forget teardown of annotation mode (unmount, destroy). Nothing is left
 * to render an error into by then, but the promise must still be observed so a
 * rejecting IPC call cannot become an unhandled rejection (M14, #293).
 */
function disableAnnotationMode(viewId: string): void {
	void Promise.resolve(window.ao?.browser.setAnnotationMode({ viewId, enabled: false })).catch(() => undefined);
}

/** IPC rejections arrive as Errors whose message carries the main-process reason. */
function browserErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	if (typeof error === "string" && error !== "") return error;
	return "Navigation failed";
}

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
	const [annotationMode, setAnnotationModeState] = useState(false);
	const slotNodeRef = useRef<HTMLDivElement | null>(null);
	const viewIdRef = useRef("");
	const annotationModeRef = useRef(false);
	const activeRef = useRef(active);
	const frameRef = useRef<number | null>(null);
	const settleTimerRef = useRef<number | null>(null);
	const observerRef = useRef<ResizeObserver | null>(null);
	const previewTriggerRef = useRef<{ revision: number | null; target: string } | null>(null);
	const hasUrlRef = useRef(false);
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

	const measureAndSend = useCallback(() => {
		frameRef.current = null;
		const id = viewIdRef.current;
		const node = slotNodeRef.current;
		if (!id) return;
		if (!activeRef.current || !node || !node.isConnected || !hasUrlRef.current) {
			sendHiddenBounds(id);
			return;
		}
		const rect = visibleSlotRect(node);
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
			if (node) {
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
			}
			scheduleMeasure();
		},
		[scheduleMeasure],
	);

	// The mount/unmount effect must see the CURRENT terminated flag without
	// re-running (and re-ensuring the view) every time it flips.
	const terminatedRef = useRef(Boolean(terminated));
	useEffect(() => {
		terminatedRef.current = Boolean(terminated);
	}, [terminated]);

	useEffect(() => {
		let disposed = false;
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
			return () => {
				disposed = true;
				viewIdRef.current = "";
			};
		}
		window.ao?.browser
			.ensure(sessionId)
			.then((state) => {
				if (disposed) return;
				viewIdRef.current = state.viewId;
				setViewId(state.viewId);
				setNavState(state);
				scheduleSettleMeasure();
			})
			.catch((error: unknown) => {
				// A view that cannot even be created leaves the panel dead; say so
				// rather than raising an unhandled rejection (M14, #293).
				if (disposed) return;
				setNavState((current) => ({ ...current, isLoading: false, error: browserErrorMessage(error) }));
			});
		return () => {
			disposed = true;
			const id = viewIdRef.current;
			if (id) {
				if (annotationModeRef.current) {
					disableAnnotationMode(id);
					setAnnotationModeState(false);
				}
				sendHiddenBounds(id);
				// A live session's view is kept warm (hidden) so returning to it is
				// instant — the main process bounds those with LRU eviction. A
				// terminated session will never be returned to, so its page is torn
				// down here rather than parked with live timers and sockets (M12).
				if (terminatedRef.current) {
					window.ao?.browser.destroy(id);
				}
			}
			viewIdRef.current = "";
		};
	}, [hasNativeBrowser, scheduleSettleMeasure, sendHiddenBounds, sessionId]);

	useEffect(() => {
		return window.ao?.browser.onNavState((state) => {
			if (state.viewId !== viewIdRef.current) return;
			setNavState(state);
		});
	}, []);

	useEffect(() => {
		if (navState.url && active) {
			scheduleSettleMeasure();
		} else {
			sendHiddenBounds();
		}
	}, [active, navState.url, poppedOut, scheduleSettleMeasure, sendHiddenBounds]);

	useEffect(() => {
		const handle = () => scheduleMeasure();
		window.addEventListener("resize", handle);
		window.addEventListener("scroll", handle, true);
		return () => {
			window.removeEventListener("resize", handle);
			window.removeEventListener("scroll", handle, true);
			observerRef.current?.disconnect();
			cancelScheduledMeasure();
			if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
		};
	}, [cancelScheduledMeasure, scheduleMeasure]);

	// Every browser control crosses IPC and can REJECT — a malformed target, a
	// blocked scheme, a refused connection, a destroyed view. Callers fire these as
	// `void navigate(url)`, so an escaping rejection was both invisible (navState.error
	// never set: the panel looked like it had ignored the user) and an unhandled
	// promise rejection (M14, #293). Observe every one and convert it into nav state.
	const withView = useCallback(async (fn: (id: string) => Promise<BrowserNavState | void>) => {
		const id = viewIdRef.current;
		if (!id) return;
		try {
			const next = await fn(id);
			if (next) setNavState(next);
		} catch (error) {
			setNavState((current) => ({
				...current,
				isLoading: false,
				error: browserErrorMessage(error),
			}));
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
		// Observed, not fired-and-forgotten: setAnnotationMode rejects on a destroyed
		// view, and this effect has no caller to catch for it (M14, #293).
		setAnnotationMode(false).catch((error: unknown) => {
			setNavState((current) => ({ ...current, error: browserErrorMessage(error) }));
		});
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
		if (!viewId || terminated) return;
		const target = previewUrl?.trim() ?? "";
		const revision = typeof previewRevision === "number" ? previewRevision : null;
		const previous = previewTriggerRef.current;
		if (previous?.revision === revision && previous.target === target) return;
		if (revision !== null && previous?.revision === revision) return;
		previewTriggerRef.current = { revision, target };
		if (target) {
			void navigate(target);
		} else if ((revision !== null && revision > 0) || previous?.target) {
			void clear();
		}
	}, [clear, navigate, previewRevision, previewUrl, viewId]);

	const destroy = useCallback(() => {
		const id = viewIdRef.current;
		if (!id) return;
		if (annotationModeRef.current) {
			// Catching helper, like the unmount path: teardown and LRU eviction are
			// exactly when the view is already gone, so this IPC rejects ("Object has
			// been destroyed") — a bare `void` leaks that as an unhandled rejection.
			disableAnnotationMode(id);
			setAnnotationModeState(false);
		}
		sendHiddenBounds(id);
		window.ao?.browser.destroy(id);
		viewIdRef.current = "";
	}, [sendHiddenBounds]);

	// When the session is terminated, clear the view and stop reacting to
	// daemon-driven preview changes so stale content does not remain visible — then
	// destroy the page outright (M12, #293). A terminated session is never returned
	// to, so keeping its WebContentsView hidden-but-alive only leaks memory, timers
	// and background network for the rest of the app's life.
	useEffect(() => {
		if (!terminated) return;
		void (async () => {
			await clear();
			destroy();
		})();
	}, [clear, destroy, terminated]);

	return {
		viewId,
		navState,
		slotRef,
		navigate,
		goBack: () => (hasNativeBrowser ? withView((id) => window.ao!.browser.goBack(id)) : Promise.resolve()),
		goForward: () => (hasNativeBrowser ? withView((id) => window.ao!.browser.goForward(id)) : Promise.resolve()),
		reload: () => (hasNativeBrowser ? withView((id) => window.ao!.browser.reload(id)) : Promise.resolve()),
		stop: () => (hasNativeBrowser ? withView((id) => window.ao!.browser.stop(id)) : Promise.resolve()),
		destroy,
		annotationMode,
		setAnnotationMode,
	};
}
