"use client";

import type { ReactNode } from "react";

import { useSectionViewed } from "@/lib/analytics/use-section-viewed";

interface TrackedSectionProps {
  /** Stable, coarse name for the section, e.g. "features". */
  section: string;
  children: ReactNode;
}

/**
 * Reports the first time a section scrolls into view.
 *
 * A thin client wrapper so the page itself can stay a server component and the
 * individual section components need no analytics awareness. It renders a plain
 * wrapper element rather than cloning children, so layout and the sections'
 * own styling are untouched.
 */
export function TrackedSection({ section, children }: TrackedSectionProps) {
  const ref = useSectionViewed<HTMLDivElement>(section);
  // A real box on purpose: `display: contents` would remove this element from
  // the layout tree, leaving IntersectionObserver with a zero-size rect that
  // never intersects, so the events would silently never fire.
  return (
    <div ref={ref} data-section={section}>
      {children}
    </div>
  );
}
