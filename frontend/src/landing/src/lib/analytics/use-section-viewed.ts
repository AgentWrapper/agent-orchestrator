"use client";

import { useEffect, useRef } from "react";

import { track } from "./index";

/**
 * Observer options for section-view reporting.
 *
 * The threshold is deliberately 0, not a fraction of the element.
 * `intersectionRatio` is measured against the *element*, so a fractional
 * threshold is unsatisfiable for any section taller than the viewport: the
 * features section is ~3000px, which at 0.4 would need ~1200px visible at once
 * inside a ~770px window. Observed before this was fixed: a full-page scroll
 * reported only the hero, and every taller section below it reported nothing.
 *
 * Visibility is bounded by rootMargin instead, which shrinks the root's bottom
 * edge so a section must reach the upper part of the viewport to count. Grazing
 * the bottom edge while scrolling past is not "reached this section".
 */
export const SECTION_VIEWED_OBSERVER_OPTIONS: IntersectionObserverInit = {
  threshold: 0,
  rootMargin: "0px 0px -20% 0px",
};

/**
 * Reports `section` the first time `node` becomes visible, then stops watching.
 *
 * Split out from the hook so the once-only behaviour is testable without a React
 * renderer. An IntersectionObserver re-fires every time an element re-enters
 * view, so without the disconnect a visitor scrolling up and down a long page
 * would emit the same event repeatedly, which is the shape of stream that
 * produced AO's original PostHog bill.
 */
export function attachSectionObserver(
  node: HTMLElement,
  section: string,
  report: (section: string) => void = (name) =>
    track("section_viewed", { section: name }),
): () => void {
  // Older browsers simply contribute no scroll data rather than breaking.
  if (typeof IntersectionObserver === "undefined") return () => {};

  let reported = false;
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting || reported) continue;
      reported = true;
      report(section);
      observer.disconnect();
    }
  }, SECTION_VIEWED_OBSERVER_OPTIONS);

  observer.observe(node);
  return () => observer.disconnect();
}

/**
 * Reports the first time a named section scrolls into view.
 *
 * Autocapture records clicks and `$pageview`/`$pageleave` give time on page, but
 * neither answers "did they ever reach the download section". On a single-page
 * marketing site every section shares one URL, so scroll depth is the only way
 * to see how far down people actually get.
 */
export function useSectionViewed<T extends HTMLElement = HTMLDivElement>(
  section: string,
) {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    return attachSectionObserver(node, section);
  }, [section]);

  return ref;
}
