import semver from "semver";
import type { UpdateChannel } from "./update-settings";

const H48 = 48 * 60 * 60 * 1000;

/**
 * Pure escalation decision. Returns true when the user should be nudged harder
 * to restart and install a downloaded update.
 *
 * latest channel: escalated after 48 hours of sitting staged.
 * nightly channel: escalated when the feed marks the staged build important, OR
 *   when the running version is behind the latest stable release (time to jump
 *   to stable). The semver term is skipped when latestStableVersion could not
 *   be fetched.
 */
export function evaluateEscalation(opts: {
	channel: UpdateChannel;
	stagedAt: number;
	now: number;
	important: boolean;
	runningVersion: string;
	latestStableVersion: string | undefined;
}): boolean {
	const { channel, stagedAt, now, important, runningVersion, latestStableVersion } = opts;

	if (channel === "latest") {
		return now - stagedAt >= H48;
	}

	// nightly channel
	if (important) return true;
	if (latestStableVersion !== undefined) {
		// semver.lt handles pre-release comparisons correctly:
		// "0.10.4-nightly.202607031330" < "0.10.4" (pre-release < release),
		// but not < "0.10.3" (major.minor.patch is higher).
		try {
			return semver.lt(runningVersion, latestStableVersion);
		} catch {
			// Unparseable version strings: do not escalate.
			return false;
		}
	}
	return false;
}
