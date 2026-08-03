import posthog from "posthog-js";

import { getHeroFlagBootstrap } from "@/lib/analytics/hero-flag-bootstrap";
import {
  buildMarketingPostHogConfig,
  resolveMarketingPostHogHost,
} from "@/lib/analytics/posthog-config";
import { ANALYTICS_CONSENT_KEY } from "@/lib/constants";

// NEXT_PUBLIC_* is inlined at build time. Until the deploy workflow passed this
// through, it was undefined on the deployed site and init was skipped entirely,
// which is why the marketing site recorded nothing at all.
const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;

if (POSTHOG_KEY) {
  const host = resolveMarketingPostHogHost(process.env.NEXT_PUBLIC_POSTHOG_HOST);
  posthog.init(POSTHOG_KEY, {
    ...buildMarketingPostHogConfig(host, getHeroFlagBootstrap()),
    loaded: (posthog) => {
      const consent = localStorage.getItem(ANALYTICS_CONSENT_KEY);
      if (consent === "accepted") {
        posthog.opt_in_capturing();
      } else {
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
