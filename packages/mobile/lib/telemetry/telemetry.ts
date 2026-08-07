import { type ActiveStorage, reserveDailyActive } from "./dailyActive";
import { MOBILE_ALLOWLIST, MOBILE_EVENTS, type MobileEventName } from "./events";
import { sanitizeMobileProperties } from "./sanitize";

// The capture facade. Everything the app calls goes through here, so the
// sanitizer and the once-per-day gate are the only paths to PostHog. The
// concrete posthog-react-native client is injected as a narrow interface, so
// this whole file is unit-testable without the SDK or a device; runtime.ts is
// the thin edge that constructs the real client.

export interface MobileTelemetryClient {
	capture(event: string, properties?: Record<string, unknown>): void;
	// register returns a Promise in the SDK; we never await it (best-effort).
	register(properties: Record<string, unknown>): void | Promise<void>;
}

export type MobileTelemetry = {
	/** Emit an allowlisted event. Unknown event names and unknown props are dropped. */
	capture(event: MobileEventName, properties?: Record<string, unknown>): void;
	/** Emit the daily-active heartbeat at most once per UTC day. */
	active(storage?: ActiveStorage, now?: Date): Promise<void>;
};

export type MobileTelemetryOptions = {
	disabledEvents?: readonly string[];
	/**
	 * Returns false to drop an event that has hit the per-name rate cap. Sync so
	 * capture() stays non-blocking; runtime.ts backs it with an in-memory,
	 * persisted limiter. Omitted in tests that are not exercising the cap.
	 */
	allow?: (event: string) => boolean;
};

export function createMobileTelemetry(
	client: MobileTelemetryClient,
	context: Record<string, unknown>,
	options: MobileTelemetryOptions = {},
): MobileTelemetry {
	// Context rides as super-properties, so every event is tagged with
	// client/platform/version without the call sites repeating it.
	void client.register(context);
	const denied = new Set(options.disabledEvents ?? []);
	const allow = options.allow ?? (() => true);

	const capture = (event: MobileEventName, properties?: Record<string, unknown>): void => {
		// Fail closed on the event name: an event not in the allowlist is never
		// sent, so a typo cannot ship a bare untracked event.
		if (!(event in MOBILE_ALLOWLIST)) return;
		// Build-time kill switch, mirroring the desktop denylist.
		if (denied.has(event)) return;
		// Per-name rate cap: the runaway backstop. Checked last so a legitimate
		// event is only dropped when the name is genuinely over its window.
		if (!allow(event)) return;
		client.capture(event, {
			...sanitizeMobileProperties(event, properties),
			// Anonymous rate, belt-and-braces with personProfiles:"never" at init.
			// Matches every desktop and daemon event.
			$process_person_profile: false,
		});
	};

	return {
		capture,
		active: async (storage, now) => {
			if (await reserveDailyActive(storage, now)) {
				capture(MOBILE_EVENTS.active);
			}
		},
	};
}
