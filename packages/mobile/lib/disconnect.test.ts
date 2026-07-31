import { beforeEach, describe, expect, it, vi } from "vitest";

// The modules under the seam all reach into native storage, so they're mocked
// out: what's worth asserting here is the order and completeness of the steps,
// not their implementations (which have their own coverage).
const calls: string[] = [];

vi.mock("./push", () => ({
	unregisterFromPush: vi.fn(async () => {
		calls.push("unregisterFromPush");
	}),
}));
vi.mock("./config", () => ({
	clearConfig: vi.fn(async () => {
		calls.push("clearConfig");
	}),
}));
vi.mock("./onboardingStore", () => ({
	clearOnboardingSkipped: vi.fn(async () => {
		calls.push("clearOnboardingSkipped");
	}),
}));

const { forgetServer } = await import("./disconnect");

describe("forgetServer", () => {
	beforeEach(() => {
		calls.length = 0;
	});

	// Clearing only the config would leave the daemon still pushing to this
	// device, and leave the password behind in the keystore.
	it("unregisters push, clears the config, and re-arms onboarding", async () => {
		await forgetServer();
		expect(calls).toEqual(["unregisterFromPush", "clearConfig", "clearOnboardingSkipped"]);
	});

	// The unregister needs credentials that clearConfig would otherwise destroy,
	// so the ordering is load-bearing, not incidental.
	it("unregisters before the credentials are thrown away", async () => {
		await forgetServer();
		expect(calls.indexOf("unregisterFromPush")).toBeLessThan(calls.indexOf("clearConfig"));
	});
});
