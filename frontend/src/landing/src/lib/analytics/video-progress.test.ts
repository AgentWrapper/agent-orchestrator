import { describe, expect, it, vi } from "vitest";
import {
	newVideoProgressState,
	reportVideoProgress,
	VIDEO_MILESTONES,
} from "./video-progress";

const DURATION = 200; // seconds; 25% = 50s, 50% = 100s, 75% = 150s

function collector() {
	const seen: number[] = [];
	return { seen, report: (m: number) => seen.push(m) };
}

describe("video watch-through milestones", () => {
	it("reports each milestone once as playback advances", () => {
		const state = newVideoProgressState();
		const { seen, report } = collector();

		reportVideoProgress(state, 10, DURATION, report);
		expect(seen).toEqual([]);
		reportVideoProgress(state, 50, DURATION, report);
		expect(seen).toEqual([25]);
		reportVideoProgress(state, 100, DURATION, report);
		expect(seen).toEqual([25, 50]);
		reportVideoProgress(state, 150, DURATION, report);
		expect(seen).toEqual([25, 50, 75]);
		reportVideoProgress(state, 200, DURATION, report);
		expect(seen).toEqual([25, 50, 75, 100]);
	});

	// The whole reason this is milestone-based. timeupdate fires ~4x/second, so a
	// full view must still cost four events, not one per tick.
	it("costs at most four events across a whole view, not one per tick", () => {
		const state = newVideoProgressState();
		const { seen, report } = collector();

		// 200s at 4 ticks/second is 800 calls.
		for (let tick = 0; tick <= 800; tick++) {
			reportVideoProgress(state, (tick / 800) * DURATION, DURATION, report);
		}
		expect(seen).toEqual([25, 50, 75, 100]);
		expect(seen).toHaveLength(VIDEO_MILESTONES.length);
	});

	it("does not re-report when the viewer scrubs backwards and replays", () => {
		const state = newVideoProgressState();
		const { seen, report } = collector();

		reportVideoProgress(state, 150, DURATION, report);
		expect(seen).toEqual([25, 50, 75]);
		// Back to the start, then forward through the same milestones again.
		reportVideoProgress(state, 0, DURATION, report);
		reportVideoProgress(state, 60, DURATION, report);
		reportVideoProgress(state, 120, DURATION, report);
		expect(seen).toEqual([25, 50, 75]);
	});

	it("reports every passed milestone when the viewer seeks straight to the end", () => {
		const state = newVideoProgressState();
		const { seen, report } = collector();

		reportVideoProgress(state, DURATION, DURATION, report);
		expect(seen).toEqual([25, 50, 75, 100]);
	});

	// duration is NaN until metadata loads and 0 for a live stream. Either would
	// make the percentage NaN or Infinity and fire all four milestones on the
	// first tick, before the visitor has watched anything.
	it("reports nothing until the duration is known", () => {
		const { seen, report } = collector();

		reportVideoProgress(newVideoProgressState(), 0, Number.NaN, report);
		reportVideoProgress(newVideoProgressState(), 5, 0, report);
		reportVideoProgress(newVideoProgressState(), 5, Number.POSITIVE_INFINITY, report);
		reportVideoProgress(newVideoProgressState(), Number.NaN, DURATION, report);
		reportVideoProgress(newVideoProgressState(), -1, DURATION, report);

		expect(seen).toEqual([]);
	});

	it("keeps separate views independent", () => {
		const first = newVideoProgressState();
		const second = newVideoProgressState();
		const { seen, report } = collector();

		reportVideoProgress(first, 60, DURATION, report);
		reportVideoProgress(second, 60, DURATION, report);
		expect(seen).toEqual([25, 25]);
	});

	it("returns the milestones it reported so callers can assert on them", () => {
		const state = newVideoProgressState();
		expect(reportVideoProgress(state, 120, DURATION, vi.fn())).toEqual([25, 50]);
		expect(reportVideoProgress(state, 120, DURATION, vi.fn())).toEqual([]);
	});
});
