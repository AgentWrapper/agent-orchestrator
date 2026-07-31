import { useCallback, useEffect, useRef } from "react";
import { gsap } from "gsap";
import { Flip } from "gsap/Flip";

gsap.registerPlugin(Flip);

const DEFAULT_DURATION_MS = 320;
const DEFAULT_EASE = "expo.out";

export type FlipOptions = {
	duration?: number;
	ease?: string;
	onSettle?: () => void;
};

export type FlipController = {
	captureRect: (node: HTMLElement | null) => void;
	playFlip: (node: HTMLElement | null, options?: FlipOptions) => void;
};

function prefersReducedMotion(): boolean {
	return typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

// Drives a GSAP Flip transition between the origin node captured by
// captureRect() and a (possibly different, e.g. remounted-elsewhere) target
// node. `scale: false` tweens real width/height/top/left rather than a CSS
// transform — a transform-based scale distorts non-uniformly whenever the
// origin and destination aspect ratios differ (e.g. a docked panel vs. a
// fullscreen one), visibly warping real UI controls like toolbar buttons.
// Real layout tweening reflows children exactly like any responsive resize,
// so nothing but the intended box ever changes shape.
export function useFlipTransition(): FlipController {
	const pendingStateRef = useRef<Flip.FlipState | null>(null);
	const activeTimelineRef = useRef<{ kill: () => void } | null>(null);
	const flippingNodeRef = useRef<HTMLElement | null>(null);

	// Marks the target for the tween's exact duration, so a surface can opt into
	// CSS that only makes sense while its box is mid-resize. Because `scale:
	// false` tweens real layout, every frame re-lays-out the subtree; a surface
	// whose contents visibly reshape under that (the Browser panel's toolbar and
	// its frozen snapshot) uses the marker to sit out the tween instead.
	const clearFlippingMark = useCallback(() => {
		const node = flippingNodeRef.current;
		flippingNodeRef.current = null;
		if (node) delete node.dataset.flipping;
	}, []);

	const captureRect = useCallback((node: HTMLElement | null) => {
		pendingStateRef.current = node ? Flip.getState(node) : null;
	}, []);

	const playFlip = useCallback(
		(node: HTMLElement | null, options?: FlipOptions) => {
			activeTimelineRef.current?.kill();
			activeTimelineRef.current = null;
			// kill() does not fire onComplete, so an interrupted tween would leave
			// the previous target marked forever.
			clearFlippingMark();

			const state = pendingStateRef.current;
			pendingStateRef.current = null;
			const onSettle = options?.onSettle;

			if (!node || !state || prefersReducedMotion()) {
				onSettle?.();
				return;
			}

			node.dataset.flipping = "";
			flippingNodeRef.current = node;

			activeTimelineRef.current = Flip.from(state, {
				targets: node,
				scale: false,
				absolute: true,
				duration: (options?.duration ?? DEFAULT_DURATION_MS) / 1000,
				ease: options?.ease ?? DEFAULT_EASE,
				onComplete: () => {
					activeTimelineRef.current = null;
					clearFlippingMark();
					// Drop the inline width/height/position GSAP applied during the
					// tween, so the node goes back to being governed purely by its own
					// CSS (a later window resize would otherwise fight stale values).
					gsap.set(node, { clearProps: "all" });
					onSettle?.();
				},
			});
		},
		[clearFlippingMark],
	);

	useEffect(
		() => () => {
			activeTimelineRef.current?.kill();
			clearFlippingMark();
		},
		[clearFlippingMark],
	);

	return { captureRect, playFlip };
}
