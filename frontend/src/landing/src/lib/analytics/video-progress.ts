import { track } from "./index";

/**
 * Watch-through milestones, in percent.
 *
 * Four fixed points, not a continuous stream. `timeupdate` fires roughly four
 * times a second, so reporting it directly would be ~240 events per minute of
 * watching per visitor, which is the repeating-stream shape that produced AO's
 * PostHog bill. A whole view costs at most four events instead.
 */
export const VIDEO_MILESTONES = [25, 50, 75, 100] as const;

export type VideoMilestone = (typeof VIDEO_MILESTONES)[number];

/**
 * Tracks which milestones a single view has already reported.
 *
 * Held by the caller rather than module state so the set dies with the
 * component: a visitor who reloads or navigates back gets a fresh view, and
 * scrubbing backwards inside one view does not re-report a milestone already
 * passed.
 */
export type VideoProgressState = Set<VideoMilestone>;

export function newVideoProgressState(): VideoProgressState {
	return new Set();
}

/**
 * Reports any milestone newly reached by `currentTime`, once each.
 *
 * Returns the milestones actually reported, which is what makes the once-only
 * behaviour testable without a player or a React renderer.
 *
 * Seeking is deliberately not special-cased. Someone who drags to the end has
 * reached 100%, and the four events still cost the same. What matters is that
 * each milestone is reported at most once per view.
 */
export function reportVideoProgress(
	state: VideoProgressState,
	currentTime: number,
	duration: number,
	report: (milestone: VideoMilestone) => void = (milestone) =>
		track("video_progress", { video: "demo", percent: milestone }),
): VideoMilestone[] {
	// duration is NaN until metadata loads and 0 for a live stream, either of
	// which would make the percentage Infinity or NaN and fire every milestone at
	// once on the first tick.
	if (!Number.isFinite(duration) || duration <= 0) return [];
	if (!Number.isFinite(currentTime) || currentTime < 0) return [];

	const percent = (currentTime / duration) * 100;
	const reported: VideoMilestone[] = [];
	for (const milestone of VIDEO_MILESTONES) {
		if (percent < milestone || state.has(milestone)) continue;
		state.add(milestone);
		reported.push(milestone);
		report(milestone);
	}
	return reported;
}
