import { useCallback, useEffect, useRef } from "react";
import { gsap } from "gsap";
import { Flip } from "gsap/Flip";

gsap.registerPlugin(Flip);

// Used only if the token cannot be read (no document, or a stylesheet that has
// not applied yet); tokens.css is the source of truth.
const FALLBACK_DURATION_MS = 320;
// GSAP's own ease, not a CSS one. `--ease-emphasized` in tokens.css is its
// cubic-bezier equivalent, for CSS-driven parts of the same transition.
const DEFAULT_EASE = "expo.out";

// DESIGN.md documents this transition's timing, so the number belongs in the
// motion scale in tokens.css rather than duplicated here. Read per play (not
// memoised at module load) so a theme or stylesheet swap is picked up and so
// the value is never captured before first paint.
function emphasizedDurationMs(): number {
	if (typeof window === "undefined" || typeof document === "undefined") return FALLBACK_DURATION_MS;
	const raw = getComputedStyle(document.documentElement).getPropertyValue("--duration-emphasized").trim();
	if (!raw) return FALLBACK_DURATION_MS;
	const value = Number.parseFloat(raw);
	if (!Number.isFinite(value) || value <= 0) return FALLBACK_DURATION_MS;
	return raw.endsWith("ms") ? value : value * 1000;
}

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
//
// The trade is that real layout tweening relayouts the subtree every frame, so
// contents that reshape under a width sweep (a dense toolbar row, a bitmap
// whose box changes aspect) visibly squeeze and rescale their way through the
// transition. Targets are marked `data-flipping` for exactly the tween's
// duration so those surfaces can sit it out in CSS rather than animate through
// it — see the Browser panel's rules in styles.css.
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
				duration: (options?.duration ?? emphasizedDurationMs()) / 1000,
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
