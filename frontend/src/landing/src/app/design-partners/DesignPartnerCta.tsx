"use client";

import type { ReactNode } from "react";
import { track } from "@/lib/analytics";

/**
 * Destination of a design-partner call to action.
 *
 * There is no form on this page. The two ways to raise your hand are booking a
 * call and writing an email, so those are the two things worth counting: anyone
 * who clicks either has self-identified as a prospective design partner, which
 * is the highest-intent signal anywhere on the site.
 */
export type CtaDestination = "book_call" | "email";

/** Which block on the page the click came from, so the two can be compared. */
export type CtaPlacement = "hero" | "closing";

export function DesignPartnerCta({
  href,
  destination,
  placement,
  className,
  external,
  children,
}: {
  href: string;
  destination: CtaDestination;
  placement: CtaPlacement;
  className?: string;
  external?: boolean;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      className={className}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      onClick={() => {
        // Neither the mailto nor the cal.com hand-off leaves anything behind on
        // our side, so the click is the only place this is observable.
        track("design_partner_cta_clicked", { destination, placement });
      }}
    >
      {children}
    </a>
  );
}
