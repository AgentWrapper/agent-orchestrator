import { POSTHOG_COOKIE_NAME } from "@superset/shared/constants";
import posthog from "posthog-js";

import { getHeroFlagBootstrap } from "@/lib/analytics/hero-flag-bootstrap";
import { ANALYTICS_CONSENT_KEY } from "@/lib/constants";

const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
if (POSTHOG_KEY) {
  posthog.init(POSTHOG_KEY, {
    bootstrap: getHeroFlagBootstrap(),
    api_host: "/ingest",
    ui_host: "https://us.posthog.com",
    defaults: "2025-11-30",
    capture_pageview: "history_change",
    capture_pageleave: true,
    capture_exceptions: true,
    debug: false,
    cross_subdomain_cookie: true,
    person_profiles: "always",
    persistence: "cookie",
    persistence_name: POSTHOG_COOKIE_NAME,
    disable_session_recording: true,
    loaded: (posthog) => {
      const consent = localStorage.getItem(ANALYTICS_CONSENT_KEY);
      if (consent === "declined") {
        posthog.opt_out_capturing();
      }
    },
  });

  posthog.register({
    app_name: "marketing",
    domain: window.location.hostname,
  });
}

export const onRouterTransitionStart = () => {};
