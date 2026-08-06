// Once-per-UTC-day gate for the ao.app.active heartbeat, the same shape as the
// desktop's reservation. Daily actives is a unique count, so emitting more than
// once a day per install buys nothing and only costs events. This is the pure
// decision plus a storage seam; the runtime wrapper passes AsyncStorage.
//
// The heartbeat is event-driven (app launch, foreground), never a timer, so a
// phone left backgrounded across midnight simply reports on its next foreground,
// which is the correct direction for a cost-sensitive unique metric.

export type ActiveStorage = {
	getItem: (key: string) => Promise<string | null>;
	setItem: (key: string, value: string) => Promise<void>;
};

export const ACTIVE_STORAGE_KEY = "ao.telemetry.activeDay";

function utcDay(now: Date): string {
	return now.toISOString().slice(0, 10);
}

/**
 * Returns true at most once per UTC day, marking the day as reported.
 *
 * Never throws: a storage failure falls back to allowing the emit, because
 * under-reporting a returning user is worse than a rare duplicate, and the
 * duplicate is still bounded to one per app start.
 */
export async function reserveDailyActive(
	storage: ActiveStorage | undefined,
	now: Date = new Date(),
): Promise<boolean> {
	const today = utcDay(now);
	if (!storage) return true;
	try {
		const stored = await storage.getItem(ACTIVE_STORAGE_KEY);
		if (stored === today) return false;
		await storage.setItem(ACTIVE_STORAGE_KEY, today);
		return true;
	} catch {
		return true;
	}
}
