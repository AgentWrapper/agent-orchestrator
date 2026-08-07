"use client";

import posthog from "posthog-js";
import { useEffect } from "react";
import { replayDecision } from "@/lib/analytics/design-partner-replay";

/**
 * Starts session replay for the duration of this page, and only this page.
 *
 * Mounted from the design-partner route, so the route boundary is the recording
 * boundary: navigating away unmounts this and stops the recording, and no other
 * page can reach it. Replay stays disabled in the shared init config, so nothing
 * here can arm it site-wide.
 */
export function DesignPartnerReplay() {
  useEffect(() => {
    const decision = replayDecision({
      key: process.env.NEXT_PUBLIC_POSTHOG_KEY,
      pathname: window.location.pathname,
      optedOut: posthog.has_opted_out_capturing(),
    });

    if (!decision.record) {
      // Logged rather than silent: "shared-project" is the case somebody will
      // hit after wiring the key and wondering why nothing recorded.
      console.info(`[replay] not recording: ${decision.reason}`);
      return;
    }

    posthog.startSessionRecording();
    return () => posthog.stopSessionRecording();
  }, []);

  return null;
}
