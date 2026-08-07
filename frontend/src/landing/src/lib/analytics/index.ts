import posthog from "posthog-js";

import { campaignProperties } from "./campaign";
import { trackReddit } from "./reddit";

/**
 * PostHog events that should also be forwarded to the Reddit Pixel as
 * conversion events. Keyed by PostHog event name → Reddit standard event.
 * `download_clicked` fires whenever a visitor hits a download CTA (across all
 * platforms), which is the conversion we optimize Reddit ads toward.
 */
const REDDIT_EVENT_MAP: Record<string, string> = {
	download_clicked: "Purchase",
};

export function track(
	event: string,
	properties?: Record<string, unknown>,
): void {
	// Best-effort: a throw from analytics must never escape into the caller.
	// Several callers navigate right after (e.g. the download click handler), and
	// PostHog's capture throws when called before init — which happens whenever
	// NEXT_PUBLIC_POSTHOG_KEY is unset (local dev) — aborting that navigation.
	// Campaign attribution rides on every event, so any funnel step can be broken
	// down by source, not only the download click. Merged under the caller's own
	// properties so an explicit property always wins over the ambient campaign.
	const enriched = { ...campaignProperties(), ...properties };
	try {
		posthog.capture(event, enriched);
	} catch (error) {
		console.warn("PostHog capture failed", error);
	}

	const redditEvent = REDDIT_EVENT_MAP[event];
	if (redditEvent) {
		trackReddit(redditEvent, enriched);
	}
}
