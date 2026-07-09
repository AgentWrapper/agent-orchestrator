import { useCallback, useEffect, useRef } from "react";

interface UseResizableOptions {
	/** CSS custom property to drive (set on :root), e.g. "--ao-sidebar-w". */
	cssVar: string;
	/** localStorage key to persist the width. */
	storageKey: string;
	defaultWidth: number;
	min: number;
	max: number;
	/**
	 * Which edge the drag handle sits on relative to the panel it resizes.
	 * "right" (sidebar handle) grows with rightward drag; "left" (inspector
	 * handle) grows with leftward drag.
	 */
	edge: "left" | "right";
	/** Optional raw drag width below which the owner should collapse. */
	collapseBelow?: number;
	/** Called once when a drag crosses collapseBelow. */
	onCollapse?: () => void;
	/** Called once when a collapsed rail drag should reopen the owner. */
	onExpand?: () => void;
	/** Pointer movement needed before a collapsed rail drag expands. */
	expandDragThreshold?: number;
}

/**
 * Pointer-driven panel resize, cloned from agent-orchestrator's useResizable.
 * Persists the width to localStorage and applies it via a CSS custom property
 * on :root (so the consuming layout reads it with `width: var(--cssVar, default)`),
 * avoiding any inline `style=`.
 */
export function useResizable({
	cssVar,
	storageKey,
	defaultWidth,
	min,
	max,
	edge,
	collapseBelow,
	onCollapse,
	onExpand,
	expandDragThreshold = 8,
}: UseResizableOptions) {
	const widthRef = useRef(defaultWidth);
	const frameRef = useRef<number | null>(null);
	const pendingWidthRef = useRef<number | null>(null);

	const apply = useCallback(
		(next: number) => {
			const clamped = Math.min(max, Math.max(min, next));
			widthRef.current = clamped;
			document.documentElement.style.setProperty(cssVar, `${clamped}px`);
		},
		[cssVar, max, min],
	);

	const applyOnFrame = useCallback(
		(next: number) => {
			pendingWidthRef.current = next;
			if (frameRef.current !== null) return;
			frameRef.current = window.requestAnimationFrame(() => {
				frameRef.current = null;
				const pending = pendingWidthRef.current;
				pendingWidthRef.current = null;
				if (pending !== null) apply(pending);
			});
		},
		[apply],
	);

	const flushPending = useCallback(() => {
		if (frameRef.current !== null) {
			window.cancelAnimationFrame(frameRef.current);
			frameRef.current = null;
		}
		const pending = pendingWidthRef.current;
		pendingWidthRef.current = null;
		if (pending !== null) apply(pending);
	}, [apply]);

	const discardPending = useCallback(() => {
		if (frameRef.current !== null) {
			window.cancelAnimationFrame(frameRef.current);
			frameRef.current = null;
		}
		pendingWidthRef.current = null;
	}, []);

	// Restore persisted width on mount.
	useEffect(() => {
		const saved = Number(window.localStorage.getItem(storageKey));
		apply(Number.isFinite(saved) && saved > 0 ? saved : defaultWidth);
		return () => {
			if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
			document.documentElement.style.removeProperty(cssVar);
		};
	}, [apply, cssVar, defaultWidth, storageKey]);

	const onPointerDown = useCallback(
		(event: React.PointerEvent<HTMLElement>) => {
			event.preventDefault();
			const startX = event.clientX;
			const startWidth = widthRef.current;
			const sign = edge === "right" ? 1 : -1;
			let collapsed = false;
			document.body.classList.add("is-resizing-x");

			const onUp = () => {
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
				flushPending();
				document.body.classList.remove("is-resizing-x");
				if (!collapsed) window.localStorage.setItem(storageKey, String(widthRef.current));
			};
			const onMove = (e: PointerEvent) => {
				const nextWidth = startWidth + sign * (e.clientX - startX);
				if (collapseBelow !== undefined && onCollapse && nextWidth <= collapseBelow) {
					collapsed = true;
					const preservedWidth = Math.min(max, Math.max(min, startWidth));
					discardPending();
					apply(preservedWidth);
					window.localStorage.setItem(storageKey, String(preservedWidth));
					onUp();
					onCollapse();
					return;
				}
				applyOnFrame(nextWidth);
			};
			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp);
		},
		[apply, applyOnFrame, collapseBelow, discardPending, edge, flushPending, max, min, onCollapse, storageKey],
	);

	const onCollapsedPointerDown = useCallback(
		(event: React.PointerEvent<HTMLElement>) => {
			const startX = event.clientX;
			const sign = edge === "right" ? 1 : -1;
			let expanded = false;
			document.body.classList.add("is-resizing-x");

			const onUp = () => {
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
				flushPending();
				document.body.classList.remove("is-resizing-x");
				if (expanded) window.localStorage.setItem(storageKey, String(widthRef.current));
			};
			const onMove = (e: PointerEvent) => {
				const delta = sign * (e.clientX - startX);
				if (delta < expandDragThreshold) return;
				if (!expanded) {
					expanded = true;
					onExpand?.();
				}
				applyOnFrame(min + delta);
			};
			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp);
		},
		[applyOnFrame, edge, expandDragThreshold, flushPending, min, onExpand, storageKey],
	);

	/** Double-click the handle to reset to the default width. */
	const onDoubleClick = useCallback(() => {
		apply(defaultWidth);
		window.localStorage.setItem(storageKey, String(defaultWidth));
	}, [apply, defaultWidth, storageKey]);

	return { onPointerDown, onCollapsedPointerDown, onDoubleClick };
}
