"use client";

import Link from "next/link";

export type MobileBottomNavTab = "dashboard" | "prs" | "orchestrator";

interface MobileBottomNavProps {
  ariaLabel: string;
  activeTab?: MobileBottomNavTab;
  dashboardHref: string;
  prsHref: string;
  showOrchestrator?: boolean;
  orchestratorHref?: string | null;
}

export function MobileBottomNav({
  ariaLabel,
  activeTab,
  dashboardHref,
  prsHref,
  showOrchestrator = true,
  orchestratorHref = null,
}: MobileBottomNavProps) {
  return (
    <nav className="mobile-bottom-nav" aria-label={ariaLabel}>
      <Link
        href={dashboardHref}
        className="mobile-bottom-nav__item"
        data-active={activeTab === "dashboard" ? "true" : "false"}
        aria-current={activeTab === "dashboard" ? "page" : undefined}
      >
        <svg
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path d="M3 13h8V3H3zm10 8h8V11h-8zM3 21h8v-6H3zm10-10h8V3h-8z" />
        </svg>
        <span>Dashboard</span>
      </Link>
      <Link
        href={prsHref}
        className="mobile-bottom-nav__item"
        data-active={activeTab === "prs" ? "true" : "false"}
        aria-current={activeTab === "prs" ? "page" : undefined}
      >
        <svg
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
        </svg>
        <span>PRs</span>
      </Link>
      {showOrchestrator ? (
        orchestratorHref ? (
          <Link
            href={orchestratorHref}
            className="mobile-bottom-nav__item"
            data-active={activeTab === "orchestrator" ? "true" : "false"}
            aria-current={activeTab === "orchestrator" ? "page" : undefined}
          >
            <svg
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="M9 3H5a2 2 0 0 0-2 2v4m16 0V5a2 2 0 0 0-2-2h-4m0 18h4a2 2 0 0 0 2-2v-4M3 15v4a2 2 0 0 0 2 2h4" />
              <path d="M9 9h6v6H9z" />
            </svg>
            <span>Orchestrator</span>
          </Link>
        ) : (
          <button type="button" className="mobile-bottom-nav__item" disabled>
            <svg
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="M9 3H5a2 2 0 0 0-2 2v4m16 0V5a2 2 0 0 0-2-2h-4m0 18h4a2 2 0 0 0 2-2v-4M3 15v4a2 2 0 0 0 2 2h4" />
              <path d="M9 9h6v6H9z" />
            </svg>
            <span>Orchestrator</span>
          </button>
        )
      ) : null}
    </nav>
  );
}
