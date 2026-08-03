import { POSTHOG_COOKIE_NAME } from "@ao/shared/constants";
import type { PostHogConfig } from "posthog-js";

/** Host to send to when nothing is configured at build time. */
export const DEFAULT_MARKETING_POSTHOG_HOST = "https://us.i.posthog.com";

/**
 * Resolves the ingestion host for the marketing site.
 *
 * The site is a static export on GitHub Pages (`output: "export"`), so there is
 * no server to proxy through. The previous value was `"/ingest"`, which needed a
 * Next rewrite that the export deliberately omits, so every request would have
 * 404'd even once the key was set. Overridable so a managed reverse proxy can be
 * swapped in later without touching this code.
 */
export function resolveMarketingPostHogHost(
  configured: string | undefined,
): string {
  const trimmed = configured?.trim();
  return trimmed ? trimmed : DEFAULT_MARKETING_POSTHOG_HOST;
}

/**
 * PostHog options for the marketing site.
 *
 * Deliberately the opposite of the desktop app on two settings. The app
 * disables autocapture and session replay because its DOM contains user source
 * code, agent prompts, terminal output, and local paths. This site is public
 * marketing copy, so click heatmaps and replay are the product signal rather
 * than a data-handling problem.
 *
 * Extracted from the init call so the invariants are testable: an accidental
 * revert to `"/ingest"`, or autocapture and replay silently switching off, is
 * otherwise invisible until someone notices the dashboards are empty.
 */
export function buildMarketingPostHogConfig(
  host: string,
  bootstrap: PostHogConfig["bootstrap"],
): Partial<PostHogConfig> {
  return {
    bootstrap,
    api_host: host,
    ui_host: DEFAULT_MARKETING_POSTHOG_HOST,
    defaults: "2025-11-30",
    capture_pageview: "history_change",
    capture_pageleave: true,
    capture_exceptions: true,
    autocapture: true,
    debug: false,
    cross_subdomain_cookie: true,
    person_profiles: "never",
    // Consent-gated: nothing is captured until the visitor accepts, and the
    // `loaded` callback opts in only then.
    opt_out_capturing_by_default: true,
    persistence: "cookie",
    persistence_name: POSTHOG_COOKIE_NAME,
    disable_session_recording: false,
    session_recording: {
      // The only thing a visitor types here is a waitlist email, so mask every
      // input and let ordinary copy through, which is what makes a replay of a
      // marketing page worth watching at all.
      maskAllInputs: true,
      maskTextSelector: "[data-ph-mask]",
      blockSelector: "[data-ph-no-record]",
    },
  };
}
