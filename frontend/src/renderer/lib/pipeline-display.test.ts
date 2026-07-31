import { describe, expect, it } from "vitest";
import { SETTLED_OUTCOMES, type StageOutcome } from "./pipeline-draft";
import {
	formatStageDuration,
	RUN_STATUSES,
	runStatusLabel,
	runStatusOf,
	runStatusTone,
	stageOutcomeDotTone,
	stageOutcomeLabel,
	stageOutcomesOf,
	shortSha,
} from "./pipeline-display";

const ALL_OUTCOMES: StageOutcome[] = ["pending", "running", ...SETTLED_OUTCOMES];

describe("RUN_STATUSES", () => {
	it("is the five D11 run statuses in lifecycle order", () => {
		expect(RUN_STATUSES).toEqual(["pending", "running", "succeeded", "failed", "cancelled"]);
	});

	it("labels every status with the GitHub Actions wording, none of them blank", () => {
		expect(RUN_STATUSES.map(runStatusLabel)).toEqual(["Queued", "In progress", "Success", "Failure", "Cancelled"]);
	});
});

describe("runStatusTone", () => {
	it("tones each status apart: accent running, success, error, muted cancelled, neutral pending", () => {
		expect(runStatusTone("running")).toContain("text-accent");
		expect(runStatusTone("succeeded")).toContain("text-success");
		expect(runStatusTone("failed")).toContain("text-error");
		expect(runStatusTone("cancelled")).toContain("text-passive");
		expect(runStatusTone("pending")).toContain("text-muted-foreground");
	});
});

describe("stageOutcomeDotTone", () => {
	it("keeps succeeded_unverified in the success family but hollow, not filled", () => {
		expect(stageOutcomeDotTone("succeeded")).toContain("bg-success");
		const unverified = stageOutcomeDotTone("succeeded_unverified");
		expect(unverified).toContain("border-success");
		expect(unverified).not.toContain("bg-success");
		expect(unverified).not.toBe(stageOutcomeDotTone("succeeded"));
	});

	it("groups failed with timed_out, no_output with no_signal, cancelled with skipped", () => {
		expect(stageOutcomeDotTone("timed_out")).toBe(stageOutcomeDotTone("failed"));
		expect(stageOutcomeDotTone("failed")).toContain("bg-error");
		expect(stageOutcomeDotTone("no_signal")).toBe(stageOutcomeDotTone("no_output"));
		expect(stageOutcomeDotTone("no_output")).toContain("bg-warning");
		expect(stageOutcomeDotTone("skipped")).toBe(stageOutcomeDotTone("cancelled"));
		expect(stageOutcomeDotTone("cancelled")).toContain("bg-passive");
	});

	it("pulses running on the accent and leaves pending neutral", () => {
		expect(stageOutcomeDotTone("running")).toContain("bg-accent");
		expect(stageOutcomeDotTone("running")).toContain("animate-pulse");
		expect(stageOutcomeDotTone("pending")).toContain("bg-muted-foreground");
	});

	it("does not collapse the eight settled outcomes into pass/fail", () => {
		const tones = new Set(SETTLED_OUTCOMES.map(stageOutcomeDotTone));
		// succeeded, succeeded_unverified, failed/timed_out, no_output/no_signal,
		// cancelled/skipped: five looks for eight outcomes, not two.
		expect(tones.size).toBe(5);
	});

	it("has a tone and a label for every outcome in the union", () => {
		for (const outcome of ALL_OUTCOMES) {
			expect(stageOutcomeDotTone(outcome)).not.toBe("");
			expect(stageOutcomeLabel(outcome)).not.toBe("");
		}
		expect(stageOutcomeLabel("succeeded_unverified")).toBe("succeeded (unverified)");
	});
});

describe("runStatusOf", () => {
	it("reads the run's status field", () => {
		expect(runStatusOf({ status: "succeeded" })).toBe("succeeded");
	});

	it("reads an unknown or missing status as pending rather than dropping the run", () => {
		expect(runStatusOf({})).toBe("pending");
		expect(runStatusOf({ status: "exploded" })).toBe("pending");
	});
});

describe("stageOutcomesOf", () => {
	it("reads the outcome map, treating a null one as empty", () => {
		expect(stageOutcomesOf({ stageOutcomes: { lint: "succeeded_unverified" } })).toEqual({
			lint: "succeeded_unverified",
		});
		expect(stageOutcomesOf({ stageOutcomes: null })).toEqual({});
		expect(stageOutcomesOf({})).toEqual({});
	});
});

describe("formatStageDuration", () => {
	it("scales from seconds to hours", () => {
		expect(formatStageDuration("2026-07-15T00:00:00Z", "2026-07-15T00:00:09Z")).toBe("9s");
		expect(formatStageDuration("2026-07-15T00:00:00Z", "2026-07-15T00:01:30Z")).toBe("1m 30s");
		expect(formatStageDuration("2026-07-15T00:00:00Z", "2026-07-15T02:05:00Z")).toBe("2h 5m");
	});

	it("measures an unsettled stage against now", () => {
		const startedAt = new Date(Date.now() - 90_000).toISOString();
		expect(formatStageDuration(startedAt, null)).toBe("1m 30s");
	});

	it("has no duration for a stage that never started, or for clocks that ran backwards", () => {
		expect(formatStageDuration(null, null)).toBe("");
		expect(formatStageDuration(undefined, "2026-07-15T00:01:00Z")).toBe("");
		expect(formatStageDuration("2026-07-15T00:01:00Z", "2026-07-15T00:00:00Z")).toBe("");
		expect(formatStageDuration("not a date", "2026-07-15T00:00:00Z")).toBe("");
	});
});

describe("shortSha", () => {
	it("clips to twelve characters", () => {
		expect(shortSha("abcdef1234567890")).toBe("abcdef123456");
		expect(shortSha("abcdef")).toBe("abcdef");
	});
});
