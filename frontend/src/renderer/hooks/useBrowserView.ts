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
	mirrorUrl: string;
	mirrorStream: MediaStream | null;
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

const OPEN_MODAL_SELECTOR =
	'[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"]';

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
	const [mirrorUrl, setMirrorUrl] = useState("");
	const [mirrorStream, setMirrorStream] = useState<MediaStream | null>(null);
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
	const modalOpenRef = useRef(false);
	const mirrorTokenRef = useRef(0);
	const mirrorTimerRef = useRef<number | null>(null);
	const mirrorStreamRef = useRef<MediaStream | null>(null);
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
		if (!activeRef.current || !node || !node.isConnected || !hasUrlRef.current || hiddenByFullscreen(node)) {
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
				if (annotationModeRef.current) {
					void window.ao?.browser.setAnnotationMode({ viewId: id, enabled: false });
					setAnnotationModeState(false);
				}
				sendHiddenBounds(id);
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

	const stopMirrorStream = useCallback(() => {
		mirrorStreamRef.current?.getTracks().forEach((track) => track.stop());
		mirrorStreamRef.current = null;
		setMirrorStream(null);
	}, []);

	const runMirror = useCallback(
		(id: string) => {
			const token = ++mirrorTokenRef.current;
			const live = () => mirrorTokenRef.current === token && modalOpenRef.current && viewIdRef.current === id;
			const streamMirror = async (): Promise<boolean> => {
				if (!navigator.mediaDevices?.getDisplayMedia) return false;
				const granted = await window.ao?.browser.requestMirror?.(id).catch(() => false);
				if (!granted || !live()) return false;
				const stream = await navigator.mediaDevices.getDisplayMedia({ audio: false, video: true });
				if (!live()) {
					stream.getTracks().forEach((track) => track.stop());
					return true;
				}
				stopMirrorStream();
				mirrorStreamRef.current = stream;
				setMirrorStream(stream);
				return true;
			};
			const frameMirror = async () => {
				while (live()) {
					const pending = window.ao?.browser.capture?.(id) ?? Promise.resolve("");
					const frame = await pending.catch(() => "");
					if (!live()) return;
					if (frame) setMirrorUrl(frame);
					await new Promise((resolve) => {
						window.setTimeout(resolve, 66);
					});
				}
			};
			const tick = async () => {
				const streamed = await streamMirror().catch(() => false);
				if (streamed || !live()) return;
				await frameMirror();
			};
			void tick();
		},
		[stopMirrorStream],
	);

	useEffect(() => {
		if (!hasNativeBrowser) return;
		const clearMirrorTimer = () => {
			if (mirrorTimerRef.current === null) return;
			window.clearTimeout(mirrorTimerRef.current);
			mirrorTimerRef.current = null;
		};
		const update = () => {
			const open = document.querySelector(OPEN_MODAL_SELECTOR) !== null;
			if (open === modalOpenRef.current) return;
			modalOpenRef.current = open;
			if (open) {
				clearMirrorTimer();
				const id = viewIdRef.current;
				if (id && activeRef.current && hasUrlRef.current) {
					runMirror(id);
					scheduleMeasure();
				} else {
					sendHiddenBounds();
				}
			} else {
				mirrorTokenRef.current += 1;
				scheduleSettleMeasure();
				clearMirrorTimer();
				mirrorTimerRef.current = window.setTimeout(() => {
					mirrorTimerRef.current = null;
					setMirrorUrl("");
					stopMirrorStream();
				}, 320);
			}
		};
		update();
		const observer = new MutationObserver(update);
		observer.observe(document.body, { childList: true });
		return () => {
			observer.disconnect();
			clearMirrorTimer();
			mirrorTokenRef.current += 1;
			stopMirrorStream();
		};
	}, [hasNativeBrowser, runMirror, scheduleMeasure, scheduleSettleMeasure, sendHiddenBounds, stopMirrorStream]);

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
		if (annotationModeRef.current) {
			void window.ao?.browser.setAnnotationMode({ viewId: id, enabled: false });
			setAnnotationModeState(false);
		}
		mirrorTokenRef.current += 1;
		stopMirrorStream();
		setMirrorUrl("");
		sendHiddenBounds(id);
		window.ao?.browser.destroy(id);
		viewIdRef.current = "";
	}, [sendHiddenBounds, stopMirrorStream]);

	return {
		viewId,
		navState,
		mirrorUrl,
		mirrorStream,
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
