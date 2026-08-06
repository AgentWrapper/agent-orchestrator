/**
 * Campaign attribution from UTM parameters.
 *
 * Captured once, from the URL the visitor first arrived on, and then attached to
 * every event for the rest of the tab session. Capturing per-click would miss
 * the campaign entirely: the download button navigates to `/download`, which no
 * longer carries the `?utm_*` query the visit started with, so by the time the
 * conversion fires the original source is gone from the URL.
 *
 * These are event properties, not person properties, so they still work with
 * `person_profiles: "never"`. PostHog's own `$initial_utm_*` lives on the person
 * profile, which is switched off to stay on the anonymous billing rate, so it
 * cannot be relied on here.
 */

const CAMPAIGN_STORAGE_KEY = "ao.campaign";

/** The standard five. Kept closed so a crafted query cannot add arbitrary keys. */
const UTM_KEYS = [
	"utm_source",
	"utm_medium",
	"utm_campaign",
	"utm_term",
	"utm_content",
] as const;

type UtmKey = (typeof UTM_KEYS)[number];
export type CampaignParams = Partial<Record<UtmKey, string>>;

type CampaignStorage = Pick<Storage, "getItem" | "setItem">;

/** A UTM value longer than this is treated as junk and dropped. */
const MAX_UTM_LENGTH = 200;

/**
 * Pulls the UTM parameters out of a URL query string.
 *
 * Pure, so the parsing rules are testable without a browser: only the five known
 * keys, non-empty after trimming, bounded in length. An unknown parameter, or a
 * blank value, contributes nothing rather than an empty string that would
 * pollute the breakdown.
 */
export function parseCampaign(search: string): CampaignParams {
	const params = new URLSearchParams(search);
	const out: CampaignParams = {};
	for (const key of UTM_KEYS) {
		const raw = params.get(key);
		if (raw == null) continue;
		const value = raw.trim();
		if (value === "" || value.length > MAX_UTM_LENGTH) continue;
		out[key] = value;
	}
	return out;
}

/**
 * Captures the entry URL's campaign once and returns it on every later call.
 *
 * First call with UTM params in the URL stores them for the tab; subsequent
 * calls return the stored set even after navigation drops the query string. A
 * visit that arrives with no UTM stores an empty marker, so a later internal
 * navigation that happens to carry stray params cannot overwrite the true entry
 * source.
 */
export function captureCampaign(
	search: string,
	storage: CampaignStorage | undefined,
): CampaignParams {
	if (!storage) return parseCampaign(search);
	try {
		const existing = storage.getItem(CAMPAIGN_STORAGE_KEY);
		if (existing != null) return JSON.parse(existing) as CampaignParams;
		const captured = parseCampaign(search);
		storage.setItem(CAMPAIGN_STORAGE_KEY, JSON.stringify(captured));
		return captured;
	} catch {
		return parseCampaign(search);
	}
}

function campaignStorage(): CampaignStorage | undefined {
	try {
		// sessionStorage, not localStorage: a campaign attributes one visit, and a
		// return visit weeks later from a different source should not inherit it.
		return window.sessionStorage;
	} catch {
		return undefined;
	}
}

/**
 * The campaign properties to attach to outgoing events.
 *
 * Empty object when there is no browser or no campaign, so spreading it into an
 * event payload is always safe and adds nothing when there is nothing to add.
 */
export function campaignProperties(): CampaignParams {
	if (typeof window === "undefined") return {};
	return captureCampaign(window.location.search, campaignStorage());
}
