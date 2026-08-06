import { MOBILE_ALLOWLIST, type PropRule } from "./events";

// Turns a caller's raw property bag into the subset that is allowed to leave the
// device, per the allowlist in events.ts. Iterating the allowlist rather than
// the payload is the whole guarantee: a key nobody registered cannot be
// forwarded, including one added next month by someone who never read events.ts.
//
// An unknown event name returns {} rather than passing the payload through, so a
// typo in an event name fails closed instead of leaking an unsanitised bag.

const COUNT_MAX = Number.MAX_SAFE_INTEGER;

function keepValue(rule: PropRule, value: unknown): { ok: boolean; value?: unknown } {
	if ("oneOf" in rule) {
		return typeof value === "string" && rule.oneOf.includes(value)
			? { ok: true, value }
			: { ok: false };
	}
	if ("flag" in rule) {
		return typeof value === "boolean" ? { ok: true, value } : { ok: false };
	}
	// count: a finite, non-negative, safe integer. NaN/Infinity/floats/negatives
	// are dropped rather than coerced.
	if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= COUNT_MAX) {
		return { ok: true, value };
	}
	return { ok: false };
}

export function sanitizeMobileProperties(
	event: string,
	properties?: Record<string, unknown>,
): Record<string, unknown> {
	const allowed = MOBILE_ALLOWLIST[event];
	if (!allowed) return {};
	const out: Record<string, unknown> = {};
	if (!properties) return out;
	for (const key of Object.keys(allowed)) {
		if (!(key in properties)) continue;
		const decision = keepValue(allowed[key], properties[key]);
		if (decision.ok) out[key] = decision.value;
	}
	return out;
}
