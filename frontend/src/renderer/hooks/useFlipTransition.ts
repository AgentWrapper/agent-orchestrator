import { useCallback, useEffect, useRef } from "react";
import { gsap } from "gsap";
import { Flip } from "gsap/Flip";

gsap.registerPlugin(Flip);

// Used only if the token cannot be read (no document, or a stylesheet that has
// not applied yet); tokens.css is the source of truth.
const FALLBACK_DURATION_MS = { emphasized: 320, normal: 150 } as const;
// GSAP's own ease, not a CSS one. `--ease-emphasized` in tokens.css is its
// cubic-bezier equivalent, for CSS-driven parts of the same transition.
const DEFAULT_EASE = "expo.out";

// DESIGN.md documents this transition's timing, so the number belongs in the
// motion scale in tokens.css rather than duplicated here. Read per play (not
// memoised at module load) so a theme or stylesheet swap is picked up and so
// the value is never captured before first paint.
type MotionTiming = keyof typeof FALLBACK_DURATION_MS;

function motionDurationMs(timing: MotionTiming): number {
	const fallback = FALLBACK_DURATION_MS[timing];
	if (typeof window === "undefined" || typeof document === "undefined") return fallback;
	const raw = getComputedStyle(document.documentElement).getPropertyValue(`--duration-${timing}`).trim();
	if (!raw) return fallback;
	const value = Number.parseFloat(raw);
	if (!Number.isFinite(value) || value <= 0) return fallback;
	return raw.endsWith("ms") ? value : value * 1000;
}

export type FlipOptions = {
	duration?: number;
	timing?: MotionTiming;
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
// this only suits contents that reflow cleanly under a width sweep, like the
// file diff viewer's vertical list. The Browser panel deliberately does not use
// it — see DESIGN.md's Motion section for why.
export function useFlipTransition(): FlipController {
	const pendingStateRef = useRef<Flip.FlipState | null>(null);
	const activeTimelineRef = useRef<{ kill: () => void } | null>(null);

	const captureRect = useCallback((node: HTMLElement | null) => {
		pendingStateRef.current = node ? Flip.getState(node) : null;
	}, []);

	const playFlip = useCallback(
		(node: HTMLElement | null, options?: FlipOptions) => {
			activeTimelineRef.current?.kill();
			activeTimelineRef.current = null;

			const state = pendingStateRef.current;
			pendingStateRef.current = null;
			const onSettle = options?.onSettle;

			if (!node || !state || prefersReducedMotion()) {
				onSettle?.();
				return;
			}

			activeTimelineRef.current = Flip.from(state, {
				targets: node,
				scale: false,
				absolute: true,
				duration: (options?.duration ?? motionDurationMs(options?.timing ?? "emphasized")) / 1000,
				ease: options?.ease ?? DEFAULT_EASE,
				onComplete: () => {
					activeTimelineRef.current = null;
					// Drop the inline width/height/position GSAP applied during the
					// tween, so the node goes back to being governed purely by its own
					// CSS (a later window resize would otherwise fight stale values).
					gsap.set(node, { clearProps: "all" });
					onSettle?.();
				},
			});
		},
		[],
	);

	useEffect(() => () => activeTimelineRef.current?.kill(), []);

	return { captureRect, playFlip };
}
