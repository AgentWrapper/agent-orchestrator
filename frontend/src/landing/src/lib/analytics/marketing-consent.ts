/**
 * Segment-then-consent ordering for the marketing PostHog client.
 *
 * posthog-js invokes the `init` `loaded` callback synchronously, and
 * `opt_in_capturing()` immediately emits the opt-in event and an initial
 * pageview. When the super-properties were registered only after `init`
 * returned, those first events went out without `app_name=marketing`. On the
 * shared desktop project that let untagged marketing traffic surface in desktop
 * dashboards, and a returning consented visitor's initial pageview was emitted
 * untagged before the tag existed.
 *
 * Registering the super-properties first, from inside `loaded` and before the
 * opt-in, guarantees every event including the very first one carries the tag.
 */
export type MarketingConsentClient = {
	register: (properties: Record<string, unknown>) => void;
	opt_in_capturing: () => void;
	opt_out_capturing: () => void;
};

export const MARKETING_ACCEPTED_CONSENT = "accepted";

export function applyMarketingConsent(
	client: MarketingConsentClient,
	consent: string | null,
	domain: string,
): void {
	// Order matters: register must run before opt_in_capturing, never after.
	client.register({ app_name: "marketing", domain });
	if (consent === MARKETING_ACCEPTED_CONSENT) {
		client.opt_in_capturing();
	} else {
		client.opt_out_capturing();
	}
}
