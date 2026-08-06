import { describe, expect, it } from "vitest";
import { shouldOnboard } from "./onboarding";

describe("shouldOnboard", () => {
	it("onboards a fresh install", () => {
		expect(shouldOnboard({ configured: false, skipped: false })).toBe(true);
	});

	it("does not onboard once a server is configured", () => {
		expect(shouldOnboard({ configured: true, skipped: false })).toBe(false);
	});

	it("does not onboard after the user skipped", () => {
		expect(shouldOnboard({ configured: false, skipped: true })).toBe(false);
	});

	it("does not onboard when configured and skipped", () => {
		expect(shouldOnboard({ configured: true, skipped: true })).toBe(false);
	});

	// Both flags load asynchronously. Acting on half-loaded state would bounce a
	// paired user onto the welcome screen for a frame on every cold start.
	it("waits while the config is still loading", () => {
		expect(shouldOnboard({ configured: null, skipped: false })).toBe(false);
	});

	it("waits while the skip flag is still loading", () => {
		expect(shouldOnboard({ configured: false, skipped: null })).toBe(false);
	});

	it("waits while both are still loading", () => {
		expect(shouldOnboard({ configured: null, skipped: null })).toBe(false);
	});
});
