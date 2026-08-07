// Per-event-name rate cap for the mobile client, mirroring the desktop sink's
// bounds (backend/internal/adapters/telemetry/ratelimit.go): at most 5 events
// per name per rolling minute, 200 per name per UTC day. The daily ceiling is
// the real backstop against a runaway loop or a caller wired into a poll tick;
// the minute cap smooths a short burst.
//
// Pure and testable: the decision is a function of the stored state and the
// current time. runtime.ts holds the state in memory (seeded from AsyncStorage
// so a crash-restart loop cannot reset the daily ceiling) and persists it.

export const EVENTS_PER_NAME_PER_MINUTE = 5;
export const EVENTS_PER_NAME_PER_DAY = 200;

type NameWindow = {
	minuteStart: number; // epoch ms of the current minute window
	minuteCount: number;
	day: string; // UTC date "YYYY-MM-DD"
	dayCount: number;
};

export type RateLimitState = Record<string, NameWindow>;

function utcDay(nowMs: number): string {
	return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * Decides whether an event of `name` may be sent now, and returns the state to
 * store back. `allowed: false` means the cap was hit; the state still advances
 * so the window bookkeeping stays correct.
 *
 * Windows reset lazily on read: a minute older than 60s starts fresh, and a new
 * UTC day zeroes the day counter. So an idle app never carries stale counts.
 */
export function checkRateLimit(
	state: RateLimitState,
	name: string,
	nowMs: number,
	limits: { perMinute: number; perDay: number } = {
		perMinute: EVENTS_PER_NAME_PER_MINUTE,
		perDay: EVENTS_PER_NAME_PER_DAY,
	},
): { allowed: boolean; state: RateLimitState } {
	const prev = state[name];
	const day = utcDay(nowMs);

	const minuteStart = prev && nowMs - prev.minuteStart < 60_000 ? prev.minuteStart : nowMs;
	const minuteCount = minuteStart === prev?.minuteStart ? prev.minuteCount : 0;
	const dayCount = prev && prev.day === day ? prev.dayCount : 0;

	// Deny without mutating the counts further: once at the cap, extra attempts
	// in the same window neither send nor inflate the stored count past the cap.
	if (minuteCount >= limits.perMinute || dayCount >= limits.perDay) {
		const next: RateLimitState = {
			...state,
			[name]: { minuteStart, minuteCount, day, dayCount },
		};
		return { allowed: false, state: next };
	}

	const next: RateLimitState = {
		...state,
		[name]: { minuteStart, minuteCount: minuteCount + 1, day, dayCount: dayCount + 1 },
	};
	return { allowed: true, state: next };
}

/**
 * Merges persisted state into in-memory state at launch, preserving the daily
 * ceiling across a restart. The naive spread ({...persisted, ...current}) lets a
 * count that advanced in the race before the async load resolved overwrite the
 * higher persisted count, which would reset the ceiling a restart is meant to
 * carry over. For the same UTC day this takes the max of both; a persisted entry
 * from an older day is dropped, since its counts no longer apply.
 */
export function mergeRateState(persisted: RateLimitState, current: RateLimitState): RateLimitState {
	const out: RateLimitState = { ...persisted };
	for (const name of Object.keys(current)) {
		const cur = current[name];
		const prev = out[name];
		if (!prev || prev.day !== cur.day) {
			out[name] = cur;
			continue;
		}
		out[name] = {
			day: cur.day,
			dayCount: Math.max(prev.dayCount, cur.dayCount),
			minuteStart: Math.max(prev.minuteStart, cur.minuteStart),
			minuteCount: Math.max(prev.minuteCount, cur.minuteCount),
		};
	}
	return out;
}
