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
 * Session replay is off, everywhere, by product decision: AO records no
 * sessions on the desktop app or on this site. The masking config below is kept
 * deliberately, so that if replay is ever enabled for a narrow case such as a
 * design-partner page, it starts from masked inputs rather than someone
 * discovering the defaults after the fact.
 *
 * Autocapture is on and is a different thing: it records clicks and element
 * text, not a replay of the screen. It stays enabled because this site is
 * public marketing copy. The desktop app keeps it off, since its DOM contains
 * user source code, agent prompts, and terminal output.
 *
 * Extracted from the init call so the invariants are testable: an accidental
 * revert to `"/ingest"`, or replay silently switching on, is otherwise invisible
 * until someone notices.
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
    // No session recording anywhere. Also belt-and-braces: PostHog gates replay
    // on a project-side toggle too, and both surfaces share one project, so the
    // client refusing is what keeps this independent of that setting.
    disable_session_recording: true,
    session_recording: {
      // Dormant while recording is disabled, kept so any future narrow opt-in
      // (a design-partner page) inherits masked inputs by default.
      maskAllInputs: true,
      maskTextSelector: "[data-ph-mask]",
      blockSelector: "[data-ph-no-record]",
    },
  };
}
