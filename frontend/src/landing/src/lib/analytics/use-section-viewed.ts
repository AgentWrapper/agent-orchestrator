"use client";

import { useEffect, useRef } from "react";

import { track } from "./index";

/**
 * Reports the first time a named section scrolls into view.
 *
 * Autocapture records clicks, and `$pageview` / `$pageleave` give time on page,
 * but neither answers "did they ever reach the download section". On a
 * single-page marketing site every section shares one URL, so scroll depth is
 * the only way to see how far down the page people actually get.
 *
 * Fires at most once per section per page load. Without that guard an
 * IntersectionObserver re-fires on every scroll past, which is exactly the kind
 * of repeating stream that produced AO's original PostHog bill.
 */
export function useSectionViewed(section: string, threshold = 0.4) {
  const ref = useRef<HTMLElement | null>(null);
  const reported = useRef(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    // Older browsers without IntersectionObserver simply contribute no scroll
    // data rather than breaking the page.
    if (typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting || reported.current) continue;
          reported.current = true;
          track("section_viewed", { section });
          // One report is all we want, so stop watching immediately.
          observer.disconnect();
        }
      },
      { threshold },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [section, threshold]);

  return ref;
}
