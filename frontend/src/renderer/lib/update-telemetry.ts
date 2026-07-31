import type { UpdateStatus } from "../../main/update-settings";
import { captureRendererEvent } from "./telemetry";

/**
 * Update-flow telemetry.
 *
 * The desktop app downloads updates automatically and installs them when the
 * user quits, but a large share of installs sit on an old version for weeks. As
 * shipped there was no signal at all about why: a stuck install looks identical
 * whether the check failed, the download failed, or the user simply never quits
 * the app. These events separate those cases.
 *
 * Only enum-like fields go on the wire. `message` from the updater is a raw
 * error string that can carry URLs and local paths, so it is mapped to a coarse
 * category and never sent verbatim.
 */

export type UpdateFailureCategory =
	| "network"
	| "signature"
	| "permission"
	| "disk_space"
	| "not_supported"
	| "unknown";

/**
 * Buckets an updater error message into a safe category.
 *
 * electron-updater surfaces failures as free-text messages, so this matches on
 * substrings. Anything unrecognized becomes "unknown" rather than leaking the
 * original text.
 */
export function updateFailureCategory(message: string | undefined): UpdateFailureCategory {
	const text = (message ?? "").toLowerCase();
	if (text === "") return "unknown";
	if (/enotfound|econnreset|econnrefused|etimedout|net::|socket|dns|network|502|503|504/.test(text)) {
		return "network";
	}
	if (/signature|code sign|notariz|checksum|sha512|integrity|not trusted/.test(text)) {
		return "signature";
	}
	if (/eacces|eperm|permission|denied|read-only|readonly/.test(text)) return "permission";
	if (/enospc|no space|disk full/.test(text)) return "disk_space";
	if (/unsupported|not supported|cannot update/.test(text)) return "not_supported";
	return "unknown";
}

/**
 * Decides what, if anything, to report for an update-status transition.
 *
 * Returns null for states that carry no new information. Notably `downloading`
 * is skipped: it fires repeatedly with a changing percent and would be pure
 * volume. Progress is visible in the UI, not needed in analytics.
 *
 * Exported separately from the emit path so the mapping is testable without a
 * PostHog client.
 */
export function updateTelemetryFor(
	previous: UpdateStatus | null,
	next: UpdateStatus,
): { event: string; properties: Record<string, unknown> } | null {
	// Same state as last time is not a transition. The status channel re-pushes
	// on reconnect and on every percent tick, so without this the "downloaded"
	// event would repeat for as long as the app stays open.
	if (previous && previous.state === next.state && previous.version === next.version) return null;

	switch (next.state) {
		case "error":
			return {
				event: "ao.renderer.update_failed",
				properties: {
					// Which stage failed, inferred from where we came from. The updater
					// does not label its own errors by phase.
					phase: previous?.state === "downloading" ? "download" : "check",
					error_category: updateFailureCategory(next.message),
					to_version: next.version,
				},
			};
		case "downloaded":
			return {
				event: "ao.renderer.update_downloaded",
				properties: { to_version: next.version },
			};
		case "unsupported":
			return {
				event: "ao.renderer.update_unsupported",
				properties: { error_category: "not_supported" },
			};
		default:
			return null;
	}
}

/** Emits the event for a transition, if the transition warrants one. */
export async function captureUpdateStatusTransition(
	previous: UpdateStatus | null,
	next: UpdateStatus,
): Promise<void> {
	const planned = updateTelemetryFor(previous, next);
	if (!planned) return;
	await captureRendererEvent(planned.event, planned.properties);
}
