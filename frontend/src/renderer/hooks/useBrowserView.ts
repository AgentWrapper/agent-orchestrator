import { useCallback, useEffect, useRef, useState } from "react";
import type { BrowserNavState, BrowserRect } from "../../main/browser-view-host";

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
	const slotNodeRef = useRef<HTMLDivElement | null>(null);
	const viewIdRef = useRef("");
	const activeRef = useRef(active);
	const frameRef = useRef<number | null>(null);
	const settleTimerRef = useRef<number | null>(null);
	const observerRef = useRef<ResizeObserver | null>(null);
	const previewTriggerRef = useRef<{ revision: number | null; target: string } | null>(null);
	const hasUrlRef = useRef(false);

	useEffect(() => {
		activeRef.current = active;
	}, [active]);

	useEffect(() => {
		hasUrlRef.current = Boolean(navState.url);
	}, [navState.url]);

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

	useEffect(() => {
		let disposed = false;
		window.ao?.browser.ensure(sessionId).then((state) => {
			if (disposed) return;
			viewIdRef.current = state.viewId;
			setViewId(state.viewId);
			setNavState(state);
			scheduleSettleMeasure();
		});
		return () => {
			disposed = true;
			const id = viewIdRef.current;
			if (id) {
				sendHiddenBounds(id);
			}
			viewIdRef.current = "";
		};
	}, [scheduleSettleMeasure, sendHiddenBounds, sessionId]);

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

	const withView = useCallback(async (fn: (id: string) => Promise<BrowserNavState | void>) => {
		const id = viewIdRef.current;
		if (!id) return;
		const next = await fn(id);
		if (next) setNavState(next);
	}, []);

	const navigate = useCallback(
		(url: string) => withView((id) => window.ao!.browser.navigate({ viewId: id, url })),
		[withView],
	);

	const clear = useCallback(() => withView((id) => window.ao!.browser.clear(id)), [withView]);

	// When the session is terminated, clear the view and stop reacting to
	// daemon-driven preview changes so stale content does not remain visible.
	useEffect(() => {
		if (!terminated) return;
		void clear();
	}, [clear, terminated]);

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
		sendHiddenBounds(id);
		window.ao?.browser.destroy(id);
		viewIdRef.current = "";
	}, [sendHiddenBounds]);

	return {
		viewId,
		navState,
		slotRef,
		navigate,
		goBack: () => withView((id) => window.ao!.browser.goBack(id)),
		goForward: () => withView((id) => window.ao!.browser.goForward(id)),
		reload: () => withView((id) => window.ao!.browser.reload(id)),
		stop: () => withView((id) => window.ao!.browser.stop(id)),
		destroy,
	};
}
