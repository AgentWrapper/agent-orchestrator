import { useCallback, useEffect, useRef } from "react";

const DEFAULT_DURATION_MS = 320;
const DEFAULT_EASING = "cubic-bezier(0.16, 1, 0.3, 1)";
const FALLBACK_BUFFER_MS = 100;

export type FlipRect = Pick<DOMRect, "left" | "top" | "width" | "height">;

export type FlipOptions = {
	duration?: number;
	easing?: string;
	onSettle?: () => void;
};

export type FlipController = {
	captureRect: (node: HTMLElement | null) => void;
	playFlip: (node: HTMLElement | null, options?: FlipOptions) => void;
};

// FLIP (First-Last-Invert-Play): computes the transform that makes an element
// laid out at `last` render as though it were still at `first`'s position/size,
// so the caller can clear it and let a CSS transition play the real motion —
// GPU-only (transform), so it stays smooth regardless of the content underneath.
export function computeInvertTransform(first: FlipRect, last: FlipRect): { transform: string; transformOrigin: string } {
	const dx = first.left - last.left;
	const dy = first.top - last.top;
	const sx = last.width === 0 ? 1 : first.width / last.width;
	const sy = last.height === 0 ? 1 : first.height / last.height;
	return {
		transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`,
		transformOrigin: "0 0",
	};
}

function prefersReducedMotion(): boolean {
	return typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

export function useFlipTransition(): FlipController {
	const pendingFirstRectRef = useRef<FlipRect | null>(null);
	const cancelActiveRef = useRef<(() => void) | null>(null);

	const captureRect = useCallback((node: HTMLElement | null) => {
		pendingFirstRectRef.current = node ? node.getBoundingClientRect() : null;
	}, []);

	const playFlip = useCallback((node: HTMLElement | null, options?: FlipOptions) => {
		cancelActiveRef.current?.();
		cancelActiveRef.current = null;

		const first = pendingFirstRectRef.current;
		pendingFirstRectRef.current = null;
		const onSettle = options?.onSettle;

		if (!node || !first || prefersReducedMotion()) {
			node?.style.removeProperty("transform");
			node?.style.removeProperty("transition");
			onSettle?.();
			return;
		}

		const last = node.getBoundingClientRect();
		const { transform, transformOrigin } = computeInvertTransform(first, last);
		node.style.transformOrigin = transformOrigin;
		node.style.transition = "none";
		node.style.transform = transform;
		// Force a reflow so the browser commits the inverted transform before the
		// next frame clears it — otherwise the two style writes coalesce and the
		// element never visually starts at `first`.
		void node.getBoundingClientRect();

		const duration = options?.duration ?? DEFAULT_DURATION_MS;
		const easing = options?.easing ?? DEFAULT_EASING;

		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			node.removeEventListener("transitionend", handleTransitionEnd);
			window.clearTimeout(fallbackId);
			cancelActiveRef.current = null;
			onSettle?.();
		};
		const handleTransitionEnd = (event: TransitionEvent) => {
			if (event.target !== node || event.propertyName !== "transform") return;
			finish();
		};
		node.addEventListener("transitionend", handleTransitionEnd);
		const fallbackId = window.setTimeout(finish, duration + FALLBACK_BUFFER_MS);

		const rafId = window.requestAnimationFrame(() => {
			node.style.transition = `transform ${duration}ms ${easing}`;
			node.style.transform = "";
		});

		cancelActiveRef.current = () => {
			if (settled) return;
			settled = true;
			window.cancelAnimationFrame(rafId);
			node.removeEventListener("transitionend", handleTransitionEnd);
			window.clearTimeout(fallbackId);
			node.style.transition = "";
			node.style.transform = "";
		};
	}, []);

	useEffect(() => () => cancelActiveRef.current?.(), []);

	return { captureRect, playFlip };
}
