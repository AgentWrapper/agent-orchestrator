"use client";

import { useLayoutEffect, type RefObject } from "react";

/**
 * Keeps an open popover within the viewport.
 *
 * Measures the popover's bounding rect after every open-transition and on
 * window resize, and applies a horizontal `translateX` shift via
 * `element.style.transform` when the popover would overflow the left or
 * right edge of the viewport. Anchor positioning (top/bottom alignment,
 * right:0 vs left:0, gap) stays in CSS — this hook only corrects for
 * viewport clipping.
 *
 * The hook mutates the popover element directly via its DOM style, so it
 * does not introduce an inline `style={}` prop on the JSX element.
 *
 * Usage:
 *   const popoverRef = useRef<HTMLDivElement>(null);
 *   usePopoverClamp(open, popoverRef);
 *   return open ? <div ref={popoverRef} className="my-popover">…</div> : null;
 *
 * Paired CSS should include `max-width: calc(100vw - 16px)` as a
 * secondary guard so the popover can never exceed the viewport width
 * even before the shift is applied.
 */
export function usePopoverClamp(
  open: boolean,
  popoverRef: RefObject<HTMLElement | null>,
  margin = 8,
): void {
  useLayoutEffect(() => {
    if (!open) return;
    const el = popoverRef.current;
    if (!el) return;

    const clamp = () => {
      // Reset any previous shift so we measure the natural position.
      el.style.transform = "";
      const rect = el.getBoundingClientRect();
      const vw = window.innerWidth;
      let dx = 0;
      if (rect.left < margin) {
        dx = margin - rect.left;
      } else if (rect.right > vw - margin) {
        dx = vw - margin - rect.right;
      }
      if (dx !== 0) {
        el.style.transform = `translateX(${dx}px)`;
      }
    };

    clamp();
    window.addEventListener("resize", clamp);
    return () => {
      window.removeEventListener("resize", clamp);
      // Leave the transform cleared so the next open re-measures from a
      // clean state; otherwise a stale shift could be inherited.
      el.style.transform = "";
    };
  }, [open, popoverRef, margin]);
}
