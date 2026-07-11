import { describe, expect, it } from "vitest";
import { modelAvailabilityStatusLabel } from "./ModelAvailabilityField";

describe("modelAvailabilityStatusLabel", () => {
	it("suppresses expected not-probed unknown rows while preserving actionable statuses", () => {
		expect(
			modelAvailabilityStatusLabel({
				status: "unknown",
				reason: "not probed; only configured pins are live-validated",
			}),
		).toBe("");
		expect(modelAvailabilityStatusLabel({ status: "unknown", reason: "probe unavailable" })).toBe("unknown");
		expect(modelAvailabilityStatusLabel({ status: "unreachable", reason: "400 model not available" })).toBe(
			"unreachable",
		);
	});
});
